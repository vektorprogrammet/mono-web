import { makeAdmissionApiConfig, type AdmissionApiConfig } from "./admission/config.js";
import { makeReceiptApiConfig, type ReceiptApiConfig } from "./receipt/config.js";

export interface PublicApplicationEffectConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
}

export interface BackendConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  readonly admission: AdmissionApiConfig;
  readonly receipt: ReceiptApiConfig;
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

const publicApplicationEffectConfig = (
  env: Readonly<Record<string, string | undefined>>,
): PublicApplicationEffectConfig | undefined => {
  const endpoint = env.PUBLIC_APPLICATION_EFFECT_ENDPOINT;
  const token = env.PUBLIC_APPLICATION_EFFECT_TOKEN;
  if (endpoint === undefined && token === undefined) return undefined;
  if (endpoint === undefined || token === undefined || token.length === 0) {
    throw new Error(
      "PUBLIC_APPLICATION_EFFECT_ENDPOINT and PUBLIC_APPLICATION_EFFECT_TOKEN must be set together",
    );
  }
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_APPLICATION_EFFECT_ENDPOINT must use HTTP or HTTPS");
  }
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
  return {
    host: loopbackHost(env.BACKEND_HOST),
    port: parsePort(env.BACKEND_PORT),
    postgresUrl: nonEmpty(env.BACKEND_PG_URL, "BACKEND_PG_URL"),
    admission,
    receipt,
    ...(effects === undefined ? {} : { publicApplicationEffects: effects }),
  };
};
