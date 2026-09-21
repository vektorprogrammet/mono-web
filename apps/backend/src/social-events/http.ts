import { randomUUID } from "node:crypto";
import {
  SocialEventCommandId,
  SocialEventId,
  SocialEvents,
  deriveSocialEventCandidateGrants,
  socialEventDepartmentAccessContext,
  socialEventScopeAccessContext,
} from "@vektorprogrammet/domain";
import {
  AuthorizationInstant,
  accessHttpStatus,
  evaluateAccessJourney,
  type AccessSpec,
  type CanonicalResourceContext,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { OrganizationAuthorityInstantSchema } from "@vektorprogrammet/domain/organization";
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
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestCredentialInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  nativeProblemResponse,
  parseIdempotencyKey,
  semanticRequestDigest,
} from "../http-semantics.js";
import { nativeCommandOutcomeResponse } from "../native-operation.js";

const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';
const maxCreateBodyBytes = 32_768;

const socialEventScopeQueryKeys: Record<string, true> = {
  departmentId: true,
  semesterId: true,
};

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

const noQuery = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search !== "") {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: (cause) => cause,
  });

const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  code: "request.malformed" | "validation.failed" | "internal.error",
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new HttpSemanticFailure(
          code,
          code === "request.malformed" ? 400 : code === "validation.failed" ? 422 : 500,
        ),
    ),
  );

const strictScope = (request: Request) =>
  Effect.try({
    try: () => {
      const values = [...new URL(request.url).searchParams];
      if (
        values.length !== 2 ||
        values.some(([name]) => socialEventScopeQueryKeys[name] !== true) ||
        values.filter(([name]) => name === "departmentId").length !== 1 ||
        values.filter(([name]) => name === "semesterId").length !== 1
      ) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      return Object.fromEntries(values);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((scope) => strictDecode(SocialEventScope, scope, "request.malformed")),
  );

const authorize = (input: {
  readonly endpoint: Endpoint;
  readonly credential: TransactionPersonAuthority["credential"];
  readonly authority: TransactionPersonAuthority["authority"];
  readonly authorizationInstant: string;
  readonly context: SocialEventAccessContext;
}) => {
  const spec: AccessSpec = Option.getOrThrow(reflectAccessSpec(input.endpoint));
  return evaluateAccessJourney(spec, undefined, {
    now: Effect.succeed(AuthorizationInstant.make(input.authorizationInstant)),
    resolveCredential: () => Effect.succeed(input.credential),
    resolveScope: () =>
      Effect.succeed({
        selection: "ExactlyOne" as const,
        contexts: [input.context],
      }),
    resolveGrants: () => Effect.succeed(deriveSocialEventCandidateGrants(input.authority)),
  }).pipe(
    Effect.flatMap((evaluation) => {
      const status = accessHttpStatus(evaluation, spec.concealment);
      return status === 200
        ? Effect.void
        : Effect.fail(
            new HttpSemanticFailure(
              status === 401 ? "credential.invalid" : "authority.denied",
              status,
            ),
          );
    }),
  );
};

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
    if (authenticated.credential.principal._tag !== "Person") {
      return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
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
    return { ...authenticated, authority };
  });

const readSnapshot = (
  request: Request,
  mode: "scope" | "list",
  input: SocialEventsApiHttpOptions,
) =>
  Effect.gen(function* () {
    if (mode === "scope") yield* noQuery(request);
    const scope = mode === "list" ? yield* strictScope(request) : undefined;
    return yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(Effect.asVoid);
          const operation = mode === "scope" ? "readScope" : "list";
          yield* runTransactionHook(input, request, operation, "before-authority-snapshot");
          const observedAt = yield* SocialEvents.use(({ readSnapshotInstant }) => readSnapshotInstant());
          const authorization = yield* resolveSocialEventAuthority(
            request,
            observedAt,
            "None",
          );
          yield* runTransactionHook(input, request, operation, "after-authority-snapshot");

          if (mode === "scope") {
            yield* authorize({
              endpoint: ReadSocialEventScopeEndpoint,
              credential: authorization.credential,
              authority: authorization.authority,
              authorizationInstant: authorization.authorizationInstant,
              context: socialEventScopeAccessContext(authorization.authority),
            });
            const body = yield* SocialEvents.use(({ readScope }) =>
              readScope({ authority: authorization.authority, observedAt }),
            );
            const response = yield* strictDecode(
              SocialEventScopeResource,
              body,
              "internal.error",
            );
            return new Response(JSON.stringify(response), {
              headers: {
                "content-type": "application/json",
                "cache-control": "private, no-store",
                vary: "Origin",
              },
            });
          }

          if (scope === undefined) {
            return yield* Effect.fail(new HttpSemanticFailure("internal.error", 500));
          }
          yield* authorize({
            endpoint: ListSocialEventsEndpoint,
            credential: authorization.credential,
            authority: authorization.authority,
            authorizationInstant: authorization.authorizationInstant,
            context: socialEventDepartmentAccessContext(authorization.authority, scope.departmentId),
          });
          yield* SocialEvents.use(({ validateScope }) => validateScope(scope));
          const body = yield* SocialEvents.use(({ readList }) =>
            readList({ ...scope, observedAt }),
          );
          const response = yield* strictDecode(SocialEventListResource, body, "internal.error");
          return new Response(JSON.stringify(response), {
            headers: {
              "content-type": "application/json",
              "cache-control": "private, no-store",
              vary: "Origin",
            },
          });
        }),
      ),
    );
  });

const create = (request: Request, input: SocialEventsApiHttpOptions) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    yield* Effect.try({
      try: () => {
        if (
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
        ) {
          throw new HttpSemanticFailure("media-type.unsupported", 415);
        }
      },
      catch: (cause) => cause,
    });
    const rawBody = yield* readBoundedJson(request, maxCreateBodyBytes);
    const body = yield* strictDecode(CreateSocialEventRequest, rawBody, "validation.failed");
    const idempotencyKey = yield* Effect.try({
      try: () => {
        const idempotencyKeyHeader = request.headers.get("idempotency-key");
        return parseIdempotencyKey(idempotencyKeyHeader === null ? [] : [idempotencyKeyHeader]);
      },
      catch: (cause) => cause,
    });
    const operationId = "social-events.create";
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* runTransactionHook(input, request, "create", "before-authority-snapshot");
        const observedAt = yield* SocialEvents.use(({ readSnapshotInstant }) => readSnapshotInstant());
        const authorization = yield* resolveSocialEventAuthority(request, observedAt, "ForShare");
        yield* runTransactionHook(input, request, "create", "after-authority-snapshot");
        yield* runTransactionHook(input, request, "create", "before-create-authorization");
        yield* authorize({
          endpoint: CreateSocialEventEndpoint,
          credential: authorization.credential,
          authority: authorization.authority,
          authorizationInstant: authorization.authorizationInstant,
          context: socialEventDepartmentAccessContext(authorization.authority, body.departmentId),
        });
        yield* runTransactionHook(input, request, "create", "after-create-authorization");
        yield* SocialEvents.use(({ validateScope }) =>
          validateScope({ departmentId: body.departmentId, semesterId: body.semesterId }),
        );
        const identity = deriveHttpIdentity({
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
          execute: SocialEvents.use(({ create }) =>
            Effect.gen(function* () {
              const event = yield* create({
                commandId: SocialEventCommandId.make(identity.commandId),
                actorPersonId: authorization.authority.personId,
                occurredAt: observedAt,
                eventId: SocialEventId.make(`social_event_${randomUUID()}`),
                request: body,
              });
              const response = yield* Schema.decodeUnknownEffect(SocialEventResource)(event, {
                onExcessProperty: "error",
              }).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));
              const etag = deriveStrongETag({
                representationKind: "social-event",
                resourceIdentity: response.eventId,
                version: response.revision,
              });
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  etag,
                  location: `/api/social-events/${encodePathIdentity(response.eventId)}`,
                },
                bodyBytes: jsonBodyBytes(response),
              };
            }),
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
    );
    return nativeCommandOutcomeResponse(outcome);
  });

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(
      cause.code,
      cause.status,
      cause.status === 401 ? { "www-authenticate": PERSON_CHALLENGE } : undefined,
    );
  }
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : undefined;
  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": PERSON_CHALLENGE,
      });
    case "SocialEventScopeInvalid":
      return nativeProblemResponse("scope.invalid", 422);
    case "SocialEventValidationError":
    case "SocialEventInvalidTimeRange":
      return nativeProblemResponse("validation.failed", 422);
    case "SocialEventDecodeError":
      return nativeProblemResponse("internal.error", 500);
    case "OrganizationDecodeError":
    case "OrganizationPersistenceError":
      return nativeProblemResponse("organization.unavailable", 503);
    case "IdentityEngineError":
    case "SocialEventPersistenceError":
      return nativeProblemResponse("dependency.unavailable", 503);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};

/** Native HttpApi handlers for the frozen social-event surface. */
export const SocialEventsApiHandlers = (input: SocialEventsApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "social-events", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readScope", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readSnapshot(webRequest, "scope", input),
            errorResponse,
          ),
        )
        .handleRaw("list", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readSnapshot(webRequest, "list", input),
            errorResponse,
          ),
        )
        .handleRaw("create", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => create(webRequest, input), errorResponse),
        ),
    ),
  );
