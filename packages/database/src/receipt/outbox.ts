import { Database } from "../service.js";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  recoverStaleOutboxClaim,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import { Match, Effect, Schema, Semaphore, Clock } from "effect";
import {
  ReceiptAuxiliaryEffects,
  ReceiptFileService,
  ReceiptPersistenceError,
  ReceiptOutboxRequestSchema,
  type ClaimedReceiptOutbox,
  type ReceiptAuxiliaryEffectConflict,
  type ReceiptDeliveryUnavailable,
  type ReceiptFileFailure,
  ReceiptOutboxDeliveryResult,
  type ReceiptOutboxRequest,
} from "@vektorprogrammet/domain/receipt";

// Shared by request-time drains and the unattended worker, before any claim is held.
const deliveryPermit = Semaphore.makeUnsafe(1);

interface ClaimedOutboxRow {
  readonly effect_id: string;
  readonly command_id: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly payload_json: unknown;
}

interface ClaimIdRow {
  readonly claim_id: string;
}

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

const requireActiveClaim = (
  transitioned: boolean,
  operation: string,
): Effect.Effect<void, ReceiptPersistenceError> =>
  transitioned
    ? Effect.void
    : Effect.fail(
        new ReceiptPersistenceError({
          operation,
          message: "active Receipt outbox claim was not found",
        }),
      );

const receiptOutbox: OutboxTable = { name: "economy_receipt_outbox", terminalPayload: "Retain" };

export const claimNextReceiptOutbox = (
  claimId: string,
  claimedAt: string,
  receiptId?: string,
): Effect.Effect<ClaimedReceiptOutbox | undefined, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const receiptScope = receiptId ?? null;

    const rows = yield* sql
      .withTransaction(
        sql<ClaimedOutboxRow>`
      WITH candidate AS (
        SELECT outbox.effect_id
        FROM economy_receipt_outbox AS outbox
        JOIN economy_receipt_command_receipts AS command_receipt
          ON command_receipt.command_id = outbox.command_id
        WHERE outbox.status IN ('Pending', 'Failed')
          AND (${receiptScope}::text IS NULL OR outbox.receipt_id = ${receiptScope})
          AND NOT EXISTS (
            SELECT 1
            FROM economy_receipt_outbox AS predecessor
            JOIN economy_receipt_command_receipts AS predecessor_command
              ON predecessor_command.command_id = predecessor.command_id
            WHERE predecessor.receipt_id = outbox.receipt_id
              AND (
                predecessor_command.committed_at,
                predecessor.command_id,
                predecessor.ordinal
              ) < (
                command_receipt.committed_at,
                outbox.command_id,
                outbox.ordinal
              )
              AND predecessor.status <> 'Delivered'
          )
        ORDER BY outbox.attempts, command_receipt.committed_at, outbox.command_id, outbox.ordinal
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
      )
      UPDATE economy_receipt_outbox AS claimed
      SET ${outboxClaimAssignments(sql, "claimed", claimId, claimedAt)}
      FROM candidate
      WHERE claimed.effect_id = candidate.effect_id
      RETURNING claimed.effect_id, claimed.command_id, claimed.ordinal,
        claimed.attempts, claimed.payload_json
    `,
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("claim Receipt outbox", cause)),
        ),
      );

    const row = rows[0];

    if (row === undefined) return undefined;

    const request = yield* Schema.decodeUnknownEffect(ReceiptOutboxRequestSchema)(
      row.payload_json,
      {
        onExcessProperty: "error",
      },
    ).pipe(Effect.mapError((cause) => persistenceError("decode Receipt outbox request", cause)));

    if (request.effectId !== row.effect_id || request.commandId !== row.command_id) {
      return yield* Effect.fail(
        new ReceiptPersistenceError({
          operation: "decode Receipt outbox request",
          message: "outbox envelope does not match its durable identity",
        }),
      );
    }

    return {
      effectId: row.effect_id,
      commandId: row.command_id,
      ordinal: row.ordinal,
      attempts: row.attempts,
      claimId,
      request,
    };
  });

export const completeReceiptOutbox = (
  claim: ClaimedReceiptOutbox,
): Effect.Effect<void, ReceiptPersistenceError, Database> =>
  Database.use((sql) => markOutboxDelivered(sql, receiptOutbox, claim)).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("complete Receipt outbox", cause)),
    ),
    Effect.flatMap((delivered) => requireActiveClaim(delivered, "complete Receipt outbox")),
  );

export const failReceiptOutbox = (
  claim: ClaimedReceiptOutbox,
  failureTag: string,
): Effect.Effect<void, ReceiptPersistenceError, Database> =>
  Database.use((sql) => markOutboxFailed(sql, receiptOutbox, claim, failureTag)).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("fail Receipt outbox", cause)),
    ),
    Effect.flatMap((failed) => requireActiveClaim(failed, "fail Receipt outbox")),
  );

export const listStaleReceiptOutboxClaimIds = (
  claimedBefore: string,
  receiptId?: string,
): Effect.Effect<ReadonlyArray<string>, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const receiptScope = receiptId ?? null;

    const rows = yield* sql
      .withTransaction(
        sql<ClaimIdRow>`
        SELECT DISTINCT claim_id
        FROM economy_receipt_outbox
        WHERE status = 'Processing'
          AND claim_id IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claimed_at < ${claimedBefore}
          AND (${receiptScope}::text IS NULL OR receipt_id = ${receiptScope})
        ORDER BY claim_id
        LIMIT 256
      `,
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("list stale Receipt outbox claims", cause)),
        ),
      );

    return rows.map((row) => row.claim_id);
  });

export const recoverStaleReceiptOutbox = (
  claimId: string,
  claimedBefore: string,
): Effect.Effect<number, ReceiptPersistenceError, Database> =>
  Database.use((sql) =>
    recoverStaleOutboxClaim(sql, receiptOutbox, claimId, claimedBefore, {
      status: "Failed",
      failureTag: "StaleReceiptOutboxClaim",
    }),
  ).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("recover stale Receipt outbox", cause)),
    ),
  );

const interpretReceiptOutbox = (
  request: ReceiptOutboxRequest,
  claimId: string,
): Effect.Effect<
  void,
  ReceiptFileFailure | ReceiptAuxiliaryEffectConflict | ReceiptDeliveryUnavailable,
  ReceiptFileService | ReceiptAuxiliaryEffects
> => {
  return Match.value(request).pipe(
    Match.tag("PromoteReceiptFile", "DeleteReceiptFile", (request) => {
      return ReceiptFileService.use(({ apply }) => apply(request));
    }),
    Match.tag(
      "NotifyEconomyReceiptSubmitted",
      "NotifyReceiptApproved",
      "NotifyReceiptRejected",
      "NotifyReceiptSettled",
      "WriteReceiptAudit",
      (request) => {
        return ReceiptAuxiliaryEffects.use(({ apply }) => apply(request, claimId));
      },
    ),
    Match.exhaustive,
  );
};

export const deliverNextReceiptOutbox = (
  claimId: string,
  claimedAt: string,
  receiptId?: string,
): Effect.Effect<
  ReceiptOutboxDeliveryResult,
  ReceiptPersistenceError,
  Database | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.gen(function* () {
    const waitingSince = yield* Clock.currentTimeMillis;

    return yield* deliveryPermit.withPermit(
      Effect.gen(function* () {
        const acquiredAt = new Date(
          Date.parse(claimedAt) + Math.max(0, (yield* Clock.currentTimeMillis) - waitingSince),
        ).toISOString();

        const claim = yield* claimNextReceiptOutbox(claimId, acquiredAt, receiptId);

        if (claim === undefined) return ReceiptOutboxDeliveryResult.Idle();

        return yield* interpretReceiptOutbox(claim.request, claim.claimId).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failReceiptOutbox(claim, failure._tag).pipe(
                Effect.as(ReceiptOutboxDeliveryResult.Failed({ claim, failureTag: failure._tag })),
              ),
            onSuccess: () =>
              completeReceiptOutbox(claim).pipe(
                Effect.as(ReceiptOutboxDeliveryResult.Delivered({ claim })),
              ),
          }),
        );
      }),
    );
  });
