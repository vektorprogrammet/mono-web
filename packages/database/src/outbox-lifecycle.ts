/**
 * Claim-fenced status transitions shared by PostgreSQL outbox tables.
 *
 * A participating table has `effect_id text PRIMARY KEY`, `status text`, `attempts integer`,
 * `claim_id text`, `claimed_at timestamptz`, and `last_failure_tag text`. Its CHECK constraint
 * sets `claim_id` and `claimed_at` only while `status = 'Processing'`. `Pending` and `Failed`
 * rows are claimable; `Delivered` and `Quarantined` rows are terminal.
 *
 * The owning aggregate keeps candidate selection, predecessor ordering, row locks, the claim
 * RETURNING list, payload decoding, envelope validation, failure tags, and retry policy.
 * This module writes the lifecycle columns, and `payload_json`, `delivered_at`, and
 * `provider_reference` only when the caller selects them:
 *
 * - `outboxClaimAssignments` is the SET list of a claim. It moves the selected row to
 *   `Processing`, stores the claim, increments `attempts`, and clears `last_failure_tag`.
 *   Attempts count claims; no other transition changes them.
 * - `markOutboxDelivered`, `markOutboxFailed`, `quarantineOutboxClaim`, and
 *   `releaseOutboxClaim` update the row only while its `effect_id`, `status = 'Processing'`,
 *   and `claim_id` match the claim, and they clear the claim. If the claim is no longer
 *   active, stale recovery or another claim owns the row. Then the first three change nothing
 *   and fail with `OutboxClaimLost`, so a caller cannot report their business outcome.
 *   `releaseOutboxClaim` succeeds, because a lost claim has nothing to release.
 * - `recoverStaleOutboxClaims` and `recoverStaleOutboxClaim` move `Processing` rows claimed
 *   before a cutoff to a claimable status and succeed with the number of recovered rows.
 *
 * `OutboxTable.terminalPayload` selects whether `Delivered` and `Quarantined` replace
 * `payload_json` with `{}`. A table with only the lifecycle columns uses `Retain` and
 * records no delivery evidence. SQL failures remain `SqlError` for the caller to map.
 */
import { Data, Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import type { DatabaseOperations } from "./service.js";

/** One claim-fenced outbox table and its terminal payload policy. */
export interface OutboxTable {
  /** Table name, schema-qualified when its adapter qualifies it. Rendered as an escaped identifier. */
  readonly name: string;
  /** `Scrub` replaces `payload_json` with `{}` when a row becomes Delivered or Quarantined. */
  readonly terminalPayload: "Scrub" | "Retain";
}

/** The fencing token that a worker holds for one Processing row. */
export interface OutboxClaim {
  readonly effectId: string;
  readonly claimId: string;
}

/** Delivery acknowledgement columns written with Delivered, for tables that record them. */
export interface OutboxDeliveryEvidence {
  readonly deliveredAt: string;
  readonly providerReference?: string;
}

/** The claimable status and failure tag given to a stale Processing row. */
export interface OutboxStaleRecovery {
  readonly status: "Pending" | "Failed";
  readonly failureTag: string;
}

/** The claim no longer owns its Processing row, so the transition changed nothing. */
export class OutboxClaimLost extends Data.TaggedError("OutboxClaimLost")<{
  readonly effectId: string;
  readonly claimId: string;
}> {}

const noAssignments = Statement.fragment([]);

const scrubbedPayload = Statement.fragment([Statement.literal(", payload_json = '{}'::jsonb")]);

const leaveProcessing = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  assignments: Statement.Fragment,
): Effect.Effect<boolean, SqlError> =>
  sql`
    UPDATE ${sql(table.name)}
    SET ${assignments}, claim_id = NULL, claimed_at = NULL
    WHERE effect_id = ${claim.effectId}
      AND status = 'Processing'
      AND claim_id = ${claim.claimId}
    RETURNING effect_id
  `.pipe(Effect.map((rows) => rows.length === 1));

const settleClaim = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  assignments: Statement.Fragment,
): Effect.Effect<void, OutboxClaimLost | SqlError> =>
  leaveProcessing(sql, table, claim, assignments).pipe(
    Effect.flatMap((settled) =>
      settled
        ? Effect.void
        : Effect.fail(new OutboxClaimLost({ effectId: claim.effectId, claimId: claim.claimId })),
    ),
  );

const recoverStale = (
  sql: DatabaseOperations,
  table: OutboxTable,
  recovery: OutboxStaleRecovery,
  stalePredicate: Statement.Fragment,
): Effect.Effect<number, SqlError> =>
  sql<{ readonly count: string }>`
    WITH recovered AS (
      UPDATE ${sql(table.name)}
      SET status = ${recovery.status}, claim_id = NULL, claimed_at = NULL,
        last_failure_tag = ${recovery.failureTag}
      WHERE status = 'Processing'
        AND ${stalePredicate}
      RETURNING 1
    )
    SELECT count(*)::text AS count FROM recovered
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? "0")));

/** SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row. */
export const outboxClaimAssignments = (
  sql: DatabaseOperations,
  targetAlias: string,
  claimId: string,
  claimedAt: string,
): Statement.Fragment =>
  sql`status = 'Processing', claim_id = ${claimId}, claimed_at = ${claimedAt},
    attempts = ${sql(targetAlias)}.attempts + 1, last_failure_tag = NULL`;

export const markOutboxDelivered = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  evidence?: OutboxDeliveryEvidence,
): Effect.Effect<void, OutboxClaimLost | SqlError> => {
  const payload = table.terminalPayload === "Scrub" ? scrubbedPayload : noAssignments;

  const deliveredAt =
    evidence === undefined ? noAssignments : sql`, delivered_at = ${evidence.deliveredAt}`;

  const providerReference =
    evidence?.providerReference === undefined
      ? noAssignments
      : sql`, provider_reference = ${evidence.providerReference}`;

  return settleClaim(
    sql,
    table,
    claim,
    sql`status = 'Delivered', last_failure_tag = NULL${payload}${deliveredAt}${providerReference}`,
  );
};

export const markOutboxFailed = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string,
): Effect.Effect<void, OutboxClaimLost | SqlError> =>
  settleClaim(sql, table, claim, sql`status = 'Failed', last_failure_tag = ${failureTag}`);

export const quarantineOutboxClaim = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string,
): Effect.Effect<void, OutboxClaimLost | SqlError> => {
  const payload = table.terminalPayload === "Scrub" ? scrubbedPayload : noAssignments;

  return settleClaim(
    sql,
    table,
    claim,
    sql`status = 'Quarantined', last_failure_tag = ${failureTag}${payload}`,
  );
};

/** Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none. */
export const releaseOutboxClaim = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string,
): Effect.Effect<void, SqlError> =>
  leaveProcessing(
    sql,
    table,
    claim,
    sql`status = 'Pending', last_failure_tag = ${failureTag}`,
  ).pipe(Effect.asVoid);

/** Recovers every Processing row claimed before `claimedBefore`. */
export const recoverStaleOutboxClaims = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claimedBefore: string,
  recovery: OutboxStaleRecovery,
): Effect.Effect<number, SqlError> =>
  recoverStale(sql, table, recovery, sql`claimed_at < ${claimedBefore}`);

/** Recovers the rows of one claim when that claim was taken before `claimedBefore`. */
export const recoverStaleOutboxClaim = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claimId: string,
  claimedBefore: string,
  recovery: OutboxStaleRecovery,
): Effect.Effect<number, SqlError> =>
  recoverStale(sql, table, recovery, sql`claim_id = ${claimId} AND claimed_at < ${claimedBefore}`);
