/**
 * EX-0024: required public native SQL APIs retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { SqlClient } from "effect/sql";
import { Mail } from "@vektorprogrammet/domain/mail";
import { Duration, Effect } from "effect";
import { drainPasswordResetMail } from "@vektorprogrammet/database/password-recovery";
import type { BackendAuthConfig, PasswordResetDeliveryConfig } from "../config.js";
import { pollForever } from "../worker-support.js";

export const runPasswordResetDeliveryWorker = Effect.fn("runPasswordResetDeliveryWorker")(
  function* (auth: BackendAuthConfig, config: PasswordResetDeliveryConfig) {
    const pool = yield* SqlClient.SqlClient;
    const mail = yield* Mail;

    return yield* pollForever(drainPasswordResetMail(pool, auth, mail, config.sender), {
      interval: Duration.millis(config.pollIntervalMilliseconds),
    });
  },
);
