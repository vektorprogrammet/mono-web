import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@vektorprogrammet/domain/receipt";

export interface ReceiptApiPrincipal {
  readonly actor: ReceiptActor;
  readonly paymentAccountCiphertext: string;
}

export interface ReceiptApiConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  readonly stagingRoot: string;
  readonly committedRoot: string;
  readonly maxFileBytes: number;
  readonly tokens: ReadonlyMap<string, ReceiptApiPrincipal>;
  readonly now: () => string;
  readonly nextReceiptId: () => string;
  readonly nextVisualId: () => string;
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
};

const parseActive = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("invalid token active flag");
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseApprovalScope = (value: unknown): ReceiptActor["approvalScope"] => {
  if (!isRecord(value) || typeof value._tag !== "string") {
    throw new Error("invalid token approval scope");
  }
  if (value._tag === "None" || value._tag === "Global") return { _tag: value._tag };
  if (value._tag === "Department") {
    const departmentId = nonEmpty(value.departmentId, "token approval department");
    return { _tag: "Department", departmentId };
  }
  throw new Error("invalid token approval scope");
};

const parsePrincipal = (value: unknown): ReceiptApiPrincipal => {
  if (!isRecord(value)) throw new Error("invalid token mapping");
  const actor: ReceiptActor = {
    personId: nonEmpty(value.personId, "token person"),
    departmentId: nonEmpty(value.departmentId, "token department"),
    active: parseActive(value.active),
    approvalScope: parseApprovalScope(value.approvalScope),
  };
  return {
    actor,
    paymentAccountCiphertext: nonEmpty(value.paymentAccountCiphertext, "token account"),
  };
};

const parseTokens = (raw: string | undefined): ReadonlyMap<string, ReceiptApiPrincipal> => {
  if (raw === undefined || raw.length === 0) throw new Error("RECEIPT_AUTH_TOKENS is required");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("RECEIPT_AUTH_TOKENS must be JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("RECEIPT_AUTH_TOKENS must be an object");
  }
  const result = new Map<string, ReceiptApiPrincipal>();
  for (const [token, value] of Object.entries(decoded)) {
    if (token.length === 0) throw new Error("RECEIPT_AUTH_TOKENS contains an empty token");
    if (result.has(token)) throw new Error("RECEIPT_AUTH_TOKENS contains a duplicate token");
    result.set(token, parsePrincipal(value));
  }
  if (result.size === 0) throw new Error("RECEIPT_AUTH_TOKENS is empty");
  return result;
};

const parsePort = (raw: string | undefined): number => {
  const value = raw ?? "8788";
  if (!/^\d+$/.test(value)) throw new Error("RECEIPT_API_PORT must be an integer");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("RECEIPT_API_PORT is outside the valid range");
  }
  return port;
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

const loopbackHost = (host: string): string => {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("RECEIPT_API_HOST must be loopback");
  }
  return host;
};

export const makeReceiptApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReceiptApiConfig => ({
  host: loopbackHost(env.RECEIPT_API_HOST ?? "127.0.0.1"),
  port: parsePort(env.RECEIPT_API_PORT),
  postgresUrl: nonEmpty(env.RECEIPT_PG_URL, "RECEIPT_PG_URL"),
  stagingRoot: nonEmpty(
    env.RECEIPT_STAGING_ROOT ?? "/tmp/vektor-receipt-staging",
    "RECEIPT_STAGING_ROOT",
  ),
  committedRoot: nonEmpty(
    env.RECEIPT_COMMITTED_ROOT ?? "/tmp/vektor-receipt-committed",
    "RECEIPT_COMMITTED_ROOT",
  ),
  maxFileBytes: parseMaxFileBytes(env.RECEIPT_MAX_FILE_BYTES),
  tokens: parseTokens(env.RECEIPT_AUTH_TOKENS),
  now: () => new Date().toISOString(),
  nextReceiptId: () => `receipt_${randomUUID()}`,
  nextVisualId: () => `visual_${randomUUID()}`,
});
