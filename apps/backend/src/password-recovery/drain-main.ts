import { Effect, Layer, Redacted } from "effect";
import { Mail } from "@vektorprogrammet/domain/mail";
import { DatabasePgPool, DatabaseLive } from "@vektorprogrammet/database/live";
import { drainPasswordResetMail } from "../../../../packages/database/src/password-recovery.js";
import { decodeBackendConfig } from "../config.js";
import { mailDeliveryConfig, HttpMailLive } from "../mail/http.js";

if (process.argv.length !== 3 || process.argv[2] !== "--once")
  throw new Error("Usage: bun run apps/backend/src/password-recovery/drain-main.ts --once");

const sender = process.env.MAIL_SENDER;

if (!sender) throw new Error("MAIL_SENDER is required");

const config = decodeBackendConfig(process.env);

try {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const mail = yield* Mail;

      return yield* drainPasswordResetMail(pool, config.auth, mail, sender);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DatabaseLive({ url: Redacted.make(config.auth.postgresUrl), maxConnections: 2 }),
          HttpMailLive(mailDeliveryConfig(process.env)),
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
