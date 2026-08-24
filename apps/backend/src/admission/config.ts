import { randomBytes, randomUUID } from "node:crypto";
import {
  isRfc3339Instant,
  type AdmissionPeriodActor,
  type AdmissionPeriodId,
} from "@vektorprogrammet/domain/admission-period";
import {
  ApplicantIdSchema,
  PublicApplicationIdSchema,
  type ApplicantId,
  type PublicApplicationId,
} from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { AdmissionPeriodId as AdmissionPeriodIdSchema } from "@vektorprogrammet/domain/admission-period";

export interface AdmissionApiPrincipal {
  readonly actor: AdmissionPeriodActor;
}

export interface AdmissionApiRateLimit {
  readonly consume: (key: string, now: string) => boolean;
}

export interface AdmissionApiConfig {
  readonly tokens: ReadonlyMap<string, AdmissionApiPrincipal>;
  readonly maxBodyBytes: number;
  readonly rateLimit: AdmissionApiRateLimit;
  readonly now: () => string;
  readonly nextAdmissionPeriodId: () => AdmissionPeriodId;
  readonly nextApplicantId: () => ApplicantId;
  readonly nextApplicationId: () => PublicApplicationId;
  readonly nextActivationToken: () => string;
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
      personId: PersonId.make(nonEmpty(value.personId, "token person")),
      departmentId: DepartmentId.make(nonEmpty(value.departmentId, "token department")),
      active: parseActive(value.active),
    };
  }
  if (value._tag === "GlobalAdmin") {
    return {
      _tag: "GlobalAdmin",
      personId: PersonId.make(nonEmpty(value.personId, "token person")),
      active: parseActive(value.active),
    };
  }
  if (value._tag === "Member") {
    return {
      _tag: "Member",
      personId: PersonId.make(nonEmpty(value.personId, "token person")),
      departmentId: DepartmentId.make(nonEmpty(value.departmentId, "token department")),
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
  if (raw === undefined || raw.length === 0) return new Map();
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
  return result;
};

const parsePositiveInteger = (raw: string | undefined, fallback: number, field: string): number => {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return parsed;
};

const isInstant = isRfc3339Instant;

export const makeAdmissionApiRateLimit = (
  maxRequests = 5,
  windowMilliseconds = 60_000,
): AdmissionApiRateLimit => {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("admission rate limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1) {
    throw new Error("admission rate limit window must be a positive safe integer");
  }
  const buckets = new Map<string, { readonly startedAt: number; readonly count: number }>();
  return {
    consume(key, now) {
      const timestamp = Date.parse(now);
      if (Number.isNaN(timestamp)) return false;
      const current = buckets.get(key);
      if (current === undefined || timestamp - current.startedAt >= windowMilliseconds) {
        buckets.set(key, { startedAt: timestamp, count: 1 });
        return true;
      }
      if (current.count >= maxRequests) return false;
      buckets.set(key, { startedAt: current.startedAt, count: current.count + 1 });
      return true;
    },
  };
};

export const makeAdmissionApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionApiConfig => {
  const configuredNow = env.ADMISSION_FIXED_NOW;
  if (configuredNow !== undefined && !isInstant(configuredNow)) {
    throw new Error("ADMISSION_FIXED_NOW must be an RFC 3339 instant");
  }
  const maxBodyBytes = parsePositiveInteger(
    env.ADMISSION_MAX_BODY_BYTES,
    16_384,
    "ADMISSION_MAX_BODY_BYTES",
  );
  const rateLimitMax = parsePositiveInteger(
    env.ADMISSION_RATE_LIMIT_MAX,
    5,
    "ADMISSION_RATE_LIMIT_MAX",
  );
  const rateLimitWindow = parsePositiveInteger(
    env.ADMISSION_RATE_LIMIT_WINDOW_MS,
    60_000,
    "ADMISSION_RATE_LIMIT_WINDOW_MS",
  );
  return {
    tokens: parseTokens(env.ADMISSION_AUTH_TOKENS),
    maxBodyBytes,
    rateLimit: makeAdmissionApiRateLimit(rateLimitMax, rateLimitWindow),
    now: () => configuredNow ?? new Date().toISOString(),
    nextAdmissionPeriodId: () => AdmissionPeriodIdSchema.make(`admission_period_${randomUUID()}`),
    nextApplicantId: () => ApplicantIdSchema.make(`applicant_${randomUUID()}`),
    nextApplicationId: () => PublicApplicationIdSchema.make(`application_${randomUUID()}`),
    nextActivationToken: () => randomBytes(32).toString("base64url"),
  };
};
