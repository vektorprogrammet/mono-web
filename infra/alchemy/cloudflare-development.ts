import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const workerMain = new URL("../../apps/backend/src/cloudflare-worker.ts", import.meta.url).pathname;

/**
 * Development-only resource graph. Configuration values are operator-supplied at
 * synthesis/deployment time; this module neither reads workstation PostgreSQL
 * settings nor performs provider effects when imported.
 */
export const cloudflareDevelopmentStack = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== "development")
    throw new Error("Cloudflare development stack requires stage 'development'");

  const bucket = yield* Cloudflare.R2.Bucket("DevelopmentReceiptFiles", {
    name: "vektor-development-receipt-files",
  });
  const email = yield* Cloudflare.Email.SendEmail("DevelopmentMail", {
    allowedSenderAddresses: [yield* Config.string("CLOUDFLARE_DEVELOPMENT_MAIL_SENDER")],
  });
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("DevelopmentHyperdrive", {
    name: "vektor-development-hyperdrive",
    origin: {
      scheme: "postgresql",
      host: yield* Config.string("CLOUDFLARE_DEVELOPMENT_TUNNEL_HOST"),
      database: yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE"),
      user: yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE_USER"),
      password: Redacted.make(yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE_PASSWORD")),
      accessClientId: Redacted.make(
        yield* Config.string("CLOUDFLARE_DEVELOPMENT_ACCESS_CLIENT_ID"),
      ),
      accessClientSecret: Redacted.make(
        yield* Config.string("CLOUDFLARE_DEVELOPMENT_ACCESS_CLIENT_SECRET"),
      ),
    },
    mtls: { sslmode: "verify-full" },
  });

  return yield* Cloudflare.Worker("DevelopmentBackend", {
    main: workerMain,
    workersDev: false,
    compatibility: { flags: ["nodejs_compat"], date: "2026-09-22" },
    env: {
      HYPERDRIVE: hyperdrive,
      RECEIPT_FILES: bucket,
      MAIL: email,
      MAIL_SENDER: yield* Config.string("CLOUDFLARE_DEVELOPMENT_MAIL_SENDER"),
      BETTER_AUTH_SECRET: yield* Config.string("CLOUDFLARE_DEVELOPMENT_BETTER_AUTH_SECRET"),
      BACKEND_OAUTH_CANONICAL_ORIGIN: yield* Config.string(
        "CLOUDFLARE_DEVELOPMENT_CANONICAL_ORIGIN",
      ),
      BACKEND_OAUTH_DASHBOARD_ORIGIN: yield* Config.string(
        "CLOUDFLARE_DEVELOPMENT_DASHBOARD_ORIGIN",
      ),
      BACKEND_TRUSTED_ORIGINS: yield* Config.string("CLOUDFLARE_DEVELOPMENT_TRUSTED_ORIGINS"),
    },
  });
});
