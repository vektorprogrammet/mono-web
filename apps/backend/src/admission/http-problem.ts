/** Admission HTTP failure classification and JSON response helpers. */
import { InactiveActor, UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  isProblem,
  makeNativeValidationError,
  type NativeProblemCode,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Match, Predicate, type Schema } from "effect";
import { isSerializationConflict, problemWebResponse } from "../http-api/problem.js";
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

/** The closed Problem Details union that one admission endpoint declares. */
export interface AdmissionEndpointProblems {
  readonly members: ReadonlyArray<{
    readonly fields: {
      readonly code: { readonly literal: NativeProblemCode };
      readonly status: { readonly literal: number };
    };
  }>;
}

/**
 * The 503 problem an endpoint answers for a failure that no case classifies: its own
 * service problem when its union declares one, otherwise the dependency problem. The
 * idempotency problem names the receipt store only, so it is never the fallback.
 */
const unavailableProblem = (problems: AdmissionEndpointProblems) => {
  const unavailable = problems.members
    .map((member) => member.fields)
    .filter(
      (fields) =>
        fields.status.literal === 503 && fields.code.literal !== "idempotency.unavailable",
    );

  const fields =
    unavailable.find((candidate) => candidate.code.literal !== "dependency.unavailable") ??
    unavailable[0];

  if (fields === undefined)
    throw new Error("An admission endpoint declares no unavailable problem");

  return fields;
};

/** Classifies one admission failure; an unclassified failure answers `undefined`. */
const classifiedAdmissionFailure = (cause: unknown): Response | undefined => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  // A typed problem carries its own code; the registry renders its status and headers.
  if (isProblem(cause)) return problemWebResponse(cause);

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
      // A race still lost after the executor's one retry is a conflict, not an outage.
      Match.when(Predicate.isTagged("NativeHttpReceiptPersistenceError"), (failure) =>
        isSerializationConflict(failure)
          ? nativeProblemResponse("transaction.conflict", 409)
          : nativeProblemResponse("idempotency.unavailable", 503),
      ),
      // An invalid receipt identity or response capsule is a server defect.
      Match.when(Predicate.isTagged("NativeHttpReceiptInvalid"), () =>
        nativeProblemResponse("internal.error", 500),
      ),
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
      // The domain decodes the whole command, so the rejection names the whole body.
      return problemWebResponse(
        Problem.validation("validation.failed", [makeNativeValidationError("", "invalid")]),
      );
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
      return undefined;
  }
};

/** Native problem mapping for one admission endpoint, falling back to its own 503 problem. */
export const admissionHttpErrorResponse = (problems: AdmissionEndpointProblems) => {
  // The code and its status come from the same declared union member.
  const { code, status } = unavailableProblem(problems);

  return (cause: unknown): Response =>
    classifiedAdmissionFailure(cause) ?? nativeProblemResponse(code.literal, status.literal);
};
