import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  AffiliationScope, OwnAffiliationCommand, PlacementCommand, PlacementScope, PlacementScopes, PlacementFailure, canManagePlacements } from "@vektorprogrammet/domain/placements";
import { lockPlacementDepartment, mutateAffiliation, mutatePlacementBoard, readOwnAffiliation, readPlacementBoard, readPlacementScopes } from "@vektorprogrammet/database/placements";
import {
  ExternalNativeApi,
  OwnAffiliationResource,
  PlacementBoardResource,
  ListPlacementScopesEndpoint,
  ReadOwnAffiliationEndpoint,
  CommandOwnAffiliationEndpoint,
  ReadPlacementBoardEndpoint,
  CommandPlacementBoardEndpoint,
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
import type { BackendRun } from "../router.js";
type Requirements =
  Parameters<BackendRun>[0] extends Effect.Effect<unknown, unknown, infer R> ? R : never;
const header = (r: Request, k: string) => (r.headers.has(k) ? [r.headers.get(k)!] : []);
const resource = <A extends object>(body: A) => ({
  ...body,
  etag: deriveStrongETag({
    representationKind: "PlacementSnapshot",
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
const query = (request: Request, own: boolean) => {
  const q = new URL(request.url).searchParams;
  const keys = own ? ["departmentId"] : ["departmentId", "semesterId"];
  if ([...q.keys()].some((k) => !keys.includes(k) || q.getAll(k).length !== 1))
    throw new HttpSemanticFailure("request.malformed", 400);
  return Object.fromEntries(q);
};
type Endpoint =
  | typeof ListPlacementScopesEndpoint
  | typeof ReadOwnAffiliationEndpoint
  | typeof CommandOwnAffiliationEndpoint
  | typeof ReadPlacementBoardEndpoint
  | typeof CommandPlacementBoardEndpoint;
const authorize = async (
  request: Request,
  run: BackendRun,
  endpoint: Endpoint,
  departmentId: PlacementScope["departmentId"] | null,
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
  if (cause instanceof HttpSemanticFailure || cause instanceof PlacementFailure)
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
  if (code === "23505") return nativeProblemResponse("placement.overlap", 409);
  if (code === "40001" || code === "40P01")
    return nativeProblemResponse("transaction.conflict", 409);
  return nativeProblemResponse("internal.error", 500);
};
export const PlacementsApiHandlers = (input: { run: BackendRun; now?: () => string }) => {
  const read = (request: Request, mode: "scopes" | "own" | "board") =>
    input.run(
      Database.use((sql) =>
        sql.withTransaction(
          withNativeHttpRuntime(input.run, async (run) => {
            await run(Database.use((sql) => sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`));
            if (mode === "scopes") {
              if (new URL(request.url).search)
                throw new HttpSemanticFailure("request.malformed", 400);
              const auth = await authorize(
                request,
                run,
                ListPlacementScopesEndpoint,
                null,
                false,
                input.now,
              );
              return json(
                await decode(PlacementScopes, await run(readPlacementScopes(auth.authority)), run),
              );
            }
            if (mode === "own") {
              const scope = await decode(AffiliationScope, query(request, true), run);
              const auth = await authorize(
                request,
                run,
                ReadOwnAffiliationEndpoint,
                scope.departmentId,
                false,
                input.now,
              );
              return json(
                await decode(
                  OwnAffiliationResource,
                  resource(
                    await run(readOwnAffiliation(auth.authority.personId, scope.departmentId)),
                  ),
                  run,
                ),
              );
            }
            const scope = await decode(PlacementScope, query(request, false), run);
            await authorize(
              request,
              run,
              ReadPlacementBoardEndpoint,
              scope.departmentId,
              true,
              input.now,
            );
            return json(
              await decode(
                PlacementBoardResource,
                resource(await run(readPlacementBoard(scope))),
                run,
              ),
            );
          }),
        ),
      ),
    );
  const mutate = async (request: Request, own: boolean) => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new HttpSemanticFailure("media-type.unsupported", 415);
    const body = await readBoundedJson(request, 8192);
    const selected = own
      ? {
          own: true as const,
          scope: await decode(AffiliationScope, query(request, true), input.run),
          command: await decode(OwnAffiliationCommand, body, input.run),
        }
      : {
          own: false as const,
          scope: await decode(PlacementScope, query(request, false), input.run),
          command: await decode(PlacementCommand, body, input.run),
        };
    const ifMatch = parseRequiredIfMatch(header(request, "if-match"));
    const key = parseIdempotencyKey(header(request, "idempotency-key"));
    const endpoint = own ? CommandOwnAffiliationEndpoint : CommandPlacementBoardEndpoint;
    const operationId = own ? "placements.commandOwnAffiliation" : "placements.commandBoard";
    const outcome = await input.run(
      executeNativeHttpCommandPostgres<unknown, Requirements>(
        prepareNativeHttpCommand(input.run, async (run) => {
          const auth = await authorize(
            request,
            run,
            endpoint,
            selected.scope.departmentId,
            !own,
            input.now,
          );
          const identity = deriveHttpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget(
              own
                ? "/api/placements/affiliation/{departmentId}"
                : "/api/placements/{departmentId}/{semesterId}",
              selected.scope,
            ),
            idempotencyKey: key,
          });
          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              yield* lockPlacementDepartment(selected.scope.departmentId);
              const current = selected.own
                ? resource(
                    yield* readOwnAffiliation(auth.authority.personId, selected.scope.departmentId),
                  )
                : resource(yield* readPlacementBoard(selected.scope));
              const precondition = evaluateMutationPrecondition(current.etag, ifMatch);
              if (precondition._tag === "Failed")
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              const changed = selected.own
                ? resource(
                    yield* mutateAffiliation(
                      yield* readOwnAffiliation(
                        auth.authority.personId,
                        selected.scope.departmentId,
                      ),
                      selected.command.action,
                      auth.authority.personId,
                      auth.authorizationInstant,
                    ),
                  )
                : resource(
                    yield* mutatePlacementBoard(
                      selected.scope,
                      selected.command,
                      auth.authority.personId,
                      auth.authorizationInstant,
                      `placement-${identity.identitySha256}`,
                    ),
                  );
              return yield* Effect.promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
      ),
    );
    return nativeCommandOutcomeResponse(outcome);
  };
  return HttpApiBuilder.group(ExternalNativeApi, "placements", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) =>
          toHttpApiResponse(request, (r) => read(r, "scopes"), errorResponse),
        )
        .handleRaw("readOwnAffiliation", ({ request }) =>
          toHttpApiResponse(request, (r) => read(r, "own"), errorResponse),
        )
        .handleRaw("readBoard", ({ request }) =>
          toHttpApiResponse(request, (r) => read(r, "board"), errorResponse),
        )
        .handleRaw("commandOwnAffiliation", ({ request }) =>
          toHttpApiResponse(request, (r) => mutate(r, true), errorResponse),
        )
        .handleRaw("commandBoard", ({ request }) =>
          toHttpApiResponse(request, (r) => mutate(r, false), errorResponse),
        ),
    ),
  );
};
