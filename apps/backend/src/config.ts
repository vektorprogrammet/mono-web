import {
  OAUTH_NATIVE_API_RESOURCE,
  type OAuthProviderRuntimeConfig,
} from "@vektorprogrammet/database";
import { makeAdmissionApiConfig, type AdmissionApiConfig } from "./admission/config.js";
import { makeOrganizationApiConfig, type OrganizationApiConfig } from "./organization/config.js";
import { makeReceiptApiConfig, type ReceiptApiConfig } from "./receipt/config.js";
import { makeRecruitmentApiConfig, type RecruitmentApiConfig } from "./recruitment/config.js";
import {
  makeNativeSessionBoundaryPolicy,
  type NativeSessionBoundaryPolicy,
} from "./session-security.js";

export interface PublicApplicationEffectConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly deliveryTimeoutMilliseconds: number;
}

export interface BackendAuthConfig {
  readonly postgresUrl: string;
  readonly secret: string;
  readonly oauth: OAuthProviderRuntimeConfig;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly secureCookies: boolean;
  readonly internalSourceNetworks: ReadonlyArray<string>;
}

export interface BackendConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  /** Native identity engine inputs (spec 0054). */
  readonly auth: BackendAuthConfig;
  readonly sessionBoundary: NativeSessionBoundaryPolicy;
  readonly admission: AdmissionApiConfig;
  readonly receipt: ReceiptApiConfig;
  readonly recruitment: RecruitmentApiConfig;
  readonly organization: OrganizationApiConfig;
  readonly publicApplicationEffects?: PublicApplicationEffectConfig;
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const exactOrigin = (raw: string | undefined, field: string): string => {
  const value = nonEmpty(raw, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute origin`);
  }
  if (
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "localhost" ||
    url.hostname.includes("*")
  ) {
    throw new Error(`${field} must be one exact origin without a trailing slash`);
  }
  const local = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (url.protocol !== "https:" && !local) {
    throw new Error(`${field} must use https or fixed-port http://127.0.0.1`);
  }
  return value;
};

const internalSourceNetworks = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const values = (env.OAUTH_INTERNAL_SOURCE_NETWORKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (
    values.some((value) => !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(value))
  ) {
    throw new Error("OAUTH_INTERNAL_SOURCE_NETWORKS must contain comma-separated IPv4 CIDRs");
  }
  if (env.BACKEND_INGRESS === "internal" && values.length === 0) {
    throw new Error("OAUTH_INTERNAL_SOURCE_NETWORKS is required for internal ingress");
  }
  return values;
};

export const decodeOAuthBackendConfig = (
  env: Readonly<Record<string, string | undefined>>,
  trustedOrigins: ReadonlyArray<string>,
): Pick<BackendAuthConfig, "oauth" | "internalSourceNetworks"> => {
  const canonicalOrigin = exactOrigin(env.OAUTH_CANONICAL_ORIGIN, "OAUTH_CANONICAL_ORIGIN");
  const dashboardOrigin = exactOrigin(env.OAUTH_DASHBOARD_ORIGIN, "OAUTH_DASHBOARD_ORIGIN");
  if (!trustedOrigins.includes(dashboardOrigin)) {
    throw new Error("OAUTH_DASHBOARD_ORIGIN must be a trusted first-party origin");
  }
  if (env.OAUTH_NATIVE_API_RESOURCE !== OAUTH_NATIVE_API_RESOURCE) {
    throw new Error(`OAUTH_NATIVE_API_RESOURCE must be ${OAUTH_NATIVE_API_RESOURCE}`);
  }
  return {
    oauth: {
      canonicalOrigin,
      dashboardOrigin,
      nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
    },
    internalSourceNetworks: internalSourceNetworks(env),
  };
};

const loopbackHost = (value: string | undefined): string => {
  const host = value ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("BACKEND_HOST must be loopback");
  }
  return host;
};

const parsePort = (value: string | undefined): number => {
  const raw = value ?? "8790";
  if (!/^\d+$/.test(raw)) throw new Error("BACKEND_PORT must be an integer");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BACKEND_PORT is outside the valid range");
  }
  return port;
};

const positiveInteger = (raw: string | undefined, fallback: number, field: string): number => {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return parsed;
};

const providerEndpoint = (raw: string): URL => {
  const endpoint = new URL(raw);
  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("PUBLIC_APPLICATION_EFFECT_ENDPOINT must use HTTPS unless it targets loopback");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("PUBLIC_APPLICATION_EFFECT_ENDPOINT must not contain credentials");
  }
  return endpoint;
};

const publicApplicationEffectConfig = (
  env: Readonly<Record<string, string | undefined>>,
): PublicApplicationEffectConfig | undefined => {
  const mode = env.PUBLIC_APPLICATION_EFFECT_MODE;
  const endpoint = env.PUBLIC_APPLICATION_EFFECT_ENDPOINT;
  const token = env.PUBLIC_APPLICATION_EFFECT_TOKEN;
  if (mode === "disabled") {
    if (endpoint !== undefined || token !== undefined) {
      throw new Error(
        "PUBLIC_APPLICATION_EFFECT_ENDPOINT and PUBLIC_APPLICATION_EFFECT_TOKEN require PUBLIC_APPLICATION_EFFECT_MODE=http",
      );
    }
    return undefined;
  }
  if (mode !== "http") {
    throw new Error("PUBLIC_APPLICATION_EFFECT_MODE must be disabled or http");
  }
  if (endpoint === undefined || token === undefined || token.length === 0) {
    throw new Error(
      "PUBLIC_APPLICATION_EFFECT_ENDPOINT and PUBLIC_APPLICATION_EFFECT_TOKEN are required in http mode",
    );
  }
  const parsed = providerEndpoint(endpoint);
  return {
    endpoint: parsed,
    token,
    pollIntervalMilliseconds: positiveInteger(
      env.PUBLIC_APPLICATION_EFFECT_POLL_MS,
      250,
      "PUBLIC_APPLICATION_EFFECT_POLL_MS",
    ),
    staleClaimMilliseconds: positiveInteger(
      env.PUBLIC_APPLICATION_EFFECT_STALE_MS,
      60_000,
      "PUBLIC_APPLICATION_EFFECT_STALE_MS",
    ),
    deliveryTimeoutMilliseconds: positiveInteger(
      env.PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS,
      10_000,
      "PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS",
    ),
  };
};

export const makeBackendConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): BackendConfig => {
  const admission = makeAdmissionApiConfig(env);
  const receipt = makeReceiptApiConfig(env);
  const sessionBoundary = makeNativeSessionBoundaryPolicy(env);
  const effects = publicApplicationEffectConfig(env);
  const postgresUrl = nonEmpty(env.BACKEND_PG_URL, "BACKEND_PG_URL");
  const secret = nonEmpty(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const oauth = decodeOAuthBackendConfig(env, sessionBoundary.trustedOrigins);
  return {
    host: loopbackHost(env.BACKEND_HOST),
    port: parsePort(env.BACKEND_PORT),
    postgresUrl,
    sessionBoundary,
    auth: {
      postgresUrl,
      secret,
      ...oauth,
      trustedOrigins: sessionBoundary.trustedOrigins,
      secureCookies: sessionBoundary.secureCookies,
    },
    admission,
    receipt,
    recruitment: makeRecruitmentApiConfig(admission),
    organization: makeOrganizationApiConfig(env),
    ...(effects === undefined ? {} : { publicApplicationEffects: effects }),
  };
};
