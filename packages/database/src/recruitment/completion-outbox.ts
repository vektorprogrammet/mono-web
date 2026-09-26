import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseOperations } from "../service.js";
import {
  markOutboxDelivered,
  markOutboxFailed,
  type OutboxClaimLost,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  releaseOutboxClaim,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import { Profile, type ProfileOperations } from "@vektorprogrammet/domain/profile";
import { personProfileDisplayName } from "@vektorprogrammet/domain/profile";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { flow, Data, Predicate, Effect, Schema } from "effect";
import {
  RecruitmentNotificationEffectId,
  RecruitmentConductCommandId,
  RecruitmentInterviewId,
  RecruitmentInterviewCompletionOutboxRequestSchema,
  RecruitmentPersistenceError,
} from "@vektorprogrammet/domain/recruitment";
import {
  type RecruitmentInterviewCompletionOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "@vektorprogrammet/domain/recruitment";
import {
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
} from "@vektorprogrammet/domain/recruitment";

interface ClaimedRow {
  readonly effectId: string;
  readonly effectType: string;
  readonly commandId: string;
  readonly interviewId: string;
  readonly applicationId: string;
  readonly interviewRevision: number;
  readonly claimId: string;
  readonly attempts: number;
  readonly payloadJson: unknown;
  readonly deliveryEnvelope: unknown;
}

const ClaimedRowSchema = Schema.Struct({
  effectId: RecruitmentNotificationEffectId,
  effectType: Schema.String,
  commandId: RecruitmentConductCommandId,
  interviewId: RecruitmentInterviewId,
  applicationId: PublicApplicationIdSchema,
  interviewRevision: Schema.Int,
  claimId: Schema.String,
  attempts: Schema.Int,
  payloadJson: Schema.Unknown,
  deliveryEnvelope: Schema.NullOr(Schema.Unknown),
});

interface CanonicalRow {
  readonly commandSha256: string;
  readonly commandJson: unknown;
  readonly observationJson: unknown;
  readonly receiptKind: string;
  readonly receiptInterviewId: string;
  readonly receiptRevision: number;
  readonly canonicalInterviewId: string;
  readonly canonicalApplicationId: string;
  readonly interviewerPersonId: string;
  readonly currentInterviewRevision: number;
  readonly conductInterviewId: string;
  readonly conductRevision: number;
}

const CanonicalRowSchema = Schema.Struct({
  commandSha256: Schema.String,
  commandJson: Schema.Unknown,
  observationJson: Schema.Unknown,
  receiptKind: Schema.String,
  receiptInterviewId: RecruitmentInterviewId,
  receiptRevision: Schema.Int,
  canonicalInterviewId: RecruitmentInterviewId,
  canonicalApplicationId: PublicApplicationIdSchema,
  interviewerPersonId: PersonId,
  currentInterviewRevision: Schema.Int,
  conductInterviewId: RecruitmentInterviewId,
  conductRevision: Schema.Int,
});

export interface ClaimedRecruitmentInterviewCompletion {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: RecruitmentInterviewCompletionOutboxRequest;
}

export type RecruitmentInterviewCompletionDeliveryResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Delivered";
      readonly claim: ClaimedRecruitmentInterviewCompletion;
      readonly evidence: RecruitmentNotificationEvidence;
    }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedRecruitmentInterviewCompletion;
      readonly failureTag: string;
    }
  /** The claim was recovered or replaced first, so its outcome was not recorded. */
  | { readonly _tag: "ClaimLost"; readonly effectId: string };

export const RecruitmentInterviewCompletionDeliveryResult =
  Data.taggedEnum<RecruitmentInterviewCompletionDeliveryResult>();

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    cause,
    message: cause instanceof Error ? cause.message : "recruitment completion outbox failed",
  });

const decodeForClaim = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.map((decoded) => ({ _tag: "Decoded" as const, value: decoded })),
    Effect.catch(() => Effect.succeed({ _tag: "Invalid" as const })),
  );

const completionOutbox: OutboxTable = {
  name: "public.recruitment_interview_completion_outbox",
  terminalPayload: "Scrub",
};

const quarantineClaim = (
  sql: DatabaseOperations,
  effectId: string,
  claimId: string,
  failureTag: string,
): Effect.Effect<undefined, RecruitmentPersistenceError | OutboxClaimLost> =>
  quarantineOutboxClaim(sql, completionOutbox, { effectId, claimId }, failureTag).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("quarantine interview completion claim", cause)),
    ),
    Effect.as(undefined),
  );

const staticEnvelopeMatches = (
  row: typeof ClaimedRowSchema.Type,
  canonical: typeof CanonicalRowSchema.Type,
  command: typeof FinalizeInterviewCommandSchema.Type,
  observation: typeof FinalizeInterviewObservationSchema.Type,
): boolean => {
  const expectedDigest = sha256Hex(canonicalJsonBytes(command));

  return (
    row.effectType === "SendInterviewCompletionReceipt" &&
    row.effectId === `recruitment-completion:${expectedDigest}` &&
    row.commandId === command.commandId &&
    row.interviewId === command.interviewId &&
    row.applicationId === canonical.canonicalApplicationId &&
    row.interviewRevision === observation.interviewRevision &&
    canonical.commandSha256 === expectedDigest &&
    canonical.receiptKind === "InterviewFinalized" &&
    canonical.receiptInterviewId === row.interviewId &&
    canonical.receiptRevision === row.interviewRevision &&
    canonical.canonicalInterviewId === row.interviewId &&
    canonical.currentInterviewRevision >= row.interviewRevision &&
    canonical.conductInterviewId === row.interviewId &&
    canonical.conductRevision === row.interviewRevision &&
    Predicate.isTagged(observation, "InterviewFinalized") &&
    observation.commandId === row.commandId &&
    observation.interviewId === row.interviewId &&
    observation.completionState === "Completed" &&
    observation.cancellationState === "NotCancelled" &&
    observation.notificationState === "Pending" &&
    command.expectedRevision + 1 === row.interviewRevision &&
    canonicalJson(command) === canonicalJson(canonical.commandJson) &&
    canonicalJson(observation) === canonicalJson(canonical.observationJson)
  );
};

const readFirstEnvelope = (
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
  canonical: typeof CanonicalRowSchema.Type,
  row: typeof ClaimedRowSchema.Type,
): Effect.Effect<
  RecruitmentInterviewCompletionOutboxRequest | undefined,
  RecruitmentPersistenceError
> =>
  Effect.gen(function* () {
    const applicantRead = yield* admissions
      .readApplicantContacts([canonical.canonicalApplicationId])
      .pipe(
        Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
        Effect.catch((failure) =>
          Predicate.isTagged(failure, "PublicApplicationPersistenceError")
            ? Effect.fail(persistenceError("read completion applicant contact", failure))
            : Effect.succeed({ _tag: "Missing" as const }),
        ),
      );

    if (Predicate.isTagged(applicantRead, "Missing") || applicantRead.contacts.length !== 1)
      return undefined;
    const applicant = applicantRead.contacts[0];

    if (applicant === undefined || applicant.applicationId !== canonical.canonicalApplicationId)
      return undefined;

    const profiles = yield* profile.readProfiles([canonical.interviewerPersonId]).pipe(
      Effect.map((values) => ({ _tag: "Read" as const, values })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "ProfilePersistenceError")
          ? Effect.fail(persistenceError("read completion interviewer profile", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    const contacts = yield* profile.readContacts([canonical.interviewerPersonId]).pipe(
      Effect.map((values) => ({ _tag: "Read" as const, values })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "ProfilePersistenceError")
          ? Effect.fail(persistenceError("read completion interviewer contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (
      Predicate.isTagged(profiles, "Missing") ||
      Predicate.isTagged(contacts, "Missing") ||
      profiles.values.length !== 1 ||
      contacts.values.length !== 1
    )
      return undefined;
    const interviewer = profiles.values[0];
    const interviewerContact = contacts.values[0];

    if (
      interviewer === undefined ||
      interviewerContact === undefined ||
      interviewer.personId !== canonical.interviewerPersonId ||
      interviewerContact.personId !== canonical.interviewerPersonId
    )
      return undefined;

    const decoded = yield* RecruitmentInterviewCompletionOutboxRequestSchema.makeEffect({
      effectId: row.effectId,
      commandId: row.commandId,
      interviewId: row.interviewId,
      applicationId: row.applicationId,
      interviewRevision: row.interviewRevision,
      applicantDisplayName: `${applicant.firstName.trim()} ${applicant.lastName.trim()}`.trim(),
      applicantEmail: applicant.email,
      interviewerDisplayName: personProfileDisplayName(interviewer),
      interviewerEmail: interviewerContact.email,
    }).pipe(
      Effect.map((decoded) => ({ _tag: "Decoded" as const, value: decoded })),
      Effect.orElseSucceed(() => ({ _tag: "Invalid" as const })),
    );

    return Predicate.isTagged(decoded, "Decoded") ? decoded.value : undefined;
  });

const claimInTransaction = (
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedRecruitmentInterviewCompletion | undefined,
  RecruitmentPersistenceError | OutboxClaimLost
> =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedRow>`
      WITH candidate AS (
        SELECT outbox.effect_id
        FROM public.recruitment_interview_completion_outbox AS outbox
        INNER JOIN public.recruitment_interview_lifecycle_command_receipts AS receipt
          ON receipt.command_id = outbox.command_id
        WHERE outbox.status IN ('Pending', 'Failed')
        ORDER BY outbox.attempts ASC, receipt.committed_at ASC, outbox.command_id ASC
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.recruitment_interview_completion_outbox AS outbox
      SET ${outboxClaimAssignments(sql, "outbox", claimId, claimedAt)}
      FROM candidate
      WHERE outbox.effect_id = candidate.effect_id
      RETURNING outbox.effect_id AS "effectId", outbox.effect_type AS "effectType",
        outbox.command_id AS "commandId", outbox.interview_id AS "interviewId",
        outbox.application_id AS "applicationId", outbox.interview_revision AS "interviewRevision",
        outbox.claim_id AS "claimId", outbox.attempts, outbox.payload_json AS "payloadJson",
        outbox.delivery_envelope AS "deliveryEnvelope"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("claim interview completion outbox", cause)),
      ),
    );

    const raw = rows[0];

    if (raw === undefined) return undefined;
    const decodedRow = yield* decodeForClaim(ClaimedRowSchema)(raw);

    if (!Predicate.isTagged(decodedRow, "Decoded"))
      return yield* quarantineClaim(sql, raw.effectId, claimId, "RecruitmentDecodeError");
    const row = decodedRow.value;

    if (row.claimId !== claimId)
      return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");

    const canonicalRows = yield* sql<CanonicalRow>`
      SELECT receipt.command_sha256 AS "commandSha256", receipt.command_json AS "commandJson",
        receipt.observation_json AS "observationJson", receipt.kind AS "receiptKind",
        receipt.interview_id AS "receiptInterviewId", receipt.resulting_revision AS "receiptRevision",
        interview.interview_id AS "canonicalInterviewId",
        interview.application_id AS "canonicalApplicationId",
        interview.interviewer_person_id AS "interviewerPersonId",
        interview.revision AS "currentInterviewRevision",
        conduct.interview_id AS "conductInterviewId",
        conduct.interview_revision AS "conductRevision"
      FROM public.recruitment_interview_completion_outbox AS outbox
      INNER JOIN public.recruitment_interview_lifecycle_command_receipts AS receipt
        ON receipt.command_id = outbox.command_id
      INNER JOIN public.recruitment_interviews AS interview
        ON interview.interview_id = outbox.interview_id
      INNER JOIN public.recruitment_interview_conducts AS conduct
        ON conduct.interview_id = outbox.interview_id
      WHERE outbox.effect_id = ${row.effectId}
        AND outbox.status = 'Processing' AND outbox.claim_id = ${row.claimId}
      FOR SHARE OF receipt, interview, conduct
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read canonical interview completion envelope", cause)),
      ),
    );

    if (canonicalRows.length !== 1)
      return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
    const decodedCanonical = yield* decodeForClaim(CanonicalRowSchema)(canonicalRows[0]);

    const decodedCommand = yield* decodeForClaim(FinalizeInterviewCommandSchema)(
      canonicalRows[0]?.commandJson,
    );

    const decodedObservation = yield* decodeForClaim(FinalizeInterviewObservationSchema)(
      canonicalRows[0]?.observationJson,
    );

    if (
      !Predicate.isTagged(decodedCanonical, "Decoded") ||
      !Predicate.isTagged(decodedCommand, "Decoded") ||
      !Predicate.isTagged(decodedObservation, "Decoded") ||
      !staticEnvelopeMatches(
        row,
        decodedCanonical.value,
        decodedCommand.value,
        decodedObservation.value,
      )
    )
      return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");

    let request: RecruitmentInterviewCompletionOutboxRequest;

    if (row.deliveryEnvelope === null) {
      if (canonicalJson(row.payloadJson) !== "{}")
        return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
      const first = yield* readFirstEnvelope(admissions, profile, decodedCanonical.value, row);

      if (first === undefined)
        return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
      const frozen = canonicalJson(first);

      const updated = yield* sql<{ readonly effectId: string }>`
        UPDATE public.recruitment_interview_completion_outbox
        SET delivery_envelope = ${frozen}::jsonb, payload_json = ${frozen}::jsonb
        WHERE effect_id = ${row.effectId} AND status = 'Processing' AND claim_id = ${row.claimId}
          AND delivery_envelope IS NULL
        RETURNING effect_id AS "effectId"
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("freeze interview completion envelope", cause)),
        ),
      );

      if (updated[0]?.effectId !== row.effectId)
        return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
      request = first;
    } else {
      const decodedRequest = yield* decodeForClaim(
        RecruitmentInterviewCompletionOutboxRequestSchema,
      )(row.deliveryEnvelope);

      if (
        !Predicate.isTagged(decodedRequest, "Decoded") ||
        canonicalJson(row.payloadJson) !== canonicalJson(row.deliveryEnvelope) ||
        decodedRequest.value.effectId !== row.effectId ||
        decodedRequest.value.commandId !== row.commandId ||
        decodedRequest.value.interviewId !== row.interviewId ||
        decodedRequest.value.applicationId !== row.applicationId ||
        decodedRequest.value.interviewRevision !== row.interviewRevision
      )
        return yield* quarantineClaim(sql, row.effectId, row.claimId, "AuthorityEnvelopeMismatch");
      request = decodedRequest.value;
    }

    return { effectId: row.effectId, claimId: row.claimId, attempts: row.attempts, request };
  });

export const claimNextRecruitmentInterviewCompletion = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedRecruitmentInterviewCompletion | undefined,
  RecruitmentPersistenceError | OutboxClaimLost,
  Admissions | Database | Profile
> =>
  Effect.gen(function* () {
    const admissions = yield* Admissions;
    const sql = yield* Database;
    const profile = yield* Profile;

    return yield* sql
      .withTransaction(claimInTransaction(sql, admissions, profile, claimId, claimedAt))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("interview completion claim transaction", cause)),
        ),
      );
  });

export const completeRecruitmentInterviewCompletion = (
  claim: ClaimedRecruitmentInterviewCompletion,
  evidence: RecruitmentNotificationEvidence,
): Effect.Effect<void, RecruitmentPersistenceError | OutboxClaimLost, Database> =>
  Effect.gen(function* () {
    if (evidence.effectId !== claim.effectId)
      return yield* persistenceError("completion delivery evidence effect mismatch");

    yield* Database.use((sql) =>
      markOutboxDelivered(sql, completionOutbox, claim, {
        deliveredAt: evidence.deliveredAt,
        providerReference: evidence.providerReference,
      }),
    ).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("complete interview completion claim", cause)),
      ),
    );
  });

export const failRecruitmentInterviewCompletion = (
  claim: ClaimedRecruitmentInterviewCompletion,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError | OutboxClaimLost, Database> =>
  Database.use((sql) => markOutboxFailed(sql, completionOutbox, claim, failureTag)).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("fail interview completion claim", cause)),
    ),
  );

export const releaseRecruitmentInterviewCompletion = (
  claim: ClaimedRecruitmentInterviewCompletion,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Database.use((sql) =>
    releaseOutboxClaim(
      sql,
      completionOutbox,
      claim,
      "InterruptedRecruitmentInterviewCompletionClaim",
    ),
  ).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("release interview completion claim", cause)),
    ),
  );

export const recoverStaleRecruitmentInterviewCompletions = (
  claimedBefore: string,
): Effect.Effect<number, RecruitmentPersistenceError, Database> =>
  Database.use((sql) =>
    recoverStaleOutboxClaims(sql, completionOutbox, claimedBefore, {
      status: "Failed",
      failureTag: "StaleClaimRecovered",
    }),
  ).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("recover stale interview completion claims", cause)),
    ),
  );

export const deliverNextRecruitmentInterviewCompletion = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  RecruitmentInterviewCompletionDeliveryResult,
  RecruitmentPersistenceError,
  Admissions | Database | NotificationGateway | Profile
> =>
  Effect.acquireUseRelease(
    claimNextRecruitmentInterviewCompletion(claimId, claimedAt),
    (
      claim,
    ): Effect.Effect<
      RecruitmentInterviewCompletionDeliveryResult,
      RecruitmentPersistenceError | OutboxClaimLost,
      Admissions | Database | NotificationGateway | Profile
    > => {
      if (claim === undefined)
        return Effect.succeed(RecruitmentInterviewCompletionDeliveryResult.Idle());

      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;

        return yield* gateway.deliverInterviewCompletionReceipt(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInterviewCompletion(claim, failure._tag).pipe(
                Effect.as(
                  RecruitmentInterviewCompletionDeliveryResult.Failed({
                    claim,
                    failureTag: failure._tag,
                  }),
                ),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInterviewCompletion(claim, evidence).pipe(
                Effect.as(
                  RecruitmentInterviewCompletionDeliveryResult.Delivered({ claim, evidence }),
                ),
              ),
          }),
        );
      });
    },
    (claim) => (claim === undefined ? Effect.void : releaseRecruitmentInterviewCompletion(claim)),
  ).pipe(
    Effect.catchTag("OutboxClaimLost", ({ effectId }) =>
      Effect.succeed(RecruitmentInterviewCompletionDeliveryResult.ClaimLost({ effectId })),
    ),
  );

export type RecruitmentInterviewCompletionOutboxFailure =
  | RecruitmentPersistenceError
  | RecruitmentNotificationDeliveryError;
