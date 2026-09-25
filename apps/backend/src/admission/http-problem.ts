/** Admission HTTP failure classification and JSON response helpers. */
import { InactiveActor, UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { makeNativeValidationError, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Match, Predicate, type Schema } from "effect";
import { problemWebResponse } from "../http-api/problem.js";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";

/** Keeps admission-classified failures and wraps every other thrown value as unknown. */
export const knownAdmissionFailure = (cause: unknown) =>
  cause instanceof HttpSemanticFailure ||
  cause instanceof InactiveActor ||
  cause instanceof UnauthenticatedActor
    ? cause
    : new Cause.UnknownError(cause);

export const jsonResponse = (body: Schema.Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const errorTag = (cause: unknown): string =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isString(cause._tag)
    ? cause._tag
    : "AdmissionPeriodPersistenceError";

/** Native problem mapping for admission and public application endpoints. */
export const admissionHttpErrorResponse = (cause: unknown): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  if (cause !== null && (cause === null || Predicate.isObjectOrArray(cause)) && "_tag" in cause) {
    const response = Match.value(cause).pipe(
      Match.when(Predicate.isTagged("NativeHttpReceiptInFlightError"), () => {
        return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptDigestConflictError"), () => {
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptExpiredError"), () => {
        return nativeProblemResponse("idempotency.response-expired", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptPersistenceError"), () => {
        return nativeProblemResponse("idempotency.unavailable", 503);
      }),
      Match.orElse(() => undefined),
    );

    if (response !== undefined) return response;
  }

  const tag = errorTag(cause);

  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "InactiveActor":
    case "AdmissionRoleDenied":
    case "AdmissionScopeDenied":
      return nativeProblemResponse("authority.denied", 403);
    case "AdmissionPeriodNotFound":
      return nativeProblemResponse("admission-period.not-found", 404);
    case "PublicApplicationNotFound":
      return nativeProblemResponse("application.not-found", 404);
    case "RequestBodyTooLarge":
      return nativeProblemResponse("request.too-large", 413);
    case "PublicApplicationRateLimitExceeded":
      return nativeProblemResponse("rate-limit.exceeded", 429, { "retry-after": "60" });
    case "PublicApplicationDecodeError":
    case "AdmissionPeriodDecodeError":
    case "ReturningAssistantDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "ReturningAssistantUnauthenticated":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "ReturningAssistantIdentityMissing":
      return nativeProblemResponse("returning.identity-missing", 404);
    case "ReturningAssistantHistoryMissing":
      return nativeProblemResponse("returning.history-missing", 404);
    case "ReturningAssistantIdentityAmbiguous":
      return nativeProblemResponse("returning.identity-ambiguous", 409);
    case "ReturningAssistantStudyMappingInvalid":
      return nativeProblemResponse("returning.study-invalid", 409);
    case "ReturningAssistantPeriodUnavailable":
      return nativeProblemResponse("returning.period-unavailable", 409);
    case "ReturningAssistantTeamScopeDenied":
      return nativeProblemResponse("returning.team-scope-denied", 403);
    case "ReturningAssistantDuplicate":
      return nativeProblemResponse("returning.period-unavailable", 409);
    case "ReturningAssistantRevisionConflict":
      return nativeProblemResponse("returning.revision-conflict", 412);
    case "ReturningAssistantCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "ReturningAssistantPersistenceError":
      return nativeProblemResponse("returning.unavailable", 503);
    case "DepartmentNotFound":
      // The frozen unions have no department code; an unknown department is an invalid value.
      return problemWebResponse(
        Problem.validation("validation.failed", [
          makeNativeValidationError("/departmentId", "invalid"),
        ]),
      );
    case "FieldOfStudyNotFound":
    case "FieldOfStudyInactive":
    case "FieldOfStudyDepartmentMismatch":
      return nativeProblemResponse("application.invalid-field-of-study", 422);
    case "InvalidAdmissionPeriodWindow":
    case "AdmissionWindowOutsideSemester":
      return nativeProblemResponse("admission-period.invalid-window", 422);
    case "NoEligibleAdmissionPeriod":
      return nativeProblemResponse("application.no-eligible-period", 409);
    case "AmbiguousAdmissionPeriod":
      return nativeProblemResponse("application.ambiguous-period", 409);
    case "DuplicatePublicApplication":
      return nativeProblemResponse("application.duplicate", 409);
    case "AdmissionPeriodAlreadyExists":
      return nativeProblemResponse("admission-period.already-exists", 409);
    case "StaleAdmissionPeriodRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "DuplicatePublicApplicationCommandConflict":
    case "DuplicateAdmissionPeriodCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    default:
      return nativeProblemResponse("admissions.unavailable", 503);
  }
};
