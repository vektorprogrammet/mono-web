import assert from "node:assert/strict";
import { Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import {
  CancelInterviewCommandSchema,
  CancelInterviewObservationSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
} from "../../packages/domain/src/recruitment/schema.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../../packages/domain/src/tutor/evidence.js";

const leaderPersonId = "journey-conduct-leader-0063";
const baseInterviewId = "interview-native-conduct-a-0063";
const fixtureIds = {
  explicit: "interview-correction-explicit-0105",
  historicalNull: "interview-correction-historical-null-0105",
  unfinished: "interview-correction-unfinished-0105",
  cancelled: "interview-correction-cancelled-0105",
} as const;
const fixtureApplicants = {
  explicit: "applicant-correction-explicit-0105",
  historicalNull: "applicant-correction-historical-null-0105",
  unfinished: "applicant-correction-unfinished-0105",
  cancelled: "applicant-correction-cancelled-0105",
} as const;
const fixtureApplications = {
  explicit: "application-correction-explicit-0105",
  historicalNull: "application-correction-historical-null-0105",
  unfinished: "application-correction-unfinished-0105",
  cancelled: "application-correction-cancelled-0105",
} as const;
const fixtureInvitations = {
  explicit: "invitation-correction-explicit-0105",
  historicalNull: "invitation-correction-historical-null-0105",
  unfinished: "invitation-correction-unfinished-0105",
  cancelled: "invitation-correction-cancelled-0105",
} as const;
const fixtureCommands = {
  explicit: "conduct-correction-explicit-finalize-0105",
  cancelled: "conduct-correction-cancel-0105",
} as const;
const fixtureTimestamps = {
  explicitFinalizedAt: "2031-09-14T10:00:00.000Z",
  historicalNullFinalizedAt: "2031-09-14T10:01:00.000Z",
  cancelledAt: "2031-09-14T10:02:00.000Z",
} as const;
const fixtureAnswers = [
  { questionId: "interview-schema-native-conduct-0063-q0", answer: "Original correction fixture answer." },
  { questionId: "interview-schema-native-conduct-0063-q1", answer: ["Teknologi"] },
  { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
  { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
] as const;
const fixtureScore = { explanatoryPower: 4, roleModel: 5, suitability: 6 } as const;

export const interviewCorrectionPre0039Fixture = {
  leaderPersonId,
  ...fixtureIds,
  explicitCommandId: fixtureCommands.explicit,
  cancelledCommandId: fixtureCommands.cancelled,
} as const;

export type InterviewCorrectionPre0039Snapshot = Readonly<{
  interviews: unknown;
  schedules: unknown;
  invitations: unknown;
  invitationResponseAudits: unknown;
  questionSnapshots: unknown;
  conducts: unknown;
  cancellations: unknown;
  lifecycleReceipts: unknown;
  lifecycleAudits: unknown;
}>;

export type InterviewCorrectionPre0039Fixture = Readonly<{
  ids: typeof interviewCorrectionPre0039Fixture;
  before0039: InterviewCorrectionPre0039Snapshot;
}>;

type SqlConnection = Pool | PoolClient;

const clone = async (
  client: PoolClient,
  table: string,
  where: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  await client.query(
    `INSERT INTO public.${table}
       SELECT (jsonb_populate_record(NULL::public.${table}, to_jsonb(source) || $1::jsonb)).*
       FROM public.${table} source WHERE ${where}`,
    [JSON.stringify(overrides)],
  );
};

const lifecycleRows = (interviewId: string) => {
  if (interviewId === fixtureIds.cancelled) {
    const command = Schema.decodeUnknownSync(CancelInterviewCommandSchema)({
      commandId: fixtureCommands.cancelled,
      interviewId,
      expectedRevision: 1,
    });
    const observation = Schema.decodeUnknownSync(CancelInterviewObservationSchema)({
      _tag: "InterviewCancelled",
      commandId: fixtureCommands.cancelled,
      interviewId,
      interviewRevision: 2,
      cancelledAt: fixtureTimestamps.cancelledAt,
      completionState: "NotCompleted",
      cancellationState: "Cancelled",
    });
    return {
      command,
      observation,
      kind: "InterviewCancelled" as const,
      resultingRevision: 2,
      occurredAt: fixtureTimestamps.cancelledAt,
    };
  }
  assert.equal(interviewId, fixtureIds.explicit);
  const command = Schema.decodeUnknownSync(FinalizeInterviewCommandSchema)({
    commandId: fixtureCommands.explicit,
    interviewId,
    expectedRevision: 1,
    answers: fixtureAnswers,
    score: fixtureScore,
    recommendation: "Ja",
  });
  const observation = Schema.decodeUnknownSync(FinalizeInterviewObservationSchema)({
    _tag: "InterviewFinalized",
    commandId: fixtureCommands.explicit,
    interviewId,
    interviewRevision: 2,
    finalizedAt: fixtureTimestamps.explicitFinalizedAt,
    completionState: "Completed",
    cancellationState: "NotCancelled",
  });
  return {
    command,
    observation,
    kind: "InterviewFinalized" as const,
    resultingRevision: 2,
    occurredAt: fixtureTimestamps.explicitFinalizedAt,
  };
};

const insertLifecycleRows = async (client: PoolClient, interviewId: string): Promise<void> => {
  const row = lifecycleRows(interviewId);
  const digest = sha256Hex(canonicalJsonBytes(row.command));
  await client.query(
    `INSERT INTO public.recruitment_interview_lifecycle_command_receipts
      (command_id, command_sha256, command_json, observation_json, kind, interview_id, resulting_revision, committed_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)`,
    [
      row.command.commandId,
      digest,
      canonicalJson(row.command),
      canonicalJson(row.observation),
      row.kind,
      interviewId,
      row.resultingRevision,
      row.occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO public.recruitment_interview_lifecycle_audit
      (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.command.commandId, interviewId, row.kind, leaderPersonId, row.resultingRevision, row.occurredAt],
  );
};

const recordIds = Object.values(fixtureIds);

export const readInterviewCorrectionPre0039Snapshot = async (
  connection: SqlConnection,
): Promise<InterviewCorrectionPre0039Snapshot> => {
  const result = await connection.query(
    `SELECT
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_interviews entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS interviews,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_interview_schedules entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS schedules,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_invitations entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS invitations,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id, entry.response_revision)
                 FROM public.recruitment_invitation_response_audit entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS "invitationResponseAudits",
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id, entry.ordinal)
                 FROM public.recruitment_interview_question_snapshots entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS "questionSnapshots",
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_interview_conducts entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS conducts,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_interview_cancellations entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS cancellations,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id, entry.command_id)
                 FROM public.recruitment_interview_lifecycle_command_receipts entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS "lifecycleReceipts",
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id, entry.command_id)
                 FROM public.recruitment_interview_lifecycle_audit entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS "lifecycleAudits"`,
    [recordIds],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0] as InterviewCorrectionPre0039Snapshot;
};

export const seedInterviewCorrectionPre0039Fixture = async ({
  pool,
}: {
  readonly pool: Pool;
}): Promise<InterviewCorrectionPre0039Fixture> => {
  const base = await pool.query(
    `SELECT count(*)::int AS count FROM public.recruitment_interviews WHERE interview_id = $1`,
    [baseInterviewId],
  );
  assert.equal(base.rows[0]?.count, 1, "native conduct seed must run before the 0105 fixture");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      for (const [key, interviewId] of Object.entries(fixtureIds) as ReadonlyArray<readonly [keyof typeof fixtureIds, string]>) {
        const applicantId = fixtureApplicants[key];
        const applicationId = fixtureApplications[key];
        const invitationId = fixtureInvitations[key];
        await clone(client, "admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
          applicant_id: applicantId,
          email: `${key}.correction@example.invalid`,
          normalized_email: `${key}.correction@example.invalid`,
          first_name: `Correction ${key}`,
        });
        await clone(client, "admission_applications", "application_id='application-native-conduct-a-0063'", {
          application_id: applicationId,
          applicant_id: applicantId,
        });
        await clone(client, "recruitment_interviews", `interview_id='${baseInterviewId}'`, {
          interview_id: interviewId,
          application_id: applicationId,
        });
        await clone(client, "recruitment_interview_schedules", `interview_id='${baseInterviewId}'`, {
          interview_id: interviewId,
        });
        await clone(client, "recruitment_invitations", "invitation_id='invitation-native-conduct-a-0063'", {
          invitation_id: invitationId,
          interview_id: interviewId,
          capability_sha256: `${({ explicit: "e", historicalNull: "a", unfinished: "b", cancelled: "c" } as const)[key]}${"f".repeat(63)}`,
        });
        await clone(client, "recruitment_invitation_response_audit", "invitation_id='invitation-native-conduct-a-0063'", {
          invitation_id: invitationId,
          interview_id: interviewId,
        });
        await clone(client, "recruitment_interview_question_snapshots", `interview_id='${baseInterviewId}'`, {
          interview_id: interviewId,
        });
      }
      await client.query(
        `INSERT INTO public.recruitment_interview_conducts
          (interview_id, answers, explanatory_power, role_model, suitability, recommendation,
           finalized_by_person_id, finalized_at, interview_revision)
         VALUES
          ($1, $4::jsonb, 4, 5, 6, 'Ja', $2, $5, 2),
          ($3, $4::jsonb, 4, 5, 6, NULL, $2, $6, 1)`,
        [
          fixtureIds.explicit,
          leaderPersonId,
          fixtureIds.historicalNull,
          canonicalJson(fixtureAnswers),
          fixtureTimestamps.explicitFinalizedAt,
          fixtureTimestamps.historicalNullFinalizedAt,
        ],
      );
      await client.query(
        `UPDATE public.recruitment_interviews SET revision = 2 WHERE interview_id = $1`,
        [fixtureIds.explicit],
      );
      await client.query(
        `UPDATE public.recruitment_interviews SET revision = 2 WHERE interview_id = $1`,
        [fixtureIds.cancelled],
      );
      await client.query(
        `INSERT INTO public.recruitment_interview_cancellations
          (interview_id, cancelled_by_person_id, cancelled_at, interview_revision)
         VALUES ($1, $2, $3, 2)`,
        [fixtureIds.cancelled, leaderPersonId, fixtureTimestamps.cancelledAt],
      );
      await insertLifecycleRows(client, fixtureIds.explicit);
      await insertLifecycleRows(client, fixtureIds.cancelled);
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    }
  } finally {
    client.release();
  }
  const before0039 = await readInterviewCorrectionPre0039Snapshot(pool);
  assert.equal((before0039.conducts as ReadonlyArray<unknown>).length, 2);
  assert.equal((before0039.cancellations as ReadonlyArray<unknown>).length, 1);
  assert.equal((before0039.lifecycleReceipts as ReadonlyArray<unknown>).length, 2);
  assert.equal((before0039.lifecycleAudits as ReadonlyArray<unknown>).length, 2);
  return { ids: interviewCorrectionPre0039Fixture, before0039 };
};

export const assertInterviewCorrectionPre0039Preserved = async (
  connection: SqlConnection,
  fixture: InterviewCorrectionPre0039Fixture,
): Promise<void> => {
  const after0039 = await readInterviewCorrectionPre0039Snapshot(connection);
  assert.deepEqual(after0039, fixture.before0039, "0039 changed pre-existing recruitment records");
};
