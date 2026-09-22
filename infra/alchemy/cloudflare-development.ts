import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const workerMain = new URL("../../apps/backend/src/cloudflare-worker.ts", import.meta.url).pathname;
const developmentOrigin = "https://vektor.phibkro.org";
const databaseOrigin = "vektor-db-origin.phibkro.org";

/**
 * Development-only resource graph. Configuration values are operator-supplied at
 * synthesis/deployment time; this module neither reads workstation PostgreSQL
 * settings nor performs provider effects when imported.
 */
export const cloudflareDevelopmentStack = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== "development") {
    throw new Error("Cloudflare development stack requires stage 'development'");
  }

  const mailSender = yield* Config.string("CLOUDFLARE_DEVELOPMENT_MAIL_SENDER");
  const mailRecipient = yield* Config.string("CLOUDFLARE_DEVELOPMENT_MAIL_RECIPIENT");
  const tunnelId = yield* Config.string("CLOUDFLARE_DEVELOPMENT_TUNNEL_ID");
  const zoneId = yield* Config.string("CLOUDFLARE_DEVELOPMENT_ZONE_ID");
  yield* Cloudflare.DNS.Record("DevelopmentDatabaseOrigin", {
    zoneId,
    name: databaseOrigin,
    type: "CNAME",
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
  });
  const databaseClient = yield* Cloudflare.Access.ServiceToken("DevelopmentDatabaseClient", {
    name: "vektor-development-hyperdrive",
    duration: "8760h",
  });
  const databaseClientSecret = databaseClient.clientSecret.pipe(
    Output.map((secret) => {
      if (secret === undefined) {
        throw new Error("Development database Access service token has no client secret");
      }
      return secret;
    }),
  );
  const databasePolicy = yield* Cloudflare.Access.Policy("DevelopmentDatabasePolicy", {
    name: "vektor-development-hyperdrive",
    decision: "non_identity",
    include: [{ serviceToken: { tokenId: databaseClient.serviceTokenId } }],
  });
  yield* Cloudflare.Access.Application("DevelopmentDatabaseAccess", {
    type: "self_hosted",
    name: "Vektorprogrammet development database",
    domain: databaseOrigin,
    appLauncherVisible: false,
    policies: [databasePolicy.policyId],
  });
  const bucket = yield* Cloudflare.R2.Bucket("DevelopmentReceiptFiles", {
    name: "vektor-development-receipt-files",
  }).pipe(Alchemy.RemovalPolicy.retain());
  const email = yield* Cloudflare.Email.SendEmail("DevelopmentMail", {
    allowedSenderAddresses: [mailSender],
    destinationAddress: mailRecipient,
  });
  const hyperdriveOrigin = {
    scheme: "postgresql" as const,
    host: databaseOrigin,
    database: yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE"),
    user: yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE_USER"),
    password: Redacted.make(yield* Config.string("CLOUDFLARE_DEVELOPMENT_DATABASE_PASSWORD")),
    accessClientId: databaseClient.clientId.pipe(Output.map(Redacted.make)),
    accessClientSecret: databaseClientSecret,
  };
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("DevelopmentHyperdrive", {
    name: "vektor-development-hyperdrive",
    origin: hyperdriveOrigin,
    mtls: { sslmode: "require" },
  });

  return yield* Cloudflare.Worker("DevelopmentBackend", {
    main: workerMain,
    workersDev: false,
    routes: [
      { pattern: "vektor.phibkro.org/api/*", zoneName: "phibkro.org" },
      { pattern: "vektor.phibkro.org/health", zoneName: "phibkro.org" },
    ],
    crons: ["* * * * *"],
    compatibility: { flags: ["nodejs_compat"], date: "2026-09-22" },
    env: {
      HYPERDRIVE: hyperdrive,
      RECEIPT_FILES: bucket,
      MAIL: email,
      MAIL_SENDER: mailSender,
      MAIL_RECIPIENT_OVERRIDE: mailRecipient,
      BETTER_AUTH_SECRET: Redacted.make(
        yield* Config.string("CLOUDFLARE_DEVELOPMENT_BETTER_AUTH_SECRET"),
      ),
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([developmentOrigin]),
      OAUTH_CANONICAL_ORIGIN: developmentOrigin,
      OAUTH_DASHBOARD_ORIGIN: developmentOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    },
  });
});
