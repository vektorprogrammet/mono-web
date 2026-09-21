import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { canManagePlacements } from "@vektorprogrammet/domain/placements";
import {
  OnboardingClaim,
  OnboardingCommand,
  OnboardingFailure,
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
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  ExternalNativeApi,
  OnboardingResource,
  ReadOnboardingEndpoint,
  CommandOnboardingEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { DomainId } from "@vektorprogrammet/domain/authz";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveStrongETag,
  deriveHttpIdentity,
  normalizeTarget,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  semanticMutationRequest,
  semanticRequestDigest,
  evaluateMutationPrecondition,
  responseCapsule,
  nativeProblemResponse,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { drainOnboardingDelivery, type OnboardingDeliveryConfig } from "./delivery.js";
const semantic = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof HttpSemanticFailure
        ? cause
        : new HttpSemanticFailure("internal.error", 500),
  });
const tokenDigest = (token: string) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    catch: (cause) =>
      cause instanceof HttpSemanticFailure
        ? cause
        : new HttpSemanticFailure("internal.error", 500),
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ),
  );
const header = (r: Request, k: string) => (r.headers.has(k) ? [r.headers.get(k)!] : []);
const resource = <A extends object>(body: A) => ({
  ...body,
  etag: deriveStrongETag({
    representationKind: "OnboardingSnapshot",
    resourceIdentity: JSON.stringify(body),
    version: JSON.stringify(body),
  }),
});
const json = (body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": etag ? "no-store" : "private, no-store",
      vary: "Origin",
      ...(etag ? { etag } : {}),
    },
  });
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );
const query = (request: Request) =>
  semantic(() => {
    const q = new URL(request.url).searchParams;
    if ([...q.keys()].some((k) => k !== "departmentId" || q.getAll(k).length !== 1))
      throw new HttpSemanticFailure("request.malformed", 400);
    return Object.fromEntries(q);
  });
type Endpoint = typeof ReadOnboardingEndpoint | typeof CommandOnboardingEndpoint;
const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: typeof OnboardingScope.Type.departmentId | null,
  manage: boolean,
  now?: () => string,
) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(request, { now });
    if (manage && (departmentId === null || !canManagePlacements(auth.authority, departmentId)))
      return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: auth.credential,
      personId: auth.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "organization",
            ...(departmentId === null ? {} : { departmentId }),
            authorityVersion: auth.authorizationInstant,
          }),
        ],
      },
      grantScopes:
        departmentId === null
          ? [{ _tag: "Domain", domainId: DomainId.make("organization") }]
          : [{ _tag: "Department", departmentId }],
      now: auth.authorizationInstant,
    });
    return auth;
  });
const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure || cause instanceof OnboardingFailure)
    return nativeProblemResponse(cause.code, cause.status);
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "UnauthenticatedActor"
  )
    return nativeProblemResponse("credential.invalid", 401);
  const sqlCode = (x: unknown, n = 0): string | null =>
    n < 8 && typeof x === "object" && x !== null
      ? "code" in x && typeof x.code === "string"
        ? x.code
        : "cause" in x
          ? sqlCode(x.cause, n + 1)
          : null
      : null;
  const code = sqlCode(cause);
  if (code === "23505") return nativeProblemResponse("onboarding.sign-in-required", 409);
  if (code === "40001" || code === "40P01")
    return nativeProblemResponse("transaction.conflict", 409);
  return nativeProblemResponse("internal.error", 500);
};
export const OnboardingApiHandlers = (input: {
  now?: () => string;
  delivery?: OnboardingDeliveryConfig;
}) => {
  const now = () => input.now?.() ?? new Date().toISOString();
  const read = (request: Request) =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const scope = yield* decode(OnboardingScope, yield* query(request));
          yield* authorize(
            request,
            ReadOnboardingEndpoint,
            scope.departmentId,
            true,
            input.now,
          );
          const board = yield* readOnboardingBoard(scope.departmentId);
          return json(yield* decode(OnboardingResource, resource(board)));
        }),
      ),
    );
  const readBody = (request: Request) => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    return readBoundedJson(request, 8192);
  };
  const command = (request: Request) =>
    Effect.gen(function* () {
      const body = yield* readBody(request);
      const selected = yield* decode(OnboardingCommand, body);
      const scope = yield* decode(OnboardingScope, yield* query(request));
      const ifMatch = yield* semantic(() => parseRequiredIfMatch(header(request, "if-match")));
      const key = yield* semantic(() => parseIdempotencyKey(header(request, "idempotency-key")));
      const token = yield* semantic(
        () =>
          "onboard_" +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
      );
      const digest = yield* tokenDigest(token);
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorize(
            request,
            CommandOnboardingEndpoint,
            scope.departmentId,
            true,
            input.now,
          );
          const identity = yield* semantic(() =>
            deriveHttpIdentity({
              credentialSubject: `Person:${auth.authority.personId}`,
              qualifiedOperationId: "onboarding.command",
              normalizedTarget: normalizeTarget("/api/onboarding/{departmentId}", scope),
              idempotencyKey: key,
            }),
          );
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
              const precondition = evaluateMutationPrecondition(current.etag, ifMatch);
              if (precondition._tag === "Failed")
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              yield* commandOnboarding({
                departmentId: scope.departmentId,
                command: selected,
                actor: auth.authority.personId,
                now: auth.authorizationInstant,
                invitationId: "onboarding-" + identity.identitySha256,
                token,
                digest,
              });
              const changed = resource(yield* readOnboardingBoard(scope.departmentId));
              return yield* promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
      );
      const response = nativeCommandOutcomeResponse(outcome);
      if (response.ok && selected.action !== "Revoke")
        yield* drainOnboardingDelivery(selected.applicationId, input.delivery);
      return response;
    });
  const claim = (request: Request) =>
    Effect.gen(function* () {
      yield* semantic(() => {
        if (new URL(request.url).search) throw new HttpSemanticFailure("request.malformed", 400);
      });
      const body = yield* decode(OnboardingClaim, yield* readBody(request));
      const digest = yield* tokenDigest(body.token);
      yield* checkOnboardingClaim(digest, now());
      const passwordHash =
        body.mode === "NewAccount" ? yield* promise(() => hashOnboardingPassword(body.password)) : null;
      const result = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const identity =
              body.mode === "ExistingAccount"
                ? {
                    mode: "ExistingAccount" as const,
                    personId: (
                      yield* resolveRequestPersonAuthorityInTransaction(request, {
                        now: input.now,
                      })
                    ).authority.personId,
                  }
                : {
                    mode: "NewAccount" as const,
                    personId: yield* semantic(() => PersonId.make(crypto.randomUUID())),
                    passwordHash: passwordHash!,
                  };
            return yield* claimOnboarding({
              digest,
              now: now(),
              identity,
              provision: provisionOnboardingAccount,
            });
          }),
        ),
      );
      return json(result);
    });
  return HttpApiBuilder.group(ExternalNativeApi, "onboarding", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readBoard", ({ request }) => toHttpApiResponse(request, read, errorResponse))
        .handleRaw("command", ({ request }) => toHttpApiResponse(request, command, errorResponse))
        .handleRaw("claim", ({ request }) => toHttpApiResponse(request, claim, errorResponse)),
    ),
  );
};
