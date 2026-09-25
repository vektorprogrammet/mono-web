import { Scope } from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { canManagePlacements } from "@vektorprogrammet/placements/contracts";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  OnboardingClaim,
  OnboardingCommand,
  type OnboardingFailure,
  OnboardingScope,
} from "@vektorprogrammet/domain/onboarding";
import {
  checkOnboardingClaim,
  claimOnboarding,
  commandOnboarding,
  lockOnboardingApplicant,
  onboardingApplication,
  readOnboardingBoard,
} from "@vektorprogrammet/database/onboarding";
import { hashOnboardingPassword, provisionOnboardingAccount } from "@vektorprogrammet/database";
import {
  type OrganizationDecodeError,
  type OrganizationPersistenceError,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import {
  ExternalNativeApi,
  OnboardingResource,
  ReadOnboardingEndpoint,
  CommandOnboardingEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { flow, Predicate, Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  currentInstant,
  headerCredentialCount,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import {
  authorizePerson,
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
 *
 * @construct http-problem
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
 *
 * @construct http-problem
 */
const onboardingProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | OnboardingFailure
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationDecodeError
    | OrganizationPersistenceError
    | SqlError
  >()({
    OnboardingFailure: ({ code }) => Problem.make(code),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: sqlProblem,
    SqlError: sqlProblem,
  });

/**
 * Hex SHA-256 of a claim token, the only form the database stores.
 *
 * @construct crypto-digest
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
 *
 * @construct http-problem
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

/** A coordinator of the department, then the declared AccessSpec, at one transaction instant. */
const authorize = (
  request: Request,
  endpoint: typeof ReadOnboardingEndpoint | typeof CommandOnboardingEndpoint,
  departmentId: typeof OnboardingScope.Type.departmentId,
  presentation: CredentialPresentation,
  now?: () => string,
) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(request, { now });

    if (!canManagePlacements(auth.authority, departmentId))
      return yield* Problem.make("authority.denied");

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
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
      presentation,
    );

    return auth;
  });

export const OnboardingApiHandlers = (input: {
  now?: () => string;
  delivery?: OnboardingDeliveryConfig;
}) => {
  const now = currentInstant(input.now);

  const read = (request: Request) => {
    const presentation = personPresentation(request);

    return Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* scopeOf(request);
          yield* authorize(
            request,
            ReadOnboardingEndpoint,
            scope.departmentId,
            presentation,
            input.now,
          );
          const board = yield* readOnboardingBoard(scope.departmentId);

          return json(yield* boardOutput(resource(board)));
        }),
      ),
    ).pipe(onboardingProblems(presentation));
  };

  const command = (request: Request) =>
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

      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorize(
            request,
            CommandOnboardingEndpoint,
            scope.departmentId,
            presentation,
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
              const app = yield* onboardingApplication(selected.applicationId, scope.departmentId);
              yield* lockOnboardingApplicant(app.applicantId);
              const current = resource(yield* readOnboardingBoard(scope.departmentId));
              yield* requireCurrentETag(current.etag, ifMatch);
              yield* commandOnboarding({
                departmentId: scope.departmentId,
                command: selected,
                actor: auth.authority.personId,
                now: auth.authorizationInstant,
                invitationId: "onboarding-" + identity.identitySha256,
                token,
                digest,
              });

              const changed = yield* boardOutput(
                resource(yield* readOnboardingBoard(scope.departmentId)),
              );

              return yield* Effect.promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
      ).pipe(onboardingProblems(presentation), commandReceiptProblems);

      const response = yield* commandOutcomeResponse(outcome);

      if (selected.action !== "Revoke")
        yield* drainOnboardingDelivery(selected.applicationId, input.delivery).pipe(
          Effect.catchTag("SchemaError", Effect.die),
          onboardingProblems(presentation),
        );

      return response;
    });

  const claim = (request: Request) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* decodeRequest(OnboardingClaim)(
        yield* readJsonBody(request, JSON_MEDIA_TYPE, MAX_BODY_BYTES),
      );

      const digest = yield* tokenDigest(body.token);

      // A new-account claim presents one credential: its token. An existing-account claim has one
      // principal, the signed-in Person. Its token is then a single-use requirement bound to one
      // invitation, which claimOnboarding checks and consumes after the Person is resolved.
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
              personId: PersonId.make(crypto.randomUUID()),
              passwordHash: yield* Effect.promise(() => hashOnboardingPassword(body.password)),
            }
          : null;

      const result = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const identity = newAccount ?? {
              mode: "ExistingAccount" as const,
              personId: (yield* resolveRequestPersonAuthorityInTransaction(request, {
                now: input.now,
              })).authority.personId,
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
    }).pipe(onboardingProblems(personPresentation(request)));

  return HttpApiBuilder.group(ExternalNativeApi, "onboarding", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readBoard", ({ request }) => webHandler(request, read))
        .handleRaw("command", ({ request }) => webHandler(request, command))
        .handleRaw("claim", ({ request }) => webHandler(request, claim)),
    ),
  );
};
