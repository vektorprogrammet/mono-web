/**
 * The immutable outbox of announced admission outcome mail (spec 0027, migration 0082).
 *
 * `queueOutcomeMail` runs inside the announcing command's transaction. It selects the effective
 * template of the application's department, renders it with the caller's renderer, and inserts
 * the one envelope `{deliveryId, recipient, subject, html, text}` of the application, so the
 * outcome and its exact bytes commit or roll back together. The delivery functions run after the
 * commit under the shared claim-fenced outbox lifecycle: they only forward that snapshot with the
 * sender of the worker and never render a later template revision. A delivery answer changes only
 * the delivery columns, never the envelope or the final outcome.
 */
import { DateTime, Data, Effect, Option, Result, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Mail } from "@vektorprogrammet/domain/mail";
import {
  decodeOutcomeMailEnvelope,
  type OutcomeMailRenderer,
  type OutcomeMailValues,
  type OutcomeTemplateKind,
} from "@vektorprogrammet/domain/admissions/template";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { canonicalJsonValue } from "@vektorprogrammet/domain/shared-kernel";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  releaseOutboxClaim,
  type OutboxClaimLost,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import { Database } from "../service.js";
import { readEffectiveOutcomeTemplates } from "./outcome-template-store.js";

/** The announcement's mail could not be queued; the caller maps it to an internal failure. */
export class OutcomeMailQueueFailure extends Data.TaggedError("OutcomeMailQueueFailure")<{
  readonly reason: "application-missing" | "template-missing" | "storage";
  readonly cause?: unknown;
}> {}

/** The delivery worker could not read or write the outbox. */
export class OutcomeMailOutboxError extends Data.TaggedError("OutcomeMailOutboxError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

/** The deterministic delivery ID, identity of the effect and idempotency key at the provider. */
export const outcomeMailDeliveryId = (applicationId: string): string =>
  `admission-outcome:${applicationId}`;

const Facts = Schema.Struct({
  recipient: Schema.String,
  firstName: Schema.String,
  departmentId: DepartmentId,
  departmentName: Schema.String,
  semesterId: Schema.String,
});

const findFacts = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: Facts,
  execute: (applicationId) =>
    Database.use(
      (sql) => sql`
    SELECT applicant.email AS recipient, applicant.first_name AS "firstName",
      department.department_id AS "departmentId", department.name AS "departmentName",
      period.semester_id AS "semesterId"
    FROM public.admission_applications AS application
    INNER JOIN public.admission_applicants AS applicant ON applicant.applicant_id = application.applicant_id
    INNER JOIN public.admission_periods AS period
      ON period.admission_period_id = application.admission_period_id
      AND period.department_id = application.department_id
    INNER JOIN public.organization_departments AS department
      ON department.department_id = application.department_id
    WHERE application.application_id = ${applicationId}`,
    ),
});

const storage = (cause: unknown) => new OutcomeMailQueueFailure({ reason: "storage", cause });

/** What one queued message was built from. */
export interface QueuedOutcomeMail {
  readonly deliveryId: string;
  readonly kind: OutcomeTemplateKind;
  readonly templateRevisionId: string;
}

/**
 * Renders and stores the one envelope of an announced application, in the caller's transaction.
 *
 * @remarks
 * `schoolName` is the school of the applicant's active placement in the scope, present exactly
 * for an admitted applicant who has one; it selects `AdmittedWithSchool` over
 * `AdmittedPlacementPending`. The recipient, first name, department name and semester come from
 * the application itself. The insert fails when the application already has an envelope, so the
 * caller announces once. A failure of `render` propagates unchanged; every storage failure
 * becomes `OutcomeMailQueueFailure` with its cause.
 *
 * @sideEffects Inserts one `admission_outcome_outbox` row.
 */
export const queueOutcomeMail = <E, R>(
  input: {
    readonly applicationId: string;
    readonly outcome: "Admitted" | "Rejected";
    readonly schoolName: string | undefined;
  },
  render: OutcomeMailRenderer<E, R>,
): Effect.Effect<QueuedOutcomeMail, OutcomeMailQueueFailure | E, Database | R> =>
  Effect.gen(function* () {
    const found = yield* findFacts(input.applicationId).pipe(Effect.mapError(storage));

    if (Option.isNone(found))
      return yield* new OutcomeMailQueueFailure({ reason: "application-missing" });

    const facts = found.value;

    const kind: OutcomeTemplateKind =
      input.outcome === "Rejected"
        ? "Rejected"
        : input.schoolName === undefined
          ? "AdmittedPlacementPending"
          : "AdmittedWithSchool";

    const entries = yield* readEffectiveOutcomeTemplates(facts.departmentId).pipe(
      Effect.mapError(storage),
    );

    const template = entries.find((entry) => entry.kind === kind);

    if (template === undefined)
      return yield* new OutcomeMailQueueFailure({ reason: "template-missing" });

    const common = {
      firstName: facts.firstName,
      departmentName: facts.departmentName,
      semesterName: facts.semesterId,
    };

    const values: OutcomeMailValues =
      kind === "AdmittedWithSchool" && input.schoolName !== undefined
        ? { ...common, schoolName: input.schoolName }
        : common;

    const rendered = yield* render({
      kind,
      template: { subject: template.subject, body: template.body },
      values,
    });

    const deliveryId = outcomeMailDeliveryId(input.applicationId);

    const envelope = {
      deliveryId,
      recipient: facts.recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };

    yield* Database.use(
      (sql) => sql`
        INSERT INTO public.admission_outcome_outbox
          (effect_id, application_id, kind, template_revision_id, payload_json)
        VALUES (${deliveryId}, ${input.applicationId}, ${kind}, ${template.revisionId},
          ${sql.json(canonicalJsonValue(envelope))})`,
    ).pipe(Effect.mapError(storage));

    return { deliveryId, kind, templateRevisionId: template.revisionId };
  });

const outcomeOutbox: OutboxTable = {
  name: "public.admission_outcome_outbox",
  terminalPayload: "Retain",
};

export type OutcomeMailDeliveryResult =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Delivered"; readonly effectId: string }
  | { readonly _tag: "Failed"; readonly effectId: string; readonly failureTag: string }
  | { readonly _tag: "Quarantined"; readonly effectId: string; readonly failureTag: string }
  /** The claim was recovered or replaced first, so its outcome was not recorded. */
  | { readonly _tag: "ClaimLost"; readonly effectId: string };

export const OutcomeMailDeliveryResult = Data.taggedEnum<OutcomeMailDeliveryResult>();

export interface OutcomeMailDeliveryPolicy {
  /** Distinct per claim attempt; the fencing token of the claimed row. */
  readonly claimId: string;
  /** The instant of the claim, RFC 3339 with milliseconds. */
  readonly claimedAt: string;
  /** The sender of every outcome mail: the existing MAIL_SENDER. */
  readonly sender: string;
  /** The attempt with this number is the last: its temporary failure quarantines the row. */
  readonly maxAttempts: number;
  /** A Failed row waits `min(2^(attempts-1), retryDelayMaxSeconds)` seconds after its attempt. */
  readonly retryDelayMaxSeconds: number;
}

const ClaimedRow = Schema.Struct({
  effectId: Schema.String,
  claimId: Schema.String,
  attempts: Schema.Int,
  payload: Schema.Unknown,
});

const outboxError = (operation: string) => (cause: unknown) =>
  new OutcomeMailOutboxError({ operation, cause });

const claimNext = (policy: OutcomeMailDeliveryPolicy) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`
          WITH candidate AS (
            SELECT effect_id FROM public.admission_outcome_outbox
            WHERE status = 'Pending'
              OR (status = 'Failed'
                AND last_attempt_at + LEAST(power(2, attempts - 1), ${policy.retryDelayMaxSeconds}::double precision)
                  * interval '1 second' <= ${policy.claimedAt}::timestamptz)
            ORDER BY committed_at, effect_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE public.admission_outcome_outbox AS outbox
          SET ${outboxClaimAssignments(sql, "outbox", policy.claimId, policy.claimedAt)},
            last_attempt_at = ${policy.claimedAt}
          FROM candidate
          WHERE outbox.effect_id = candidate.effect_id
          RETURNING outbox.effect_id AS "effectId", outbox.claim_id AS "claimId",
            outbox.attempts, outbox.payload_json AS payload`;

        return rows[0];
      }),
    ),
  ).pipe(Effect.mapError(outboxError("claim admission outcome mail")));

/** Returns Processing rows claimed before `claimedBefore` to Failed, so a later claim retries them. */
export const recoverStaleOutcomeMail = (claimedBefore: string) =>
  Database.use((sql) =>
    recoverStaleOutboxClaims(sql, outcomeOutbox, claimedBefore, {
      status: "Failed",
      failureTag: "StaleClaim",
    }),
  ).pipe(Effect.mapError(outboxError("recover admission outcome mail claims")));

/** Maps a storage failure of a claim-fenced settlement; a lost claim stays for the caller. */
const settle = <A>(
  operation: string,
  effect: Effect.Effect<A, OutboxClaimLost | SqlError, Database>,
) =>
  effect.pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(outboxError(operation)(cause))));

const quarantine = (effectId: string, claimId: string, failureTag: string) =>
  settle(
    "quarantine admission outcome mail",
    Database.use((sql) =>
      quarantineOutboxClaim(sql, outcomeOutbox, { effectId, claimId }, failureTag),
    ),
  ).pipe(Effect.as(OutcomeMailDeliveryResult.Quarantined({ effectId, failureTag })));

/**
 * Claims the next due envelope and forwards it to the Mail service once.
 *
 * @remarks
 * Provider acceptance is `Delivered` with its provider reference. A temporary failure before the
 * last attempt is `Failed` and retries with backoff; a permanent or ambiguous answer, the last
 * attempt's temporary failure and an envelope that does not decode are `Quarantined`, visible and
 * terminal. An interrupted attempt returns its claim. Settling a claim that another worker or
 * stale recovery owns changes nothing and answers `ClaimLost`. The row's envelope is forwarded
 * exactly as stored; nothing here reads a template.
 *
 * @sideEffects One provider call and the outbox row that the claim owns.
 */
export const deliverNextOutcomeMail = (
  policy: OutcomeMailDeliveryPolicy,
): Effect.Effect<OutcomeMailDeliveryResult, OutcomeMailOutboxError, Database | Mail> =>
  Effect.gen(function* () {
    const claimed = yield* claimNext(policy);

    if (claimed === undefined) return OutcomeMailDeliveryResult.Idle();

    const row = yield* Schema.decodeUnknownEffect(ClaimedRow)(claimed).pipe(
      Effect.mapError(outboxError("decode claimed admission outcome mail")),
    );

    const { effectId, claimId } = row;
    const claim = { effectId, claimId };
    const envelope = yield* decodeOutcomeMailEnvelope(row.payload).pipe(Effect.option);

    if (Option.isNone(envelope) || envelope.value.deliveryId !== effectId)
      return yield* quarantine(effectId, claimId, "InvalidOutcomeMailEnvelope");

    const delivery = yield* Mail.use((mail) =>
      mail.deliver({
        deliveryId: envelope.value.deliveryId,
        sender: policy.sender,
        recipient: envelope.value.recipient,
        subject: envelope.value.subject,
        text: envelope.value.text,
        html: envelope.value.html,
      }),
    ).pipe(
      Effect.onInterrupt(() =>
        Database.use((sql) =>
          releaseOutboxClaim(sql, outcomeOutbox, claim, "InterruptedOutcomeMailClaim"),
        ).pipe(Effect.ignore),
      ),
      Effect.result,
    );

    if (Result.isSuccess(delivery)) {
      // Record when the provider acknowledged, not when the claim was taken.
      const acknowledgedAt = yield* DateTime.now;

      yield* settle(
        "deliver admission outcome mail",
        Database.use((sql) =>
          markOutboxDelivered(sql, outcomeOutbox, claim, {
            deliveredAt: DateTime.formatIso(acknowledgedAt),
            providerReference: delivery.success.providerReference,
          }),
        ),
      );

      return OutcomeMailDeliveryResult.Delivered({ effectId });
    }

    const failureTag = `MailDeliveryError:${delivery.failure.kind}`;

    if (delivery.failure.kind !== "temporary-unavailability" || row.attempts >= policy.maxAttempts)
      return yield* quarantine(effectId, claimId, failureTag);

    yield* settle(
      "fail admission outcome mail",
      Database.use((sql) => markOutboxFailed(sql, outcomeOutbox, claim, failureTag)),
    );

    return OutcomeMailDeliveryResult.Failed({ effectId, failureTag });
  }).pipe(
    Effect.catchTag("OutboxClaimLost", ({ effectId }) =>
      Effect.succeed(OutcomeMailDeliveryResult.ClaimLost({ effectId })),
    ),
  );
