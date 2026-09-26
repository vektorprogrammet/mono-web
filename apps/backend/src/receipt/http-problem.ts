/** The problems receipt handlers answer for domain, store, and credential failures. */
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  ReceiptDecodeError,
  ReceiptFailure,
  ReceiptFileFailure,
  ReceiptSettlementFailure,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/receipt";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import type { Cause } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { problemMapper, requestInvalid } from "../http-api/problem.js";

/**
 * The one answer for every receipt failure other than a rejected credential,
 * including an unavailable store, Identity, or E2E barrier.
 *
 * @construct http-problem
 */
export const receiptProblems = problemMapper<
  | Exclude<ReceiptFailure | ReceiptSettlementFailure, UnauthenticatedActor>
  | ReceiptFileFailure
  | IdentityEngineError
  | SqlError
  | Cause.TimeoutError
>()({
  InactiveActor: () => Problem.make("authority.denied"),
  ReceiptOwnerDenied: () => Problem.make("authority.denied"),
  ReceiptScopeDenied: () => Problem.make("authority.denied"),
  ReceiptAuthorityDenied: () => Problem.make("authority.denied"),
  AmbiguousPaymentSelection: () => Problem.make("authority.denied"),
  AmbiguousParameterFill: () => Problem.make("authority.denied"),
  FailedComposedRequirement: () => Problem.make("authority.denied"),
  ReceiptNotFound: () => Problem.make("receipt.not-found"),
  StaleReceiptRevision: () => Problem.make("precondition.failed"),
  ReceiptDecodeError: () => requestInvalid(),
  SettlementAfterRecordedAt: () => Problem.make("settlement.after-recorded-at"),
  ReceiptFileNotStaged: () => Problem.make("receipt.file-not-staged"),
  ReceiptAlreadyExists: () => Problem.make("receipt.already-exists"),
  ReceiptAlreadySettled: () => Problem.make("receipt.already-settled"),
  DuplicateExternalSettlementReference: () =>
    Problem.make("settlement.external-reference-conflict"),
  DuplicateReceiptCommandConflict: () => Problem.make("idempotency.digest-conflict"),
  InvalidReceiptTransition: () => Problem.make("receipt.invalid-transition"),
  ReceiptPersistenceError: () => Problem.make("receipts.unavailable"),
  ReceiptFileIdentityConflict: () => Problem.make("receipts.unavailable"),
  ReceiptFileEffectConflict: () => Problem.make("receipts.unavailable"),
  ReceiptFileInjectedFailure: () => Problem.make("receipts.unavailable"),
  IdentityEngineError: () => Problem.make("receipts.unavailable"),
  SqlError: () => Problem.make("receipts.unavailable"),
  TimeoutError: () => Problem.make("receipts.unavailable"),
});

/**
 * A stored receipt value a read cannot decode is the receipt store failing, not the request.
 */
export const storedReceiptProblems = problemMapper<ReceiptDecodeError>()({
  ReceiptDecodeError: () => Problem.make("receipts.unavailable"),
});

/**
 * A credential rejected inside a receipt handler is answered from the request's own evidence.
 *
 * @construct http-problem
 */
export const receiptCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
  });
