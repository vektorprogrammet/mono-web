/**
 * Admissions: admission periods, public applications, applicant progress, and returning
 * assistants.
 *
 * @since 0.3.0
 */
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  ApplicantProgressItemSchema,
  ApplicantProgressResponseSchema,
  ApplicantProgressStateSchema,
  PublicApplicationCatalogSchema,
  PublicApplicationIdSchema,
  ReturningAssistantOptionsSchema,
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistantRegistrationResponseSchema,
  type ApplicantProgressItem,
  type ApplicantProgressResponse,
  type ApplicantProgressState,
} from "@vektorprogrammet/domain/application";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { anonymousNativeAccess, personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodManagementListResponse,
  AdmissionPeriodMergePatch,
  CreateAdmissionPeriodRequest,
  OpenAdmissionPeriodListResponse,
  PublicApplicationConfirmationSchema,
  SubmitApplicationRequest,
} from "./v2-schemas.js";

export {
  AdmissionPeriodId,
  ApplicantProgressItemSchema,
  ApplicantProgressResponseSchema,
  ApplicantProgressStateSchema,
  PublicApplicationCatalogSchema,
  PublicApplicationIdSchema,
  ReturningAssistantOptionsSchema,
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistantRegistrationResponseSchema,
};

export type { ApplicantProgressItem, ApplicantProgressResponse, ApplicantProgressState };

/** Problems of `admissions.listOpenAdmissionPeriods`. */
export const ListOpenAdmissionPeriodsProblem = problemUnion("ListOpenAdmissionPeriodsProblem", [
  "internal.error",
  "admissions.unavailable",
]);

/** Problems of `admissions.listApplicationOptions`. */
export const ListApplicationOptionsProblem = problemUnion("ListApplicationOptionsProblem", [
  "internal.error",
  "admissions.unavailable",
]);

/** Problems of `admissions.submitApplication`. */
export const SubmitApplicationProblem = problemUnion("SubmitApplicationProblem", [
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "validation.failed",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
  "application.no-eligible-period",
  "application.ambiguous-period",
  "application.duplicate",
  "application.invalid-field-of-study",
  "rate-limit.exceeded",
]);

/** Problems of `admissions.readApplicationConfirmation`. */
export const ReadApplicationConfirmationProblem = problemUnion(
  "ReadApplicationConfirmationProblem",
  ["internal.error", "application.not-found", "admissions.unavailable"],
);

/** Problems of `admissions.readApplicantProgress`. */
export const ReadApplicantProgressProblem = problemUnion("ReadApplicantProgressProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "admissions.unavailable",
]);

/** Problems of `admissions.listAdmissionPeriods`. */
export const ListAdmissionPeriodsProblem = problemUnion("ListAdmissionPeriodsProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "admissions.unavailable",
]);

/** Problems of `admissions.createAdmissionPeriod`. */
export const CreateAdmissionPeriodProblem = problemUnion("CreateAdmissionPeriodProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "validation.failed",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
  "admission-period.already-exists",
  "admission-period.invalid-window",
]);

/** Problems of `admissions.reviseAdmissionPeriod`. */
export const ReviseAdmissionPeriodProblem = problemUnion("ReviseAdmissionPeriodProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "validation.failed",
  "validation.no-change",
  "validation.field-not-deletable",
  "precondition.failed",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
  "admission-period.not-found",
  "admission-period.invalid-window",
]);

/** Problems of `admissions.readReturningAssistantOptions`. */
export const ReadReturningAssistantOptionsProblem = problemUnion(
  "ReadReturningAssistantOptionsProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "validation.failed",
    "returning.identity-missing",
    "returning.identity-ambiguous",
    "returning.history-missing",
    "returning.study-invalid",
    "returning.period-unavailable",
    "internal.error",
    "returning.unavailable",
  ],
);

/** Problems of `admissions.registerReturningAssistant`. */
export const RegisterReturningAssistantProblem = problemUnion("RegisterReturningAssistantProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "validation.failed",
  "returning.identity-missing",
  "returning.identity-ambiguous",
  "returning.history-missing",
  "returning.study-invalid",
  "returning.period-unavailable",
  "returning.team-scope-denied",
  "returning.revision-conflict",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
  "returning.unavailable",
]);

/** The currently open admission periods, for the public application form. */
export const ListOpenAdmissionPeriods = Rpc.make("admissions.listOpenAdmissionPeriods", {
  success: OpenAdmissionPeriodListResponse,
  error: rpcProblems(ListOpenAdmissionPeriodsProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("admissions.public-open-periods")));

/** The departments and fields of study open to applicants. */
export const ListApplicationOptions = Rpc.make("admissions.listApplicationOptions", {
  success: PublicApplicationCatalogSchema,
  error: rpcProblems(ListApplicationOptionsProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("admissions.public-application-options")));

/** Submits, or replays by its idempotency key, one public application. */
export const SubmitApplication = Rpc.make("admissions.submitApplication", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: SubmitApplicationRequest }),
  success: PublicApplicationConfirmationSchema,
  error: rpcProblems(SubmitApplicationProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("admissions.application-create", "Transaction")));

/** The public confirmation of one submitted application. */
export const ReadApplicationConfirmation = Rpc.make("admissions.readApplicationConfirmation", {
  payload: Schema.Struct({ applicationId: PublicApplicationIdSchema }),
  success: PublicApplicationConfirmationSchema,
  error: rpcProblems(ReadApplicationConfirmationProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("admissions.public-application-by-id")));

/** The current-semester recruitment progress of the signed-in applicant. */
export const ReadApplicantProgress = Rpc.make("admissions.readApplicantProgress", {
  success: ApplicantProgressResponseSchema,
  error: rpcProblems(ReadApplicantProgressProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "admissions.read-applicant-progress",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** The admission periods the caller manages; each item carries the tag that a revision names. */
export const ListAdmissionPeriods = Rpc.make("admissions.listAdmissionPeriods", {
  success: AdmissionPeriodManagementListResponse,
  error: rpcProblems(ListAdmissionPeriodsProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "admissions.read-periods",
        canonicalScopeResolver: "admissions.management-periods",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one admission period. */
export const CreateAdmissionPeriod = Rpc.make("admissions.createAdmissionPeriod", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateAdmissionPeriodRequest }),
  success: AdmissionPeriodManagementItem,
  error: rpcProblems(CreateAdmissionPeriodProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "admissions.create-period",
        canonicalScopeResolver: "admissions.period-create",
        decisionTime: "Transaction",
      }),
    ),
  );

/**
 * Revises, or replays by its idempotency key, the window of one admission period. `request` keeps
 * merge-patch semantics: an absent member keeps its value, an empty patch changes nothing, and a
 * null member would delete a field, which an admission period refuses.
 */
export const ReviseAdmissionPeriod = Rpc.make("admissions.reviseAdmissionPeriod", {
  payload: Schema.Struct({
    admissionPeriodId: AdmissionPeriodId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: AdmissionPeriodMergePatch,
  }),
  success: AdmissionPeriodManagementItem,
  error: rpcProblems(ReviseAdmissionPeriodProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "admissions.revise-period",
        canonicalScopeResolver: "admissions.period-by-id",
        decisionTime: "Transaction",
      }),
    ),
  );

/** The identity, placement, department, and admission-period options of a returning assistant. */
export const ReadReturningAssistantOptions = Rpc.make("admissions.readReturningAssistantOptions", {
  success: ReturningAssistantOptionsSchema,
  error: rpcProblems(ReadReturningAssistantOptionsProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "placements.self",
        canonicalScopeResolver: "profile.current-person",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Registers, or replays by its idempotency key, a returning assistant for an admission period. */
export const RegisterReturningAssistant = Rpc.make("admissions.registerReturningAssistant", {
  payload: Schema.Struct({
    idempotencyKey: IdempotencyKey,
    request: ReturningAssistantRegistrationInputSchema,
  }),
  success: ReturningAssistantRegistrationResponseSchema,
  error: rpcProblems(RegisterReturningAssistantProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "placements.self",
        canonicalScopeResolver: "profile.current-person",
        decisionTime: "Transaction",
      }),
    ),
  );

export class AdmissionsRpcs extends RpcGroup.make(
  ListOpenAdmissionPeriods,
  ListApplicationOptions,
  SubmitApplication,
  ReadApplicationConfirmation,
  ReadApplicantProgress,
  ListAdmissionPeriods,
  CreateAdmissionPeriod,
  ReviseAdmissionPeriod,
  ReadReturningAssistantOptions,
  RegisterReturningAssistant,
) {}
