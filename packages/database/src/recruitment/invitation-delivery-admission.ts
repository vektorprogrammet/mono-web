import { Brand, Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import {
  OutboxClaimLost,
  releaseOutboxClaim,
  type OutboxClaim,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import type { DatabaseOperations } from "../service.js";
import { invitationOpen } from "./invitation-open.js";

interface InvitationClaim extends OutboxClaim {
  readonly request: { readonly invitationId: string; readonly interviewId: string };
}

type AdmittedInvitationAttempt = Brand.Branded<OutboxClaim, "AdmittedInvitationAttempt">;

const admittedInvitationAttempt = Brand.nominal<AdmittedInvitationAttempt>();

const AdmissionRow = Schema.Struct({ open: Schema.Boolean });

const decodeAdmissionRow = Schema.decodeUnknownEffect(AdmissionRow);

/**
 * Commits admission of one already validated, claim-fenced provider attempt. Cancellation and
 * supersession share the interview fence; take it before the outbox row, never the reverse.
 * Closed work is released without scrubbing its original envelope. Only Admitted may dispatch
 * after commit; a later cancellation cannot undo that admitted external attempt. Recovery still
 * fences acknowledgement. This promises at-least-once delivery, not external exactly-once.
 */
const admitInvitationDelivery = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: InvitationClaim,
): Effect.fn.Return<
  AdmittedInvitationAttempt | undefined,
  SqlError | Schema.SchemaError | OutboxClaimLost
> {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockAdvisory(sql, AdvisoryLockKey.recruitmentInterview(claim.request.interviewId));

      const rows = yield* sql`
        SELECT (${invitationOpen(sql)}) AS open
        FROM ${sql(table.name)} AS outbox
        INNER JOIN public.recruitment_invitations AS invitation
          ON invitation.invitation_id = outbox.invitation_id
          AND invitation.interview_id = outbox.interview_id
        WHERE outbox.effect_id = ${claim.effectId}
          AND outbox.status = 'Processing' AND outbox.claim_id = ${claim.claimId}
          AND invitation.invitation_id = ${claim.request.invitationId}
          AND invitation.interview_id = ${claim.request.interviewId}
        FOR UPDATE OF outbox
      `;

      if (rows[0] === undefined) return yield* new OutboxClaimLost(claim);
      const row = yield* decodeAdmissionRow(rows[0]);

      if (row.open) return admittedInvitationAttempt(claim);
      yield* releaseOutboxClaim(sql, table, claim, "InvalidatedRecruitmentInvitation");

      return undefined;
    }),
  );
});

/** Owns the admission proof and dispatches once, after its transaction has committed. */
export const dispatchInvitationDelivery = Effect.fnUntraced(function* <A, E, R>(
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: InvitationClaim,
  deliver: Effect.Effect<A, E, R>,
  invalidated: A,
): Effect.fn.Return<A, E | SqlError | Schema.SchemaError | OutboxClaimLost, R> {
  const admitted = yield* admitInvitationDelivery(sql, table, claim);

  return admitted === undefined ? invalidated : yield* deliver;
});
