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

export const localBackendEnvironment = (composition: LocalBackendComposition) => {
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
  } as const;
};
