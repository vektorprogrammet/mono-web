/**
 * Compile-time gate for mutation headers reflected by `HttpApiClient.make`.
 *
 * This module intentionally defines no SDK-local header aliases. It compares
 * generated operation parameters with the canonical HTTP API schema types.
 */
import type { IdempotencyHeaders, IdempotencyIfMatchHeaders } from "@vektorprogrammet/http-api";
import type { EffectSdk } from "./effect-client.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;
type RefundRequest = Parameters<EffectSdk["receipts"]["refundReceipt"]>[0];
type SubmitRequest = Parameters<EffectSdk["receipts"]["submitReceipt"]>[0];
type RefundHeaders = RefundRequest extends { readonly headers: infer Headers } ? Headers : never;
type SubmitHeaders = SubmitRequest extends { readonly headers: infer Headers } ? Headers : never;

const reflectedIdempotencyIfMatchHeaders: Assert<Equal<RefundHeaders, IdempotencyIfMatchHeaders>> =
  true;
const reflectedIdempotencyHeaders: Assert<Equal<SubmitHeaders, IdempotencyHeaders>> = true;

void reflectedIdempotencyIfMatchHeaders;
void reflectedIdempotencyHeaders;
