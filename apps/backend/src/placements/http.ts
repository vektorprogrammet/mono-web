import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  Placements,
  PlacementScope,
  PlacementScopes,
  canManagePlacements,
  type CoverageCommand as CoverageCommandType,
  type OwnAffiliationCommand as OwnAffiliationCommandType,
  type OwnCoverageCommand as OwnCoverageCommandType,
  type PlacementCommand as PlacementCommandType,
  type PlacementOperationFailure,
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
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  type OrganizationResolutionError,
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
  requiredIfMatchOf,
  requireNoQuery,
  strictOutput,
  webHandler,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  normalizeTarget,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";

/**
 * The one answer for every placement domain failure. Each failure carries the
 * registry code it is answered with.
 */
const placementProblems = problemMapper<PlacementOperationFailure>()({
  PlacementFailure: (failure) => Problem.make(failure.code),
  PlacementPersistenceError: (failure) => Problem.make(failure.code),
});

/**
 * A person credential or organization projection that fails inside the
 * transaction. A projection read that lost a serialization race is a conflict.
 */
const authorityProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError | OrganizationResolutionError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: (failure) =>
      isSerializationConflict(failure)
        ? Problem.make("transaction.conflict")
        : Problem.make("internal.error"),
  });

/**
 * The snapshot transaction of a read: a lost serialization race is a conflict.
 */
const snapshotProblems = problemMapper<SqlError>()({
  SqlError: (failure) =>
    isSerializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("internal.error"),
});

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

/** Each scope member appears exactly once; any other query member is malformed. */
const query = (request: Request, mode: "affiliation" | "scope") =>
  Effect.suspend(() => {
    const parameters = new URL(request.url).searchParams;
    const keys = mode === "affiliation" ? ["departmentId"] : ["departmentId", "semesterId"];

    return [...parameters.keys()].some(
      (key) => !keys.includes(key) || parameters.getAll(key).length !== 1,
    )
      ? Effect.fail(Problem.make("request.malformed"))
      : Effect.succeed(Object.fromEntries(parameters));
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
      return yield* Problem.make("authority.denied");
    }

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
      },
      personPresentation(request),
    );

    return auth;
  });

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
          scope: yield* decodeRequest(AffiliationScope)(yield* query(request, "affiliation")),
          command: yield* decodeRequest(OwnAffiliationCommand)(body),
          endpoint: CommandOwnAffiliationEndpoint,
          operationId: "placements.commandOwnAffiliation",
          target: "/api/placements/affiliation/{departmentId}",
          manage: false,
        } as const;
      case "board":
        return {
          mode,
          scope: yield* decodeRequest(PlacementScope)(yield* query(request, "scope")),
          command: yield* decodeRequest(PlacementCommand)(body),
          endpoint: CommandPlacementBoardEndpoint,
          operationId: "placements.commandBoard",
          target: "/api/placements/{departmentId}/{semesterId}",
          manage: true,
        } as const;
      case "ownCoverage":
        return {
          mode,
          scope: yield* decodeRequest(PlacementScope)(yield* query(request, "scope")),
          command: yield* decodeRequest(OwnCoverageCommand)(body),
          endpoint: CommandOwnCoverageEndpoint,
          operationId: "placements.commandOwnCoverage",
          target: "/api/placements/coverage/own/{departmentId}/{semesterId}",
          manage: false,
        } as const;
      case "coverage":
        return {
          mode,
          scope: yield* decodeRequest(PlacementScope)(yield* query(request, "scope")),
          command: yield* decodeRequest(CoverageCommand)(body),
          endpoint: CommandCoverageBoardEndpoint,
          operationId: "placements.commandCoverageBoard",
          target: "/api/placements/coverage/{departmentId}/{semesterId}",
          manage: true,
        } as const;
    }
  });

export const PlacementsApiHandlers = (input: { now?: () => string }) => {
  /**
   * Answers one read from a repeatable-read snapshot; every check runs inside it.
   */
  const read = (request: Request, mode: "scopes" | "own" | "board" | "ownCoverage" | "coverage") =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const placements = yield* Placements;
          yield* Database.use(
            (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );

          if (mode === "scopes") {
            yield* requireNoQuery(request);

            const auth = yield* authorize(
              request,
              ListPlacementScopesEndpoint,
              null,
              false,
              input.now,
            );

            return json(
              yield* strictOutput(PlacementScopes)(yield* placements.listScopes(auth.authority)),
            );
          }

          if (mode === "own") {
            const scope = yield* decodeRequest(AffiliationScope)(
              yield* query(request, "affiliation"),
            );

            const auth = yield* authorize(
              request,
              ReadOwnAffiliationEndpoint,
              scope.departmentId,
              false,
              input.now,
            );

            return json(
              yield* strictOutput(OwnAffiliationResource)(
                resource(
                  yield* placements.readOwnAffiliation(auth.authority.personId, scope.departmentId),
                ),
              ),
            );
          }

          const scope = yield* decodeRequest(PlacementScope)(yield* query(request, "scope"));

          if (mode === "board") {
            yield* authorize(
              request,
              ReadPlacementBoardEndpoint,
              scope.departmentId,
              true,
              input.now,
            );

            return json(
              yield* strictOutput(PlacementBoardResource)(
                resource(yield* placements.readBoard(scope)),
              ),
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
              yield* strictOutput(OwnCoverageResource)(
                resource(yield* placements.readOwnCoverage(scope, auth.authority.personId)),
              ),
            );
          }

          yield* authorize(request, ReadCoverageBoardEndpoint, scope.departmentId, true, input.now);

          return json(
            yield* strictOutput(CoverageBoardResource)(
              resource(yield* placements.readCoverageBoard(scope)),
            ),
          );
        }),
      ),
    ).pipe(placementProblems, authorityProblems(personPresentation(request)), snapshotProblems);

  const mutate = (request: Request, mode: MutationSelection["mode"]) =>
    Effect.gen(function* () {
      const body = yield* readJsonBody(request, /^\s*application\/json\s*(?:;|$)/u, 8192);
      const selected = yield* selectionForMutation(request, body, mode);
      const ifMatch = yield* requiredIfMatchOf(request);
      const key = yield* idempotencyKeyOf(request);

      // Domain and credential failures are mapped after the executor, whose retry reads their causes.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const auth = yield* authorize(
            request,
            selected.endpoint,
            selected.scope.departmentId,
            selected.manage,
            input.now,
          );

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: selected.operationId,
            normalizedTarget: normalizeTarget(selected.target, selected.scope),
            idempotencyKey: key,
          });

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
                  (current) => requireCurrentETag(resource(current).etag, ifMatch),
                ),
              );

              return yield* Effect.promise(() => responseCapsule(json(changed, changed.etag)));
            }),
          };
        }),
        { retry: "serialization-once" },
      ).pipe(
        placementProblems,
        commandReceiptProblems,
        authorityProblems(personPresentation(request)),
      );

      return yield* commandOutcomeResponse(outcome);
    });

  return HttpApiBuilder.group(ExternalNativeApi, "placements", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) =>
          webHandler(request, (webRequest) => read(webRequest, "scopes")),
        )
        .handleRaw("readOwnAffiliation", ({ request }) =>
          webHandler(request, (webRequest) => read(webRequest, "own")),
        )
        .handleRaw("readBoard", ({ request }) =>
          webHandler(request, (webRequest) => read(webRequest, "board")),
        )
        .handleRaw("readOwnCoverage", ({ request }) =>
          webHandler(request, (webRequest) => read(webRequest, "ownCoverage")),
        )
        .handleRaw("readCoverageBoard", ({ request }) =>
          webHandler(request, (webRequest) => read(webRequest, "coverage")),
        )
        .handleRaw("commandOwnAffiliation", ({ request }) =>
          webHandler(request, (webRequest) => mutate(webRequest, "affiliation")),
        )
        .handleRaw("commandBoard", ({ request }) =>
          webHandler(request, (webRequest) => mutate(webRequest, "board")),
        )
        .handleRaw("commandOwnCoverage", ({ request }) =>
          webHandler(request, (webRequest) => mutate(webRequest, "ownCoverage")),
        )
        .handleRaw("commandCoverageBoard", ({ request }) =>
          webHandler(request, (webRequest) => mutate(webRequest, "coverage")),
        ),
    ),
  );
};
