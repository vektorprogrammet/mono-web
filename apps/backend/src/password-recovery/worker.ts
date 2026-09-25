import { DatabasePgPool } from "@vektorprogrammet/database/live";
import { Mail } from "@vektorprogrammet/domain/mail";
import { Duration, Effect } from "effect";
import { drainPasswordResetMail } from "../../../../packages/database/src/password-recovery.js";
import type { BackendAuthConfig, PasswordResetDeliveryConfig } from "../config.js";
import { pollForever } from "../worker-support.js";

export const runPasswordResetDeliveryWorker = Effect.fn("runPasswordResetDeliveryWorker")(
  function* (auth: BackendAuthConfig, config: PasswordResetDeliveryConfig) {
    const pool = yield* DatabasePgPool;
    const mail = yield* Mail;

    return yield* pollForever(drainPasswordResetMail(pool, auth, mail, config.sender), {
      interval: Duration.millis(config.pollIntervalMilliseconds),
    });
  },
);
