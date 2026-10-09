/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
/** What the admission outcome handlers and the outcome template handlers share. */
import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { AdmissionOutcomeOperationFailure } from "@vektorprogrammet/domain/admissions";
import type {
  OutcomeMailRenderFailure,
  OutcomeTemplateFailure,
  OutcomeTemplatePersistenceError,
} from "@vektorprogrammet/domain/admissions/template";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { OrganizationPersistenceError } from "@vektorprogrammet/domain/organization";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Match } from "effect";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
import type { OrganizationResolutionError } from "../authority.js";
import {
  isSerializationConflict,
  jsonText,
  personPresentation,
  problemMapper,
  type ProblemCases,
} from "../http-api/problem.js";
import { PRIVATE_NO_STORE } from "../http-semantics.js";

/** The largest JSON body of an outcome command. */
export const MAX_MUTATION_BYTES = 8192;

/** A private, never stored JSON answer. */
export const outcomeJson = <A>(body: A) =>
  Effect.map(
    jsonText(body),
    (text) =>
      new Response(text, {
        headers: {
          "content-type": "application/json",
          "cache-control": PRIVATE_NO_STORE,
          vary: "Origin",
        },
      }),
  );

/** A lost serialization or deadlock race may be retried; any other storage failure may not. */
export const persistenceProblem = (failure: OrganizationPersistenceError | SqlError) =>
  isSerializationConflict(failure)
    ? Problem.make("transaction.conflict")
    : Problem.make("internal.error");

/**
 * Every failure of an admission outcome, outcome template and person-authority operation. A
 * person credential rejected inside the transaction is answered from the request's evidence.
 */
type OutcomeFailure =
  | AdmissionOutcomeOperationFailure
  | OutcomeTemplateFailure
  | OutcomeTemplatePersistenceError
  | OutcomeMailRenderFailure
  | UnauthenticatedActor
  | IdentityEngineError
  | OrganizationResolutionError;

const sharedCases = (presentation: CredentialPresentation) =>
  ({
    AdmissionOutcomePersistenceError: (failure) => Problem.make(failure.code),
    OutcomeTemplateFailure: (failure) => Problem.make(failure.code),
    OutcomeTemplatePersistenceError: (failure) => Problem.make(failure.code),
    OutcomeMailRenderFailure: () => Problem.make("internal.error"),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: persistenceProblem,
  }) satisfies Omit<ProblemCases<OutcomeFailure>, "AdmissionOutcomeFailure">;

/** The answer of a command: every refusal of the outcome policy has its code. */
export const outcomeProblems = (presentation: CredentialPresentation) =>
  problemMapper<OutcomeFailure>()({
    ...sharedCases(presentation),
    AdmissionOutcomeFailure: (failure) => Problem.make(failure.code),
  });

/**
 * The answer of a read. A read decides nothing, so a policy refusal from it is a defect of the
 * service, answered as internal.error and not declared in the read contract.
 */
export const outcomeReadProblems = (presentation: CredentialPresentation) =>
  problemMapper<OutcomeFailure>()({
    ...sharedCases(presentation),
    AdmissionOutcomeFailure: (failure) =>
      Match.value(failure.code).pipe(
        Match.when("authority.denied", (code) => Problem.make(code)),
        Match.when("resource.not-found", (code) => Problem.make(code)),
        Match.when("scope.invalid", (code) => Problem.make(code)),
        Match.orElse(() => Problem.make("internal.error")),
      ),
  });

/**
 * Runs one read in a REPEATABLE READ snapshot, which resolves the credential and authority on
 * the same connection, and answers its failures.
 */
export const outcomeSnapshotRead = <A, E, R>(request: Request, effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        return yield* effect;
      }),
    ),
  ).pipe(
    Effect.catchIf(isSqlError, (failure) => Effect.fail(persistenceProblem(failure))),
    outcomeReadProblems(personPresentation(request)),
  );
