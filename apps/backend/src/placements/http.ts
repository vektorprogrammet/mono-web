import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  AffiliationScope,
  OwnAffiliationCommand,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
  PlacementFailure,
  canManagePlacements,
} from "@vektorprogrammet/domain/placements";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutatePlacementBoard,
  readOwnAffiliation,
  readPlacementBoard,
  readPlacementScopes,
} from "@vektorprogrammet/database/placements";
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
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
const semantic = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new HttpSemanticFailure("internal.error", 500),
  });
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
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );
const query = (request: Request, own: boolean) =>
  semantic(() => {
    const q = new URL(request.url).searchParams;
    const keys = own ? ["departmentId"] : ["departmentId", "semesterId"];
    if ([...q.keys()].some((key) => !keys.includes(key) || q.getAll(key).length !== 1))
      throw new HttpSemanticFailure("request.malformed", 400);
    return Object.fromEntries(q);
  });
type Endpoint =
  | typeof ListPlacementScopesEndpoint
  | typeof ReadOwnAffiliationEndpoint
  | typeof CommandOwnAffiliationEndpoint
  | typeof ReadPlacementBoardEndpoint
  | typeof CommandPlacementBoardEndpoint;
const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: PlacementScope["departmentId"] | null,
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
export const PlacementsApiHandlers = (input: { now?: () => string }) => {
  const read = (request: Request, mode: "scopes" | "own" | "board") =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Database.use(
            (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );
          if (mode === "scopes") {
            yield* semantic(() => {
              if (new URL(request.url).search)
                throw new HttpSemanticFailure("request.malformed", 400);
            });
            const auth = yield* authorize(
              request,
              ListPlacementScopesEndpoint,
              null,
              false,
              input.now,
            );
            return json(yield* decode(PlacementScopes, yield* readPlacementScopes(auth.authority)));
          }
          if (mode === "own") {
            const scope = yield* decode(AffiliationScope, yield* query(request, true));
            const auth = yield* authorize(
              request,
              ReadOwnAffiliationEndpoint,
              scope.departmentId,
              false,
              input.now,
            );
            return json(
              yield* decode(
                OwnAffiliationResource,
                resource(yield* readOwnAffiliation(auth.authority.personId, scope.departmentId)),
              ),
            );
          }
          const scope = yield* decode(PlacementScope, yield* query(request, false));
          yield* authorize(
            request,
            ReadPlacementBoardEndpoint,
            scope.departmentId,
            true,
            input.now,
          );
          return json(
            yield* decode(PlacementBoardResource, resource(yield* readPlacementBoard(scope))),
          );
        }),
      ),
    );
  const mutate = (request: Request, own: boolean) =>
    Effect.gen(function* () {
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
      const body = yield* readBoundedJson(request, 8192);
      const selected = own
        ? {
            own: true as const,
            scope: yield* decode(AffiliationScope, yield* query(request, true)),
            command: yield* decode(OwnAffiliationCommand, body),
          }
        : {
            own: false as const,
            scope: yield* decode(PlacementScope, yield* query(request, false)),
            command: yield* decode(PlacementCommand, body),
          };
      const ifMatch = yield* semantic(() => parseRequiredIfMatch(header(request, "if-match")));
      const key = yield* semantic(() => parseIdempotencyKey(header(request, "idempotency-key")));
      const endpoint = own ? CommandOwnAffiliationEndpoint : CommandPlacementBoardEndpoint;
      const operationId = own ? "placements.commandOwnAffiliation" : "placements.commandBoard";
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorize(
            request,
            endpoint,
            selected.scope.departmentId,
            !own,
            input.now,
          );
          const identity = yield* semantic(() =>
            deriveHttpIdentity({
              credentialSubject: `Person:${auth.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: normalizeTarget(
                own
                  ? "/api/placements/affiliation/{departmentId}"
                  : "/api/placements/{departmentId}/{semesterId}",
                selected.scope,
              ),
              idempotencyKey: key,
            }),
          );
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
                      selected.command.action === "GenerateProposal"
                        ? `school-service-proposal-${identity.identitySha256}`
                        : selected.command.action === "RecordOccurrence"
                          ? `school-service-occurrence-${identity.identitySha256}`
                          : `placement-${identity.identitySha256}`,
                    ).pipe(
                      Effect.tapError((cause) =>
                        Effect.sync(() => {
                          console.error(cause);
                        }),
                      ),
                    ),
                  );
              return yield* Effect.tryPromise({
                try: () => responseCapsule(json(changed, changed.etag)),
                catch: (cause) => {
                  console.error(cause);
                  return cause instanceof HttpSemanticFailure
                    ? cause
                    : new HttpSemanticFailure("internal.error", 500);
                },
              });
            }),
          };
        }),
      );
      return nativeCommandOutcomeResponse(outcome);
    });
  return HttpApiBuilder.group(ExternalNativeApi, "placements", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "scopes"), errorResponse),
        )
        .handleRaw("readOwnAffiliation", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "own"), errorResponse),
        )
        .handleRaw("readBoard", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "board"), errorResponse),
        )
        .handleRaw("commandOwnAffiliation", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => mutate(webRequest, true), errorResponse),
        )
        .handleRaw("commandBoard", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => mutate(webRequest, false), errorResponse),
        ),
    ),
  );
};
