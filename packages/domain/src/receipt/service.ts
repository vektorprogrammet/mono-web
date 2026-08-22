import { Context, Effect } from "effect";
import type { ReceiptFailure } from "./errors.js";
import type { ReceiptDecisionContext } from "./update.js";

export interface ReceiptTransactionResult {
  readonly observation: import("./schema.js").ReceiptObservation;
  readonly replayed: boolean;
  readonly outboxCount: number;
}

export interface ReceiptAuthorityShape {
  readonly execute: (
    input: unknown,
    context: ReceiptDecisionContext,
  ) => Effect.Effect<ReceiptTransactionResult, ReceiptFailure>;
}

export class ReceiptAuthority extends Context.Service<ReceiptAuthority, ReceiptAuthorityShape>()(
  "@vektorprogrammet/domain/ReceiptAuthority",
) {}

export const executeReceipt = (input: unknown, context: ReceiptDecisionContext) =>
  ReceiptAuthority.use(({ execute }) => execute(input, context));
