/** Receipt HTTP failure classification and JSON response helpers. */
import { Cause, Predicate, type Schema } from "effect";
import {
  ReceiptDecodeError,
  ReceiptNotFound,
  ReceiptPersistenceError,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/receipt";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";

type ErrorBody = {
  readonly error: { readonly tag: string; readonly message?: string };
};

const COMPOSED_DENIAL_MESSAGES = {
  AmbiguousParameterFill: "Authorization parameter fill is ambiguous",
  FailedComposedRequirement: "Composed authorization requirement failed",
} as const;

/** Keeps receipt-classified failures and wraps every other thrown value as unknown. */
export const knownReceiptFailure = (cause: unknown) =>
  cause instanceof HttpSemanticFailure ||
  cause instanceof ReceiptDecodeError ||
  cause instanceof UnauthenticatedActor ||
  cause instanceof ReceiptNotFound ||
  cause instanceof ReceiptPersistenceError
    ? cause
    : new Cause.UnknownError(cause);

const failureTag = (cause: unknown, fallback: string): string =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isString(cause._tag)
    ? cause._tag
    : fallback;

export const jsonResponse = (
  body: Schema.Json,
  status = 200,
  cacheControl: "no-store" | "private, no-store" = "no-store",
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
    },
  });

export const privateJsonResponse = (body: Schema.Json, status = 200): Response => {
  const response = jsonResponse(body, status, "private, no-store");
  response.headers.set("vary", "Origin");

  return response;
};

/** Tag-body error mapping kept by the internal receipt evidence endpoint. */
export const internalReceiptErrorResponse = (cause: unknown): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  const tag = failureTag(cause, "ReceiptPersistenceError");

  const status =
    tag === "UnauthenticatedActor"
      ? 401
      : tag === "InactiveActor" ||
          tag === "ReceiptOwnerDenied" ||
          tag === "ReceiptScopeDenied" ||
          tag === "ReceiptAuthorityDenied" ||
          tag === "AmbiguousPaymentSelection" ||
          tag === "AmbiguousParameterFill" ||
          tag === "FailedComposedRequirement"
        ? 403
        : tag === "ReceiptNotFound"
          ? 404
          : tag === "ReceiptDecodeError" ||
              tag === "ReceiptFileNotStaged" ||
              tag === "SettlementAfterRecordedAt"
            ? 422
            : tag === "ReceiptAlreadyExists" ||
                tag === "ReceiptAlreadySettled" ||
                tag === "DuplicateExternalSettlementReference" ||
                tag === "DuplicateReceiptCommandConflict" ||
                tag === "StaleReceiptRevision" ||
                tag === "InvalidReceiptTransition"
              ? 409
              : 503;

  const message =
    tag === "AmbiguousParameterFill" || tag === "FailedComposedRequirement"
      ? COMPOSED_DENIAL_MESSAGES[tag]
      : undefined;

  const body: ErrorBody = {
    error: message === undefined ? { tag } : { tag, message },
  };

  return jsonResponse(body, status);
};

/** Native problem mapping for public receipt endpoints. */
export const publicReceiptErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  switch (failureTag(cause, "ReceiptPersistenceError")) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.missing", 401);
    case "InactiveActor":
    case "ReceiptOwnerDenied":
    case "ReceiptScopeDenied":
    case "ReceiptAuthorityDenied":
    case "AmbiguousPaymentSelection":
    case "AmbiguousParameterFill":
    case "FailedComposedRequirement":
      return nativeProblemResponse("authority.denied", 403);
    case "ReceiptNotFound":
      return nativeProblemResponse("receipt.not-found", 404);
    case "StaleReceiptRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "ReceiptDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "SettlementAfterRecordedAt":
      return nativeProblemResponse("settlement.after-recorded-at", 422);
    case "ReceiptFileNotStaged":
      return nativeProblemResponse("receipt.file-not-staged", 422);
    case "ReceiptAlreadyExists":
      return nativeProblemResponse("receipt.already-exists", 409);
    case "ReceiptAlreadySettled":
      return nativeProblemResponse("receipt.already-settled", 409);
    case "DuplicateExternalSettlementReference":
      return nativeProblemResponse("settlement.external-reference-conflict", 409);
    case "DuplicateReceiptCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "InvalidReceiptTransition":
      return nativeProblemResponse("receipt.invalid-transition", 409);
    default:
      return nativeProblemResponse("receipts.unavailable", 503);
  }
};

/** Public problem mapping for finance endpoints whose responses are private to the caller. */
export const privateReceiptErrorResponse = (cause: unknown): Response => {
  const response = publicReceiptErrorResponse(cause);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("vary", "Origin");

  return response;
};
