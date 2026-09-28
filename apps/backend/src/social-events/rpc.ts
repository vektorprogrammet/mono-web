/**
 * The SocialEventsRpcs handlers: the precedent that every context's RPC handlers follow.
 *
 * A read resolves the credential and the authority in one repeatable-read snapshot and evaluates
 * the RPC's AccessSpec there. A command resolves them inside the serializable transaction that
 * commits it, mints its evidence, and stores its success as a command receipt, so a retry with the
 * same idempotency key replays the first answer.
 */
import { randomUUID } from "node:crypto";
import {
  SocialEventCommandId,
  SocialEventId,
  SocialEvents,
  socialEventCandidateGrantScopes,
  requireSocialEventCreation,
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
  CreateSocialEvent,
  ListSocialEvents,
  ReadSocialEventScope,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScopeResource,
  SocialEventsRpcs,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Option, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import {
  resolveRequestCredentialInTransaction,
  type OrganizationResolutionError,
  type TransactionPersonAuthority,
} from "../authority.js";
import { semanticRequestDigest } from "../http-semantics.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  personPresentation,
  problemMapper,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import { executeNativeHttpCommandPostgres, successCapsule } from "../rpc/receipt-transaction.js";

type SocialEventAccessContext = CanonicalResourceContext<Record<string, never>>;

export type SocialEventTransactionStage =
  | "before-authority-snapshot"
  | "after-authority-snapshot"
  | "before-create-authorization"
  | "after-create-authorization";

export type SocialEventTransactionHook = (input: {
  readonly operation: "readScope" | "list" | "create";
  readonly stage: SocialEventTransactionStage;
}) => Effect.Effect<void>;

/**
 * The one answer for every social-event, Organization projection, and transaction credential
 * failure.
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

/** Evaluates the RPC's AccessSpec against the grants the Organization projection yields. */
const authorize = (input: {
  readonly headers: Headers.Headers;
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly capability: CapabilityTypeId;
  readonly authorization: TransactionPersonAuthority;
  readonly context: SocialEventAccessContext;
}) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      credential: input.authorization.credential,
      personId: input.authorization.authority.personId,
      resolution: { selection: "ExactlyOne", contexts: [input.context] },
      grantScopes: socialEventCandidateGrantScopes(input.authorization.authority, input.capability),
      now: input.authorization.authorizationInstant,
    },
    personPresentation(input.headers),
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
  options: NativeRpcOptions,
  operation: "readScope" | "list" | "create",
  stage: SocialEventTransactionStage,
) => {
  const hook = options.socialEventsTransactionHook;

  return hook === undefined ? Effect.void : hook({ operation, stage });
};

const resolveSocialEventAuthority = (
  headers: Headers.Headers,
  observedAt: string,
  lockMode: OrganizationAuthorityRowLockMode,
) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(
      credentialRequestOf(headers),
      "OAuthUserBearer",
      { now: () => observedAt },
    );

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
 * Runs one read inside a repeatable-read, read-only snapshot whose instant also resolves the
 * caller's credential and authority.
 */
const snapshotRead = <A>(
  headers: Headers.Headers,
  options: NativeRpcOptions,
  operation: "readScope" | "list",
  read: (
    observedAt: SocialEventObservedAt,
    authorization: TransactionPersonAuthority,
  ) => Effect.Effect<A, SocialEventFailure | AuthorizationProblem, SocialEvents>,
) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        yield* runTransactionHook(options, operation, "before-authority-snapshot");

        const observedAt = yield* SocialEvents.use(
          ({ readSnapshotInstant }) => readSnapshotInstant,
        );

        const authorization = yield* resolveSocialEventAuthority(headers, observedAt, "None");

        yield* runTransactionHook(options, operation, "after-authority-snapshot");

        return yield* read(observedAt, authorization);
      }),
    ),
  ).pipe(
    socialEventProblems(personPresentation(headers)),
    Effect.catchTag("SqlError", () => Effect.fail(Problem.make("internal.error"))),
  );

/** The SocialEventsRpcs handlers. */
export const SocialEventsRpcHandlers = (options: NativeRpcOptions) =>
  SocialEventsRpcs.toLayer({
    "social-events.readScope": (_payload, { headers }) =>
      snapshotRead(headers, options, "readScope", (observedAt, authorization) =>
        Effect.gen(function* () {
          yield* authorize({
            headers,
            rpc: ReadSocialEventScope,
            capability: SOCIAL_EVENTS_READ_SCOPE_CAPABILITY,
            authorization,
            context: socialEventScopeAccessContext(authorization.authority),
          });

          const scope = yield* SocialEvents.use((events) =>
            events.readScope({ authority: authorization.authority, observedAt }),
          );

          return yield* strictOutput(SocialEventScopeResource)(scope);
        }),
      ).pipe(
        // The scope read selects no department or semester, so it never validates one.
        unreachable("scope.invalid"),
      ),

    "social-events.list": (scope, { headers }) =>
      snapshotRead(headers, options, "list", (observedAt, authorization) =>
        Effect.gen(function* () {
          yield* authorize({
            headers,
            rpc: ListSocialEvents,
            capability: SOCIAL_EVENTS_READ_CAPABILITY,
            authorization,
            context: socialEventDepartmentAccessContext(
              authorization.authority,
              scope.departmentId,
            ),
          });

          yield* SocialEvents.use(({ validateScope }) => validateScope(scope));

          const list = yield* SocialEvents.use(({ readList }) =>
            readList({ ...scope, observedAt }),
          );

          return yield* strictOutput(SocialEventListResource)(list);
        }),
      ),

    "social-events.create": ({ idempotencyKey, request }, { headers }) =>
      Effect.gen(function* () {
        const operationId = "social-events.create";

        // Domain and credential failures are mapped after the executor, whose retry reads their causes.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            yield* runTransactionHook(options, "create", "before-authority-snapshot");

            const observedAt = yield* SocialEvents.use(
              ({ readSnapshotInstant }) => readSnapshotInstant,
            );

            const authorization = yield* resolveSocialEventAuthority(
              headers,
              observedAt,
              "ForShare",
            );

            yield* runTransactionHook(options, "create", "after-authority-snapshot");

            yield* runTransactionHook(options, "create", "before-create-authorization");

            yield* authorize({
              headers,
              rpc: CreateSocialEvent,
              capability: SOCIAL_EVENTS_CREATE_CAPABILITY,
              authorization,
              context: socialEventDepartmentAccessContext(
                authorization.authority,
                request.departmentId,
              ),
            });

            // The AccessSpec admitted the candidate grants; the command takes them as evidence.
            const creator = yield* Effect.fromResult(
              requireSocialEventCreation(authorization.authority, request.departmentId),
            ).pipe(Effect.mapError(() => Problem.make("authority.denied")));

            yield* runTransactionHook(options, "create", "after-create-authorization");

            yield* SocialEvents.use(({ validateScope }) =>
              validateScope({ departmentId: request.departmentId, semesterId: request.semesterId }),
            );

            // The HTTP route stays the normalized target, so receipts and command IDs are stable.
            const identity = yield* commandIdentity({
              credentialSubject: `Person:${authorization.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/social-events",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest({ body: request }),
                operationId,
              },
              execute: SocialEvents.use((events) =>
                events.create(creator, {
                  commandId: SocialEventCommandId.make(identity.commandId),
                  occurredAt: observedAt,
                  eventId: SocialEventId.make(`social_event_${randomUUID()}`),
                  request,
                }),
              ).pipe(
                Effect.flatMap(strictOutput(SocialEventResource)),
                Effect.flatMap(successCapsule(SocialEventResource)),
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
        ).pipe(socialEventProblems(personPresentation(headers)), commandReceiptProblems);

        return yield* commandOutcome(SocialEventResource)(outcome);
      }),
  });
