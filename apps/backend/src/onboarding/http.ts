/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  credentialMatchesAccessSpec,
  reaches,
  ReachTarget,
  Scope,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  OnboardingClaim,
  OnboardingCommand,
  type OnboardingFailure,
  type OnboardingNotAdmitted,
  type OnboardingDeliveryNotRetryable,
  type OnboardingDeliveryAdmission,
  OnboardingScope,
} from "@vektorprogrammet/domain/onboarding";
import {
  checkOnboardingClaim,
  claimOnboarding,
  commandOnboarding,
  readOnboardingBoard,
} from "@vektorprogrammet/database/onboarding";
import { hashOnboardingPassword, provisionOnboardingAccount } from "@vektorprogrammet/database";
import {
  type OrganizationDecodeError,
  type OrganizationPersistenceError,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import {
  ClaimOnboardingEndpoint,
  ExternalNativeApi,
  OnboardingResource,
  readBoard as readOnboardingBoardEndpoint,
  command as commandOnboardingEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import {
  type CredentialPresentation,
  nativeCookieChallenge,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Crypto, flow, Predicate, Effect, Option, Ref, Schema } from "effect";
import { Instant } from "@vektorprogrammet/domain/time";
import type { SqlError } from "effect/sql/SqlError";
import type { HttpApiGroup } from "effect/http-api";
import {
  OnboardingApiHandlers as GeneratedOnboardingApiHandlers,
  type OnboardingGuards,
  type OnboardingRawHandlers,
} from "../../.effx/generated/onboarding-handlers.js";
import {
  currentInstant,
  headerCredentialCount,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import {
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  isSerializationConflict,
  personPresentation,
  problemMapper,
  readJsonBody,
  requireCurrentETag,
  requireNoQuery,
  requiredIfMatchOf,
  webHandler,
} from "../http-api/problem.js";
import {
  deriveStrongETag,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
  responseCapsule,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { drainOnboardingDelivery, type OnboardingDeliveryConfig } from "./delivery.js";
import {
  authorizeOnboardingAt,
  onboardingGuard,
  type OnboardingOperation,
  type OnboardingPersonAuthorize,
} from "./http-guard.js";

type OnboardingEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["onboarding"]
>;

/** Guards remain lazy until the raw handler supplies its original authority frame. */
export const onboardingGuards = {
  "onboarding.readBoard": () =>
    onboardingGuard("onboarding.readBoard", readOnboardingBoardEndpoint),
  "onboarding.command": () => onboardingGuard("onboarding.command", commandOnboardingEndpoint),
} satisfies OnboardingGuards<OnboardingEndpoints>;

/** Both bodies are JSON. The media type is matched case-sensitively. */
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/u;

const MAX_BODY_BYTES = 8_192;

/** The SQLSTATE of the first coded failure in a cause chain. */
const sqlState = (cause: unknown, depth = 0): string | undefined => {
  if (depth >= 8 || !Predicate.isObjectOrArray(cause)) return undefined;

  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) return cause.code;

  return Predicate.hasProperty(cause, "cause") ? sqlState(cause.cause, depth + 1) : undefined;
};

/**
 * A failed statement. A unique violation means a racing claim provisioned
 * the same account first, so the claimant must sign in to it.
 */
const sqlProblem = (cause: SqlError | OrganizationPersistenceError) =>
  sqlState(cause) === "23505"
    ? Problem.make("onboarding.sign-in-required")
    : isSerializationConflict(cause)
      ? Problem.make("transaction.conflict")
      : Problem.make("internal.error");

/**
 * The one answer for every onboarding failure. A person credential rejected
 * inside the transaction is answered from the request's own evidence.
 */
const onboardingProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | OnboardingFailure
    | OnboardingNotAdmitted
    | OnboardingDeliveryNotRetryable
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationDecodeError
    | OrganizationPersistenceError
    | SqlError
  >()({
    OnboardingFailure: ({ code }) => Problem.make(code),
    OnboardingNotAdmitted: () => Problem.make("onboarding.not-admitted"),
    OnboardingDeliveryNotRetryable: () => Problem.make("onboarding.delivery-not-retryable"),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: sqlProblem,
    SqlError: sqlProblem,
  });

/**
 * Hex SHA-256 of a claim token, the only form the database stores.
 */
const tokenDigest = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => Buffer.from(digest).toString("hex")),
  );

const resource = <A extends object>(body: A) => ({
  ...body,
  etag: deriveStrongETag({
    representationKind: "OnboardingSnapshot",
    resourceIdentity: JSON.stringify(body),
    version: JSON.stringify(body),
  }),
});

const json = (body: Schema.Json, etag?: string) => {
  const nativeHeaders = new Headers();
  nativeHeaders.set("content-type", "application/json");
  nativeHeaders.set("cache-control", etag ? "no-store" : "private, no-store");
  nativeHeaders.set("vary", "Origin");

  if (etag) {
    nativeHeaders.set("etag", etag);
  }

  return new Response(JSON.stringify(body), {
    headers: nativeHeaders,
  });
};

/**
 * Board rows reach the schema unchecked; a row outside it is a server defect, not a request error.
 */
const boardOutput = flow(
  Schema.decodeUnknownEffect(OnboardingResource, { onExcessProperty: "error" }),
  Effect.orDie,
);

/** The one departmentId query member the board operations accept. */
const scopeOf = (request: Request) => {
  const query = new URL(request.url).searchParams;

  return [...query.keys()].some((k) => k !== "departmentId" || query.getAll(k).length !== 1)
    ? Effect.fail(Problem.make("request.malformed"))
    : decodeRequest(OnboardingScope)(Object.fromEntries(query));
};

/**
 * Onboarding retains generic admissions.outcomes reach plus its own onboarding.manage
 * AccessSpec. Outcome-decide delegation policy does not interpret onboarding authority.
 */
const authorizeOnboarding = Effect.fn("authorizeOnboarding")(function* (
  request: Request,
  operation: OnboardingOperation,
  guard: OnboardingPersonAuthorize,
  departmentId: typeof OnboardingScope.Type.departmentId,
  now?: () => string,
) {
  const auth = yield* resolveRequestPersonAuthorityInTransaction(request, { now });

  if (!reaches(auth.authority, "admissions.outcomes", ReachTarget.Department({ departmentId })))
    return yield* Problem.make("authority.denied");

  yield* authorizeOnboardingAt(guard, {
    operation,
    request,
    input: {
      credential: auth.credential,
      personId: auth.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "organization",
            departmentId,
            authorityVersion: auth.authorizationInstant,
          }),
        ],
      },
      grantScopes: [Scope.Department({ departmentId })],
      now: auth.authorizationInstant,
    },
  });

  return auth;
});

/**
 * The one principal of an existing-account claim: a Person credential that the claim's
 * AccessSpec accepts. The AccessSpec accepts the browser session and no bearer. The token is
 * checked and consumed afterwards, by claimOnboarding.
 */
const claimingPerson = (request: Request, now?: () => string) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(request, { now });

    if (
      !credentialMatchesAccessSpec(
        Option.getOrThrow(reflectAccessSpec(ClaimOnboardingEndpoint)),
        auth.credential,
      )
    )
      return yield* new UnauthenticatedActor({ message: "authentication required" });

    return auth.authority.personId;
  });

export const OnboardingApiHandlers = (input: {
  now?: () => string;
  delivery?: OnboardingDeliveryConfig;
}) => {
  const now = currentInstant(input.now);
  const freshInstant = now.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Instant)), Effect.orDie);

  const read = (request: Request, guard: OnboardingPersonAuthorize) => {
    const presentation = personPresentation(request);

    return Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* scopeOf(request);
          yield* authorizeOnboarding(
            request,
            "onboarding.readBoard",
            guard,
            scope.departmentId,
            input.now,
          );
          const board = yield* readOnboardingBoard(scope.departmentId, freshInstant);

          return json(yield* boardOutput(resource(board)));
        }),
      ),
    ).pipe(onboardingProblems(presentation));
  };

  const command = (request: Request, guard: OnboardingPersonAuthorize) =>
    Effect.gen(function* () {
      const body = yield* readJsonBody(request, JSON_MEDIA_TYPE, MAX_BODY_BYTES);
      const selected = yield* decodeRequest(OnboardingCommand)(body);
      const scope = yield* scopeOf(request);
      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);
      const presentation = personPresentation(request);

      const token =
        "onboard_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

      const digest = yield* tokenDigest(token);

      const deliveryAdmission = yield* Ref.make<OnboardingDeliveryAdmission | null>(null);

      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorizeOnboarding(
            request,
            "onboarding.command",
            guard,
            scope.departmentId,
            input.now,
          );

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: "onboarding.command",
            normalizedTarget: normalizeTarget("/api/onboarding/{departmentId}", scope),
            idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId: "onboarding.command",
            },
            execute: Effect.gen(function* () {
              const admitted = yield* commandOnboarding(
                {
                  departmentId: scope.departmentId,
                  command: selected,
                  actor: auth.authority.personId,
                  now: freshInstant,
                  invitationId: "onboarding-" + identity.identitySha256,
                  token,
                  digest,
                },
                Effect.gen(function* () {
                  if (selected.action === "RetryDelivery" && input.delivery === undefined)
                    return yield* Problem.make("dependency.unavailable");

                  const current = resource(
                    yield* readOnboardingBoard(scope.departmentId, freshInstant),
                  );

                  yield* requireCurrentETag(current.etag, ifMatch);
                }),
              );

              yield* Ref.set(deliveryAdmission, admitted);

              const changed = yield* boardOutput(
                resource(yield* readOnboardingBoard(scope.departmentId, freshInstant)),
              );

              return yield* Effect.promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
        { retry: "serialization-once" },
      ).pipe(onboardingProblems(presentation), commandReceiptProblems);

      const response = yield* commandOutcomeResponse(outcome);

      // A replay never starts or resumes delivery. The capsule already means committed admission.
      const admitted = yield* Ref.get(deliveryAdmission);

      if (
        Predicate.isTagged(outcome, "Committed") &&
        admitted !== null &&
        input.delivery !== undefined
      )
        yield* drainOnboardingDelivery(
          selected.applicationId,
          input.delivery,
          admitted.invitationId,
        ).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.logWarning(
                "Committed onboarding delivery could not decode its stored envelope",
              ),
            SqlError: () =>
              Effect.logWarning(
                "Committed onboarding delivery attempt could not persist; explicit retry required",
              ),
          }),
        );

      return response;
    });

  // The session is the claim's one Person credential, so a credential problem challenges for it.
  const claim = (request: Request) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* decodeRequest(OnboardingClaim)(
        yield* readJsonBody(request, JSON_MEDIA_TYPE, MAX_BODY_BYTES),
      );

      const digest = yield* tokenDigest(body.token);

      // A new-account claim presents one credential: its token. An existing-account claim has one
      // principal, the browser session's Person. Its token is then a single-use requirement bound to
      // one invitation, which claimOnboarding checks and consumes after the Person is resolved.
      if (body.mode === "NewAccount") {
        if (
          headerCredentialCount(
            request.headers.get("cookie"),
            request.headers.get("authorization"),
          ) > 0
        )
          return yield* new UnauthenticatedActor({ message: "authentication required" });

        yield* checkOnboardingClaim(digest, yield* now);
      }

      const newAccount =
        body.mode === "NewAccount"
          ? {
              mode: "NewAccount" as const,
              personId: PersonId.make(
                yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie),
              ),
              passwordHash: yield* hashOnboardingPassword(body.password).pipe(Effect.orDie),
            }
          : null;

      const result = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const identity = newAccount ?? {
              mode: "ExistingAccount" as const,
              personId: yield* claimingPerson(request, input.now),
            };

            return yield* claimOnboarding({
              digest,
              now: yield* now,
              identity,
              provision: provisionOnboardingAccount,
            });
          }),
        ),
      );

      return json(result);
    }).pipe(onboardingProblems(personPresentation(request, nativeCookieChallenge)));

  const raw = {
    readBoard: ({ request }, authorize) =>
      webHandler(request, (webRequest) => read(webRequest, authorize)),
    command: ({ request }, authorize) =>
      webHandler(request, (webRequest) => command(webRequest, authorize)),
  } satisfies OnboardingRawHandlers<OnboardingEndpoints, typeof onboardingGuards>;

  // The generated factory requires native completion of Identity's handwritten claim.
  return GeneratedOnboardingApiHandlers({ raw, guards: onboardingGuards })((handlers) =>
    handlers.handleRaw("claim", ({ request }) => webHandler(request, claim)),
  );
};
