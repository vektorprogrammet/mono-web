import { randomBytes, randomUUID } from "node:crypto";
import {
  isRfc3339Instant,
  type AdmissionPeriodId,
} from "@vektorprogrammet/domain/admission-period";
import {
  ApplicantIdSchema,
  PublicApplicationIdSchema,
  type ApplicantId,
  type PublicApplicationId,
} from "@vektorprogrammet/domain/application";
import { AdmissionPeriodId as AdmissionPeriodIdSchema } from "@vektorprogrammet/domain/admission-period";
import { publicRateLimit, type PublicRateLimit } from "../http-api/public-rate-limit.js";

export interface AdmissionApiConfig {
  readonly maxBodyBytes: number;
  readonly rateLimit: PublicRateLimit;
  /** Fixed instant from `ADMISSION_FIXED_NOW`; without it, handlers read the Clock service. */
  readonly now?: () => string;
  readonly nextAdmissionPeriodId: () => AdmissionPeriodId;
  readonly nextApplicantId: () => ApplicantId;
  readonly nextApplicationId: () => PublicApplicationId;
  readonly nextActivationToken: () => string;
}

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

export const decodeAdmissionApiConfig = (
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
    maxBodyBytes,
    rateLimit: publicRateLimit(rateLimitMax, rateLimitWindow),
    now: configuredNow === undefined ? undefined : () => configuredNow,
    nextAdmissionPeriodId: () => AdmissionPeriodIdSchema.make(`admission_period_${randomUUID()}`),
    nextApplicantId: () => ApplicantIdSchema.make(`applicant_${randomUUID()}`),
    nextApplicationId: () => PublicApplicationIdSchema.make(`application_${randomUUID()}`),
    nextActivationToken: () => randomBytes(32).toString("base64url"),
  };
};
