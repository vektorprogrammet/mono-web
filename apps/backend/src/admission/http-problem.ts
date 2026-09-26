/** Admission problems: the one declared answer for every admission failure. */
import type { AdmissionPeriodFailure } from "@vektorprogrammet/domain/admission-period";
import type {
  PublicApplicationError,
  ReturningAssistantError,
} from "@vektorprogrammet/domain/application";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import { makeNativeValidationError, Problem } from "@vektorprogrammet/http-api/http-semantics";
import type { OrganizationResolutionError } from "../authority.js";
import { personPresentation, problemMapper, requestInvalid } from "../http-api/problem.js";

/** Public applications answer a spent rate limit with one fixed delay. */
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * The one answer for every admission failure. A failed dependency answers the
 * endpoint's own unavailable problem, and a rejected credential answers from
 * the request's credential evidence.
 *
 * @construct http-problem
 */
export const admissionProblems = <
  Unavailable extends "admissions.unavailable" | "dependency.unavailable" | "returning.unavailable",
>(
  request: Request,
  unavailable: Unavailable,
) => {
  const presentation = personPresentation(request);

  return problemMapper<
    | AdmissionPeriodFailure
    | PublicApplicationError
    | ReturningAssistantError
    | IdentityEngineError
    | OrganizationResolutionError
  >()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    ReturningAssistantUnauthenticated: () => Problem.unauthenticated(presentation),
    InactiveActor: () => Problem.make("authority.denied"),
    AdmissionRoleDenied: () => Problem.make("authority.denied"),
    AdmissionScopeDenied: () => Problem.make("authority.denied"),
    // The domain decodes the whole command, so the rejection names the whole body.
    AdmissionPeriodDecodeError: requestInvalid,
    PublicApplicationDecodeError: requestInvalid,
    ReturningAssistantDecodeError: requestInvalid,
    // The frozen unions have no department or semester code; an unknown one is an invalid value.
    DepartmentNotFound: () =>
      Problem.validation("validation.failed", [
        makeNativeValidationError("/departmentId", "invalid"),
      ]),
    SemesterNotFound: () =>
      Problem.validation("validation.failed", [
        makeNativeValidationError("/semesterId", "invalid"),
      ]),
    DepartmentRequired: () =>
      Problem.validation("validation.failed", [
        makeNativeValidationError("/departmentId", "missing"),
      ]),
    AdmissionPeriodNotFound: () => Problem.make("admission-period.not-found"),
    InvalidAdmissionPeriodWindow: () => Problem.make("admission-period.invalid-window"),
    AdmissionWindowOutsideSemester: () => Problem.make("admission-period.invalid-window"),
    AdmissionPeriodAlreadyExists: () => Problem.make("admission-period.already-exists"),
    StaleAdmissionPeriodRevision: () => Problem.make("precondition.failed"),
    DuplicateAdmissionPeriodCommandConflict: () => Problem.make("idempotency.digest-conflict"),
    NoEligibleAdmissionPeriod: () => Problem.make("application.no-eligible-period"),
    AmbiguousAdmissionPeriod: () => Problem.make("application.ambiguous-period"),
    FieldOfStudyNotFound: () => Problem.make("application.invalid-field-of-study"),
    FieldOfStudyInactive: () => Problem.make("application.invalid-field-of-study"),
    FieldOfStudyDepartmentMismatch: () => Problem.make("application.invalid-field-of-study"),
    DuplicatePublicApplication: () => Problem.make("application.duplicate"),
    DuplicatePublicApplicationCommandConflict: () => Problem.make("idempotency.digest-conflict"),
    PublicApplicationNotFound: () => Problem.make("application.not-found"),
    RequestBodyTooLarge: () => Problem.make("request.too-large"),
    PublicApplicationRateLimitExceeded: () => Problem.rateLimited(RATE_LIMIT_RETRY_AFTER_SECONDS),
    ReturningAssistantIdentityMissing: () => Problem.make("returning.identity-missing"),
    ReturningAssistantIdentityAmbiguous: () => Problem.make("returning.identity-ambiguous"),
    ReturningAssistantHistoryMissing: () => Problem.make("returning.history-missing"),
    ReturningAssistantStudyMappingInvalid: () => Problem.make("returning.study-invalid"),
    ReturningAssistantPeriodUnavailable: () => Problem.make("returning.period-unavailable"),
    ReturningAssistantDuplicate: () => Problem.make("returning.period-unavailable"),
    ReturningAssistantTeamScopeDenied: () => Problem.make("returning.team-scope-denied"),
    ReturningAssistantRevisionConflict: () => Problem.make("returning.revision-conflict"),
    ReturningAssistantCommandConflict: () => Problem.make("idempotency.digest-conflict"),
    ReturningAssistantPersistenceError: () => Problem.make("returning.unavailable"),
    AdmissionPeriodPersistenceError: () => Problem.make(unavailable),
    PublicApplicationPersistenceError: () => Problem.make(unavailable),
    PublicApplicationQueryLimitExceeded: () => Problem.make(unavailable),
    IdentityEngineError: () => Problem.make(unavailable),
    OrganizationDecodeError: () => Problem.make(unavailable),
    OrganizationPersistenceError: () => Problem.make(unavailable),
  });
};

/**
 * Problems only a public application submission answers. The catalog, a
 * confirmation, and applicant progress read rows at the clock's own instant.
 */
export const submissionProblems = [
  "validation.failed",
  "application.no-eligible-period",
  "application.ambiguous-period",
  "application.invalid-field-of-study",
  "application.duplicate",
  "idempotency.digest-conflict",
  "request.too-large",
  "rate-limit.exceeded",
] as const;

/**
 * Problems only an admission period command answers. A listing reads
 * projections at the clock's own instant; it names no department, semester,
 * window, or command.
 */
export const periodCommandProblems = [
  "validation.failed",
  "admission-period.not-found",
  "admission-period.invalid-window",
  "admission-period.already-exists",
  "idempotency.digest-conflict",
] as const;
