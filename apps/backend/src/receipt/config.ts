import { randomUUID } from "node:crypto";

export interface ReceiptApiConfig {
  readonly stagingRoot: string;
  readonly committedRoot: string;
  readonly maxFileBytes: number;
  readonly now: () => string;
  readonly nextReceiptId: () => string;
  readonly nextVisualId: () => string;
  readonly e2eTestMode?: boolean;
  readonly e2eFailNextPromotionEffectId?: string;
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
};

const parseMaxFileBytes = (raw: string | undefined): number => {
  const value = raw ?? "10485760";
  if (!/^\d+$/.test(value)) throw new Error("RECEIPT_MAX_FILE_BYTES must be an integer");
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error("RECEIPT_MAX_FILE_BYTES must be a positive safe integer");
  }
  return bytes;
};

export const makeReceiptApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReceiptApiConfig => {
  const e2eTestMode = env.RECEIPT_E2E_TEST_MODE === "1";
  const e2eFailNextPromotionEffectId =
    e2eTestMode &&
    env.RECEIPT_E2E_FAIL_PROMOTION_EFFECT_ID !== undefined &&
    env.RECEIPT_E2E_FAIL_PROMOTION_EFFECT_ID.length > 0
      ? env.RECEIPT_E2E_FAIL_PROMOTION_EFFECT_ID
      : undefined;
  return {
    stagingRoot: nonEmpty(
      env.RECEIPT_STAGING_ROOT ?? "/tmp/vektor-receipt-staging",
      "RECEIPT_STAGING_ROOT",
    ),
    committedRoot: nonEmpty(
      env.RECEIPT_COMMITTED_ROOT ?? "/tmp/vektor-receipt-committed",
      "RECEIPT_COMMITTED_ROOT",
    ),
    maxFileBytes: parseMaxFileBytes(env.RECEIPT_MAX_FILE_BYTES),
    now: () => new Date().toISOString(),
    nextReceiptId: () => `receipt_${randomUUID()}`,
    nextVisualId: () => `visual_${randomUUID()}`,
    e2eTestMode,
    e2eFailNextPromotionEffectId,
  };
};
