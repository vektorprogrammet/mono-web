import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted, Schema } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Pool } from "pg";
import {
  CancelInterviewCommandSchema,
  CancelInterviewObservationSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
} from "../../packages/domain/src/recruitment/schema.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../../packages/domain/src/tutor/evidence.js";
import { databaseMigrationDefinitions } from "../../packages/database/src/migrations.js";

const preCorrectionMigrations = databaseMigrationDefinitions.filter(
  (definition) => Number(definition.id.split("_")[0]) < 39,
);
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
  historicalNull: "conduct-correction-historical-null-finalize-0105",
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

export const recommendationPreupgradeFixture = {
  leaderPersonId,
  ...fixtureIds,
  explicitCommandId: fixtureCommands.explicit,
  historicalNullCommandId: fixtureCommands.historicalNull,
  cancelledCommandId: fixtureCommands.cancelled,
} as const;

export type RecommendationPreupgradeSnapshot = Readonly<{
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

export type RecommendationPreupgradeFixture = Readonly<{
  ids: typeof recommendationPreupgradeFixture;
  before0039: RecommendationPreupgradeSnapshot;
}>;

type HostRun = (
  command: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
) => string;

type MigrationDefinition = (typeof preCorrectionMigrations)[number];

const migrateBefore0039 = async (postgresUrl: string): Promise<void> => {
  const loader = Migrator.fromRecord(
    Object.fromEntries(
      preCorrectionMigrations.map((definition: MigrationDefinition) => [
        definition.id,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const source = yield* Effect.promise(() => readFile(definition.url, "utf8"));
          yield* sql.unsafe(source).raw;
        }),
      ]),
    ),
  );
  await Effect.runPromise(
    Migrator.make({})({ loader, table: "vektorprogrammet_schema_migrations" }).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgresUrl) })),
    ),
  );
};

const clone = async (
  pool: Pool,
  table: string,
  where: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  await pool.query(
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
  const explicit = interviewId === fixtureIds.explicit;
  const commandId = explicit ? fixtureCommands.explicit : fixtureCommands.historicalNull;
  const finalizedAt = explicit
    ? fixtureTimestamps.explicitFinalizedAt
    : fixtureTimestamps.historicalNullFinalizedAt;
  const command = Schema.decodeUnknownSync(FinalizeInterviewCommandSchema)({
    commandId,
    interviewId,
    expectedRevision: 1,
    answers: fixtureAnswers,
    score: fixtureScore,
    recommendation: explicit ? "Ja" : "Kanskje",
  });
  const observation = Schema.decodeUnknownSync(FinalizeInterviewObservationSchema)({
    _tag: "InterviewFinalized",
    commandId,
    interviewId,
    interviewRevision: 1,
    finalizedAt,
    completionState: "Completed",
    cancellationState: "NotCancelled",
  });
  return {
    command,
    observation,
    kind: "InterviewFinalized" as const,
    resultingRevision: 1,
    occurredAt: finalizedAt,
  };
};

const insertLifecycleRows = async (pool: Pool, interviewId: string): Promise<void> => {
  const row = lifecycleRows(interviewId);
  const digest = sha256Hex(canonicalJsonBytes(row.command));
  await pool.query(
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
  await pool.query(
    `INSERT INTO public.recruitment_interview_lifecycle_audit
      (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.command.commandId, interviewId, row.kind, leaderPersonId, row.resultingRevision, row.occurredAt],
  );
};

const recordIds = Object.values(fixtureIds);

export const readRecommendationPreupgradeSnapshot = async (
  pool: Pool,
): Promise<RecommendationPreupgradeSnapshot> => {
  const result = await pool.query(
    `SELECT
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id)
                 FROM public.recruitment_interviews row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS interviews,
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id)
                 FROM public.recruitment_interview_schedules row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS schedules,
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id)
                 FROM public.recruitment_invitations row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS invitations,
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id, row.response_revision)
                 FROM public.recruitment_invitation_response_audit row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS "invitationResponseAudits",
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id, row.ordinal)
                 FROM public.recruitment_interview_question_snapshots row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS "questionSnapshots",
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id)
                 FROM public.recruitment_interview_conducts row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS conducts,
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id)
                 FROM public.recruitment_interview_cancellations row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS cancellations,
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id, row.command_id)
                 FROM public.recruitment_interview_lifecycle_command_receipts row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS "lifecycleReceipts",
       COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.interview_id, row.command_id)
                 FROM public.recruitment_interview_lifecycle_audit row WHERE row.interview_id = ANY($1::text[])), '[]'::jsonb) AS "lifecycleAudits"`,
    [recordIds],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0] as RecommendationPreupgradeSnapshot;
};

export const seedRecommendationPreupgradeFixture = async ({
  pool,
  run,
  env,
  root,
}: {
  readonly pool: Pool;
  readonly run: HostRun;
  readonly env: NodeJS.ProcessEnv;
  readonly root: string;
}): Promise<RecommendationPreupgradeFixture> => {
  const postgresUrl = env.JOURNEY_SEED_PG_URL;
  assert.ok(postgresUrl, "JOURNEY_SEED_PG_URL is required");
  assert.equal(new URL(postgresUrl).hostname, "127.0.0.1", "preupgrade fixture requires loopback PostgreSQL");
  await migrateBefore0039(postgresUrl);
  await pool.query(
    `INSERT INTO public.person_profiles(person_id, first_name, last_name, revision)
     VALUES ($1, 'Lina', 'Lagleder', 0) ON CONFLICT (person_id) DO NOTHING`,
    [leaderPersonId],
  );
  run(
    "bun",
    ["apps/dashboard/e2e/native-conduct-journey-seed.mjs"],
    { ...env, JOURNEY_SEED_PG_URL: postgresUrl, CONDUCT_SEED_SKIP_IDENTITY: "1" },
    root,
  );
  await pool.query("BEGIN");
  try {
    for (const [key, interviewId] of Object.entries(fixtureIds) as ReadonlyArray<readonly [keyof typeof fixtureIds, string]>) {
      const applicantId = fixtureApplicants[key];
      const applicationId = fixtureApplications[key];
      const invitationId = fixtureInvitations[key];
      await clone(pool, "admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
        applicant_id: applicantId,
        email: `${key}.correction@example.invalid`,
        normalized_email: `${key}.correction@example.invalid`,
        first_name: `Correction ${key}`,
      });
      await clone(pool, "admission_applications", "application_id='application-native-conduct-a-0063'", {
        application_id: applicationId,
        applicant_id: applicantId,
      });
      await clone(pool, "recruitment_interviews", `interview_id='${baseInterviewId}'`, {
        interview_id: interviewId,
        application_id: applicationId,
      });
      await clone(pool, "recruitment_interview_schedules", `interview_id='${baseInterviewId}'`, {
        interview_id: interviewId,
      });
      await clone(pool, "recruitment_invitations", "invitation_id='invitation-native-conduct-a-0063'", {
        invitation_id: invitationId,
        interview_id: interviewId,
        capability_sha256: `${({ explicit: "e", historicalNull: "a", unfinished: "b", cancelled: "c" } as const)[key]}${"f".repeat(63)}`,
      });
      await clone(pool, "recruitment_invitation_response_audit", "invitation_id='invitation-native-conduct-a-0063'", {
        invitation_id: invitationId,
        interview_id: interviewId,
      });
      await clone(pool, "recruitment_interview_question_snapshots", `interview_id='${baseInterviewId}'`, {
        interview_id: interviewId,
      });
    }
    await pool.query(
      `INSERT INTO public.recruitment_interview_conducts
        (interview_id, answers, explanatory_power, role_model, suitability, recommendation,
         finalized_by_person_id, finalized_at, interview_revision)
       VALUES
        ($1, $4::jsonb, 4, 5, 6, 'Ja', $2, $5, 1),
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
    await pool.query(
      `UPDATE public.recruitment_interviews SET revision = 2 WHERE interview_id = $1;
       INSERT INTO public.recruitment_interview_cancellations
         (interview_id, cancelled_by_person_id, cancelled_at, interview_revision)
       VALUES ($1, $2, $3, 2)`,
      [fixtureIds.cancelled, leaderPersonId, fixtureTimestamps.cancelledAt],
    );
    await insertLifecycleRows(pool, fixtureIds.explicit);
    await insertLifecycleRows(pool, fixtureIds.historicalNull);
    await insertLifecycleRows(pool, fixtureIds.cancelled);
    await pool.query("COMMIT");
  } catch (cause) {
    await pool.query("ROLLBACK");
    throw cause;
  }
  const before0039 = await readRecommendationPreupgradeSnapshot(pool);
  assert.equal((before0039.conducts as ReadonlyArray<unknown>).length, 2);
  assert.equal((before0039.cancellations as ReadonlyArray<unknown>).length, 1);
  assert.equal((before0039.lifecycleReceipts as ReadonlyArray<unknown>).length, 3);
  assert.equal((before0039.lifecycleAudits as ReadonlyArray<unknown>).length, 3);
  return { ids: recommendationPreupgradeFixture, before0039 };
};

export const assertRecommendationPreupgradePreserved = async (
  pool: Pool,
  fixture: RecommendationPreupgradeFixture,
): Promise<void> => {
  const after0039 = await readRecommendationPreupgradeSnapshot(pool);
  assert.deepEqual(after0039, fixture.before0039, "0039 changed pre-existing recruitment records");
};
