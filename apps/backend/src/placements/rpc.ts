/**
 * The PlacementsRpcs handlers. A read answers from one repeatable-read snapshot that also resolves
 * the caller's credential and authority. A command resolves them again inside the serializable
 * transaction that commits it: a board or coverage-board change runs on the coordinator's
 * `DepartmentReach<"placements.coordinate">`, and a person's own affiliation or coverage runs as
 * that person. The `ifMatch` precondition is compared under the department lock, and the changed
 * snapshot is stored as the command's receipt.
 */
import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { DomainId, requireDepartmentReach, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  DepartmentId,
  OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  Placements,
  type PlacementExecution,
  type PlacementOperationFailure,
  type PlacementSnapshot,
} from "@vektorprogrammet/domain/placements";
import {
  CommandCoverageBoard,
  CommandOwnAffiliation,
  CommandOwnCoverage,
  CommandPlacementBoard,
  CoverageBoardResource,
  CoverageCommand,
  ListPlacementScopes,
  OwnAffiliationCommand,
  OwnAffiliationResource,
  OwnCoverageCommand,
  OwnCoverageResource,
  PlacementBoardResource,
  PlacementCommand,
  PlacementDraftResource,
  PlacementScopes,
  PlacementsRpcs,
  ReadCoverageBoard,
  ReadOwnAffiliation,
  ReadOwnCoverage,
  ReadPlacementBoard,
  ReadPlacementDraft,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Effect, Option, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  type OrganizationResolutionError,
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import {
  deriveStrongETag,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  isSerializationConflict,
  jsonText,
  personPresentation,
  problemMapper,
  requireCurrentETag,
  strictOutput,
} from "../rpc/problem.js";
import { executeNativeHttpCommandPostgres, successCapsule } from "../rpc/receipt-transaction.js";

/**
 * The one answer for every placement domain failure. Each failure carries the registry code it is
 * answered with.
 */
const placementProblems = problemMapper<PlacementOperationFailure>()({
  PlacementFailure: (failure) => Problem.make(failure.code),
  PlacementPersistenceError: (failure) => Problem.make(failure.code),
});

/**
 * A person credential or organization projection that fails inside the transaction. A projection
 * read that lost a serialization race is a conflict.
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

/** The snapshot transaction of a read: a lost serialization race is a conflict. */
const snapshotProblems = problemMapper<SqlError>()({
  SqlError: (failure) =>
    isSerializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("internal.error"),
});

/**
 * A snapshot with its strong tag. The tag versions the whole snapshot text, as the HTTP handler's
 * did, so a tag read before the cutover still names the same version.
 */
const resource = <A extends object>(body: A) =>
  Effect.map(jsonText(body), (text) => ({
    ...body,
    etag: deriveStrongETag({
      representationKind: "PlacementSnapshot",
      resourceIdentity: text,
      version: text,
    }),
  }));

type PlacementRpc =
  | typeof ListPlacementScopes
  | typeof ReadOwnAffiliation
  | typeof CommandOwnAffiliation
  | typeof ReadPlacementBoard
  | typeof CommandPlacementBoard
  | typeof ReadOwnCoverage
  | typeof CommandOwnCoverage
  | typeof ReadCoverageBoard
  | typeof CommandCoverageBoard
  | typeof ReadPlacementDraft;

/** The coordinator's reach over the department, which a board or coverage-board change requires. */
const requireCoordinator = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId | null,
) =>
  departmentId === null
    ? Effect.fail(Problem.make("authority.denied"))
    : Effect.fromResult(
        requireDepartmentReach(authority, "placements.coordinate", departmentId),
      ).pipe(Effect.mapError(() => Problem.make("authority.denied")));

/** Evaluates the RPC's AccessSpec for the resolved person in the department's scope. */
const evaluateAccess = (
  headers: Headers.Headers,
  rpc: PlacementRpc,
  departmentId: DepartmentId | null,
  auth: TransactionPersonAuthority,
) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(rpc)),
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
    personPresentation(headers),
  );

/** The encoded JSON of a decoded command: the body that the HTTP request digest covered. */
const jsonBody =
  <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
  (value: S["Type"]): Effect.Effect<Schema.Json> =>
    Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(Effect.orDie);

/** A changed snapshot, decoded strictly with the success schema of its command. */
const snapshotOutput =
  <S extends Schema.Codec<unknown, unknown, never, never>>(success: S) =>
  (snapshot: PlacementSnapshot & { readonly etag: StrongETag }): Effect.Effect<S["Type"]> =>
    Schema.decodeEffect(success)(snapshot, { onExcessProperty: "error" }).pipe(Effect.orDie);

/** One placement command: its receipt identity, its precondition, and how it is authorized. */
interface MutationPlan<S extends Schema.Codec<unknown, unknown, never, never>, E, R> {
  readonly operationId:
    | "placements.commandOwnAffiliation"
    | "placements.commandBoard"
    | "placements.commandOwnCoverage"
    | "placements.commandCoverageBoard";
  /** The route template that the HTTP handler filled as the normalized target. */
  readonly target: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  /** The command as the JSON body of the HTTP request, for the request digest. */
  readonly body: Effect.Effect<Schema.Json>;
  readonly success: S;
  /** Resolves the actor or the coordinator inside the transaction, and builds the execution. */
  readonly authorize: Effect.Effect<
    {
      readonly auth: TransactionPersonAuthority;
      readonly execution: (commandId: string) => PlacementExecution;
    },
    E,
    R
  >;
}

/** The PlacementsRpcs handlers. */
export const PlacementsRpcHandlers = (options: NativeRpcOptions) => {
  const personAuthority = (headers: Headers.Headers) =>
    resolveRequestPersonAuthorityInTransaction(credentialRequestOf(headers), {
      now: options.now,
    });

  /** Resolves the person, requires the coordinator's reach when `manage`, and evaluates access. */
  const authorize = (
    headers: Headers.Headers,
    rpc: PlacementRpc,
    departmentId: DepartmentId | null,
    manage: boolean,
  ) =>
    Effect.gen(function* () {
      const auth = yield* personAuthority(headers);

      if (manage) yield* requireCoordinator(auth.authority, departmentId);

      yield* evaluateAccess(headers, rpc, departmentId, auth);

      return auth;
    });

  /** Resolves the person, requires the coordinator's reach, and returns it as evidence. */
  const authorizeCoordinator = (
    headers: Headers.Headers,
    rpc: PlacementRpc,
    departmentId: DepartmentId,
  ) =>
    Effect.gen(function* () {
      const auth = yield* personAuthority(headers);
      const coordinator = yield* requireCoordinator(auth.authority, departmentId);
      yield* evaluateAccess(headers, rpc, departmentId, auth);

      return { auth, coordinator };
    });

  /** Answers one read from a repeatable-read snapshot; every check runs inside it. */
  const snapshotRead = <A, E, R>(headers: Headers.Headers, read: Effect.Effect<A, E, R>) =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

          return yield* read;
        }),
      ),
    ).pipe(placementProblems, authorityProblems(personPresentation(headers)), snapshotProblems);

  const mutate = <S extends Schema.Codec<unknown, unknown, never, never>, E, R>(
    headers: Headers.Headers,
    plan: MutationPlan<S, E, R>,
  ) =>
    Effect.gen(function* () {
      const body = yield* plan.body;

      // Domain and credential failures are mapped after the executor, whose retry reads their causes.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const { auth, execution } = yield* plan.authorize;

          // The HTTP target stays the normalized target, so receipts and command IDs are stable.
          const identity = yield* commandIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: plan.operationId,
            normalizedTarget: normalizeTarget(plan.target, plan.scope),
            idempotencyKey: plan.idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, plan.ifMatch)),
              operationId: plan.operationId,
            },
            execute: Effect.gen(function* () {
              const changed = yield* Placements.use((placements) =>
                placements.execute(execution(identity.identitySha256), (current) =>
                  Effect.flatMap(resource(current), (snapshot) =>
                    requireCurrentETag(snapshot.etag, plan.ifMatch),
                  ),
                ),
              );

              const answer = yield* snapshotOutput(plan.success)(yield* resource(changed));

              return yield* successCapsule(plan.success)(answer);
            }),
          };
        }),
        { retry: "serialization-once" },
      ).pipe(
        placementProblems,
        commandReceiptProblems,
        authorityProblems(personPresentation(headers)),
      );

      return yield* commandOutcome(plan.success)(outcome);
    });

  return PlacementsRpcs.toLayer({
    "placements.listScopes": (_payload, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const auth = yield* authorize(headers, ListPlacementScopes, null, false);

          const scopes = yield* Placements.use((placements) =>
            placements.listScopes(auth.authority),
          );

          return yield* strictOutput(PlacementScopes)(scopes);
        }),
      ),

    "placements.readOwnAffiliation": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const auth = yield* authorize(headers, ReadOwnAffiliation, scope.departmentId, false);

          const affiliation = yield* Placements.use((placements) =>
            placements.readOwnAffiliation(auth.authority.personId, scope.departmentId),
          );

          return yield* strictOutput(OwnAffiliationResource)(yield* resource(affiliation));
        }),
      ),

    "placements.readBoard": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          yield* authorize(headers, ReadPlacementBoard, scope.departmentId, true);

          const board = yield* Placements.use((placements) => placements.readBoard(scope));

          return yield* strictOutput(PlacementBoardResource)(yield* resource(board));
        }),
      ),

    "placements.readDraft": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          yield* authorize(headers, ReadPlacementDraft, scope.departmentId, true);

          // One snapshot: the draft is drafted from exactly the board version it names.
          const board = yield* resource(
            yield* Placements.use((placements) => placements.readBoard(scope)),
          );

          const draft = yield* Placements.use((placements) => placements.readDraft(scope));

          return yield* strictOutput(PlacementDraftResource)({ ...draft, boardEtag: board.etag });
        }),
      ),

    "placements.readOwnCoverage": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const auth = yield* authorize(headers, ReadOwnCoverage, scope.departmentId, false);

          const coverage = yield* Placements.use((placements) =>
            placements.readOwnCoverage(scope, auth.authority.personId),
          );

          return yield* strictOutput(OwnCoverageResource)(yield* resource(coverage));
        }),
      ),

    "placements.readCoverageBoard": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          yield* authorize(headers, ReadCoverageBoard, scope.departmentId, true);

          const board = yield* Placements.use((placements) => placements.readCoverageBoard(scope));

          return yield* strictOutput(CoverageBoardResource)(yield* resource(board));
        }),
      ),

    // A person's own affiliation runs as that person.
    "placements.commandOwnAffiliation": (
      { departmentId, idempotencyKey, ifMatch, request },
      { headers },
    ) =>
      mutate(headers, {
        operationId: "placements.commandOwnAffiliation",
        target: "/api/placements/affiliation/{departmentId}",
        scope: { departmentId },
        idempotencyKey,
        ifMatch,
        body: jsonBody(OwnAffiliationCommand)(request),
        success: OwnAffiliationResource,
        authorize: authorize(headers, CommandOwnAffiliation, departmentId, false).pipe(
          Effect.map((auth) => ({
            auth,
            execution: (commandId: string): PlacementExecution => ({
              mutation: { mode: "affiliation", scope: { departmentId }, command: request },
              actor: auth.authority.personId,
              now: auth.authorizationInstant,
              commandId,
            }),
          })),
        ),
      }),

    // A board change runs on the coordinator's reach over the department.
    "placements.commandBoard": (
      { departmentId, semesterId, idempotencyKey, ifMatch, request },
      { headers },
    ) =>
      mutate(headers, {
        operationId: "placements.commandBoard",
        target: "/api/placements/{departmentId}/{semesterId}",
        scope: { departmentId, semesterId },
        idempotencyKey,
        ifMatch,
        body: jsonBody(PlacementCommand)(request),
        success: PlacementBoardResource,
        authorize: authorizeCoordinator(headers, CommandPlacementBoard, departmentId).pipe(
          Effect.map(({ auth, coordinator }) => ({
            auth,
            execution: (commandId: string): PlacementExecution => ({
              mutation: { mode: "board", scope: { departmentId, semesterId }, command: request },
              coordinator,
              now: auth.authorizationInstant,
              commandId,
            }),
          })),
        ),
      }),

    // A person's own coverage runs as that person.
    "placements.commandOwnCoverage": (
      { departmentId, semesterId, idempotencyKey, ifMatch, request },
      { headers },
    ) =>
      mutate(headers, {
        operationId: "placements.commandOwnCoverage",
        target: "/api/placements/coverage/own/{departmentId}/{semesterId}",
        scope: { departmentId, semesterId },
        idempotencyKey,
        ifMatch,
        body: jsonBody(OwnCoverageCommand)(request),
        success: OwnCoverageResource,
        authorize: authorize(headers, CommandOwnCoverage, departmentId, false).pipe(
          Effect.map((auth) => ({
            auth,
            execution: (commandId: string): PlacementExecution => ({
              mutation: {
                mode: "ownCoverage",
                scope: { departmentId, semesterId },
                command: request,
              },
              actor: auth.authority.personId,
              now: auth.authorizationInstant,
              commandId,
            }),
          })),
        ),
      }),

    // A coverage-board change runs on the coordinator's reach over the department.
    "placements.commandCoverageBoard": (
      { departmentId, semesterId, idempotencyKey, ifMatch, request },
      { headers },
    ) =>
      mutate(headers, {
        operationId: "placements.commandCoverageBoard",
        target: "/api/placements/coverage/{departmentId}/{semesterId}",
        scope: { departmentId, semesterId },
        idempotencyKey,
        ifMatch,
        body: jsonBody(CoverageCommand)(request),
        success: CoverageBoardResource,
        authorize: authorizeCoordinator(headers, CommandCoverageBoard, departmentId).pipe(
          Effect.map(({ auth, coordinator }) => ({
            auth,
            execution: (commandId: string): PlacementExecution => ({
              mutation: { mode: "coverage", scope: { departmentId, semesterId }, command: request },
              coordinator,
              now: auth.authorizationInstant,
              commandId,
            }),
          })),
        ),
      }),
  });
};
