/** Content HTTP failure classification and native problem responses. */
import { ContentAuthorityInactive, ContentNotInScope } from "@vektorprogrammet/domain/content";
import { Cause, Predicate } from "effect";
import { isSerializationConflict } from "../http-api/problem.js";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";

const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

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

/** Native problem mapping for staff content and public news endpoints. */
export const contentHttpErrorResponse = (cause: unknown): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

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
