import { describe, expect, it } from "vitest";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import type { Pool } from "pg";
import type { AuthEngineConfig } from "./auth-engine.js";
import { makePasswordRecovery } from "./password-recovery.js";
const config: AuthEngineConfig = {
  postgresUrl: "",
  secret: "synthetic",
  oauth: {
    canonicalOrigin: "http://127.0.0.1:8790",
    dashboardOrigin: "http://127.0.0.1:5174",
    nativeApiResource: "urn:vektorprogrammet:native-api",
  },
  trustedOrigins: ["http://127.0.0.1:5174"],
  secureCookies: false,
};
const context = new IdentityRequestContext({
  requestCorrelation: "focused-recovery",
  sourceIp: null,
  userAgent: null,
});
const setup = (failAudit = false) => {
  const writes: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      if (failAudit) throw new Error("synthetic audit unavailable");
      writes.push(values);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { writes, recovery: makePasswordRecovery(pool, config) };
};
describe("owned recovery boundary", () => {
  it("rejects a trusted-origin different callback path before invoking credential engine", async () => {
    const { recovery, writes } = setup();
    let called = false;
    const r = await recovery.handler(
      async () => {
        called = true;
        return Response.json({ status: true });
      },
      new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
        method: "POST",
        headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: "synthetic@example.invalid",
          redirectTo: "http://127.0.0.1:5174/login",
        }),
      }),
      context,
    );
    expect(r.status).toBe(403);
    expect(called).toBe(false);
    expect(JSON.stringify(writes)).toContain("redirect-not-allowed");
    expect(JSON.stringify(writes)).not.toContain("synthetic@example.invalid");
  });
  it("rejects reset query tokens before invoking credential engine", async () => {
    const { recovery } = setup();
    let called = false;
    const r = await recovery.handler(
      async () => {
        called = true;
        return Response.json({ status: true });
      },
      new Request("http://127.0.0.1:8790/api/auth/reset-password?token=forbidden-query", {
        method: "POST",
        headers: { origin: config.oauth.dashboardOrigin },
      }),
      context,
    );
    expect(r.status).toBe(403);
    expect(called).toBe(false);
  });
  it("cannot claim complete success without the credential engine establishing its subject", async () => {
    const { recovery } = setup();
    const r = await recovery.handler(
      async () => Response.json({ status: true }),
      new Request("http://127.0.0.1:8790/api/auth/reset-password", {
        method: "POST",
        headers: { origin: config.oauth.dashboardOrigin },
      }),
      context,
    );
    expect(r.status).toBe(503);
  });
  it("concealed request audit failure replaces engine success with unavailable", async () => {
    const { recovery } = setup(true);
    const r = await recovery.handler(
      async () => Response.json({ status: true }),
      new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
        method: "POST",
        headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          email: "unknown@example.invalid",
          redirectTo: "http://127.0.0.1:5174/tilbakestill-passord",
        }),
      }),
      context,
    );
    expect(r.status).toBe(503);
  });
});
