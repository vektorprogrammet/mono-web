import process from "node:process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Config, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Mail } from "@vektorprogrammet/domain/mail";
import { DatabasePgPool, DatabaseLive } from "@vektorprogrammet/database/live";
import { drainPasswordResetMail } from "@vektorprogrammet/database/password-recovery";
import { decodeBackendConfig } from "../config.js";
import { mailDeliveryConfig, HttpMailLive } from "../mail/http.js";

if (process.argv.length !== 3 || process.argv[2] !== "--once")
  throw new Error("Usage: bun run apps/backend/src/password-recovery/drain-main.ts --once");

// An unset or empty variable is missing.
const sender = Effect.runSync(Config.String("MAIL_SENDER").pipe(Config.withDefault("")));

if (!sender) throw new Error("MAIL_SENDER is required");

const config = Effect.runSync(decodeBackendConfig(process.env));

try {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const mail = yield* Mail;

      return yield* drainPasswordResetMail(pool, config.auth, mail, sender);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DatabaseLive({ url: Redacted.make(config.auth.postgresUrl), maxConnections: 2 }).pipe(
            Layer.provide(BunServices.layer),
          ),
          HttpMailLive(mailDeliveryConfig(process.env)).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      ),
    ),
  );

  process.stdout.write(JSON.stringify({ result }) + "\n");
  process.exitCode = result === "Delivered" || result === "Empty" ? 0 : 1;
} catch {
  process.stderr.write("Password recovery drain unavailable\n");
  process.exitCode = 1;
}
