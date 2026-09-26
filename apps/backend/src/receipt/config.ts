import { randomUUID } from "node:crypto";
import { RECEIPT_FILE_MAX_BYTES } from "@vektorprogrammet/domain/receipt";
import { Predicate } from "effect";
import type { IdentityDeployment } from "../session-security.js";

/**
 * Test-only receipt authority: internal lifecycle evidence, the approval concurrency barrier,
 * and one forced file-promotion failure. Decoded only for a local deployment composition.
 */
export interface ReceiptE2EComposition {
  readonly failNextPromotionEffectId?: string;
}

export interface ReceiptApiConfig {
  readonly stagingRoot: string;
  readonly committedRoot: string;
  readonly maxFileBytes: number;
  /** Evidence compositions can pin the instant; absence reads the Effect Clock. */
  readonly now?: () => string;
  readonly nextReceiptId: () => string;
  readonly nextVisualId: () => string;
  readonly e2e?: ReceiptE2EComposition;
}

const nonEmpty = (value: string | undefined, field: string): string => {
  if (!Predicate.isString(value) || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }

  return value;
};

const parseMaxFileBytes = (value: string | undefined): number => {
  if (value === undefined) return RECEIPT_FILE_MAX_BYTES;

  if (!/^\d+$/.test(value)) throw new Error("RECEIPT_MAX_FILE_BYTES must be an integer");
  const bytes = Number(value);

  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error("RECEIPT_MAX_FILE_BYTES must be a positive safe integer");
  }

  return bytes;
};

/** Storage and allocation settings; never test-only authority. */
export const decodeReceiptApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReceiptApiConfig => ({
  stagingRoot: nonEmpty(
    env.RECEIPT_STAGING_ROOT ?? "/tmp/vektor-receipt-staging",
    "RECEIPT_STAGING_ROOT",
  ),
  committedRoot: nonEmpty(
    env.RECEIPT_COMMITTED_ROOT ?? "/tmp/vektor-receipt-committed",
    "RECEIPT_COMMITTED_ROOT",
  ),
  maxFileBytes: parseMaxFileBytes(env.RECEIPT_MAX_FILE_BYTES),
  nextReceiptId: () => `receipt_${randomUUID()}`,
  nextVisualId: () => `visual_${randomUUID()}`,
});

/**
 * Decodes the receipt E2E composition. Any receipt E2E variable outside a local deployment,
 * or without `RECEIPT_E2E_TEST_MODE=1`, fails startup.
 */
export const decodeReceiptE2EComposition = (
  env: Readonly<Record<string, string | undefined>>,
  deployment: IdentityDeployment,
): ReceiptE2EComposition | undefined => {
  const testMode = env.RECEIPT_E2E_TEST_MODE;
  const failNextPromotionEffectId = env.RECEIPT_E2E_FAIL_PROMOTION_EFFECT_ID;

  if (testMode === undefined && failNextPromotionEffectId === undefined) return undefined;

  if (deployment !== "local") {
    throw new Error("RECEIPT_E2E_* requires NATIVE_IDENTITY_DEPLOYMENT=local");
  }

  if (testMode !== "1") {
    throw new Error("RECEIPT_E2E_* requires RECEIPT_E2E_TEST_MODE=1");
  }

  return failNextPromotionEffectId === undefined || failNextPromotionEffectId.length === 0
    ? {}
    : { failNextPromotionEffectId };
};
