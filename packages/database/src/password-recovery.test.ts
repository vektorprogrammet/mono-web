import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { withPostgresTestDatabase } from "./test-support/postgres.js";
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
} as const;

const context = new IdentityRequestContext({
  requestCorrelation: "focused-recovery",
  sourceIp: null,
  userAgent: null,
});

describe("owned recovery boundary", () => {
  it(
    "rejects a trusted-origin different callback path before invoking credential engine",
    () =>
      withPostgresTestDatabase(async (pool) => {
        const recovery = makePasswordRecovery(pool, config);
        let called = false;

        const r = await Effect.runPromise(
          recovery.handler(
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
          ),
        );

        expect(r.status).toBe(403);
        expect(called).toBe(false);
        const audit = await pool.query(`SELECT details FROM auth.identity_security_audit`);
        expect(JSON.stringify(audit.rows)).toContain("redirect-not-allowed");
        expect(JSON.stringify(audit.rows)).not.toContain("synthetic@example.invalid");
      }),
    15_000,
  );
  it(
    "rejects reset query tokens before invoking credential engine",
    () =>
      withPostgresTestDatabase(async (pool) => {
        const recovery = makePasswordRecovery(pool, config);
        let called = false;

        const r = await Effect.runPromise(
          recovery.handler(
            async () => {
              called = true;

              return Response.json({ status: true });
            },
            new Request("http://127.0.0.1:8790/api/auth/reset-password?token=forbidden-query", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          ),
        );

        expect(r.status).toBe(403);
        expect(called).toBe(false);
      }),
    15_000,
  );
  it(
    "cannot claim complete success without the credential engine establishing its subject",
    () =>
      withPostgresTestDatabase(async (pool) => {
        const recovery = makePasswordRecovery(pool, config);

        const r = await Effect.runPromise(
          recovery.handler(
            async () => Response.json({ status: true }),
            new Request("http://127.0.0.1:8790/api/auth/reset-password", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          ),
        );

        expect(r.status).toBe(503);
      }),
    15_000,
  );
  it(
    "concealed request audit failure replaces engine success with unavailable",
    () =>
      withPostgresTestDatabase(async (pool) => {
        await pool.query(
          `CREATE FUNCTION auth.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON auth.identity_security_audit FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_audit()`,
        );
        const recovery = makePasswordRecovery(pool, config);

        const r = await Effect.runPromise(
          recovery.handler(
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
          ),
        );

        expect(r.status).toBe(503);
      }),
    15_000,
  );
});
