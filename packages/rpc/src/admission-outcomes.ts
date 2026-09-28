/**
 * Admission outcomes: the recorded outcome of each application, and the substitutes on call whom
 * department members contact to arrange cover.
 *
 * @since 0.3.0
 */
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeEntry,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  OnCallSubstitute,
} from "@vektorprogrammet/domain/admissions";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";

export {
  AdmissionOutcomeCommand,
  AdmissionOutcomeEntry,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  OnCallSubstitute,
};

/** One application's outcome entry, with the tag that a later record names as `ifMatch`. */
export const AdmissionOutcomeResource = Schema.Struct({
  ...AdmissionOutcomeEntry.fields,
  etag: StrongETag,
}).annotate({ identifier: "AdmissionOutcomeResource" });

export type AdmissionOutcomeResource = typeof AdmissionOutcomeResource.Type;

const BoardFields = {
  ...AdmissionOutcomeScope.fields,
  admissionPeriodId: Schema.NullOr(AdmissionPeriodId),
};

/** Admission management sees every application; other department members see substitutes on call. */
export const AdmissionOutcomeBoardResource = Schema.TaggedUnion({
  ReadOnly: { ...BoardFields, substitutes: Schema.Array(OnCallSubstitute) },
  Decide: { ...BoardFields, entries: Schema.Array(AdmissionOutcomeResource) },
}).annotate({ identifier: "AdmissionOutcomeBoardResource" });

export type AdmissionOutcomeBoardResource = typeof AdmissionOutcomeBoardResource.Type;

const admissionOutcomeProblems = [
  "credential.missing",
  "credential.invalid",
  "validation.failed",
  "scope.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
] as const;

/** Problems of the admission outcome reads. */
export const AdmissionOutcomeProblem = problemUnion(
  "AdmissionOutcomeProblem",
  admissionOutcomeProblems,
);

/** A record also answers an unavailable receipt store. */
export const AdmissionOutcomeCommandProblem = problemUnion("AdmissionOutcomeCommandProblem", [
  ...admissionOutcomeProblems,
  "idempotency.unavailable",
]);

const access = (decide: boolean) =>
  personNativeAccess({
    capability: decide ? "admissions.outcomes.decide" : "admissions.outcomes.read",
    canonicalScopeResolver: "admissions.application-outcomes",
    decisionTime: decide ? "Transaction" : "SnapshotRead",
  });

/** The authorized departments and canonical historical semesters. */
export const ListAdmissionOutcomeScopes = Rpc.make("admissionOutcomes.listScopes", {
  success: AdmissionOutcomeScopes,
  error: rpcProblems(AdmissionOutcomeProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(access(false)));

/**
 * Admission management reads every application of the period; other department members read the
 * name and contact of each substitute on call.
 */
export const ReadAdmissionOutcomes = Rpc.make("admissionOutcomes.readOutcomes", {
  payload: AdmissionOutcomeScope,
  success: AdmissionOutcomeBoardResource,
  error: rpcProblems(AdmissionOutcomeProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(access(false)));

/** Only admission management reads one application's outcome entry. */
export const ReadAdmissionOutcome = Rpc.make("admissionOutcomes.readOutcome", {
  payload: Schema.Struct({ applicationId: PublicApplicationIdSchema }),
  success: AdmissionOutcomeResource,
  error: rpcProblems(AdmissionOutcomeProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(access(false)));

/**
 * Records Admitted, Substitute, or Rejected, or replays by its idempotency key. Recording the
 * current outcome again changes nothing.
 */
export const RecordAdmissionOutcome = Rpc.make("admissionOutcomes.recordOutcome", {
  payload: Schema.Struct({
    applicationId: PublicApplicationIdSchema,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: AdmissionOutcomeCommand,
  }),
  success: AdmissionOutcomeResource,
  error: rpcProblems(AdmissionOutcomeCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(access(true)));

export class AdmissionOutcomesRpcs extends RpcGroup.make(
  ListAdmissionOutcomeScopes,
  ReadAdmissionOutcomes,
  ReadAdmissionOutcome,
  RecordAdmissionOutcome,
) {}
