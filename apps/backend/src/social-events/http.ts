import { randomUUID } from "node:crypto";
import {
  SocialEventCommandId,
  SocialEventId,
  SocialEvents,
  socialEventCandidateGrantScopes,
  socialEventDepartmentAccessContext,
  socialEventScopeAccessContext,
  type SocialEventFailure,
  type SocialEventObservedAt,
} from "@vektorprogrammet/domain";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  SOCIAL_EVENTS_CREATE_CAPABILITY,
  SOCIAL_EVENTS_READ_CAPABILITY,
  SOCIAL_EVENTS_READ_SCOPE_CAPABILITY,
  type CanonicalResourceContext,
  type CapabilityTypeId,
} from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import { OrganizationAuthorityInstantSchema } from "@vektorprogrammet/domain/organization";
import { Database } from "@vektorprogrammet/database";
import {
  resolveOrganizationPersonAuthorityWithSql,
  type OrganizationAuthorityRowLockMode,
} from "@vektorprogrammet/database/organization";
import {
  CreateSocialEventEndpoint,
  CreateSocialEventRequest,
  ExternalNativeApi,
  ListSocialEventsEndpoint,
  ReadSocialEventScopeEndpoint,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestCredentialInTransaction,
  type OrganizationResolutionError,
  type TransactionPersonAuthority,
} from "../authority.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  readJsonBody,
  requireNoQuery,
  strictOutput,
  unreachable,
  webHandler,
  jsonText,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  semanticRequestDigest,
} from "../http-semantics.js";

const maxCreateBodyBytes = 32_768;

const socialEventScopeQueryKeys = {
  departmentId: true,
  semesterId: true,
} as const;

type Endpoint =
  | typeof ReadSocialEventScopeEndpoint
  | typeof ListSocialEventsEndpoint
  | typeof CreateSocialEventEndpoint;

type SocialEventAccessContext = CanonicalResourceContext<Record<string, never>>;

export type SocialEventTransactionStage =
  | "before-authority-snapshot"
  | "after-authority-snapshot"
  | "before-create-authorization"
  | "after-create-authorization";

export type SocialEventTransactionHook = (input: {
  readonly request: Request;
  readonly operation: "readScope" | "list" | "create";
  readonly stage: SocialEventTransactionStage;
}) => Effect.Effect<void>;

export interface SocialEventsApiHttpOptions {
  /**
   * Test-only coordination seam for proving snapshot and create-authorization
   * behavior against real concurrent transactions.
   */
  readonly transactionHook?: SocialEventTransactionHook;
}

/**
 * The one answer for every social-event, Organization projection, and
 * transaction credential failure.
 */
const socialEventProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    SocialEventFailure | OrganizationResolutionError | IdentityEngineError | UnauthenticatedActor
  >()({
    SocialEventScopeInvalid: () => Problem.make("scope.invalid"),
    SocialEventDecodeError: () => Problem.make("internal.error"),
    SocialEventPersistenceError: () => Problem.make("dependency.unavailable"),
    OrganizationDecodeError: () => Problem.make("organization.unavailable"),
    OrganizationPersistenceError: () => Problem.make("organization.unavailable"),
    IdentityEngineError: () => Problem.make("dependency.unavailable"),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
  });

/** The list scope is exactly one departmentId and one semesterId. */
const strictScope = (request: Request) =>
  Effect.suspend(() => {
    const values = [...new URL(request.url).searchParams];

    return values.length !== 2 ||
      values.some(([name]) => !Object.hasOwn(socialEventScopeQueryKeys, name)) ||
      values.filter(([name]) => name === "departmentId").length !== 1 ||
      values.filter(([name]) => name === "semesterId").length !== 1
      ? Effect.fail(Problem.make("request.malformed"))
      : Schema.decodeUnknownEffect(SocialEventScope)(Object.fromEntries(values), {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => Problem.make("request.malformed")));
  });

/** Evaluates the endpoint's AccessSpec against the grants the Organization projection yields. */
const authorize = (input: {
  readonly request: Request;
  readonly endpoint: Endpoint;
  readonly capability: CapabilityTypeId;
  readonly authorization: TransactionPersonAuthority;
  readonly context: SocialEventAccessContext;
}) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
      credential: input.authorization.credential,
      personId: input.authorization.authority.personId,
      resolution: { selection: "ExactlyOne", contexts: [input.context] },
      grantScopes: socialEventCandidateGrantScopes(input.authorization.authority, input.capability),
      now: input.authorization.authorizationInstant,
    },
    personPresentation(input.request),
  ).pipe(
    // Social-event AccessSpecs reveal every denial, so none is answered as not found.
    unreachable("resource.not-found"),
  );

/** Every answer `authorize` can give a caller it does not admit. */
type AuthorizationProblem =
  | Problem<"credential.missing">
  | Problem<"credential.invalid">
  | Problem<"authority.denied">;

const runTransactionHook = (
  options: SocialEventsApiHttpOptions,
  request: Request,
  operation: "readScope" | "list" | "create",
  stage: SocialEventTransactionStage,
) => {
  const hook = options.transactionHook;

  return hook === undefined ? Effect.void : hook({ request, operation, stage });
};

const resolveSocialEventAuthority = (
  request: Request,
  observedAt: string,
  lockMode: OrganizationAuthorityRowLockMode,
) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer", {
      now: () => observedAt,
    });

    if (!Predicate.isTagged(authenticated.credential.principal, "Person")) {
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    }

    const personId = authenticated.credential.principal.personId;

    const authority = yield* Database.use((sql) =>
      resolveOrganizationPersonAuthorityWithSql(
        sql,
        personId,
        OrganizationAuthorityInstantSchema.make(observedAt),
        lockMode,
      ),
    );

    return { ...authenticated, authority } satisfies TransactionPersonAuthority;
  });

/**
 * Reads one private JSON body inside a repeatable-read, read-only snapshot
 * whose instant also resolves the caller's credential and authority.
 */
const snapshotRead = (
  request: Request,
  options: SocialEventsApiHttpOptions,
  operation: "readScope" | "list",
  read: (
    observedAt: SocialEventObservedAt,
    authorization: TransactionPersonAuthority,
  ) => Effect.Effect<unknown, SocialEventFailure | AuthorizationProblem, SocialEvents>,
) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        yield* runTransactionHook(options, request, operation, "before-authority-snapshot");

        const observedAt = yield* SocialEvents.use(
          ({ readSnapshotInstant }) => readSnapshotInstant,
        );

        const authorization = yield* resolveSocialEventAuthority(request, observedAt, "None");
        yield* runTransactionHook(options, request, operation, "after-authority-snapshot");

        const body = yield* read(observedAt, authorization);

        return new Response(yield* jsonText(body), {
          headers: {
            "content-type": "application/json",
            "cache-control": "private, no-store",
            vary: "Origin",
          },
        });
      }),
    ),
  ).pipe(
    socialEventProblems(personPresentation(request)),
    Effect.catchTag("SqlError", () => Effect.fail(Problem.make("internal.error"))),
  );

const readScope = (request: Request, options: SocialEventsApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    return yield* snapshotRead(request, options, "readScope", (observedAt, authorization) =>
      Effect.gen(function* () {
        yield* authorize({
          request,
          endpoint: ReadSocialEventScopeEndpoint,
          capability: SOCIAL_EVENTS_READ_SCOPE_CAPABILITY,
          authorization,
          context: socialEventScopeAccessContext(authorization.authority),
        });

        const body = yield* SocialEvents.use((events) =>
          events.readScope({ authority: authorization.authority, observedAt }),
        );

        return yield* strictOutput(SocialEventScopeResource)(body);
      }),
    ).pipe(
      // The scope read selects no department or semester, so it never validates one.
      unreachable("scope.invalid"),
    );
  });

const list = (request: Request, options: SocialEventsApiHttpOptions) =>
  Effect.gen(function* () {
    const scope = yield* strictScope(request);

    return yield* snapshotRead(request, options, "list", (observedAt, authorization) =>
      Effect.gen(function* () {
        yield* authorize({
          request,
          endpoint: ListSocialEventsEndpoint,
          capability: SOCIAL_EVENTS_READ_CAPABILITY,
          authorization,
          context: socialEventDepartmentAccessContext(authorization.authority, scope.departmentId),
        });
        yield* SocialEvents.use(({ validateScope }) => validateScope(scope));

        const body = yield* SocialEvents.use(({ readList }) => readList({ ...scope, observedAt }));

        return yield* strictOutput(SocialEventListResource)(body);
      }),
    );
  });

const create = (request: Request, options: SocialEventsApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const json = yield* readJsonBody(
      request,
      /^\s*application\/json\s*(?:;|$)/iu,
      maxCreateBodyBytes,
    );

    const body = yield* decodeRequest(CreateSocialEventRequest)(json);

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = "social-events.create";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* runTransactionHook(options, request, "create", "before-authority-snapshot");

        const observedAt = yield* SocialEvents.use(
          ({ readSnapshotInstant }) => readSnapshotInstant,
        );

        const authorization = yield* resolveSocialEventAuthority(request, observedAt, "ForShare");
        yield* runTransactionHook(options, request, "create", "after-authority-snapshot");
        yield* runTransactionHook(options, request, "create", "before-create-authorization");
        yield* authorize({
          request,
          endpoint: CreateSocialEventEndpoint,
          capability: SOCIAL_EVENTS_CREATE_CAPABILITY,
          authorization,
          context: socialEventDepartmentAccessContext(authorization.authority, body.departmentId),
        });
        yield* runTransactionHook(options, request, "create", "after-create-authorization");
        yield* SocialEvents.use(({ validateScope }) =>
          validateScope({ departmentId: body.departmentId, semesterId: body.semesterId }),
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${authorization.authority.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/social-events",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body }),
            operationId,
          },
          execute: SocialEvents.use((events) =>
            events.create({
              commandId: SocialEventCommandId.make(identity.commandId),
              actorPersonId: authorization.authority.personId,
              occurredAt: observedAt,
              eventId: SocialEventId.make(`social_event_${randomUUID()}`),
              request: body,
            }),
          ).pipe(
            Effect.flatMap(strictOutput(SocialEventResource)),
            Effect.map((event) => ({
              status: 201,
              mediaType: "application/json",
              headers: {
                "content-type": "application/json",
                etag: deriveStrongETag({
                  representationKind: "social-event",
                  resourceIdentity: event.eventId,
                  version: event.revision,
                }),
                location: `/api/social-events/${encodePathIdentity(event.eventId)}`,
              },
              bodyBytes: jsonBodyBytes(event),
            })),
          ),
        };
      }),
      {
        retry: "serialization-or-unique-once",
        retryUniqueConstraints: [
          "social_events_created_command_id_key",
          "social_event_command_receipts_pkey",
          "native_http_idempotency_receipts_pkey",
        ],
      },
    ).pipe(socialEventProblems(personPresentation(request)), commandReceiptProblems);

    return yield* commandOutcomeResponse(outcome);
  });

/** Native HttpApi handlers for the frozen social-event surface. */
export const SocialEventsApiHandlers = (options: SocialEventsApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "social-events", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readScope", ({ request }) =>
          webHandler(request, (webRequest) => readScope(webRequest, options)),
        )
        .handleRaw("list", ({ request }) =>
          webHandler(request, (webRequest) => list(webRequest, options)),
        )
        .handleRaw("create", ({ request }) =>
          webHandler(request, (webRequest) => create(webRequest, options)),
        ),
    ),
  );
