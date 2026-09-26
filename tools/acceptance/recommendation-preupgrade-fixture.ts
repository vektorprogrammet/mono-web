import { Record as Rec, Schema } from "effect";
import assert from "node:assert/strict";

import type { Pool, PoolClient } from "pg";

import {
  CancelInterviewCommandSchema,
  CancelInterviewObservationSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
} from "../../packages/domain/src/recruitment/schema.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "../../packages/domain/src/shared-kernel/index.js";

const leaderPersonId = "journey-conduct-leader-0063";

const baseInterviewId = "interview-native-conduct-a-0063";

const fixtureIds = {
  explicit: "interview-correction-explicit-0105",
  historicalNull: "interview-recommendation-history",
  unfinished: "interview-correction-unfinished-0105",
  cancelled: "interview-correction-cancelled-0105",
} as const;

const fixtureApplicants = {
  explicit: "applicant-correction-explicit-0105",
  historicalNull: "applicant-recommendation-history",
  unfinished: "applicant-correction-unfinished-0105",
  cancelled: "applicant-correction-cancelled-0105",
} as const;

const fixtureApplications = {
  explicit: "application-correction-explicit-0105",
  historicalNull: "application-recommendation-history",
  unfinished: "application-correction-unfinished-0105",
  cancelled: "application-correction-cancelled-0105",
} as const;

const fixtureInvitations = {
  explicit: "invitation-correction-explicit-0105",
  historicalNull: "invitation-recommendation-history",
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
  {
    questionId: "interview-schema-native-conduct-0063-q0",
    answer: "Original correction fixture answer.",
  },
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

const InterviewCorrectionPre0039SnapshotSchema = Schema.Struct({
  interviews: Schema.Array(Schema.Json),
  schedules: Schema.Array(Schema.Json),
  invitations: Schema.Array(Schema.Json),
  invitationResponseAudits: Schema.Array(Schema.Json),
  questionSnapshots: Schema.Array(Schema.Json),
  conducts: Schema.Array(Schema.Json),
  cancellations: Schema.Array(Schema.Json),
  lifecycleReceipts: Schema.Array(Schema.Json),
  lifecycleAudits: Schema.Array(Schema.Json),
});

export type InterviewCorrectionPre0039Snapshot =
  typeof InterviewCorrectionPre0039SnapshotSchema.Type;

export type InterviewCorrectionPre0039Fixture = Readonly<{
  ids: typeof interviewCorrectionPre0039Fixture;
  before0039: InterviewCorrectionPre0039Snapshot;
}>;

/**
 * Synthetic post-migration designation for the bounded 0106 rehearsal.
 * Identity rows are created by the real native identity seed; this fixture
 * only creates active membership facts and the already-designated aggregate.
 */
export const coInterviewerCorrection0106Fixture = {
  targetInterviewId: fixtureIds.historicalNull,
  selfLinkRaceInterviewId: "interview-recommendation-link-race",
  primaryPersonId: leaderPersonId,
  primaryMembershipId: "membership-native-conduct-leader-0063",
  departmentId: "department-native-conduct-0063",
  teamId: "team-native-conduct-0063",
  differentDepartmentId: "department-other-co-interviewer-0106",
  coInterviewer: {
    personId: "journey-co-interviewer-0106",
    membershipId: "membership-co-interviewer-0106",
    firstName: "Cora",
    lastName: "Medintervjuer",
    displayName: "Cora Medintervjuer",
    email: "cora.co-interviewer@example.invalid",
    password: "co-interviewer-secret-0106",
  },
  unassignedMember: {
    personId: "journey-unassigned-member-0106",
    membershipId: "membership-unassigned-member-0106",
    firstName: "Una",
    lastName: "Tildelt",
    email: "una.unassigned@example.invalid",
    password: "unassigned-member-secret-0106",
  },
} as const;

export const coInterviewerCorrection0106IdentitySeeds = [
  {
    personId: coInterviewerCorrection0106Fixture.coInterviewer.personId,
    firstName: coInterviewerCorrection0106Fixture.coInterviewer.firstName,
    lastName: coInterviewerCorrection0106Fixture.coInterviewer.lastName,
    email: coInterviewerCorrection0106Fixture.coInterviewer.email,
    password: coInterviewerCorrection0106Fixture.coInterviewer.password,
  },
  {
    personId: coInterviewerCorrection0106Fixture.unassignedMember.personId,
    firstName: coInterviewerCorrection0106Fixture.unassignedMember.firstName,
    lastName: coInterviewerCorrection0106Fixture.unassignedMember.lastName,
    email: coInterviewerCorrection0106Fixture.unassignedMember.email,
    password: coInterviewerCorrection0106Fixture.unassignedMember.password,
  },
] as const;

export type CoInterviewerCorrection0106Fixture = typeof coInterviewerCorrection0106Fixture;

type SqlConnection = Pool | PoolClient;

const clone = async (
  client: PoolClient,
  table: string,
  where: string,
  overrides: Schema.JsonObject,
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

    const observation = CancelInterviewObservationSchema.make({
      commandId: command.commandId,
      interviewId: command.interviewId,
      interviewRevision: 2,
      cancelledAt: CancelInterviewObservationSchema.fields.cancelledAt.make(
        fixtureTimestamps.cancelledAt,
      ),
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

  const observation = FinalizeInterviewObservationSchema.make({
    commandId: command.commandId,
    interviewId: command.interviewId,
    interviewRevision: 2,
    finalizedAt: FinalizeInterviewObservationSchema.fields.finalizedAt.make(
      fixtureTimestamps.explicitFinalizedAt,
    ),
    completionState: "Completed",
    cancellationState: "NotCancelled",
    notificationState: "Pending",
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
    [
      row.command.commandId,
      interviewId,
      row.kind,
      leaderPersonId,
      row.resultingRevision,
      row.occurredAt,
    ],
  );
};

const recordIds = Object.values(fixtureIds);

export const readInterviewCorrectionPre0039Snapshot = async (
  connection: SqlConnection,
): Promise<InterviewCorrectionPre0039Snapshot> => {
  const result = await connection.query(
    `SELECT
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) - 'co_interviewer_person_id' ORDER BY entry.interview_id)
                 FROM public.recruitment_interviews entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS interviews,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_interview_schedules entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS schedules,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.interview_id)
                 FROM public.recruitment_invitations entry WHERE entry.interview_id = ANY($1::text[])), '[]'::jsonb) AS invitations,
       COALESCE((SELECT jsonb_agg(to_jsonb(entry) - 'envelope_sha256' ORDER BY entry.interview_id, entry.response_revision)
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

  return Schema.decodeUnknownSync(InterviewCorrectionPre0039SnapshotSchema)(result.rows[0]);
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
      for (const key of Rec.keys(fixtureIds)) {
        const interviewId = fixtureIds[key];

        if (key === "historicalNull") continue;
        const applicantId = fixtureApplicants[key];
        const applicationId = fixtureApplications[key];
        const invitationId = fixtureInvitations[key];
        await clone(
          client,
          "admission_applicants",
          "applicant_id='applicant-native-conduct-a-0063'",
          {
            applicant_id: applicantId,
            email: `${key}.correction@example.invalid`,
            normalized_email: `${key}.correction@example.invalid`,
            first_name: `Correction ${key}`,
          },
        );
        await clone(
          client,
          "admission_applications",
          "application_id='application-native-conduct-a-0063'",
          {
            application_id: applicationId,
            applicant_id: applicantId,
          },
        );
        await clone(client, "recruitment_interviews", `interview_id='${baseInterviewId}'`, {
          interview_id: interviewId,
          application_id: applicationId,
        });
        await clone(
          client,
          "recruitment_interview_schedules",
          `interview_id='${baseInterviewId}'`,
          {
            interview_id: interviewId,
          },
        );
        await clone(
          client,
          "recruitment_invitations",
          "invitation_id='invitation-native-conduct-a-0063'",
          {
            invitation_id: invitationId,
            interview_id: interviewId,
            capability_sha256: `${({ explicit: "e", historicalNull: "a", unfinished: "b", cancelled: "c" } as const)[key]}${"f".repeat(63)}`,
          },
        );
        await clone(
          client,
          "recruitment_invitation_response_audit",
          "invitation_id='invitation-native-conduct-a-0063'",
          {
            invitation_id: invitationId,
            interview_id: interviewId,
          },
        );
        await clone(
          client,
          "recruitment_interview_question_snapshots",
          `interview_id='${baseInterviewId}'`,
          {
            interview_id: interviewId,
          },
        );
      }

      await client.query(
        `INSERT INTO public.recruitment_interview_conducts
          (interview_id, answers, explanatory_power, role_model, suitability, recommendation,
           finalized_by_person_id, finalized_at, interview_revision)
         VALUES ($1, $3::jsonb, 4, 5, 6, 'Ja', $2, $4, 2)`,
        [
          fixtureIds.explicit,
          leaderPersonId,
          canonicalJson(fixtureAnswers),
          fixtureTimestamps.explicitFinalizedAt,
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
  assert.equal(before0039.conducts.length, 2);
  assert.equal(before0039.cancellations.length, 1);
  assert.equal(before0039.lifecycleReceipts.length, 2);
  assert.equal(before0039.lifecycleAudits.length, 2);

  return { ids: interviewCorrectionPre0039Fixture, before0039 };
};

export const assertInterviewCorrectionPre0039Preserved = async (
  connection: SqlConnection,
  fixture: InterviewCorrectionPre0039Fixture,
): Promise<void> => {
  const after0039 = await readInterviewCorrectionPre0039Snapshot(connection);
  assert.deepEqual(
    after0039,
    fixture.before0039,
    "migration changed pre-existing recruitment records",
  );
};

export const seedCoInterviewerCorrection0106Fixture = async ({
  pool,
}: {
  readonly pool: Pool;
}): Promise<CoInterviewerCorrection0106Fixture> => {
  const fixture = coInterviewerCorrection0106Fixture;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    try {
      const identities = await client.query(
        `SELECT person_id AS "personId"
           FROM public.person_profiles
          WHERE person_id = ANY($1::text[])
          ORDER BY person_id`,
        [[fixture.coInterviewer.personId, fixture.unassignedMember.personId].sort()],
      );

      assert.deepEqual(
        identities.rows.map((row) => row.personId),
        [fixture.coInterviewer.personId, fixture.unassignedMember.personId].sort(),
        "0106 identity seed must create both ordinary native Persons before designation",
      );

      const sourceMembership = await client.query(
        `SELECT membership.membership_id AS "membershipId", membership.person_id AS "personId",
                membership.is_team_leader AS "isTeamLeader", membership.is_suspended AS "isSuspended",
                membership.end_at AS "endAt", team.team_id AS "teamId",
                team.department_id AS "departmentId"
           FROM public.organization_memberships AS membership
           JOIN public.organization_teams AS team USING(team_id)
          WHERE membership.membership_id = $1`,
        [fixture.primaryMembershipId],
      );

      assert.deepEqual(sourceMembership.rows, [
        {
          membershipId: fixture.primaryMembershipId,
          personId: fixture.primaryPersonId,
          isTeamLeader: false,
          isSuspended: false,
          endAt: null,
          teamId: fixture.teamId,
          departmentId: fixture.departmentId,
        },
      ]);

      const existingMemberships = await client.query(
        `SELECT membership_id AS "membershipId"
           FROM public.organization_memberships
          WHERE membership_id = ANY($1::text[])
          ORDER BY membership_id`,
        [[fixture.coInterviewer.membershipId, fixture.unassignedMember.membershipId].sort()],
      );

      assert.equal(existingMemberships.rows.length, 0, "0106 fixture memberships must be fresh");

      for (const person of [fixture.coInterviewer, fixture.unassignedMember]) {
        await clone(client, "person_contact_profiles", `person_id='${fixture.primaryPersonId}'`, {
          person_id: person.personId,
          email: person.email,
        });
        await clone(
          client,
          "organization_memberships",
          `membership_id='${fixture.primaryMembershipId}'`,
          {
            membership_id: person.membershipId,
            person_id: person.personId,
            is_team_leader: false,
            position_id: "member",
            is_suspended: false,
            revision: 0,
          },
        );
      }

      await client.query(
        `INSERT INTO public.admission_period_departments
           SELECT (jsonb_populate_record(
             NULL::public.admission_period_departments,
             to_jsonb(department) || jsonb_build_object('department_id', $1::text)
           )).*
             FROM public.admission_period_departments AS department
            WHERE department.department_id=$2
           ON CONFLICT (department_id) DO NOTHING`,
        [fixture.differentDepartmentId, fixture.departmentId],
      );

      const candidates = await client.query(
        `SELECT interview_id AS "interviewId", interviewer_person_id AS "interviewerPersonId",
                co_interviewer_person_id AS "coInterviewerPersonId"
           FROM public.recruitment_interviews
          WHERE interview_id = ANY($1::text[])
          ORDER BY interview_id`,
        [[fixture.targetInterviewId, fixture.selfLinkRaceInterviewId].sort()],
      );

      assert.equal(
        candidates.rows.length,
        2,
        "0106 fixture needs completed and self-link race interviews",
      );

      for (const row of candidates.rows) {
        assert.equal(row.interviewerPersonId, fixture.primaryPersonId);
        assert.equal(
          row.coInterviewerPersonId,
          null,
          "pre-0040 fixture rows must remain undesignated before the synthetic 0106 designation",
        );
      }

      const designated = await client.query(
        `UPDATE public.recruitment_interviews
            SET co_interviewer_person_id=$1
          WHERE interview_id = ANY($2::text[])
          RETURNING interview_id AS "interviewId", co_interviewer_person_id AS "coInterviewerPersonId"`,
        [
          fixture.coInterviewer.personId,
          [fixture.targetInterviewId, fixture.selfLinkRaceInterviewId],
        ],
      );

      assert.deepEqual(
        designated.rows.sort((left, right) =>
          String(left.interviewId).localeCompare(String(right.interviewId)),
        ),
        [fixture.targetInterviewId, fixture.selfLinkRaceInterviewId].sort().map((interviewId) => ({
          interviewId,
          coInterviewerPersonId: fixture.coInterviewer.personId,
        })),
      );
      await clone(
        client,
        "recruitment_interview_conducts",
        `interview_id='${fixtureIds.explicit}'`,
        {
          interview_id: fixture.selfLinkRaceInterviewId,
          interview_revision: 1,
        },
      );
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    }
  } finally {
    client.release();
  }

  return fixture;
};
