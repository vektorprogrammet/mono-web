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

/** Converts the generated Effect client methods to Promise-returning methods. */
export type PromiseSdk<A = EffectSdk> = [A] extends [
  (...args: never[]) => Effect.Effect<infer Success, infer _Failure, infer _Requirements>,
]
  ? (...args: Parameters<A>) => Promise<Success>
  : { readonly [Key in keyof A]: PromiseSdk<A[Key]> };

const toPromiseClient = (client: EffectSdk): PromiseSdk => {
  const groups = Object.entries(client).map(([groupName, endpoints]) => [
    groupName,
    Object.fromEntries(
      Object.entries(endpoints).map(([name, method]) => [
        name,
        (request: never) => Effect.runPromise(method(request)),
      ]),
    ),
  ]);

  // SAFETY: Every generated group and endpoint key is retained; each endpoint receives its unchanged request and only its Effect return is converted to Promise.
  return Object.fromEntries(groups) as PromiseSdk;
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
