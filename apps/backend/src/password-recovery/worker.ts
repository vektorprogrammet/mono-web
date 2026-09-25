import { DatabasePgPool } from "@vektorprogrammet/database/live";
import { Mail } from "@vektorprogrammet/domain/mail";
import { Duration, Effect } from "effect";
import { drainPasswordResetMail } from "../../../../packages/database/src/password-recovery.js";
import type { BackendAuthConfig, PasswordResetDeliveryConfig } from "../config.js";

export const runPasswordResetDeliveryWorker = Effect.fn("runPasswordResetDeliveryWorker")(
  function* (auth: BackendAuthConfig, config: PasswordResetDeliveryConfig) {
    const pool = yield* DatabasePgPool;
    const mail = yield* Mail;

    return yield* Effect.forever(
      drainPasswordResetMail(pool, auth, mail, config.sender).pipe(
        Effect.andThen(Effect.sleep(Duration.millis(config.pollIntervalMilliseconds))),
      ),
    );
  },
);
