import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Row = Readonly<Record<string, unknown>>;
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
  aggregate: ReadonlyArray<Row>;
  assessments: ReadonlyArray<Row>;
  receipts: ReadonlyArray<Row>;
  audit: ReadonlyArray<Row>;
}>;

type DatabaseError = Readonly<{
  message?: unknown;
  constraint?: unknown;
}>;

export type InterviewCorrectionIntegrityOptions = Readonly<{
  expectedCorrectedByPersonId?: string;
  expectedCoInterviewerPersonId?: string | null;
}>;

const freshId = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

const queryRows = async (client: Pool | PoolClient, text: string, values: unknown[] = []) =>
  (await client.query(text, values)).rows as Row[];

const readSnapshot = async (pool: Pool, interviewId: string): Promise<PersistedSnapshot> => ({
  aggregate: await queryRows(
    pool,
    `SELECT interview_id, revision, co_interviewer_person_id
       FROM public.recruitment_interviews
      WHERE interview_id=$1`,
    [interviewId],
  ),
  assessments: await queryRows(
    pool,
    `SELECT interview_id, predecessor_revision, resulting_revision, answers,
            explanatory_power, role_model, suitability, recommendation,
            corrected_by_person_id, corrected_at, command_id
       FROM public.recruitment_interview_correction_assessments
      WHERE interview_id=$1
      ORDER BY resulting_revision`,
    [interviewId],
  ),
  receipts: await queryRows(
    pool,
    `SELECT command_id, command_sha256, command_json, observation_json,
            interview_id, predecessor_revision, resulting_revision, committed_at
       FROM public.recruitment_interview_correction_command_receipts
      WHERE interview_id=$1
      ORDER BY resulting_revision, command_id`,
    [interviewId],
  ),
  audit: await queryRows(
    pool,
    `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
            resulting_revision, occurred_at
       FROM public.recruitment_interview_correction_audit
      WHERE interview_id=$1
      ORDER BY resulting_revision, command_id`,
    [interviewId],
  ),
});

const readCorrectionSeed = async (pool: Pool, interviewId: string): Promise<CorrectionSeed> => {
  const rows = await queryRows(
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
  assert.equal(typeof row.predecessorRevision, "number");
  assert.equal(typeof row.resultingRevision, "number");
  assert.ok(Array.isArray(row.answers), "the existing correction must contain answer JSON");
  assert.equal(typeof row.explanatoryPower, "number");
  assert.equal(typeof row.roleModel, "number");
  assert.equal(typeof row.suitability, "number");
  assert.ok(
    row.recommendation === "Ja" || row.recommendation === "Kanskje" || row.recommendation === "Nei",
  );
  assert.equal(typeof row.correctedByPersonId, "string");
  return row as unknown as CorrectionSeed;
};

const readCommandIds = async (pool: Pool, interviewId: string) => {
  const rows = await queryRows(
    pool,
    `SELECT command_id AS "commandId"
       FROM public.recruitment_interview_correction_assessments
      WHERE interview_id=$1
      ORDER BY resulting_revision DESC
      LIMIT 1`,
    [interviewId],
  );
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0]!.commandId, "string");
  return rows[0]!.commandId as string;
};

const assertRejectedAndUnchanged = async (
  pool: Pool,
  interviewId: string,
  label: string,
  mutation: (client: PoolClient) => Promise<unknown>,
  expected: { message?: RegExp; constraint?: string },
) => {
  const before = await readSnapshot(pool, interviewId);
  const client = await pool.connect();
  let failure: DatabaseError | undefined;
  try {
    await client.query("BEGIN");
    try {
      await mutation(client);
    } catch (cause) {
      failure = cause as DatabaseError;
    }
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.ok(failure, `${label} unexpectedly succeeded`);
  assert.equal(typeof failure.message, "string", `${label} did not return a database error`);
  if (expected.constraint !== undefined) {
    assert.equal(failure.constraint, expected.constraint, `${label} hit the wrong constraint`);
  }
  if (expected.message !== undefined) {
    assert.match(String(failure.message), expected.message, `${label} hit the wrong rejection`);
  }
  assert.deepEqual(
    await readSnapshot(pool, interviewId),
    before,
    `${label} changed persisted state`,
  );
};

const insertAssessment = async (
  client: PoolClient,
  interviewId: string,
  seed: CorrectionSeed,
  commandId: string,
  predecessorRevision: number,
  resultingRevision: number,
) => {
  await client.query(
    `INSERT INTO public.recruitment_interview_correction_assessments
      (interview_id, predecessor_revision, resulting_revision, answers,
       explanatory_power, role_model, suitability, recommendation,
       corrected_by_person_id, corrected_at, command_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,$10)`,
    [
      interviewId,
      predecessorRevision,
      resultingRevision,
      JSON.stringify(seed.answers),
      seed.explanatoryPower,
      seed.roleModel,
      seed.suitability,
      seed.recommendation,
      seed.correctedByPersonId,
      commandId,
    ],
  );
};

const alignAggregateForCandidate = async (
  client: PoolClient,
  interviewId: string,
  resultingRevision: number,
) => {
  await client.query(
    `UPDATE public.recruitment_interviews
        SET revision=$2
      WHERE interview_id=$1`,
    [interviewId, resultingRevision],
  );
};

const insertReceipt = async (
  client: PoolClient,
  commandId: string,
  interviewId: string,
  predecessorRevision: number,
  resultingRevision: number,
) => {
  await client.query(
    `INSERT INTO public.recruitment_interview_correction_command_receipts
      (command_id, command_sha256, command_json, observation_json, interview_id,
       predecessor_revision, resulting_revision, committed_at)
     VALUES ($1, repeat('a', 64), '{}'::jsonb, '{}'::jsonb, $2, $3, $4, CURRENT_TIMESTAMP)`,
    [commandId, interviewId, predecessorRevision, resultingRevision],
  );
};
export async function assertInterviewCorrectionIntegrity(
  pool: Pool,
  interviewId: string,
  options: InterviewCorrectionIntegrityOptions = {},
): Promise<void> {
  const seed = await readCorrectionSeed(pool, interviewId);
  const commandId = await readCommandIds(pool, interviewId);
  const currentRevision = seed.resultingRevision;
  const candidateRevision = currentRevision + 1;
  const baseline = await readSnapshot(pool, interviewId);
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
    const audit = await queryRows(
      pool,
      `SELECT actor_person_id
         FROM public.recruitment_interview_correction_audit
        WHERE command_id=$1`,
      [commandId],
    );
    assert.deepEqual(audit, [{ actor_person_id: options.expectedCorrectedByPersonId }]);
  }
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "assessment update immutability",
    (client) =>
      client.query(
        `UPDATE public.recruitment_interview_correction_assessments
            SET recommendation = CASE recommendation WHEN 'Ja' THEN 'Nei' ELSE 'Ja' END
          WHERE interview_id=$1 AND resulting_revision=$2`,
        [interviewId, currentRevision],
      ),
    { message: /corrections are immutable/i },
  );
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "assessment delete immutability",
    (client) =>
      client.query(
        `DELETE FROM public.recruitment_interview_correction_assessments
          WHERE interview_id=$1 AND resulting_revision=$2`,
        [interviewId, currentRevision],
      ),
    { message: /corrections are immutable/i },
  );
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt update immutability",
    (client) =>
      client.query(
        `UPDATE public.recruitment_interview_correction_command_receipts
            SET observation_json='{}'::jsonb
          WHERE command_id=$1`,
        [commandId],
      ),
    { message: /corrections are immutable/i },
  );
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt delete immutability",
    (client) =>
      client.query(
        `DELETE FROM public.recruitment_interview_correction_command_receipts
          WHERE command_id=$1`,
        [commandId],
      ),
    { message: /corrections are immutable/i },
  );
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit update immutability",
    (client) =>
      client.query(
        `UPDATE public.recruitment_interview_correction_audit
            SET occurred_at=CURRENT_TIMESTAMP
          WHERE command_id=$1`,
        [commandId],
      ),
    { message: /corrections are immutable/i },
  );
  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit delete immutability",
    (client) =>
      client.query(
        `DELETE FROM public.recruitment_interview_correction_audit
          WHERE command_id=$1`,
        [commandId],
      ),
    { message: /corrections are immutable/i },
  );

  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "skipped correction predecessor",
    async (client) => {
      await alignAggregateForCandidate(client, interviewId, candidateRevision);
      await insertAssessment(
        client,
        interviewId,
        seed,
        freshId("integrity-skipped"),
        currentRevision - 1,
        candidateRevision,
      );
    },
    { message: /predecessor must be the current effective revision/i },
  );
  await assertRejectedAndUnchanged(
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

  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "receipt assessment tuple mismatch",
    async (client) => {
      const candidateCommandId = freshId("integrity-receipt");
      await alignAggregateForCandidate(client, interviewId, candidateRevision);
      await insertAssessment(
        client,
        interviewId,
        seed,
        candidateCommandId,
        currentRevision,
        candidateRevision,
      );
      await insertReceipt(
        client,
        candidateCommandId,
        interviewId,
        seed.predecessorRevision,
        seed.resultingRevision,
      );
    },
    { constraint: "correction_receipt_assessment_chain_fk" },
  );

  await assertRejectedAndUnchanged(
    pool,
    interviewId,
    "audit receipt tuple mismatch",
    async (client) => {
      const candidateCommandId = freshId("integrity-audit");
      await alignAggregateForCandidate(client, interviewId, candidateRevision);
      await insertAssessment(
        client,
        interviewId,
        seed,
        candidateCommandId,
        currentRevision,
        candidateRevision,
      );
      await insertReceipt(
        client,
        candidateCommandId,
        interviewId,
        currentRevision,
        candidateRevision,
      );
      await client.query(
        `INSERT INTO public.recruitment_interview_correction_audit
          (command_id, interview_id, actor_person_id, predecessor_revision,
           resulting_revision, occurred_at)
         VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,
        [
          candidateCommandId,
          interviewId,
          seed.correctedByPersonId,
          seed.predecessorRevision,
          seed.resultingRevision,
        ],
      );
    },
    { constraint: "correction_audit_receipt_chain_fk" },
  );
}
