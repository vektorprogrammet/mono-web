/**
 * Settings that every disposable local native backend needs.
 *
 * `decodeBackendConfig` in `apps/backend/src/config.ts` owns their meaning. Runners
 * spread this record and add only journey settings, so a newly required backend
 * setting changes this definition instead of each runner's copy.
 *
 * The module has no dependencies, so Node and Bun runners can both import it.
 */
export interface LocalBackendComposition {
  /** Loopback origin that the backend listens on; it is also the OAuth issuer. */
  readonly backendOrigin: string;
  /** First-party dashboard origin that native identity trusts. */
  readonly dashboardOrigin: string;
  readonly postgresUrl: string;
  /** Better Auth secret of at least 32 characters. */
  readonly betterAuthSecret: string;
}

/** The variables that `localBackendEnvironment` sets, as `decodeBackendConfig` reads them. */
interface LocalBackendEnvironment {
  readonly BACKEND_HOST: string;
  readonly BACKEND_PORT: string;
  readonly BACKEND_PG_URL: string;
  readonly BETTER_AUTH_SECRET: string;
  readonly NATIVE_IDENTITY_DEPLOYMENT: "local";
  readonly NATIVE_IDENTITY_TRUSTED_ORIGINS: string;
  readonly OAUTH_CANONICAL_ORIGIN: string;
  readonly OAUTH_DASHBOARD_ORIGIN: string;
  readonly OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api";
  readonly PUBLIC_APPLICATION_EFFECT_MODE: "disabled";
  readonly PASSWORD_RESET_DELIVERY_MODE: "disabled";
  readonly RECEIPT_DELIVERY_MODE: "disabled";
}

/**
 * The environment of a disposable local native backend for one composition.
 *
 * @remarks
 * It takes `BACKEND_HOST` and `BACKEND_PORT` from `backendOrigin`, which is also the OAuth
 * issuer, trusts `dashboardOrigin` as the first-party origin, points the backend at
 * `postgresUrl`, selects the `local` identity deployment, and disables public application,
 * password reset, and receipt delivery, so the backend calls no provider.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const environment = { ...process.env, ...localBackendEnvironment({ backendOrigin, dashboardOrigin, postgresUrl, betterAuthSecret }) };
 * ```
 *
 * @avoid Copying these variables into a runner: a setting that the backend starts to require
 * then breaks every copy but this one. Spread this record, and add only the settings of the
 * journey.
 *
 * @construct test-harness
 */
export const localBackendEnvironment = (
  composition: LocalBackendComposition,
): LocalBackendEnvironment => {
  const listener = new URL(composition.backendOrigin);

  return {
    BACKEND_HOST: listener.hostname,
    BACKEND_PORT: listener.port,
    BACKEND_PG_URL: composition.postgresUrl,
    BETTER_AUTH_SECRET: composition.betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([composition.dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: composition.backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: composition.dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    PASSWORD_RESET_DELIVERY_MODE: "disabled",
    RECEIPT_DELIVERY_MODE: "disabled",
  };
};
