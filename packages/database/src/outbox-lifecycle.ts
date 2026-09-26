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

/**
 * SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.
 *
 * @remarks
 * The fragment sets `status = 'Processing'`, the claim's `claim_id` and `claimed_at`, increments
 * `attempts` from the row that `targetAlias` names, and clears `last_failure_tag`. The aggregate
 * keeps the rest of its claim UPDATE: candidate selection, predecessor ordering, row locks, and
 * the RETURNING list. Attempts count claims; no other transition changes them.
 *
 * @sideEffects none: it builds a fragment, and the aggregate's UPDATE writes the row.
 *
 * @example
 * ```ts
 * sql`UPDATE economy_receipt_outbox AS claimed SET ${outboxClaimAssignments(sql, "claimed", claimId, claimedAt)} FROM candidate WHERE claimed.effect_id = candidate.effect_id`;
 * ```
 *
 * @avoid Writing the claim columns by hand: a copy can miss the attempt count or keep the last
 * failure tag, and it copies the column protocol that every outbox table shares. Put this SET
 * list in every claim UPDATE.
 *
 * @construct sql-lifecycle
 */
export const outboxClaimAssignments = (
  sql: DatabaseOperations,
  targetAlias: string,
  claimId: string,
  claimedAt: string,
): Statement.Fragment =>
  sql`status = 'Processing', claim_id = ${claimId}, claimed_at = ${claimedAt},
    attempts = ${sql(targetAlias)}.attempts + 1, last_failure_tag = NULL`;

/**
 * Settles the claimed row as Delivered, with delivery evidence when the table records it.
 *
 * @remarks
 * One UPDATE matches the row's `effect_id`, `status = 'Processing'`, and the claim's `claim_id`.
 * It sets `Delivered`, clears the claim and `last_failure_tag`, writes `delivered_at` and
 * `provider_reference` when `evidence` carries them, and replaces `payload_json` with `{}` when
 * `table.terminalPayload` is `Scrub`. When no row matches, stale recovery or another claim owns
 * the row, so it changes nothing and fails with `OutboxClaimLost`.
 *
 * @sideEffects Writes the outbox row that the claim still owns.
 *
 * @example
 * ```ts
 * Database.use((sql) => markOutboxDelivered(sql, receiptOutbox, claim));
 * ```
 *
 * @avoid Updating the status by `effect_id` alone, or reporting a delivery after
 * `OutboxClaimLost`: the row belongs to another claim, whose outcome would be overwritten. Handle
 * `OutboxClaimLost` as a lost race, not as a success.
 *
 * @construct sql-lifecycle
 */
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

/**
 * Settles the claimed row as Failed with its failure tag, so a later claim retries it.
 *
 * @remarks
 * Under the same claim fence as `markOutboxDelivered`, it sets `Failed` and `last_failure_tag`,
 * clears the claim, and keeps `payload_json`, because a later claim delivers the same envelope.
 * When the claim no longer owns the row, it changes nothing and fails with `OutboxClaimLost`.
 *
 * @sideEffects Writes the outbox row that the claim still owns.
 *
 * @example
 * ```ts
 * Database.use((sql) => markOutboxFailed(sql, receiptOutbox, claim, failureTag));
 * ```
 *
 * @avoid Failing a row that no retry can deliver, such as an envelope that does not decode: a
 * later claim takes it again. Quarantine it with `quarantineOutboxClaim`.
 *
 * @construct sql-lifecycle
 */
export const markOutboxFailed = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claim: OutboxClaim,
  failureTag: string,
): Effect.Effect<void, OutboxClaimLost | SqlError> =>
  settleClaim(sql, table, claim, sql`status = 'Failed', last_failure_tag = ${failureTag}`);

/**
 * Settles the claimed row as Quarantined, a terminal status, with its failure tag.
 *
 * @remarks
 * Under the same claim fence as `markOutboxDelivered`, it sets `Quarantined` and
 * `last_failure_tag`, clears the claim, and replaces `payload_json` with `{}` when
 * `table.terminalPayload` is `Scrub`. No claim selects a quarantined row again. When the claim no
 * longer owns the row, it changes nothing and fails with `OutboxClaimLost`.
 *
 * @sideEffects Writes the outbox row that the claim still owns.
 *
 * @example
 * ```ts
 * quarantineOutboxClaim(sql, notificationOutbox, { effectId, claimId }, failureTag);
 * ```
 *
 * @avoid Quarantining a failure that a retry can overcome, such as a provider outage: the effect
 * is then never delivered. Mark it failed with `markOutboxFailed`.
 *
 * @construct sql-lifecycle
 */
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

/**
 * Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.
 *
 * @remarks
 * A worker that is interrupted before the provider answers releases its claim. Under the same
 * claim fence as `markOutboxDelivered`, it sets `Pending` with the failure tag and clears the
 * claim, so the next claim delivers the row. When the claim no longer owns the row, it succeeds
 * without a change, because stale recovery or another claim has already moved the row.
 *
 * @sideEffects Writes the outbox row when the claim still owns it.
 *
 * @example
 * ```ts
 * releaseOutboxClaim(sql, invitationOutbox, claim, "InterruptedRecruitmentInvitationClaim");
 * ```
 *
 * @avoid Releasing a claim after the provider answered: the next claim sends the effect again.
 * Settle an answered delivery with `markOutboxDelivered` or `markOutboxFailed`.
 *
 * @construct sql-lifecycle
 */
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

/**
 * Recovers every Processing row claimed before `claimedBefore`.
 *
 * @remarks
 * One UPDATE moves each `Processing` row whose `claimed_at` lies before `claimedBefore` to
 * `recovery.status`, `Pending` or `Failed`, with `recovery.failureTag`, clears its claim, and
 * answers the number of rows it recovered. The worker of such a claim counts as gone; if it still
 * runs, its settlement fails with `OutboxClaimLost`.
 *
 * @sideEffects Writes every stale Processing row of the table.
 *
 * @example
 * ```ts
 * recoverStaleOutboxClaims(sql, invitationOutbox, claimedBefore, { status: "Failed", failureTag: "StaleClaimRecovered" });
 * ```
 *
 * @avoid A cutoff that a live claim can still reach, such as one closer to now than the longest
 * provider call: the row goes to a second claim, which delivers the effect again. Derive
 * `claimedBefore` from the worker's stale-claim window, as now minus `staleClaimMilliseconds`.
 *
 * @construct sql-lifecycle
 */
export const recoverStaleOutboxClaims = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claimedBefore: string,
  recovery: OutboxStaleRecovery,
): Effect.Effect<number, SqlError> =>
  recoverStale(sql, table, recovery, sql`claimed_at < ${claimedBefore}`);

/**
 * Recovers the rows of one claim when that claim was taken before `claimedBefore`.
 */
export const recoverStaleOutboxClaim = (
  sql: DatabaseOperations,
  table: OutboxTable,
  claimId: string,
  claimedBefore: string,
  recovery: OutboxStaleRecovery,
): Effect.Effect<number, SqlError> =>
  recoverStale(sql, table, recovery, sql`claim_id = ${claimId} AND claimed_at < ${claimedBefore}`);
