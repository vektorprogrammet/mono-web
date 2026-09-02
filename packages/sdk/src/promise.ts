/**
 * Promise adapter for the Effect-native generated SDK.
 *
 * @since 0.2.0
 */
import { Effect } from "effect";
import {
  createConfiguredEffectClient,
  createEffectClient,
  type ClientOptions,
  type EffectSdk,
} from "./effect-client.js";

/** Converts an Effect client tree to the corresponding Promise client tree. */
export type PromiseSdk<A = EffectSdk> = A extends (
  ...args: infer Args
) => Effect.Effect<infer Success, infer _Failure, infer _Requirements>
  ? (...args: Args) => Promise<Success>
  : A extends Readonly<Record<string, unknown>>
    ? { readonly [Key in keyof A]: PromiseSdk<A[Key]> }
    : A;

type AnyEffectMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown>;

const toPromiseClient = <A>(value: A): PromiseSdk<A> => {
  if (typeof value === "function") {
    const method = value as AnyEffectMethod;
    return ((...args: ReadonlyArray<never>) => Effect.runPromise(method(...args))) as PromiseSdk<A>;
  }
  if (typeof value !== "object" || value === null) {
    return value as PromiseSdk<A>;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = toPromiseClient(child);
  }
  return output as PromiseSdk<A>;
};

/** Creates the complete Promise SDK projected from `ExternalNativeApi`. */
export const createPromiseClient = (
  baseUrl: string | undefined,
  options: ClientOptions = {},
): PromiseSdk => toPromiseClient(createEffectClient(baseUrl, options));

/** Creates a Promise SDK from the SDK-owned environment configuration. */
export const createConfiguredPromiseClient = (options: ClientOptions = {}): PromiseSdk =>
  toPromiseClient(createConfiguredEffectClient(options));

export type { ClientOptions } from "./effect-client.js";
