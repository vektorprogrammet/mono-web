import { describe, expect, it } from "vitest";
import {
  CloudflareBackendBindingError,
  requireCloudflareBackendBindings,
  type CloudflareBackendEnv,
} from "./cloudflare-worker.js";

const completeEnv = (): CloudflareBackendEnv => ({
  HYPERDRIVE: { connectionString: "postgres://worker-bound" },
  RECEIPT_FILES: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  },
  MAIL: { send: async () => ({ messageId: "mail-1" }) },
  MAIL_SENDER: "noreply@example.invalid",
});

describe("Cloudflare Worker composition bindings", () => {
  it.each(["HYPERDRIVE", "RECEIPT_FILES", "MAIL", "MAIL_SENDER"] as const)(
    "fails closed when %s is absent",
    (binding) => {
      const env = completeEnv();
      delete env[binding];
      expect(() => requireCloudflareBackendBindings(env)).toThrow(
        new CloudflareBackendBindingError(binding),
      );
    },
  );

  it("keeps Hyperdrive as one connection-string binding", () => {
    expect(requireCloudflareBackendBindings(completeEnv()).hyperdrive.connectionString).toBe(
      "postgres://worker-bound",
    );
  });
});
