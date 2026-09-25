import { DateTime, Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Mail } from "@vektorprogrammet/domain/mail";
import {
  TeamApplicationEnvelope,
  TeamApplicationOutboxDelivery,
  type TeamApplicationNotification,
} from "@vektorprogrammet/domain/team-application";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  releaseOutboxClaim,
  type OutboxClaim,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import { Database, type DatabaseOperations } from "../service.js";
import { persistenceFailure } from "./persistence.js";

/**
 * The payload is the private mail envelope, so every terminal transition scrubs it.
 * Deletion cancels the remaining effects of one application with the same scrub.
 */
const teamApplicationOutbox: OutboxTable = {
  name: "team_application_outbox",
  terminalPayload: "Scrub",
};

interface ClaimedRow {
  readonly effectId: string;
  readonly payload: unknown;
}

export const insertTeamApplicationOutbox = (
  notification: TeamApplicationNotification,
  ordinal: number,
  committedAt: string,
) =>
  Database.use(
    (sql) => sql`
      INSERT INTO public.team_application_outbox (
        effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json,
        committed_at
      ) VALUES (
        ${notification.request.effectId}, ${notification.request._tag},
        ${notification.request.teamId}, ${notification.request.applicationId},
        ${notification.request.commandId}, ${ordinal},
        ${sql.json(Schema.encodeSync(TeamApplicationEnvelope)(notification.envelope))},
        ${committedAt}
      )
    `,
  ).pipe(Effect.asVoid, Effect.mapError(persistenceFailure("insert team application outbox")));

/** Claims the due effect with the fewest attempts; the notifications of one application are independent. */
const claimNext = (claimId: string, claimedAt: string) =>
  Database.use(
    (sql) => sql<ClaimedRow>`
      WITH candidate AS (
        SELECT effect_id
        FROM public.team_application_outbox
        WHERE status IN ('Pending', 'Failed')
        ORDER BY attempts, committed_at, effect_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.team_application_outbox AS claimed
      SET ${outboxClaimAssignments(sql, "claimed", claimId, claimedAt)}
      FROM candidate
      WHERE claimed.effect_id = candidate.effect_id
      RETURNING claimed.effect_id AS "effectId", claimed.payload_json AS payload
    `,
  ).pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0])),
    Effect.mapError(persistenceFailure("claim team application outbox")),
  );

/** Records a transition only while `claim` still holds the effect; returns whether it did. */
const settle = (
  operation: string,
  transition: (sql: DatabaseOperations) => Effect.Effect<boolean, SqlError>,
) => Database.use(transition).pipe(Effect.mapError(persistenceFailure(operation)));

/** Returns abandoned claims to Failed; the next claim increments the attempt. */
export const recoverStaleTeamApplicationOutbox = (claimedBefore: string) =>
  Database.use((sql) =>
    recoverStaleOutboxClaims(sql, teamApplicationOutbox, claimedBefore, {
      status: "Failed",
      failureTag: "StaleTeamApplicationOutboxClaim",
    }),
  ).pipe(Effect.mapError(persistenceFailure("recover stale team application outbox claims")));

/** Deletion stops every undelivered notification of the application and clears its envelope. */
export const cancelTeamApplicationOutbox = (applicationId: string) =>
  Database.use(
    (sql) => sql`
      UPDATE public.team_application_outbox SET
        status = 'Cancelled', payload_json = '{}'::jsonb, claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'TeamApplicationDeleted'
      WHERE application_id = ${applicationId}
        AND status IN ('Pending', 'Processing', 'Failed')
    `,
  ).pipe(Effect.asVoid, Effect.mapError(persistenceFailure("cancel team application outbox")));

/**
 * Claims one due effect, attempts delivery after the claim commits, and records the
 * outcome only while the claim is still held. Deletion or stale recovery can take the
 * claim first; that outcome is ClaimLost, not a failure. Interruption releases the
 * claim to Pending without a provider outcome.
 */
export const deliverNextTeamApplicationOutbox = (claimId: string, sender: string) =>
  Effect.gen(function* () {
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* claimNext(claimId, claimedAt);

    if (Option.isNone(claimed)) return TeamApplicationOutboxDelivery.Idle();

    const claim: OutboxClaim = { effectId: claimed.value.effectId, claimId };
    const { effectId } = claim;

    const envelope = Schema.decodeUnknownOption(TeamApplicationEnvelope)(claimed.value.payload, {
      onExcessProperty: "error",
    });

    if (Option.isNone(envelope) || envelope.value.deliveryId !== effectId) {
      const failureTag = "InvalidTeamApplicationEnvelope";

      const held = yield* settle("quarantine team application outbox", (sql) =>
        quarantineOutboxClaim(sql, teamApplicationOutbox, claim, failureTag),
      );

      return held
        ? TeamApplicationOutboxDelivery.Quarantined({ effectId, failureTag })
        : TeamApplicationOutboxDelivery.ClaimLost({ effectId });
    }

    return yield* Mail.use((mail) =>
      mail.deliver({
        deliveryId: envelope.value.deliveryId,
        sender,
        recipient: envelope.value.recipient,
        replyTo: envelope.value.replyTo,
        subject: envelope.value.subject,
        text: envelope.value.text,
      }),
    ).pipe(
      Effect.onInterrupt(() =>
        settle("release team application outbox", (sql) =>
          releaseOutboxClaim(
            sql,
            teamApplicationOutbox,
            claim,
            "InterruptedTeamApplicationOutboxClaim",
          ),
        ).pipe(Effect.ignore),
      ),
      Effect.matchEffect({
        onFailure: (failure) => {
          const failureTag = `MailDeliveryError:${failure.kind}`;

          return settle("fail team application outbox", (sql) =>
            markOutboxFailed(sql, teamApplicationOutbox, claim, failureTag),
          ).pipe(
            Effect.map((held) =>
              held
                ? TeamApplicationOutboxDelivery.Failed({ effectId, failureTag })
                : TeamApplicationOutboxDelivery.ClaimLost({ effectId }),
            ),
          );
        },
        onSuccess: () =>
          settle("deliver team application outbox", (sql) =>
            markOutboxDelivered(sql, teamApplicationOutbox, claim),
          ).pipe(
            Effect.map((held) =>
              held
                ? TeamApplicationOutboxDelivery.Delivered({ effectId })
                : TeamApplicationOutboxDelivery.ClaimLost({ effectId }),
            ),
          ),
      }),
    );
  });
