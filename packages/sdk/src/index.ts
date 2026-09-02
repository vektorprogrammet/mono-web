/**
 * Native API SDK projected from the canonical Effect `ExternalNativeApi`.
 *
 * @since 0.2.0
 */
export {
  createConfiguredPromiseClient,
  createPromiseClient,
  type ClientOptions,
  type PromiseSdk,
} from "./promise.js";
export { apiUrl, isFixtureMode, sdkRuntimeConfig } from "./config.js";
