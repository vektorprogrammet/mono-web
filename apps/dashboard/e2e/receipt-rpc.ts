/**
 * Receipt RPCs as a browser or a journey driver posts them: one RPC request message to the RPC
 * endpoint, with the credential, the origin, and any probe as real HTTP headers. The answer keeps
 * the status that its problem's registry entry gives it, so a journey compares statuses as it did
 * under the HTTP contract.
 */
import type { APIRequestContext } from "@playwright/test";
import { internalNativeRpcPath, nativeRpcPath, type NativeProblem } from "@vektorprogrammet/rpc";
import { Predicate, type Schema } from "effect";
import { nativeRpcOutcome, nativeRpcRequestBody } from "./native-operations.js";

/** What one RPC answered: its registry status, its value on success, and its problem otherwise. */
export interface NativeRpcAnswer {
  readonly status: number;
  readonly value: Schema.Json | undefined;
  readonly problem: NativeProblem | undefined;
}

/** The answer that one RPC response body carries; a body that is no RPC response is a 500. */
export const nativeRpcAnswer = (body: string): NativeRpcAnswer => {
  const outcome = nativeRpcOutcome(body);

  if (Predicate.isTagged(outcome, "Success")) {
    return { status: 200, value: outcome.value, problem: undefined };
  }

  if (Predicate.isTagged(outcome, "Problem")) {
    return { status: outcome.status, value: undefined, problem: outcome.problem };
  }

  return { status: 500, value: undefined, problem: undefined };
};

/** The base64 text that carries bytes in an RPC payload or success. */
export const rpcBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Posts one RPC to the external endpoint, or to the internal one when `internal` is set. */
export async function postNativeRpc(
  request: APIRequestContext,
  input: {
    readonly origin: string;
    readonly tag: string;
    readonly payload?: Schema.Json;
    readonly headers: Readonly<Record<string, string>>;
    readonly internal?: boolean;
  },
): Promise<NativeRpcAnswer> {
  const path = input.internal === true ? internalNativeRpcPath : nativeRpcPath;

  const response = await request.post(`${input.origin}${path}`, {
    headers: { ...input.headers, "content-type": "application/json" },
    data: nativeRpcRequestBody(input.tag, input.payload ?? null),
  });

  return nativeRpcAnswer(await response.text());
}
