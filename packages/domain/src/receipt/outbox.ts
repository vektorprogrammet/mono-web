import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import {
  ReceiptAuxiliaryEffects,
  type ReceiptAuxiliaryEffectConflict,
  type ReceiptAuxiliaryRequest,
} from "./auxiliary-service.js";
import { ReceiptOutboxRequestSchema, type ReceiptOutboxRequest } from "./effects.js";
import type { ReceiptFileFailure } from "./file-errors.js";
import { ReceiptFileService, type ReceiptFileRequest } from "./file-service.js";
import { ReceiptPersistenceError } from "./errors.js";

interface ClaimedOutboxRow {
  readonly effect_id: string;
  readonly command_id: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly payload_json: unknown;
}

interface CountRow {
  readonly count: string;
}

export interface ClaimedReceiptOutbox {
  readonly effectId: string;
  readonly commandId: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly claimId: string;
  readonly request: ReceiptOutboxRequest;
}

export type ReceiptOutboxDeliveryResult =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Delivered"; readonly claim: ClaimedReceiptOutbox }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedReceiptOutbox;
      readonly failureTag: string;
    };

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

const requireSingleUpdate = (
  rows: ReadonlyArray<unknown>,
  operation: string,
): Effect.Effect<void, ReceiptPersistenceError> =>
  rows.length === 1
    ? Effect.void
    : Effect.fail(
        new ReceiptPersistenceError({
          operation,
          message: "active Receipt outbox claim was not found",
        }),
      );

export const claimNextReceiptOutbox = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<ClaimedReceiptOutbox | undefined, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql
      .withTransaction(
        sql<ClaimedOutboxRow>`
        WITH candidate AS (
          SELECT outbox.effect_id
          FROM economy_receipt_outbox AS outbox
          JOIN economy_receipt_command_receipts AS command_receipt
            ON command_receipt.command_id = outbox.command_id
          WHERE outbox.status IN ('Pending', 'Failed')
            AND NOT EXISTS (
              SELECT 1
              FROM economy_receipt_outbox AS predecessor
              WHERE predecessor.command_id = outbox.command_id
                AND predecessor.ordinal < outbox.ordinal
                AND predecessor.status <> 'Delivered'
            )
          ORDER BY command_receipt.committed_at, outbox.command_id, outbox.ordinal
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
        )
        UPDATE economy_receipt_outbox AS claimed SET
          status = 'Processing',
          attempts = claimed.attempts + 1,
          claim_id = ${claimId},
          claimed_at = ${claimedAt},
          last_failure_tag = NULL
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
): Effect.Effect<void, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly effect_id: string }>`
      UPDATE economy_receipt_outbox SET
        status = 'Delivered', claim_id = NULL, claimed_at = NULL, last_failure_tag = NULL
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("complete Receipt outbox", cause)),
      ),
    );
    yield* requireSingleUpdate(rows, "complete Receipt outbox");
  });

export const failReceiptOutbox = (
  claim: ClaimedReceiptOutbox,
  failureTag: string,
): Effect.Effect<void, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly effect_id: string }>`
      UPDATE economy_receipt_outbox SET
        status = 'Failed', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = ${failureTag}
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("fail Receipt outbox", cause)),
      ),
    );
    yield* requireSingleUpdate(rows, "fail Receipt outbox");
  });

export const recoverStaleReceiptOutbox = (
  claimedBefore: string,
): Effect.Effect<number, ReceiptPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<CountRow>`
      WITH recovered AS (
        UPDATE economy_receipt_outbox SET
          status = 'Failed', claim_id = NULL, claimed_at = NULL,
          last_failure_tag = 'StaleReceiptOutboxClaim'
        WHERE status = 'Processing' AND claimed_at < ${claimedBefore}
        RETURNING 1
      )
      SELECT count(*)::text AS count FROM recovered
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("recover stale Receipt outbox", cause)),
      ),
    );
    return Number(rows[0]?.count ?? "0");
  });

const interpretReceiptOutbox = (
  request: ReceiptOutboxRequest,
): Effect.Effect<
  void,
  ReceiptFileFailure | ReceiptAuxiliaryEffectConflict,
  ReceiptFileService | ReceiptAuxiliaryEffects
> => {
  switch (request._tag) {
    case "PromoteReceiptFile":
    case "DeleteReceiptFile":
      return ReceiptFileService.use(({ apply }) => apply(request as ReceiptFileRequest));
    case "NotifyEconomyReceiptSubmitted":
    case "NotifyReceiptRefunded":
    case "NotifyReceiptRejected":
    case "WriteReceiptAudit":
      return ReceiptAuxiliaryEffects.use(({ apply }) => apply(request as ReceiptAuxiliaryRequest));
  }
};

export const deliverNextReceiptOutbox = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ReceiptOutboxDeliveryResult,
  ReceiptPersistenceError,
  PgClient.PgClient | ReceiptFileService | ReceiptAuxiliaryEffects
> =>
  Effect.gen(function* () {
    const claim = yield* claimNextReceiptOutbox(claimId, claimedAt);
    if (claim === undefined) return { _tag: "Idle" as const };

    return yield* interpretReceiptOutbox(claim.request).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          failReceiptOutbox(claim, failure._tag).pipe(
            Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
          ),
        onSuccess: () =>
          completeReceiptOutbox(claim).pipe(Effect.as({ _tag: "Delivered" as const, claim })),
      }),
    );
  });
