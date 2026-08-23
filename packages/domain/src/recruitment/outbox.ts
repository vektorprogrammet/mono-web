import { Database, type DatabaseShape } from "../database/service.js";
import { NotificationGateway } from "../notification/service.js";
import { canonicalJson, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import { RecruitmentDecodeError, RecruitmentPersistenceError } from "./errors.js";
import {
  RecruitmentInvitationOutboxRequestSchema,
  type RecruitmentInvitationOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "./effects.js";

interface ClaimedInvitationRow {
  readonly effectId: string;
  readonly commandId: string;
  readonly interviewId: string;
  readonly invitationId: string;
  readonly scheduleRevision: number;
  readonly claimId: string;
  readonly attempts: number;
  readonly payloadJson: unknown;
  readonly capabilitySha256: string;
}

const ClaimedInvitationRowSchema = Schema.Struct({
  effectId: Schema.String,
  commandId: Schema.String,
  interviewId: Schema.String,
  invitationId: Schema.String,
  scheduleRevision: Schema.Number,
  claimId: Schema.String,
  attempts: Schema.Number,
  payloadJson: Schema.Unknown,
  capabilitySha256: Schema.String,
});

export interface ClaimedRecruitmentInvitation {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: RecruitmentInvitationOutboxRequest;
}

export type RecruitmentInvitationDeliveryResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Delivered";
      readonly claim: ClaimedRecruitmentInvitation;
      readonly evidence: RecruitmentNotificationEvidence;
    }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedRecruitmentInvitation;
      readonly failureTag: string;
    };

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : "recruitment outbox persistence failed",
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new RecruitmentDecodeError({
          message: cause instanceof Error ? cause.message : `invalid ${operation}`,
        }),
    ),
  );

const quarantineClaim = (
  sql: DatabaseShape,
  effectId: string,
  claimId: string,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError> =>
  sql`
    UPDATE recruitment_invitation_outbox
    SET status = 'Quarantined', claim_id = NULL, claimed_at = NULL,
      last_failure_tag = ${failureTag}, payload_json = '{}'::jsonb
    WHERE effect_id = ${effectId}
      AND status = 'Processing'
      AND claim_id = ${claimId}
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("quarantine invitation outbox claim", cause)),
    ),
  );

const claimInTransaction = (
  sql: DatabaseShape,
  claimId: string,
  claimedAt: string,
): Effect.Effect<ClaimedRecruitmentInvitation | undefined, RecruitmentPersistenceError | RecruitmentDecodeError> =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedInvitationRow>`
      WITH candidate AS (
        SELECT effect_id
        FROM recruitment_invitation_outbox
        WHERE status IN ('Pending', 'Failed')
        ORDER BY command_id ASC, ordinal ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE recruitment_invitation_outbox AS outbox
      SET status = 'Processing', claim_id = ${claimId}, claimed_at = ${claimedAt},
        attempts = outbox.attempts + 1, last_failure_tag = NULL
      FROM candidate
      WHERE outbox.effect_id = candidate.effect_id
      RETURNING
        outbox.effect_id AS "effectId",
        outbox.command_id AS "commandId",
        outbox.interview_id AS "interviewId",
        outbox.invitation_id AS "invitationId",
        outbox.schedule_revision AS "scheduleRevision",
        outbox.claim_id AS "claimId",
        outbox.attempts,
        outbox.payload_json AS "payloadJson",
        (
          SELECT invitation.capability_sha256
          FROM recruitment_invitations invitation
          WHERE invitation.invitation_id = outbox.invitation_id
        ) AS "capabilitySha256"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("claim invitation outbox", cause)),
      ),
    );
    if (rows[0] === undefined) return undefined;
    const row = yield* decode(ClaimedInvitationRowSchema, rows[0], "claimed invitation row");
    const request = yield* decode(
      RecruitmentInvitationOutboxRequestSchema,
      row.payloadJson,
      "claimed invitation payload",
    ).pipe(
      Effect.catch((failure) =>
        quarantineClaim(sql, row.effectId, row.claimId, failure._tag).pipe(
          Effect.andThen(Effect.fail(failure)),
        ),
      ),
    );
    const capabilitySha256 = sha256Hex(new TextEncoder().encode(request.responseCapability));
    if (
      request.effectId !== row.effectId ||
      request.commandId !== row.commandId ||
      request.interviewId !== row.interviewId ||
      request.invitationId !== row.invitationId ||
      request.scheduleRevision !== row.scheduleRevision ||
      capabilitySha256 !== row.capabilitySha256
    ) {
      yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
      return yield* persistenceError("validate invitation outbox authority envelope");
    }
    return {
      effectId: row.effectId,
      claimId: row.claimId,
      attempts: row.attempts,
      request,
    };
  });

export const claimNextRecruitmentInvitation = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedRecruitmentInvitation | undefined,
  RecruitmentPersistenceError | RecruitmentDecodeError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* sql.withTransaction(claimInTransaction(sql, claimId, claimedAt)).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("invitation outbox claim transaction", cause)),
      ),
    );
  });

export const completeRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
  evidence: RecruitmentNotificationEvidence,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Delivered', claim_id = NULL, claimed_at = NULL,
        delivered_at = ${evidence.deliveredAt}, last_failure_tag = NULL,
        payload_json = '{}'::jsonb
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("complete invitation outbox claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("complete missing invitation outbox claim");
    }
  });

export const failRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = ${failureTag}
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("fail invitation outbox claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("fail missing invitation outbox claim");
    }
  });
export const releaseRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql`
      UPDATE recruitment_invitation_outbox
      SET status = 'Pending', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'InterruptedRecruitmentInvitationClaim'
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("release invitation outbox claim", cause)),
      ),
    );
  });


export const recoverStaleRecruitmentInvitations = (
  claimedBefore: string,
): Effect.Effect<number, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'StaleClaimRecovered'
      WHERE status = 'Processing'
        AND claimed_at < ${claimedBefore}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("recover stale invitation claims", cause)),
      ),
    );
    return rows.length;
  });

export const deliverNextRecruitmentInvitation = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  RecruitmentInvitationDeliveryResult,
  RecruitmentPersistenceError | RecruitmentDecodeError,
  Database | NotificationGateway
> =>
  Effect.acquireUseRelease(
    claimNextRecruitmentInvitation(claimId, claimedAt),
    (
      claim,
    ): Effect.Effect<
      RecruitmentInvitationDeliveryResult,
      RecruitmentPersistenceError,
      Database | NotificationGateway
    > => {
      if (claim === undefined) return Effect.succeed({ _tag: "Idle" as const });
      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;
        return yield* gateway.deliverInterviewInvitation(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInvitation(claim, failure._tag).pipe(
                Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInvitation(claim, evidence).pipe(
                Effect.as({ _tag: "Delivered" as const, claim, evidence }),
              ),
          }),
        );
      });
    },
    (claim) => (claim === undefined ? Effect.void : releaseRecruitmentInvitation(claim)),
  );

export const invitationPayloadForEvidence = (
  request: RecruitmentInvitationOutboxRequest,
): string => canonicalJson({
  ...request,
  responseCapability: "[REDACTED]",
});

export type RecruitmentInvitationOutboxFailure =
  | RecruitmentPersistenceError
  | RecruitmentDecodeError
  | RecruitmentNotificationDeliveryError;
