import {
  decodePostgresObservations,
  type PostgresObservation,
  type PostgresQueryable,
} from "./postgres-observation.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Effect, Predicate, Schema } from "effect";
import { canonicalJson } from "../../packages/domain/src/shared-kernel/index.js";
import { type JourneyStepFailed, rolledBack, step, withPoolClient } from "./journey-step.ts";

type CorrectionSeed = Readonly<{
  predecessorRevision: number;
  resultingRevision: number;
  answers: unknown;
  explanatoryPower: number;
  roleModel: number;
  suitability: number;
  recommendation: "Ja" | "Kanskje" | "Nei";
  correctedByPersonId: string;
}>;

type PersistedSnapshot = Readonly<{
  aggregate: ReadonlyArray<PostgresObservation>;
  assessments: ReadonlyArray<PostgresObservation>;
  receipts: ReadonlyArray<PostgresObservation>;
  audit: ReadonlyArray<PostgresObservation>;
}>;

// pg's DatabaseError always carries `constraint`, undefined when no constraint failed.
const DatabaseError = Schema.Struct({
  message: Schema.String,
  constraint: Schema.optional(Schema.String),
});

export type InterviewCorrectionIntegrityOptions = Readonly<{
  pool: Pool;
  interviewId: string;
  expectedCorrectedByPersonId?: string;
  expectedCoInterviewerPersonId?: string | null;
}>;

const freshId = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

const queryRows = Effect.fnUntraced(function* (
  client: PostgresQueryable,
  text: string,
  values: unknown[] = [],
) {
  return decodePostgresObservations((yield* step(() => client.query(text, values))).rows);
});

const readSnapshot = Effect.fnUntraced(function* (pool: Pool, interviewId: string) {
  const snapshot: PersistedSnapshot = {
    aggregate: yield* queryRows(
      pool,
      `SELECT interview_id, revision, co_interviewer_person_id
       FROM public.recruitment_interviews
      WHERE interview_id=$1`,
      [interviewId],
    ),
    assessments: yield* queryRows(
      pool,
      `SELECT interview_id, predecessor_revision, resulting_revision, answers,
            explanatory_power, role_model, suitability, recommendation,
            corrected_by_person_id, corrected_at, command_id
       FROM public.recruitment_interview_correction_assessments
      WHERE interview_id=$1
      ORDER BY resulting_revision`,
      [interviewId],
    ),
    receipts: yield* queryRows(
      pool,
      `SELECT command_id, command_sha256, command_json, observation_json,
            interview_id, predecessor_revision, resulting_revision, committed_at
       FROM public.recruitment_interview_correction_command_receipts
      WHERE interview_id=$1
      ORDER BY resulting_revision, command_id`,
      [interviewId],
    ),
    audit: yield* queryRows(
      pool,
      `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
            resulting_revision, occurred_at
       FROM public.recruitment_interview_correction_audit
      WHERE interview_id=$1
      ORDER BY resulting_revision, command_id`,
      [interviewId],
    ),
  };

  return snapshot;
});

const readCorrectionSeed = Effect.fnUntraced(function* (pool: Pool, interviewId: string) {
  const rows = yield* queryRows(
    pool,
    `SELECT predecessor_revision AS "predecessorRevision",
            resulting_revision AS "resultingRevision", answers,
            explanatory_power AS "explanatoryPower", role_model AS "roleModel",
            suitability, recommendation,
            corrected_by_person_id AS "correctedByPersonId"
       FROM public.recruitment_interview_correction_assessments
      WHERE interview_id=$1
      ORDER BY resulting_revision DESC
      LIMIT 1`,
    [interviewId],
  );

  assert.equal(rows.length, 1, "the integrity helper requires an existing correction");
  const row = rows[0]!;
  assert.ok(Predicate.isNumber(row.predecessorRevision));
  assert.ok(Predicate.isNumber(row.resultingRevision));
  assert.ok(Array.isArray(row.answers), "the existing correction must contain answer JSON");
  assert.ok(Predicate.isNumber(row.explanatoryPower));
  assert.ok(Predicate.isNumber(row.roleModel));
  assert.ok(Predicate.isNumber(row.suitability));
  assert.ok(
    row.recommendation === "Ja" || row.recommendation === "Kanskje" || row.recommendation === "Nei",
  );
  assert.ok(Predicate.isString(row.correctedByPersonId));

  const seed: CorrectionSeed = {
    predecessorRevision: row.predecessorRevision,
    resultingRevision: row.resultingRevision,
    answers: row.answers,
    explanatoryPower: row.explanatoryPower,
    roleModel: row.roleModel,
    suitability: row.suitability,
    recommendation: row.recommendation,
    correctedByPersonId: row.correctedByPersonId,
  };

  return seed;
});

const readCommandIds = Effect.fnUntraced(function* (pool: Pool, interviewId: string) {
  const rows = yield* queryRows(
    pool,
    `SELECT command_id AS "commandId"
       FROM public.recruitment_interview_correction_assessments
      WHERE interview_id=$1
      ORDER BY resulting_revision DESC
      LIMIT 1`,
    [interviewId],
  );

  assert.equal(rows.length, 1);
  const commandId = rows[0]!.commandId;
  assert.ok(Predicate.isString(commandId));

  return commandId;
});

const assertRejectedAndUnchanged = Effect.fnUntraced(function* (
  pool: Pool,
  interviewId: string,
  label: string,
  mutation: (client: PoolClient) => Effect.Effect<unknown, JourneyStepFailed>,
  expected: { message?: RegExp; constraint?: string },
) {
  const before = yield* readSnapshot(pool, interviewId);

  const failure = yield* withPoolClient(pool, (client) =>
    rolledBack(
      client,
      mutation(client).pipe(
        Effect.as(undefined),
        Effect.catchTag("JourneyStepFailed", (failed) =>
          Schema.decodeUnknownEffect(DatabaseError)(failed.cause),
        ),
      ),
    ),
  );

  assert.ok(failure, `${label} unexpectedly succeeded`);
  assert.ok(Predicate.isString(failure.message), `${label} did not return a database error`);

  if (expected.constraint !== undefined) {
    assert.equal(failure.constraint, expected.constraint, `${label} hit the wrong constraint`);
  }

  if (expected.message !== undefined) {
    assert.match(String(failure.message), expected.message, `${label} hit the wrong rejection`);
  }

  assert.deepEqual(
    yield* readSnapshot(pool, interviewId),
    before,
    `${label} changed persisted state`,
  );
});

const insertAssessment = Effect.fnUntraced(function* (
  client: PoolClient,
  interviewId: string,
  seed: CorrectionSeed,
  commandId: string,
  predecessorRevision: number,
  resultingRevision: number,
) {
  yield* step(() =>
    client.query(
      `INSERT INTO public.recruitment_interview_correction_assessments
      (interview_id, predecessor_revision, resulting_revision, answers,
       explanatory_power, role_model, suitability, recommendation,
       corrected_by_person_id, corrected_at, command_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$10)`,
      [
        interviewId,
        predecessorRevision,
        resultingRevision,
        canonicalJson(seed.answers),
        seed.explanatoryPower,
        seed.roleModel,
        seed.suitability,
        seed.recommendation,
        seed.correctedByPersonId,
        commandId,
      ],
    ),
  );
});

const alignAggregateForCandidate = Effect.fnUntraced(function* (
  client: PoolClient,
  interviewId: string,
  resultingRevision: number,
) {
  yield* step(() =>
    client.query(
      `UPDATE public.recruitment_interviews
        SET revision=$2
      WHERE interview_id=$1`,
      [interviewId, resultingRevision],
    ),
  );
});

const insertReceipt = Effect.fnUntraced(function* (
  client: PoolClient,
  commandId: string,
  interviewId: string,
  predecessorRevision: number,
  resultingRevision: number,
) {
  yield* step(() =>
    client.query(
      `INSERT INTO public.recruitment_interview_correction_command_receipts
      (command_id, command_sha256, command_json, observation_json, interview_id,
       predecessor_revision, resulting_revision, committed_at)
     VALUES ($1, repeat('a', 64), '{}'::jsonb, '{}'::jsonb, $2, $3, $4, date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC'))`,
      [commandId, interviewId, predecessorRevision, resultingRevision],
    ),
  );
});

export const assertInterviewCorrectionIntegrity = Effect.fnUntraced(function* (
  options: InterviewCorrectionIntegrityOptions,
) {
  const { pool, interviewId } = options;
  const seed = yield* readCorrectionSeed(pool, interviewId);
  const commandId = yield* readCommandIds(pool, interviewId);
  const currentRevision = seed.resultingRevision;
  const candidateRevision = currentRevision + 1;
  const baseline = yield* readSnapshot(pool, interviewId);
  assert.equal(baseline.aggregate.length, 1, "the corrected interview aggregate must exist");
  assert.equal(baseline.aggregate[0]!.revision, currentRevision);

  if (options.expectedCoInterviewerPersonId !== undefined) {
    assert.equal(
      baseline.aggregate[0]!.co_interviewer_person_id,
      options.expectedCoInterviewerPersonId,
      "integrity target must retain its designated co-interviewer",
    );
  }

  if (options.expectedCorrectedByPersonId !== undefined) {
    assert.equal(
      seed.correctedByPersonId,
      options.expectedCorrectedByPersonId,
      "latest correction must retain the expected actor",
    );

    const audit = yield* queryRows(
      pool,
      `SELECT actor_person_id
         FROM public.recruitment_interview_correction_audit
        WHERE command_id=$1`,
      [commandId],
    );

    assert.deepEqual(audit, [{ actor_person_id: options.expectedCorrectedByPersonId }]);
  }

  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "assessment update immutability",
    (client) =>
      step(() =>
        client.query(
          `UPDATE public.recruitment_interview_correction_assessments
            SET recommendation = CASE recommendation WHEN 'Ja' THEN 'Nei' ELSE 'Ja' END
          WHERE interview_id=$1 AND resulting_revision=$2`,
          [interviewId, currentRevision],
        ),
      ),
    { message: /corrections are immutable/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "assessment delete immutability",
    (client) =>
      step(() =>
        client.query(
          `DELETE FROM public.recruitment_interview_correction_assessments
          WHERE interview_id=$1 AND resulting_revision=$2`,
          [interviewId, currentRevision],
        ),
      ),
    { message: /corrections are immutable/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt update immutability",
    (client) =>
      step(() =>
        client.query(
          `UPDATE public.recruitment_interview_correction_command_receipts
            SET observation_json='{}'::jsonb
          WHERE command_id=$1`,
          [commandId],
        ),
      ),
    { message: /corrections are immutable/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt delete immutability",
    (client) =>
      step(() =>
        client.query(
          `DELETE FROM public.recruitment_interview_correction_command_receipts
          WHERE command_id=$1`,
          [commandId],
        ),
      ),
    { message: /corrections are immutable/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit update immutability",
    (client) =>
      step(() =>
        client.query(
          `UPDATE public.recruitment_interview_correction_audit
            SET occurred_at=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')
          WHERE command_id=$1`,
          [commandId],
        ),
      ),
    { message: /corrections are immutable/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit delete immutability",
    (client) =>
      step(() =>
        client.query(
          `DELETE FROM public.recruitment_interview_correction_audit
          WHERE command_id=$1`,
          [commandId],
        ),
      ),
    { message: /corrections are immutable/i },
  );

  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "skipped correction predecessor",
    Effect.fnUntraced(function* (client) {
      yield* alignAggregateForCandidate(client, interviewId, candidateRevision);
      yield* insertAssessment(
        client,
        interviewId,
        seed,
        freshId("integrity-skipped"),
        currentRevision - 1,
        candidateRevision,
      );
    }),
    { message: /predecessor must be the current effective revision/i },
  );
  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "aggregate revision mismatch",
    (client) =>
      insertAssessment(
        client,
        interviewId,
        seed,
        freshId("integrity-aggregate"),
        currentRevision,
        candidateRevision,
      ),
    { message: /aggregate revision must match correction revision/i },
  );

  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt assessment tuple mismatch",
    Effect.fnUntraced(function* (client) {
      const candidateCommandId = freshId("integrity-receipt");
      yield* alignAggregateForCandidate(client, interviewId, candidateRevision);
      yield* insertAssessment(
        client,
        interviewId,
        seed,
        candidateCommandId,
        currentRevision,
        candidateRevision,
      );
      yield* insertReceipt(
        client,
        candidateCommandId,
        interviewId,
        seed.predecessorRevision,
        seed.resultingRevision,
      );
    }),
    { constraint: "correction_receipt_assessment_chain_fk" },
  );

  yield* assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit receipt tuple mismatch",
    Effect.fnUntraced(function* (client) {
      const candidateCommandId = freshId("integrity-audit");
      yield* alignAggregateForCandidate(client, interviewId, candidateRevision);
      yield* insertAssessment(
        client,
        interviewId,
        seed,
        candidateCommandId,
        currentRevision,
        candidateRevision,
      );
      yield* insertReceipt(
        client,
        candidateCommandId,
        interviewId,
        currentRevision,
        candidateRevision,
      );
      yield* step(() =>
        client.query(
          `INSERT INTO public.recruitment_interview_correction_audit
          (command_id, interview_id, actor_person_id, predecessor_revision,
           resulting_revision, occurred_at)
         VALUES ($1,$2,$3,$4,$5,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
          [
            candidateCommandId,
            interviewId,
            seed.correctedByPersonId,
            seed.predecessorRevision,
            seed.resultingRevision,
          ],
        ),
      );
    }),
    { constraint: "correction_audit_receipt_chain_fk" },
  );
});
