import { Database } from "@vektorprogrammet/domain/database";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import { canManagePlacements } from "@vektorprogrammet/domain/placements";
import {
  OnboardingScope,
  OnboardingCommand,
  OnboardingClaim,
  OnboardingFailure,
  readOnboardingBoard,
  onboardingApplication,
  lockOnboardingApplicant,
  commandOnboarding,
  claimOnboarding,
  checkOnboardingClaim,
} from "@vektorprogrammet/domain/onboarding";
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
  withNativeHttpRuntime,
  prepareNativeHttpCommand,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { drainOnboardingDelivery, type OnboardingDeliveryConfig } from "./delivery.js";
import type { BackendRun } from "../router.js";
type Requirements =
  Parameters<BackendRun>[0] extends Effect.Effect<unknown, unknown, infer R> ? R : never;
const tokenDigest = async (token: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: BackendRun,
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
    ),
  );
const query = (request: Request) => {
  const q = new URL(request.url).searchParams;
  if ([...q.keys()].some((k) => k !== "departmentId" || q.getAll(k).length !== 1))
    throw new HttpSemanticFailure("request.malformed", 400);
  return Object.fromEntries(q);
};
type Endpoint = typeof ReadOnboardingEndpoint | typeof CommandOnboardingEndpoint;
const authorize = async (
  request: Request,
  run: BackendRun,
  endpoint: Endpoint,
  departmentId: typeof OnboardingScope.Type.departmentId | null,
  manage: boolean,
  now?: () => string,
) => {
  const auth = await resolveRequestPersonAuthorityInTransaction(request, { run, now });
  if (manage && (departmentId === null || !canManagePlacements(auth.authority, departmentId)))
    throw new HttpSemanticFailure("authority.denied", 403);
  await authorizePersonNativeOperation({
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
    run,
  });
  return auth;
};
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
  run: BackendRun;
  now?: () => string;
  delivery?: OnboardingDeliveryConfig;
}) => {
  const now = () => input.now?.() ?? new Date().toISOString();
  const read = (request: Request) =>
    input.run(
      Database.use((sql) =>
        sql.withTransaction(
          withNativeHttpRuntime(input.run, async (run) => {
            const scope = await decode(OnboardingScope, query(request), run);
            await authorize(
              request,
              run,
              ReadOnboardingEndpoint,
              scope.departmentId,
              true,
              input.now,
            );
            return json(
              await decode(
                OnboardingResource,
                resource(await run(readOnboardingBoard(scope.departmentId))),
                run,
              ),
            );
          }),
        ),
      ),
    );
  const readBody = async (request: Request) => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new HttpSemanticFailure("media-type.unsupported", 415);
    return readBoundedJson(request, 8192);
  };
  const command = async (request: Request) => {
    const body = await readBody(request);
    const selected = await decode(OnboardingCommand, body, input.run);
    const scope = await decode(OnboardingScope, query(request), input.run);
    const ifMatch = parseRequiredIfMatch(header(request, "if-match"));
    const key = parseIdempotencyKey(header(request, "idempotency-key"));
    const token =
      "onboard_" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const digest = await tokenDigest(token);
    const outcome = await input.run(
      executeNativeHttpCommandPostgres<unknown, Requirements>(
        prepareNativeHttpCommand(input.run, async (run) => {
          const auth = await authorize(
            request,
            run,
            CommandOnboardingEndpoint,
            scope.departmentId,
            true,
            input.now,
          );
          const identity = deriveHttpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: "onboarding.command",
            normalizedTarget: normalizeTarget("/api/onboarding/{departmentId}", scope),
            idempotencyKey: key,
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
              return yield* Effect.promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
      ),
    );
    const response = nativeCommandOutcomeResponse(outcome);
    if (response.ok && selected.action !== "Revoke")
      await input.run(drainOnboardingDelivery(selected.applicationId, input.delivery));
    return response;
  };
  const claim = async (request: Request) => {
    if (new URL(request.url).search) throw new HttpSemanticFailure("request.malformed", 400);
    const body = await decode(OnboardingClaim, await readBody(request), input.run);
    const digest = await tokenDigest(body.token);
    await input.run(checkOnboardingClaim(digest, now()));
    const passwordHash =
      body.mode === "NewAccount" ? await hashOnboardingPassword(body.password) : null;
    const result = await input.run(
      Database.use((sql) =>
        sql.withTransaction(
          withNativeHttpRuntime(input.run, async (run) => {
            const identity =
              body.mode === "ExistingAccount"
                ? {
                    mode: "ExistingAccount" as const,
                    personId: (
                      await resolveRequestPersonAuthorityInTransaction(request, {
                        run,
                        now: input.now,
                      })
                    ).authority.personId,
                  }
                : {
                    mode: "NewAccount" as const,
                    personId: PersonId.make(crypto.randomUUID()),
                    passwordHash: passwordHash!,
                  };
            return run(
              claimOnboarding({
                digest,
                now: now(),
                identity,
                provision: provisionOnboardingAccount,
              }),
            );
          }),
        ),
      ),
    );
    return json(result);
  };
  return HttpApiBuilder.group(ExternalNativeApi, "onboarding", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readBoard", ({ request }) => toHttpApiResponse(request, read, errorResponse))
        .handleRaw("command", ({ request }) => toHttpApiResponse(request, command, errorResponse))
        .handleRaw("claim", ({ request }) => toHttpApiResponse(request, claim, errorResponse)),
    ),
  );
};
