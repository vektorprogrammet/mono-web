import { expect, layer } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { DatabaseTestLive } from "./test-support/platform.js";
import { Database } from "./service.js";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  releaseOutboxClaim,
  type OutboxTable,
} from "./outbox-lifecycle.js";

// A table with only the columns that the module contract requires.
const probe: OutboxTable = { name: "outbox_lifecycle_probe", terminalPayload: "Scrub" };

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "claim-fenced outbox transitions",
  (it) => {
    it.effect(
      "change nothing and fail with OutboxClaimLost after stale recovery took the claim",
      () =>
        Effect.gen(function* () {
          const claim = { effectId: "probe-effect", claimId: "probe-worker:1" };

          const evidence = yield* Effect.gen(function* () {
            const sql = yield* Database;
            yield* sql`
          CREATE TABLE outbox_lifecycle_probe (
            effect_id text PRIMARY KEY,
            status text NOT NULL,
            attempts integer NOT NULL DEFAULT 0,
            claim_id text,
            claimed_at timestamptz,
            last_failure_tag text,
            delivered_at timestamptz,
            payload_json jsonb NOT NULL
          )
        `;
            yield* sql`
          INSERT INTO outbox_lifecycle_probe (effect_id, status, payload_json)
          VALUES (${claim.effectId}, 'Pending', '{"probe":true}'::jsonb)
        `;
            yield* sql`
          UPDATE outbox_lifecycle_probe AS outbox
          SET ${outboxClaimAssignments(sql, "outbox", claim.claimId, "2031-01-01T00:00:00.000Z")}
          WHERE effect_id = ${claim.effectId}
        `;

            const recovered = yield* recoverStaleOutboxClaims(
              sql,
              probe,
              "2031-01-01T00:01:00.000Z",
              {
                status: "Failed",
                failureTag: "StaleClaim",
              },
            );

            const lost = yield* Effect.all([
              Effect.flip(
                markOutboxDelivered(sql, probe, claim, { deliveredAt: "2031-01-01T00:02:00.000Z" }),
              ),
              Effect.flip(markOutboxFailed(sql, probe, claim, "ProviderRejected")),
              Effect.flip(quarantineOutboxClaim(sql, probe, claim, "EnvelopeMismatch")),
            ]);

            yield* releaseOutboxClaim(sql, probe, claim, "InterruptedClaim");

            const rows = yield* sql`
          SELECT status, attempts, claim_id AS "claimId", last_failure_tag AS "lastFailureTag",
            delivered_at AS "deliveredAt", payload_json AS payload
          FROM outbox_lifecycle_probe
        `;

            return {
              recovered,
              lost: lost.map((failure) =>
                Predicate.isTagged(failure, "OutboxClaimLost")
                  ? { effectId: failure.effectId, claimId: failure.claimId }
                  : failure._tag,
              ),
              rows,
            };
          });

          expect(evidence.recovered).toBe(1);
          expect(evidence.lost).toEqual([claim, claim, claim]);
          expect(evidence.rows).toEqual([
            {
              status: "Failed",
              attempts: 1,
              claimId: null,
              lastFailureTag: "StaleClaim",
              deliveredAt: null,
              payload: { probe: true },
            },
          ]);
        }),
      30_000,
    );
  },
);
