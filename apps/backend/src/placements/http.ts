import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementFailure,
  PlacementScope,
  PlacementScopes,
  canManagePlacements,
  type CoverageCommand as CoverageCommandType,
  type OwnAffiliationCommand as OwnAffiliationCommandType,
  type OwnCoverageCommand as OwnCoverageCommandType,
  type PlacementCommand as PlacementCommandType,
} from "@vektorprogrammet/domain/placements";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutateCoverageBoard,
  mutateOwnCoverage,
  mutatePlacementBoard,
  readCoverageBoard,
  readOwnAffiliation,
  readOwnCoverage,
  readPlacementBoard,
  readPlacementScopes,
} from "@vektorprogrammet/database/placements";
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
import { Effect, Option, Schema } from "effect";
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

const json = (body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      vary: "Origin",
      ...(etag === undefined ? {} : { etag }),
    },
  });

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );

const query = (request: Request, mode: "affiliation" | "scope") =>
  semantic(() => {
    const parameters = new URL(request.url).searchParams;
    const keys = mode === "affiliation" ? ["departmentId"] : ["departmentId", "semesterId"];
    if ([...parameters.keys()].some((key) => !keys.includes(key) || parameters.getAll(key).length !== 1)) {
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

const sqlField = (value: unknown, field: "code" | "constraint", depth = 0): string | null =>
  depth < 8 && typeof value === "object" && value !== null
    ? field in value && typeof value[field] === "string"
      ? value[field]
      : "cause" in value
        ? sqlField(value.cause, field, depth + 1)
        : null
    : null;

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure || cause instanceof PlacementFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "UnauthenticatedActor"
  ) {
    return nativeProblemResponse("credential.invalid", 401);
  }
  if (sqlField(cause, "code") === "23505") {
    switch (sqlField(cause, "constraint")) {
      case "school_service_absence_target_unique":
        return nativeProblemResponse("absence.duplicate", 409);
      case "school_service_substitute_offer_active_partial_unique":
      case "school_service_substitute_offer_accepted_partial_unique":
        return nativeProblemResponse("offer.unresolved", 409);
      case "school_service_occurrences_proposal_id_school_id_day_block_occurred_on_key":
        return nativeProblemResponse("coverage.occurrence-duplicate", 409);
    }
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

const selectionForMutation = (request: Request, body: unknown, mode: MutationSelection["mode"]) =>
  Effect.gen(function* () {
    switch (mode) {
      case "affiliation":
        return {
          mode,
          scope: yield* decode(AffiliationScope, yield* query(request, "affiliation")),
          command: yield* decode(OwnAffiliationCommand, body),
          endpoint: CommandOwnAffiliationEndpoint,
          operationId: "placements.commandOwnAffiliation",
          target: "/api/placements/affiliation/{departmentId}",
          manage: false,
        } as const;
      case "board":
        return {
          mode,
          scope: yield* decode(PlacementScope, yield* query(request, "scope")),
          command: yield* decode(PlacementCommand, body),
          endpoint: CommandPlacementBoardEndpoint,
          operationId: "placements.commandBoard",
          target: "/api/placements/{departmentId}/{semesterId}",
          manage: true,
        } as const;
      case "ownCoverage":
        return {
          mode,
          scope: yield* decode(PlacementScope, yield* query(request, "scope")),
          command: yield* decode(OwnCoverageCommand, body),
          endpoint: CommandOwnCoverageEndpoint,
          operationId: "placements.commandOwnCoverage",
          target: "/api/placements/coverage/own/{departmentId}/{semesterId}",
          manage: false,
        } as const;
      case "coverage":
        return {
          mode,
          scope: yield* decode(PlacementScope, yield* query(request, "scope")),
          command: yield* decode(CoverageCommand, body),
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
            return json(yield* decode(PlacementScopes, yield* readPlacementScopes(auth.authority)));
          }
          if (mode === "own") {
            const scope = yield* decode(AffiliationScope, yield* query(request, "affiliation"));
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
          const scope = yield* decode(PlacementScope, yield* query(request, "scope"));
          if (mode === "board") {
            yield* authorize(request, ReadPlacementBoardEndpoint, scope.departmentId, true, input.now);
            return json(
              yield* decode(PlacementBoardResource, resource(yield* readPlacementBoard(scope))),
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
              yield* decode(
                OwnCoverageResource,
                resource(yield* readOwnCoverage(scope, auth.authority.personId)),
              ),
            );
          }
          yield* authorize(request, ReadCoverageBoardEndpoint, scope.departmentId, true, input.now);
          return json(
            yield* decode(CoverageBoardResource, resource(yield* readCoverageBoard(scope))),
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
              yield* lockPlacementDepartment(selected.scope.departmentId);
              const current =
                selected.mode === "affiliation"
                  ? resource(
                      yield* readOwnAffiliation(
                        auth.authority.personId,
                        selected.scope.departmentId,
                      ),
                    )
                  : selected.mode === "board"
                    ? resource(yield* readPlacementBoard(selected.scope))
                    : selected.mode === "ownCoverage"
                      ? resource(yield* readOwnCoverage(selected.scope, auth.authority.personId))
                      : resource(yield* readCoverageBoard(selected.scope));
              const precondition = evaluateMutationPrecondition(current.etag, ifMatch);
              if (precondition._tag === "Failed") {
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              }
              const changed =
                selected.mode === "affiliation"
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
                  : selected.mode === "board"
                    ? resource(
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
                        ),
                      )
                    : selected.mode === "ownCoverage"
                      ? resource(
                          yield* mutateOwnCoverage(
                            selected.scope,
                            selected.command,
                            auth.authority.personId,
                            auth.authorizationInstant,
                            `school-service-absence-${identity.identitySha256}`,
                          ),
                        )
                      : resource(
                          yield* mutateCoverageBoard(
                            selected.scope,
                            selected.command,
                            auth.authority.personId,
                            auth.authorizationInstant,
                            {
                              absenceId: `school-service-absence-${identity.identitySha256}`,
                              offerId: `school-service-substitute-offer-${identity.identitySha256}`,
                              acknowledgementId: `school-service-coverage-acknowledgement-${identity.identitySha256}`,
                              occurrenceId: `school-service-occurrence-${identity.identitySha256}`,
                            },
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
          toHttpApiResponse(request, (webRequest) => read(webRequest, "ownCoverage"), errorResponse),
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
