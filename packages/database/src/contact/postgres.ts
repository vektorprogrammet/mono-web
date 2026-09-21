import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import { ContactFailure, ContactQuota } from "@vektorprogrammet/domain/contact";

export const ContactQuotaLive = Layer.effect(
  ContactQuota,
  Effect.gen(function* () {
    const sql = yield* Database;
    return ContactQuota.of({
      consume: (ip) =>
        Effect.gen(function* () {
          // Separate autocommit statements: no delivery/recipient failure can roll this back.
          yield* sql`DELETE FROM public.contact_rate_windows WHERE expires_at <= statement_timestamp()`;
          const admitted = yield* sql`
      INSERT INTO public.contact_rate_windows (visitor_ip, attempts, expires_at)
      VALUES (${ip}::inet, 1, statement_timestamp() + interval '1 hour')
      ON CONFLICT (visitor_ip) DO UPDATE SET
        attempts = CASE WHEN contact_rate_windows.expires_at <= statement_timestamp() THEN 1 ELSE contact_rate_windows.attempts + 1 END,
        expires_at = CASE WHEN contact_rate_windows.expires_at <= statement_timestamp() THEN statement_timestamp() + interval '1 hour' ELSE contact_rate_windows.expires_at END
      WHERE contact_rate_windows.expires_at <= statement_timestamp() OR contact_rate_windows.attempts < 5
      RETURNING attempts`;
          if (admitted.length === 0)
            return yield* Effect.fail(new ContactFailure({ reason: "RateLimited" }));
        }).pipe(
          Effect.mapError((error) =>
            error instanceof ContactFailure ? error : new ContactFailure({ reason: "Unavailable" }),
          ),
        ),
    });
  }),
);
