import { Scope } from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementFailure,
  PlacementPersistenceError,
  Placements,
  PlacementScope,
  PlacementScopes,
  canManagePlacements,
  type CoverageCommand as CoverageCommandType,
  type OwnAffiliationCommand as OwnAffiliationCommandType,
  type OwnCoverageCommand as OwnCoverageCommandType,
  type PlacementCommand as PlacementCommandType,
} from "@vektorprogrammet/placements/contracts";
import {
  CommandCoverageBoardEndpoint,
  CommandOwnAffiliationEndpoint,
  CommandOwnCoverageEndpoint,
  CommandPlacementBoardEndpoint,
  CoverageBoardResource,
  ExternalNativeApi,
  ListPlacementScopesEndpoint,
  OwnAffiliationResource,
  OwnCoverageResource,
  PlacementBoardResource,
  ReadCoverageBoardEndpoint,
  ReadOwnAffiliationEndpoint,
  ReadOwnCoverageEndpoint,
  ReadPlacementBoardEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { DomainId } from "@vektorprogrammet/domain/authz";
import { flow, Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  evaluateMutationPrecondition,
  nativeProblemResponse,
  normalizeTarget,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
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

const header = (request: Request, key: string) =>
  request.headers.has(key) ? [request.headers.get(key)!] : [];

const resource = <A extends object>(body: A) => ({
  ...body,
  etag: deriveStrongETag({
    representationKind: "PlacementSnapshot",
    resourceIdentity: JSON.stringify(body),
    version: JSON.stringify(body),
  }),
});

const json = (body: Schema.Json, etag?: string) => {
  const nativeHeaders = new Headers();
  nativeHeaders.set("content-type", "application/json");
  nativeHeaders.set("cache-control", "private, no-store");
  nativeHeaders.set("vary", "Origin");

  if (!(etag === undefined)) {
    nativeHeaders.set("etag", etag);
  }

  return new Response(JSON.stringify(body), {
    headers: nativeHeaders,
  });
};

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );

/** A snapshot that does not fit its response schema is a server fault, not a client error. */
const output = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

const query = (request: Request, mode: "affiliation" | "scope") =>
  semantic(() => {
    const parameters = new URL(request.url).searchParams;
    const keys = mode === "affiliation" ? ["departmentId"] : ["departmentId", "semesterId"];

    if (
      [...parameters.keys()].some(
        (key) => !keys.includes(key) || parameters.getAll(key).length !== 1,
      )
    ) {
      throw new HttpSemanticFailure("request.malformed", 400);
    }

    return Object.fromEntries(parameters);
  });

type Endpoint =
  | typeof ListPlacementScopesEndpoint
  | typeof ReadOwnAffiliationEndpoint
  | typeof CommandOwnAffiliationEndpoint
  | typeof ReadPlacementBoardEndpoint
  | typeof CommandPlacementBoardEndpoint
  | typeof ReadOwnCoverageEndpoint
  | typeof CommandOwnCoverageEndpoint
  | typeof ReadCoverageBoardEndpoint
  | typeof CommandCoverageBoardEndpoint;

const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: PlacementScope["departmentId"] | null,
  manage: boolean,
  now?: () => string,
) =>
  Effect.gen(function* () {
    const auth = yield* resolveRequestPersonAuthorityInTransaction(request, { now });

    if (manage && (departmentId === null || !canManagePlacements(auth.authority, departmentId))) {
      return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
    }

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: auth.credential,
      personId: auth.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "organization",
            departmentId: departmentId ?? undefined,
            authorityVersion: auth.authorizationInstant,
          }),
        ],
      },
      grantScopes:
        departmentId === null
          ? [Scope.Domain({ domainId: DomainId.make("organization") })]
          : [Scope.Department({ departmentId })],
      now: auth.authorizationInstant,
    });

    return auth;
  });

const sqlField = (cause: unknown, field: "code" | "constraint", depth = 0): string | null => {
  if (depth >= 8 || !(cause === null || Predicate.isObjectOrArray(cause)) || cause === null)
    return null;
  const candidate = Predicate.hasProperty(cause, field) ? cause[field] : undefined;

  if (Predicate.isString(candidate)) return candidate;

  return "cause" in cause ? sqlField(cause.cause, field, depth + 1) : null;
};

const errorResponse = (cause: unknown): Response => {
  if (
    cause instanceof HttpSemanticFailure ||
    cause instanceof PlacementFailure ||
    cause instanceof PlacementPersistenceError
  ) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  if (
    (cause === null || Predicate.isObjectOrArray(cause)) &&
    cause !== null &&
    "_tag" in cause &&
    Predicate.isTagged(cause, "UnauthenticatedActor")
  ) {
    return nativeProblemResponse("credential.invalid", 401);
  }

  const sqlCode = sqlField(cause, "code");

  if (sqlCode === "40001" || sqlCode === "40P01") {
    return nativeProblemResponse("transaction.conflict", 409);
  }

  return nativeProblemResponse("internal.error", 500);
};

type MutationSelection =
  | {
      readonly mode: "affiliation";
      readonly scope: typeof AffiliationScope.Type;
      readonly command: OwnAffiliationCommandType;
      readonly endpoint: typeof CommandOwnAffiliationEndpoint;
      readonly operationId: "placements.commandOwnAffiliation";
      readonly target: "/api/placements/affiliation/{departmentId}";
      readonly manage: false;
    }
  | {
      readonly mode: "board";
      readonly scope: typeof PlacementScope.Type;
      readonly command: PlacementCommandType;
      readonly endpoint: typeof CommandPlacementBoardEndpoint;
      readonly operationId: "placements.commandBoard";
      readonly target: "/api/placements/{departmentId}/{semesterId}";
      readonly manage: true;
    }
  | {
      readonly mode: "ownCoverage";
      readonly scope: typeof PlacementScope.Type;
      readonly command: OwnCoverageCommandType;
      readonly endpoint: typeof CommandOwnCoverageEndpoint;
      readonly operationId: "placements.commandOwnCoverage";
      readonly target: "/api/placements/coverage/own/{departmentId}/{semesterId}";
      readonly manage: false;
    }
  | {
      readonly mode: "coverage";
      readonly scope: typeof PlacementScope.Type;
      readonly command: CoverageCommandType;
      readonly endpoint: typeof CommandCoverageBoardEndpoint;
      readonly operationId: "placements.commandCoverageBoard";
      readonly target: "/api/placements/coverage/{departmentId}/{semesterId}";
      readonly manage: true;
    };

const selectionForMutation = (
  request: Request,
  body: Schema.Json,
  mode: MutationSelection["mode"],
) =>
  Effect.gen(function* () {
    switch (mode) {
      case "affiliation":
        return {
          mode,
          scope: yield* decode(AffiliationScope)(yield* query(request, "affiliation")),
          command: yield* decode(OwnAffiliationCommand)(body),
          endpoint: CommandOwnAffiliationEndpoint,
          operationId: "placements.commandOwnAffiliation",
          target: "/api/placements/affiliation/{departmentId}",
          manage: false,
        } as const;
      case "board":
        return {
          mode,
          scope: yield* decode(PlacementScope)(yield* query(request, "scope")),
          command: yield* decode(PlacementCommand)(body),
          endpoint: CommandPlacementBoardEndpoint,
          operationId: "placements.commandBoard",
          target: "/api/placements/{departmentId}/{semesterId}",
          manage: true,
        } as const;
      case "ownCoverage":
        return {
          mode,
          scope: yield* decode(PlacementScope)(yield* query(request, "scope")),
          command: yield* decode(OwnCoverageCommand)(body),
          endpoint: CommandOwnCoverageEndpoint,
          operationId: "placements.commandOwnCoverage",
          target: "/api/placements/coverage/own/{departmentId}/{semesterId}",
          manage: false,
        } as const;
      case "coverage":
        return {
          mode,
          scope: yield* decode(PlacementScope)(yield* query(request, "scope")),
          command: yield* decode(CoverageCommand)(body),
          endpoint: CommandCoverageBoardEndpoint,
          operationId: "placements.commandCoverageBoard",
          target: "/api/placements/coverage/{departmentId}/{semesterId}",
          manage: true,
        } as const;
    }
  });

export const PlacementsApiHandlers = (input: { now?: () => string }) => {
  const read = (request: Request, mode: "scopes" | "own" | "board" | "ownCoverage" | "coverage") =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const placements = yield* Placements;
          yield* Database.use(
            (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );

          if (mode === "scopes") {
            yield* semantic(() => {
              if (new URL(request.url).search) {
                throw new HttpSemanticFailure("request.malformed", 400);
              }
            });

            const auth = yield* authorize(
              request,
              ListPlacementScopesEndpoint,
              null,
              false,
              input.now,
            );

            return json(
              yield* output(PlacementScopes)(yield* placements.listScopes(auth.authority)),
            );
          }

          if (mode === "own") {
            const scope = yield* decode(AffiliationScope)(yield* query(request, "affiliation"));

            const auth = yield* authorize(
              request,
              ReadOwnAffiliationEndpoint,
              scope.departmentId,
              false,
              input.now,
            );

            return json(
              yield* output(OwnAffiliationResource)(
                resource(
                  yield* placements.readOwnAffiliation(auth.authority.personId, scope.departmentId),
                ),
              ),
            );
          }

          const scope = yield* decode(PlacementScope)(yield* query(request, "scope"));

          if (mode === "board") {
            yield* authorize(
              request,
              ReadPlacementBoardEndpoint,
              scope.departmentId,
              true,
              input.now,
            );

            return json(
              yield* output(PlacementBoardResource)(resource(yield* placements.readBoard(scope))),
            );
          }

          if (mode === "ownCoverage") {
            const auth = yield* authorize(
              request,
              ReadOwnCoverageEndpoint,
              scope.departmentId,
              false,
              input.now,
            );

            return json(
              yield* output(OwnCoverageResource)(
                resource(yield* placements.readOwnCoverage(scope, auth.authority.personId)),
              ),
            );
          }

          yield* authorize(request, ReadCoverageBoardEndpoint, scope.departmentId, true, input.now);

          return json(
            yield* output(CoverageBoardResource)(
              resource(yield* placements.readCoverageBoard(scope)),
            ),
          );
        }),
      ),
    );

  const mutate = (request: Request, mode: MutationSelection["mode"]) =>
    Effect.gen(function* () {
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
      }

      const body = yield* readBoundedJson(request, 8192);
      const selected = yield* selectionForMutation(request, body, mode);
      const ifMatch = yield* semantic(() => parseRequiredIfMatch(header(request, "if-match")));
      const key = yield* semantic(() => parseIdempotencyKey(header(request, "idempotency-key")));

      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorize(
            request,
            selected.endpoint,
            selected.scope.departmentId,
            selected.manage,
            input.now,
          );

          const identity = yield* semantic(() =>
            deriveHttpIdentity({
              credentialSubject: `Person:${auth.authority.personId}`,
              qualifiedOperationId: selected.operationId,
              normalizedTarget: normalizeTarget(selected.target, selected.scope),
              idempotencyKey: key,
            }),
          );

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId: selected.operationId,
            },
            execute: Effect.gen(function* () {
              const placements = yield* Placements;

              const changed = resource(
                yield* placements.execute(
                  {
                    mutation: selected,
                    actor: auth.authority.personId,
                    now: auth.authorizationInstant,
                    commandId: identity.identitySha256,
                  },
                  (current) =>
                    semantic(() => {
                      const precondition = evaluateMutationPrecondition(
                        resource(current).etag,
                        ifMatch,
                      );

                      if (Predicate.isTagged(precondition, "Failed")) {
                        throw new HttpSemanticFailure(precondition.code, precondition.status);
                      }
                    }),
                ),
              );

              return yield* Effect.tryPromise({
                try: () => responseCapsule(json(changed, changed.etag)),
                catch: (cause) =>
                  cause instanceof HttpSemanticFailure
                    ? cause
                    : new HttpSemanticFailure("internal.error", 500),
              });
            }),
          };
        }),
        { retry: "serialization-once" },
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
        .handleRaw("readOwnCoverage", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => read(webRequest, "ownCoverage"),
            errorResponse,
          ),
        )
        .handleRaw("readCoverageBoard", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "coverage"), errorResponse),
        )
        .handleRaw("commandOwnAffiliation", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => mutate(webRequest, "affiliation"),
            errorResponse,
          ),
        )
        .handleRaw("commandBoard", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => mutate(webRequest, "board"), errorResponse),
        )
        .handleRaw("commandOwnCoverage", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => mutate(webRequest, "ownCoverage"),
            errorResponse,
          ),
        )
        .handleRaw("commandCoverageBoard", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => mutate(webRequest, "coverage"), errorResponse),
        ),
    ),
  );
};
