/** The problems that receipt handlers answer for domain, store, and credential failures. */
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  ReceiptDecodeError,
  ReceiptFailure,
  ReceiptFileFailure,
  ReceiptSettlementFailure,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/receipt";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/rpc/problem";
import type { Cause } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  type CredentialCases,
  type ProblemCases,
  type ProblemMapper,
  problemMapper,
  requestInvalid,
} from "../rpc/problem.js";

/** Every failure that a receipt handler answers, but a rejected credential. */
type ReceiptRpcFailure =
  | Exclude<ReceiptFailure | ReceiptSettlementFailure, UnauthenticatedActor>
  | ReceiptFileFailure
  | IdentityEngineError
  | SqlError
  | Cause.TimeoutError;

const receiptCases = {
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
} satisfies ProblemCases<ReceiptRpcFailure>;

/**
 * The one answer for every receipt failure other than a rejected credential, including an
 * unavailable store, Identity, or E2E barrier.
 *
 * @remarks
 * An inactive actor, a denied owner, scope, or authority, and an ambiguous or failed authority
 * requirement answer authority.denied. The receipt, settlement, file, and idempotency failures
 * answer their receipt problems, and a command that does not decode answers validation.failed at
 * the root. The store, the file store, Identity, SQL, and a timeout of the E2E barrier answer
 * receipts.unavailable.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * command.pipe(receiptProblems, commandReceiptProblems, receiptCredentialProblems(presentation));
 * ```
 *
 * @avoid Mapping a receipt failure in a handler: the receipt RPCs then answer one failure
 * differently. Pipe the handler's effect through this.
 *
 * @construct rpc-problem
 */
export const receiptProblems: ProblemMapper<ReceiptRpcFailure, typeof receiptCases> =
  problemMapper<ReceiptRpcFailure>()(receiptCases);

/** A stored receipt value that a read cannot decode is the receipt store failing, not the request. */
export const storedReceiptProblems = problemMapper<ReceiptDecodeError>()({
  ReceiptDecodeError: () => Problem.make("receipts.unavailable"),
});

/**
 * A credential rejected inside a receipt handler is answered from the request's own evidence.
 *
 * @remarks
 * The rejection answers `Problem.unauthenticated(presentation)`: credential.missing when the
 * request presented no credential, and credential.invalid when it presented one that was
 * rejected.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * command.pipe(receiptProblems, commandReceiptProblems, receiptCredentialProblems(presentation));
 * ```
 *
 * @avoid Answering a rejected credential with a fixed code: a request that presented a rejected
 * credential would be told that it presented none. Pipe the handler's effect through this.
 *
 * @construct rpc-problem
 */
export const receiptCredentialProblems = (
  presentation: CredentialPresentation,
): ProblemMapper<UnauthenticatedActor, CredentialCases<"UnauthenticatedActor">> =>
  problemMapper<UnauthenticatedActor>()<CredentialCases<"UnauthenticatedActor">>({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
  });
