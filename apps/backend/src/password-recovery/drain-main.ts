import { makeAuthPool } from "../../../../packages/database/src/auth-engine.js";
import { drainPasswordResetMail } from "../../../../packages/database/src/password-recovery.js";
import { makeBackendConfig } from "../config.js";
import { mailDeliveryConfig, makeHttpMailDelivery } from "../mail/http.js";

if (process.argv.length !== 3 || process.argv[2] !== "--once")
  throw new Error("Usage: bun run apps/backend/src/password-recovery/drain-main.ts --once");

const sender = process.env.MAIL_SENDER;
if (!sender) throw new Error("MAIL_SENDER is required");

const config = makeBackendConfig();
const pool = makeAuthPool(config.auth);
try {
  const result = await drainPasswordResetMail(
    pool,
    config.auth,
    makeHttpMailDelivery(mailDeliveryConfig(process.env)),
    sender,
  );
  process.stdout.write(JSON.stringify({ result }) + "\n");
  process.exitCode = result === "Delivered" || result === "Empty" ? 0 : 1;
} catch {
  process.stderr.write("Password recovery drain unavailable\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
