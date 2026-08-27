import { makeAdmissionApiConfig, type AdmissionApiConfig } from "./admission/config.js";
import { makeOrganizationApiConfig, type OrganizationApiConfig } from "./organization/config.js";
import { makeReceiptApiConfig, type ReceiptApiConfig } from "./receipt/config.js";
import { makeRecruitmentApiConfig, type RecruitmentApiConfig } from "./recruitment/config.js";

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
  /** Dashboard origin; better-auth issues cookies for this base URL. */
  readonly baseURL: string;
}

export interface BackendConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  /** Native identity engine inputs (spec 0054). */
  readonly auth: BackendAuthConfig;
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

const assertSharedActorFacts = (admission: AdmissionApiConfig, receipt: ReceiptApiConfig): void => {
  for (const [token, admissionPrincipal] of admission.tokens) {
    const receiptPrincipal = receipt.tokens.get(token);
    if (receiptPrincipal === undefined) continue;
    const admissionDepartmentId =
      "departmentId" in admissionPrincipal.actor
        ? admissionPrincipal.actor.departmentId
        : undefined;
    if (
      admissionPrincipal.actor.personId !== receiptPrincipal.actor.personId ||
      admissionPrincipal.actor.active !== receiptPrincipal.actor.active ||
      (admissionDepartmentId !== undefined &&
        admissionDepartmentId !== receiptPrincipal.actor.departmentId)
    ) {
      throw new Error(`conflicting actor facts for shared token ${token}`);
    }
  }
};

export const makeBackendConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): BackendConfig => {
  const admission = makeAdmissionApiConfig(env);
  const receipt = makeReceiptApiConfig(env);
  assertSharedActorFacts(admission, receipt);
  const effects = publicApplicationEffectConfig(env);
  const postgresUrl = nonEmpty(env.BACKEND_PG_URL, "BACKEND_PG_URL");
  const secret = nonEmpty(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  return {
    host: loopbackHost(env.BACKEND_HOST),
    port: parsePort(env.BACKEND_PORT),
    postgresUrl,
    auth: {
      postgresUrl,
      secret,
      baseURL: nonEmpty(env.BETTER_AUTH_URL ?? "http://127.0.0.1:5174", "BETTER_AUTH_URL"),
    },
    admission,
    receipt,
    recruitment: makeRecruitmentApiConfig(admission),
    organization: makeOrganizationApiConfig(env),
    ...(effects === undefined ? {} : { publicApplicationEffects: effects }),
  };
};
