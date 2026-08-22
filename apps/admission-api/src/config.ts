import { randomUUID } from "node:crypto";
import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";

export interface AdmissionApiPrincipal {
  readonly actor: AdmissionPeriodActor;
}

export interface AdmissionApiConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  readonly tokens: ReadonlyMap<string, AdmissionApiPrincipal>;
  readonly now: () => string;
  readonly nextAdmissionPeriodId: () => string;
  readonly nextApplicationId: () => string;
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseActive = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("invalid token active flag");
  return value;
};

const parseActor = (value: unknown): AdmissionPeriodActor => {
  if (!isRecord(value) || typeof value._tag !== "string") {
    throw new Error("invalid token actor");
  }
  if (value._tag === "DepartmentLeader") {
    return {
      _tag: "DepartmentLeader",
      personId: nonEmpty(value.personId, "token person"),
      departmentId: nonEmpty(value.departmentId, "token department"),
      active: parseActive(value.active),
    };
  }
  if (value._tag === "GlobalAdmin") {
    return {
      _tag: "GlobalAdmin",
      personId: nonEmpty(value.personId, "token person"),
      active: parseActive(value.active),
    };
  }
  if (value._tag === "Member") {
    return {
      _tag: "Member",
      personId: nonEmpty(value.personId, "token person"),
      departmentId: nonEmpty(value.departmentId, "token department"),
      active: parseActive(value.active),
    };
  }
  throw new Error("invalid token actor");
};

const parsePrincipal = (value: unknown): AdmissionApiPrincipal => {
  if (!isRecord(value)) throw new Error("invalid token mapping");
  return { actor: parseActor(value.actor ?? value) };
};

const parseTokens = (raw: string | undefined): ReadonlyMap<string, AdmissionApiPrincipal> => {
  if (raw === undefined || raw.length === 0) throw new Error("ADMISSION_AUTH_TOKENS is required");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ADMISSION_AUTH_TOKENS must be JSON");
  }
  if (!isRecord(decoded)) throw new Error("ADMISSION_AUTH_TOKENS must be an object");
  const result = new Map<string, AdmissionApiPrincipal>();
  for (const [token, value] of Object.entries(decoded)) {
    if (token.length === 0) throw new Error("ADMISSION_AUTH_TOKENS contains an empty token");
    result.set(token, parsePrincipal(value));
  }
  if (result.size === 0) throw new Error("ADMISSION_AUTH_TOKENS is empty");
  return result;
};

const parsePort = (raw: string | undefined): number => {
  const value = raw ?? "8790";
  if (!/^\d+$/.test(value)) throw new Error("ADMISSION_API_PORT must be an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("ADMISSION_API_PORT is outside the valid range");
  }
  return port;
};

const loopbackHost = (host: string): string => {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("ADMISSION_API_HOST must be loopback");
  }
  return host;
};

const isInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value));

export const makeAdmissionApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionApiConfig => {
  const configuredNow = env.ADMISSION_FIXED_NOW ?? env.ADMISSION_API_NOW;
  if (configuredNow !== undefined && !isInstant(configuredNow)) {
    throw new Error("ADMISSION_FIXED_NOW must be an RFC 3339 instant");
  }
  return {
    host: loopbackHost(env.ADMISSION_API_HOST ?? "127.0.0.1"),
    port: parsePort(env.ADMISSION_API_PORT),
    postgresUrl: nonEmpty(env.ADMISSION_PG_URL, "ADMISSION_PG_URL"),
    tokens: parseTokens(env.ADMISSION_AUTH_TOKENS),
    now: () => configuredNow ?? new Date().toISOString(),
    nextAdmissionPeriodId: () => `admission_period_${randomUUID()}`,
    nextApplicationId: () => `application_${randomUUID()}`,
  };
};
