/** Content HTTP failure classification and native problem responses. */
import { ContentAuthorityInactive, ContentNotInScope } from "@vektorprogrammet/domain/content";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Predicate } from "effect";
import { isSerializationConflict, problemWebResponse } from "../http-api/problem.js";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";

/** Keeps content-classified failures and wraps every other thrown value as unknown. */
export const knownContentFailure = (cause: unknown) =>
  cause instanceof HttpSemanticFailure ||
  cause instanceof ContentAuthorityInactive ||
  cause instanceof ContentNotInScope
    ? cause
    : new Cause.UnknownError(cause);

const errorTag = (cause: unknown): string | undefined =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isString(cause._tag)
    ? cause._tag
    : undefined;

/**
 * Native problem mapping for staff content and public news endpoints. A person
 * rejected after ingress is answered from the credential the request presented.
 */
export const contentHttpErrorResponse = (
  cause: unknown,
  presentation: CredentialPresentation,
): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  if (cause instanceof HttpSemanticFailure) {
    return cause.status === 401
      ? problemWebResponse(Problem.unauthenticated(presentation))
      : nativeProblemResponse(cause.code, cause.status);
  }

  switch (errorTag(cause)) {
    case "UnauthenticatedActor":
      return problemWebResponse(Problem.unauthenticated(presentation));
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return nativeProblemResponse("authority.denied", 403);
    case "ArticleNotFound":
      return nativeProblemResponse("content.article-not-found", 404);
    case "SlugConflict":
      return nativeProblemResponse("content.slug-conflict", 422);
    case "DepartmentNotFound":
      return nativeProblemResponse("content.department-not-found", 422);
    case "CommandConflict":
      return nativeProblemResponse("content.lifecycle-conflict", 409);
    case "ContentIntegrityError":
      return nativeProblemResponse("content.integrity-error", 500);
    case "ContentPersistenceError":
      return nativeProblemResponse("content.unavailable", 503);
    case "ContentDecodeError":
      return nativeProblemResponse("internal.error", 500);
    case "NativeHttpReceiptPersistenceError":
      return isSerializationConflict(cause)
        ? nativeProblemResponse("transaction.conflict", 409)
        : nativeProblemResponse("idempotency.unavailable", 503);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};
