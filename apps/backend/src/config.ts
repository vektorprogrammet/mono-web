import { makeAdmissionApiConfig, type AdmissionApiConfig } from "./admission/config.js";
import { makeReceiptApiConfig, type ReceiptApiConfig } from "./receipt/config.js";

export interface BackendConfig {
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  readonly admission: AdmissionApiConfig;
  readonly receipt: ReceiptApiConfig;
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
  return {
    host: loopbackHost(env.BACKEND_HOST),
    port: parsePort(env.BACKEND_PORT),
    postgresUrl: nonEmpty(env.BACKEND_PG_URL, "BACKEND_PG_URL"),
    admission,
    receipt,
  };
};
