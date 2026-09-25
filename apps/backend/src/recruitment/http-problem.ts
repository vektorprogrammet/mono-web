/** Recruitment HTTP failure classification and native problem responses. */
import { Cause, Predicate } from "effect";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";

const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

/** Keeps HTTP semantic failures and wraps every other thrown value as unknown. */
export const knownRecruitmentFailure = (cause: unknown) =>
  cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause);

export const errorTag = (cause: unknown): string | undefined =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isString(cause._tag)
    ? cause._tag
    : undefined;

/** Native problem mapping for recruitment endpoints. */
export const recruitmentHttpErrorResponse = (
  cause: unknown,
  unavailableCode: "recruitment.unavailable" | "dependency.unavailable" = "dependency.unavailable",
): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  const sqlCode = (cause: unknown, depth = 0): string | undefined =>
    depth < 8 && (cause === null || Predicate.isObjectOrArray(cause)) && cause !== null
      ? "code" in cause && Predicate.isString(cause.code)
        ? cause.code
        : "cause" in cause
          ? sqlCode(cause.cause, depth + 1)
          : undefined
      : undefined;

  const code = sqlCode(cause);

  if (code === "40001" || code === "40P01")
    return nativeProblemResponse("transaction.conflict", 409);

  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(
      cause.code,
      cause.status,
      cause.status === 401 ? { "www-authenticate": PERSON_CHALLENGE } : undefined,
    );
  }

  switch (errorTag(cause)) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": PERSON_CHALLENGE,
      });
    case "InactiveActor":
    case "RecruitmentInactiveActor":
    case "RecruitmentRoleDenied":
    case "RecruitmentScopeDenied":
    case "RecruitmentInterviewerNotEligible":
      return nativeProblemResponse("authority.denied", 403);
    case "RecruitmentAdmissionPeriodNotFound":
      return nativeProblemResponse("recruitment.admission-period-not-found", 404);
    case "RecruitmentAmbiguousAdmissionPeriod":
      return nativeProblemResponse("application.ambiguous-period", 409);
    case "RecruitmentApplicationNotFound":
      return nativeProblemResponse("recruitment.application-not-found", 404);
    case "RecruitmentInterviewSchemaNotFound":
      return nativeProblemResponse("recruitment.interview-schema-not-found", 404);
    case "RecruitmentApplicationAlreadyAssigned":
      return nativeProblemResponse("recruitment.application-already-assigned", 409);
    case "RecruitmentInterviewSchemaInactive":
      return nativeProblemResponse("recruitment.interview-schema-inactive", 422);
    case "RecruitmentInterviewNotFound":
      return nativeProblemResponse("recruitment.interview-not-found", 404);
    case "RecruitmentInterviewAlreadyScheduled":
      return nativeProblemResponse("recruitment.already-scheduled", 409);
    case "RecruitmentInterviewStaleRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "RecruitmentScheduleInPast":
      return nativeProblemResponse("recruitment.schedule-in-past", 422);
    case "RecruitmentInvitationNotFound":
      return nativeProblemResponse("resource.not-found", 404);
    case "RecruitmentInvitationAlreadyResponded":
      return nativeProblemResponse("invitation.already-responded", 409);
    case "RecruitmentInterviewAlreadyFinalized":
      return nativeProblemResponse("recruitment.already-finalized", 409);
    case "RecruitmentInterviewAlreadyCancelled":
      return nativeProblemResponse("recruitment.already-cancelled", 409);
    case "RecruitmentInterviewNotScheduled":
      return nativeProblemResponse("recruitment.interview-not-scheduled", 409);
    case "RecruitmentInvitationNotAccepted":
      return nativeProblemResponse("recruitment.invitation-not-accepted", 409);
    case "RecruitmentConductValidationError":
      return nativeProblemResponse("recruitment.conduct-invalid", 422);
    case "RecruitmentAssignmentCommandConflict":
    case "RecruitmentScheduleCommandConflict":
    case "RecruitmentLifecycleCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    case "RecruitmentPersistenceError":
    case "InterviewQuestionsUnavailable":
    case "ProfileContactNotFound":
      return nativeProblemResponse(unavailableCode, 503);
    case "RecruitmentDecodeError":
    case "RecruitmentInvalidContext":
    case "NativeHttpReceiptInvalid":
      return nativeProblemResponse("internal.error", 500);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};
