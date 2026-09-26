import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { withPostgresTestDatabase } from "./test-support/postgres.js";
import { TestPlatform } from "./test-support/platform.js";
import type { AuthEngineConfig } from "./auth-engine.js";
import { makePasswordRecovery } from "./password-recovery.js";
import { pgQuery } from "./pg-pool.js";

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

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

layer(TestPlatform, { excludeTestServices: true })("owned recovery boundary", (it) => {
  it.effect(
    "rejects a trusted-origin different callback path before invoking credential engine",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);
          let called = false;

          const r = yield* recovery.handler(
            () => {
              called = true;

              return Promise.resolve(Response.json({ status: true }));
            },
            new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
              body: yield* jsonText({
                email: "synthetic@example.invalid",
                redirectTo: "http://127.0.0.1:5174/login",
              }),
            }),
            context,
          );

          expect(r.status).toBe(403);
          expect(called).toBe(false);
          const audit = yield* pgQuery(pool, `SELECT details FROM auth.identity_security_audit`);
          const auditText = yield* jsonText(audit.rows);
          expect(auditText).toContain("redirect-not-allowed");
          expect(auditText).not.toContain("synthetic@example.invalid");
        }),
      ),
    15_000,
  );
  it.effect(
    "rejects reset query tokens before invoking credential engine",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);
          let called = false;

          const r = yield* recovery.handler(
            () => {
              called = true;

              return Promise.resolve(Response.json({ status: true }));
            },
            new Request("http://127.0.0.1:8790/api/auth/reset-password?token=forbidden-query", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          );

          expect(r.status).toBe(403);
          expect(called).toBe(false);
        }),
      ),
    15_000,
  );
  it.effect(
    "cannot claim complete success without the credential engine establishing its subject",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);

          const r = yield* recovery.handler(
            () => Promise.resolve(Response.json({ status: true })),
            new Request("http://127.0.0.1:8790/api/auth/reset-password", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          );

          expect(r.status).toBe(503);
        }),
      ),
    15_000,
  );
  it.effect(
    "concealed request audit failure replaces engine success with unavailable",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          yield* pgQuery(
            pool,
            `CREATE FUNCTION auth.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON auth.identity_security_audit FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_audit()`,
          );
          const recovery = makePasswordRecovery(pool, config);

          const r = yield* recovery.handler(
            () => Promise.resolve(Response.json({ status: true })),
            new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
              body: yield* jsonText({
                email: "unknown@example.invalid",
                redirectTo: "http://127.0.0.1:5174/tilbakestill-passord",
              }),
            }),
            context,
          );

          expect(r.status).toBe(503);
        }),
      ),
    15_000,
  );
});
