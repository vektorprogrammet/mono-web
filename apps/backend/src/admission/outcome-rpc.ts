/**
 * The AdmissionOutcomesRpcs handlers. A read runs in one repeatable-read snapshot that also
 * resolves the caller's credential and authority. A record resolves them inside the serializable
 * transaction that commits it, takes the department's `admissions.outcomes` reach as evidence, and
 * stores its success as a command receipt.
 */
import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Admissions,
  admissionOutcomePermission,
  onCallSubstitutes,
  type AdmissionOutcomeEntry,
  type AdmissionOutcomeOperationFailure,
} from "@vektorprogrammet/domain/admissions";
import { requireDepartmentReach, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { OrganizationPersistenceError } from "@vektorprogrammet/domain/organization";
import {
  AdmissionOutcomeBoardResource,
  AdmissionOutcomeResource,
  AdmissionOutcomeScopes,
  AdmissionOutcomesRpcs,
  ListAdmissionOutcomeScopes,
  ReadAdmissionOutcome,
  ReadAdmissionOutcomes,
  RecordAdmissionOutcome,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Option } from "effect";
import type { Headers } from "effect/unstable/http";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
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

/** One entry with its tag; the tag versions the whole entry, as the HTTP representation did. */
const outcomeResource = (entry: AdmissionOutcomeEntry) =>
  Effect.map(jsonText(entry), (version) => ({
    ...entry,
    etag: deriveStrongETag({
      representationKind: "AdmissionOutcomeResource",
      resourceIdentity: entry.applicationId,
      version,
    }),
  }));

/** A lost serialization or deadlock race may be retried; any other storage failure may not. */
const persistenceProblem = (failure: OrganizationPersistenceError | SqlError) =>
  isSerializationConflict(failure)
    ? Problem.make("transaction.conflict")
    : Problem.make("internal.error");

/**
 * The one answer for every admission outcome and person-authority failure. A person credential
 * rejected inside the transaction is answered from the request's credential headers.
 */
const outcomeProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | AdmissionOutcomeOperationFailure
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationResolutionError
  >()({
    AdmissionOutcomeFailure: (failure) => Problem.make(failure.code),
    AdmissionOutcomePersistenceError: (failure) => Problem.make(failure.code),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: persistenceProblem,
  });

type OutcomeRpc =
  | typeof ListAdmissionOutcomeScopes
  | typeof ReadAdmissionOutcomes
  | typeof ReadAdmissionOutcome
  | typeof RecordAdmissionOutcome;

/**
 * Grants the department's admission outcome permission, then evaluates the declared AccessSpec.
 */
const authorize = (
  headers: Headers.Headers,
  rpc: OutcomeRpc,
  departmentId: AdmissionOutcomeEntry["departmentId"],
  decide: boolean,
  auth: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const permission = admissionOutcomePermission(auth.authority, departmentId);

    if (permission === "Denied" || (decide && permission !== "Decide"))
      return yield* Problem.make("authority.denied");

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(rpc)),
        credential: auth.credential,
        personId: auth.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "admissions",
              departmentId,
              authorityVersion: auth.authorizationInstant,
            }),
          ],
        },
        grantScopes: [Scope.Department({ departmentId })],
        now: auth.authorizationInstant,
      },
      personPresentation(headers),
    );

    return permission;
  });

/** The AdmissionOutcomesRpcs handlers. */
export const AdmissionOutcomesRpcHandlers = (options: NativeRpcOptions) => {
  const personAuthority = (headers: Headers.Headers) =>
    resolveRequestPersonAuthorityInTransaction(credentialRequestOf(headers), {
      now: options.now,
    });

  /**
   * Runs one read in a REPEATABLE READ snapshot, which resolves the credential and authority on
   * the same connection, and answers its failures.
   */
  const snapshotRead = <A, E, R>(headers: Headers.Headers, effect: Effect.Effect<A, E, R>) =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

          return yield* effect;
        }),
      ),
    ).pipe(
      Effect.catchIf(isSqlError, (failure) => Effect.fail(persistenceProblem(failure))),
      outcomeProblems(personPresentation(headers)),
    );

  return AdmissionOutcomesRpcs.toLayer({
    "admissionOutcomes.listScopes": (_payload, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const auth = yield* personAuthority(headers);

          const scopes = yield* Admissions.use((admissions) =>
            admissions.listAdmissionOutcomeScopes(auth.authority),
          );

          for (const department of scopes.departments)
            yield* authorize(
              headers,
              ListAdmissionOutcomeScopes,
              department.departmentId,
              false,
              auth,
            );

          return yield* strictOutput(AdmissionOutcomeScopes)(scopes);
        }),
      ),

    "admissionOutcomes.readOutcomes": (scope, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const auth = yield* personAuthority(headers);

          const permission = yield* authorize(
            headers,
            ReadAdmissionOutcomes,
            scope.departmentId,
            false,
            auth,
          );

          const { admissionPeriodId, entries } = yield* Admissions.use((admissions) =>
            admissions.readAdmissionOutcomes(scope),
          );

          return yield* strictOutput(AdmissionOutcomeBoardResource)(
            permission === "Decide"
              ? AdmissionOutcomeBoardResource.cases.Decide.make({
                  departmentId: scope.departmentId,
                  semesterId: scope.semesterId,
                  admissionPeriodId,
                  entries: yield* Effect.forEach(entries, outcomeResource),
                })
              : AdmissionOutcomeBoardResource.cases.ReadOnly.make({
                  departmentId: scope.departmentId,
                  semesterId: scope.semesterId,
                  admissionPeriodId,
                  substitutes: onCallSubstitutes(entries),
                }),
          );
        }),
      ),

    "admissionOutcomes.readOutcome": ({ applicationId }, { headers }) =>
      snapshotRead(
        headers,
        Effect.gen(function* () {
          const entry = yield* Admissions.use((admissions) =>
            admissions.readAdmissionOutcome(applicationId),
          );

          const auth = yield* personAuthority(headers);
          yield* authorize(headers, ReadAdmissionOutcome, entry.departmentId, true, auth);

          return yield* strictOutput(AdmissionOutcomeResource)(yield* outcomeResource(entry));
        }),
      ),

    "admissionOutcomes.recordOutcome": (
      { applicationId, idempotencyKey, ifMatch, request: command },
      { headers },
    ) =>
      Effect.gen(function* () {
        const operationId = "admissionOutcomes.recordOutcome";

        // Failures are answered after the executor, which rolls the whole command back on any of them.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const selected = yield* Admissions.use((admissions) =>
              admissions.readAdmissionOutcome(applicationId),
            );

            const auth = yield* personAuthority(headers);

            // Deciding needs the department's reach; the command takes it as evidence.
            const decider = yield* Effect.fromResult(
              requireDepartmentReach(auth.authority, "admissions.outcomes", selected.departmentId),
            ).pipe(Effect.mapError(() => Problem.make("authority.denied")));

            yield* authorize(headers, RecordAdmissionOutcome, selected.departmentId, false, auth);

            // The HTTP route stays the normalized target, so receipts and command IDs are stable.
            const identity = yield* commandIdentity({
              credentialSubject: `Person:${auth.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: normalizeTarget("/api/admission-outcomes/{applicationId}:record", {
                applicationId,
              }),
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest(
                  semanticMutationRequest({ outcome: command.outcome }, ifMatch),
                ),
                operationId,
              },
              execute: Admissions.use((admissions) =>
                admissions.recordAdmissionOutcome(
                  { applicationId, command, decider, now: auth.authorizationInstant },
                  (current) =>
                    Effect.flatMap(outcomeResource(current), (resource) =>
                      requireCurrentETag(resource.etag, ifMatch),
                    ),
                ),
              ).pipe(
                Effect.flatMap(outcomeResource),
                Effect.flatMap(strictOutput(AdmissionOutcomeResource)),
                Effect.flatMap(successCapsule(AdmissionOutcomeResource)),
              ),
            };
          }),
        ).pipe(outcomeProblems(personPresentation(headers)), commandReceiptProblems);

        return yield* commandOutcome(AdmissionOutcomeResource)(outcome);
      }),
  });
};
