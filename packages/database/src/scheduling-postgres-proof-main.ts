import assert from "node:assert/strict";
import { Cause, Config, Effect, Layer, Redacted } from "effect";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, OrganizationLive, PersonId } from "@vektorprogrammet/domain/organization";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import {
  Recruitment,
  RecruitmentInterviewId,
  RecruitmentInvitationId,
  RecruitmentLive,
  RecruitmentScheduleCommandId,
  type RecruitmentScheduleCommand,
  type RecruitmentScheduleContext,
} from "@vektorprogrammet/domain/recruitment";
import { DatabaseLive } from "./layers.js";

const cohort = {
  id: "recruitment-scheduling-postgres-proof-0050-v1",
  departmentId: "scheduling-pg-proof-0050-department",
  semesterId: "scheduling-pg-proof-0050-semester",
  admissionPeriodId: "scheduling-pg-proof-0050-period",
  fieldOfStudyId: "scheduling-pg-proof-0050-field",
  applicantAId: "scheduling-pg-proof-0050-applicant-a",
  applicantBId: "scheduling-pg-proof-0050-applicant-b",
  applicationAId: "scheduling-pg-proof-0050-application-a",
  applicationBId: "scheduling-pg-proof-0050-application-b",
  teamId: "scheduling-pg-proof-0050-team",
  leaderMembershipId: "scheduling-pg-proof-0050-leader-membership",
  interviewerMembershipId: "scheduling-pg-proof-0050-interviewer-membership",
  leaderPersonId: "scheduling-pg-proof-0050-leader",
  interviewerPersonId: "scheduling-pg-proof-0050-interviewer",
  interviewSchemaId: "scheduling-pg-proof-0050-schema",
  staleInterviewId: "scheduling-pg-proof-0050-interview-stale",
  replayInterviewId: "scheduling-pg-proof-0050-interview-replay",
  commandAId: "scheduling-pg-proof-0050-command-a",
  commandBId: "scheduling-pg-proof-0050-command-b",
  replayCommandId: "scheduling-pg-proof-0050-command-replay",
  invitationAId: "scheduling-pg-proof-0050-invitation-a",
  invitationBId: "scheduling-pg-proof-0050-invitation-b",
  replayInvitationId: "scheduling-pg-proof-0050-invitation-replay",
} as const;

interface LinkageCountRow {
  readonly schedules: string;
  readonly invitations: string;
  readonly receipts: string;
  readonly audits: string;
  readonly outbox: string;
  readonly linkedRows: string;
  readonly partialRows: string;
}

const hasFailureTag = (
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
  tag: string,
): boolean =>
  result._tag === "Failure" &&
  result.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      "_tag" in reason.error &&
      reason.error._tag === tag,
  );

const resetCohort = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM recruitment_invitation_outbox
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_schedule_audit
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_schedule_command_receipts
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_invitations
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_interview_schedules
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_assignment_audit
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_assignment_command_receipts
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_interviews
        WHERE interview_id IN (${cohort.staleInterviewId}, ${cohort.replayInterviewId})
      `;
      yield* sql`
        DELETE FROM recruitment_interview_schemas
        WHERE interview_schema_id = ${cohort.interviewSchemaId}
      `;
      yield* sql`
        DELETE FROM person_contact_profiles
        WHERE person_id IN (${cohort.leaderPersonId}, ${cohort.interviewerPersonId})
      `;
      yield* sql`
        DELETE FROM organization_memberships
        WHERE membership_id IN (${cohort.leaderMembershipId}, ${cohort.interviewerMembershipId})
      `;
      yield* sql`DELETE FROM person_profiles WHERE person_id IN (${cohort.leaderPersonId}, ${cohort.interviewerPersonId})`;
      yield* sql`DELETE FROM organization_teams WHERE team_id = ${cohort.teamId}`;
      yield* sql`DELETE FROM organization_departments WHERE department_id = ${cohort.departmentId}`;
      yield* sql`
        DELETE FROM admission_applications
        WHERE application_id IN (${cohort.applicationAId}, ${cohort.applicationBId})
      `;
      yield* sql`
        DELETE FROM admission_applicants
        WHERE applicant_id IN (${cohort.applicantAId}, ${cohort.applicantBId})
      `;
      yield* sql`
        DELETE FROM admission_period_fields_of_study
        WHERE field_of_study_id = ${cohort.fieldOfStudyId}
      `;
      yield* sql`DELETE FROM admission_periods WHERE admission_period_id = ${cohort.admissionPeriodId}`;
      yield* sql`DELETE FROM admission_period_semesters WHERE semester_id = ${cohort.semesterId}`;
      yield* sql`DELETE FROM admission_period_departments WHERE department_id = ${cohort.departmentId}`;
    }),
  );

const seedCohort = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO admission_period_departments (department_id, name)
        VALUES (${cohort.departmentId}, 'Scheduling PostgreSQL Proof Department')
      `;
      yield* sql`
        INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
        VALUES (${cohort.semesterId}, '2035-08-01T00:00:00.000Z', '2036-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO admission_periods (
          admission_period_id, department_id, semester_id, start_at, end_at, last_command_id
        ) VALUES (
          ${cohort.admissionPeriodId}, ${cohort.departmentId}, ${cohort.semesterId},
          '2035-09-01T00:00:00.000Z', '2035-10-01T00:00:00.000Z',
          'scheduling-pg-proof-0050-period-created'
        )
      `;
      yield* sql`
        INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name)
        VALUES (${cohort.fieldOfStudyId}, ${cohort.departmentId}, 'Computer Science')
      `;
      yield* sql`
        INSERT INTO admission_applicants (
          applicant_id, normalized_email, email, first_name, last_name, phone,
          gender, field_of_study_id, year_of_study
        ) VALUES
          (
            ${cohort.applicantAId}, 'scheduling-proof-a@example.invalid',
            'scheduling-proof-a@example.invalid', 'Ada', 'Applicant', '90000001',
            1, ${cohort.fieldOfStudyId}, 2
          ),
          (
            ${cohort.applicantBId}, 'scheduling-proof-b@example.invalid',
            'scheduling-proof-b@example.invalid', 'Bjarne', 'Applicant', '90000002',
            1, ${cohort.fieldOfStudyId}, 2
          )
      `;
      yield* sql`
        INSERT INTO admission_applications (
          application_id, applicant_id, admission_period_id, department_id,
          field_of_study_id, year_of_study, submitted_at
        ) VALUES
          (
            ${cohort.applicationAId}, ${cohort.applicantAId}, ${cohort.admissionPeriodId},
            ${cohort.departmentId}, ${cohort.fieldOfStudyId}, 2, '2035-09-10T12:00:00.000Z'
          ),
          (
            ${cohort.applicationBId}, ${cohort.applicantBId}, ${cohort.admissionPeriodId},
            ${cohort.departmentId}, ${cohort.fieldOfStudyId}, 2, '2035-09-10T12:01:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO organization_departments (department_id, name, short_name, email, city)
        VALUES (
          ${cohort.departmentId}, 'Scheduling PostgreSQL Proof Department', 'SPG',
          'scheduling-proof@example.invalid', 'Bergen'
        )
      `;
      yield* sql`
        INSERT INTO organization_teams (team_id, department_id, name)
        VALUES (${cohort.teamId}, ${cohort.departmentId}, 'Scheduling Proof Team')
      `;
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name)
        VALUES
          (${cohort.leaderPersonId}, 'Lise', 'Leader'),
          (${cohort.interviewerPersonId}, 'Ivar', 'Interviewer')
      `;
      yield* sql`
        INSERT INTO person_contact_profiles (person_id, email, phone)
        VALUES
          (${cohort.leaderPersonId}, 'leader.scheduling-proof@example.invalid', '91000001'),
          (${cohort.interviewerPersonId}, 'interviewer.scheduling-proof@example.invalid', '91000002')
      `;
      yield* sql`
        INSERT INTO organization_memberships (
          membership_id, person_id, team_id, start_at, position_id, is_team_leader
        ) VALUES
          (
            ${cohort.leaderMembershipId}, ${cohort.leaderPersonId}, ${cohort.teamId},
            '2035-01-01T00:00:00.000Z', 'leader', TRUE
          ),
          (
            ${cohort.interviewerMembershipId}, ${cohort.interviewerPersonId}, ${cohort.teamId},
            '2035-01-01T00:00:00.000Z', 'assistant', FALSE
          )
      `;
      yield* sql`
        INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count)
        VALUES (${cohort.interviewSchemaId}, 'Scheduling proof interview', 8)
      `;
      yield* sql`
        INSERT INTO recruitment_interview_schema_questions (
          interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives
        )
        VALUES
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q0`}, 0, 'Question 0', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q1`}, 1, 'Question 1', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q2`}, 2, 'Question 2', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q3`}, 3, 'Question 3', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q4`}, 4, 'Question 4', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q5`}, 5, 'Question 5', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q6`}, 6, 'Question 6', NULL, 'text', '[]'::jsonb),
          (${cohort.interviewSchemaId}, ${`${cohort.interviewSchemaId}-q7`}, 7, 'Question 7', NULL, 'text', '[]'::jsonb)
      `;
      yield* sql`
        INSERT INTO recruitment_interviews (
          interview_id, application_id, department_id, interviewer_person_id,
          interview_schema_id, assigned_by_person_id, assigned_at, revision
        ) VALUES
          (
            ${cohort.staleInterviewId}, ${cohort.applicationAId}, ${cohort.departmentId},
            ${cohort.interviewerPersonId}, ${cohort.interviewSchemaId}, ${cohort.leaderPersonId},
            '2035-09-15T11:00:00.000Z', 0
          ),
          (
            ${cohort.replayInterviewId}, ${cohort.applicationBId}, ${cohort.departmentId},
            ${cohort.interviewerPersonId}, ${cohort.interviewSchemaId}, ${cohort.leaderPersonId},
            '2035-09-15T11:01:00.000Z', 0
          )
      `;
    }),
  );

const actor = {
  _tag: "DepartmentLeader" as const,
  personId: PersonId.make(cohort.leaderPersonId),
  departmentId: DepartmentId.make(cohort.departmentId),
  active: true,
};

const makeContext = (
  invitationId: string,
  responseCapability: string,
): RecruitmentScheduleContext => ({
  actor,
  now: "2035-09-15T12:00:00.000Z",
  invitationId: RecruitmentInvitationId.make(invitationId),
  responseCapability,
});

const commandA: RecruitmentScheduleCommand = {
  commandId: RecruitmentScheduleCommandId.make(cohort.commandAId),
  interviewId: RecruitmentInterviewId.make(cohort.staleInterviewId),
  expectedRevision: 0,
  scheduledAt: "2035-09-20T09:00:00.000Z",
  room: "Proof Room A",
  campus: "Bergen",
  mapLink: "https://example.invalid/map/a",
  message: "Concurrent scheduling proof A",
};

const commandB: RecruitmentScheduleCommand = {
  commandId: RecruitmentScheduleCommandId.make(cohort.commandBId),
  interviewId: RecruitmentInterviewId.make(cohort.staleInterviewId),
  expectedRevision: 0,
  scheduledAt: "2035-09-20T10:00:00.000Z",
  room: "Proof Room B",
  campus: "Bergen",
  mapLink: "https://example.invalid/map/b",
  message: "Concurrent scheduling proof B",
};

const replayCommand: RecruitmentScheduleCommand = {
  commandId: RecruitmentScheduleCommandId.make(cohort.replayCommandId),
  interviewId: RecruitmentInterviewId.make(cohort.replayInterviewId),
  expectedRevision: 0,
  scheduledAt: "2035-09-21T09:00:00.000Z",
  room: "Proof Replay Room",
  campus: null,
  mapLink: null,
  message: "Concurrent identical scheduling proof",
};

const proof = Effect.gen(function* () {
  const sql = yield* Database;
  const recruitment = yield* Recruitment;
  assert.equal(sql.schemaRevision, "12_native-recruitment-invitation-response");
  yield* resetCohort(sql);
  yield* seedCohort(sql);

  const differentCommandResults = yield* Effect.all(
    [
      Effect.exit(
        recruitment.scheduleInterview(commandA, makeContext(cohort.invitationAId, "a".repeat(43))),
      ),
      Effect.exit(
        recruitment.scheduleInterview(commandB, makeContext(cohort.invitationBId, "b".repeat(43))),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const differentCommandsAccepted = differentCommandResults.filter(
    (result) => result._tag === "Success" && !result.value.replayed,
  ).length;
  const staleRevisionRejections = differentCommandResults.filter((result) =>
    hasFailureTag(result, "RecruitmentInterviewStaleRevision"),
  ).length;

  const replayContext = makeContext(cohort.replayInvitationId, "r".repeat(43));
  const identicalCommandResults = yield* Effect.all(
    [
      Effect.exit(recruitment.scheduleInterview(replayCommand, replayContext)),
      Effect.exit(recruitment.scheduleInterview(replayCommand, replayContext)),
    ],
    { concurrency: "unbounded" },
  );
  const identicalCommandsAccepted = identicalCommandResults.filter(
    (result) => result._tag === "Success" && !result.value.replayed,
  ).length;
  const identicalCommandsReplayed = identicalCommandResults.filter(
    (result) => result._tag === "Success" && result.value.replayed,
  ).length;
  const identicalObservations = identicalCommandResults.flatMap((result) =>
    result._tag === "Success" ? [result.value.observation] : [],
  );
  const exactReplayObservation =
    identicalObservations[0] !== undefined &&
    identicalObservations[1] !== undefined &&
    canonicalJson(identicalObservations[0]) === canonicalJson(identicalObservations[1]);

  const [linkage] = yield* sql<LinkageCountRow>`
    WITH cohort_interviews(interview_id) AS (
      VALUES (${cohort.staleInterviewId}::text), (${cohort.replayInterviewId}::text)
    ), linked AS (
      SELECT
        cohort_interviews.interview_id,
        schedule.interview_id AS schedule_interview_id,
        invitation.invitation_id,
        receipt.command_id AS receipt_command_id,
        audit.command_id AS audit_command_id,
        outbox.effect_id
      FROM cohort_interviews
      LEFT JOIN recruitment_interviews interview
        ON interview.interview_id = cohort_interviews.interview_id
      LEFT JOIN recruitment_interview_schedules schedule
        ON schedule.interview_id = interview.interview_id
        AND schedule.schedule_revision = interview.revision
      LEFT JOIN recruitment_invitations invitation
        ON invitation.interview_id = schedule.interview_id
        AND invitation.schedule_revision = schedule.schedule_revision
        AND invitation.response_state = 'Pending'
      LEFT JOIN recruitment_schedule_command_receipts receipt
        ON receipt.interview_id = schedule.interview_id
        AND receipt.schedule_revision = schedule.schedule_revision
      LEFT JOIN recruitment_schedule_audit audit
        ON audit.command_id = receipt.command_id
        AND audit.interview_id = receipt.interview_id
        AND audit.schedule_revision = receipt.schedule_revision
        AND audit.action = 'InterviewScheduled'
      LEFT JOIN recruitment_invitation_outbox outbox
        ON outbox.command_id = receipt.command_id
        AND outbox.interview_id = receipt.interview_id
        AND outbox.invitation_id = invitation.invitation_id
        AND outbox.schedule_revision = receipt.schedule_revision
        AND outbox.ordinal = 0
        AND outbox.status = 'Pending'
    )
    SELECT
      (
        SELECT count(*)::text
        FROM recruitment_interview_schedules schedule
        INNER JOIN cohort_interviews ON cohort_interviews.interview_id = schedule.interview_id
      ) AS "schedules",
      (
        SELECT count(*)::text
        FROM recruitment_invitations invitation
        INNER JOIN cohort_interviews ON cohort_interviews.interview_id = invitation.interview_id
      ) AS "invitations",
      (
        SELECT count(*)::text
        FROM recruitment_schedule_command_receipts receipt
        INNER JOIN cohort_interviews ON cohort_interviews.interview_id = receipt.interview_id
      ) AS "receipts",
      (
        SELECT count(*)::text
        FROM recruitment_schedule_audit audit
        INNER JOIN cohort_interviews ON cohort_interviews.interview_id = audit.interview_id
      ) AS "audits",
      (
        SELECT count(*)::text
        FROM recruitment_invitation_outbox outbox
        INNER JOIN cohort_interviews ON cohort_interviews.interview_id = outbox.interview_id
      ) AS "outbox",
      (
        SELECT count(*)::text FROM linked
        WHERE schedule_interview_id IS NOT NULL
          AND invitation_id IS NOT NULL
          AND receipt_command_id IS NOT NULL
          AND audit_command_id IS NOT NULL
          AND effect_id IS NOT NULL
      ) AS "linkedRows",
      (
        SELECT count(*)::text FROM linked
        WHERE schedule_interview_id IS NULL
          OR invitation_id IS NULL
          OR receipt_command_id IS NULL
          OR audit_command_id IS NULL
          OR effect_id IS NULL
      ) AS "partialRows"
  `;

  const evidence = {
    specId: "0050" as const,
    database: "PostgreSQL" as const,
    schemaRevision: sql.schemaRevision,
    cohort: cohort.id,
    passed: true as const,
    concurrency: {
      sameInterview: true,
      differentCommandsAccepted,
      staleRevisionRejections,
      identicalCommandsAccepted,
      identicalCommandsReplayed,
      exactReplayObservation,
    },
    durableRows: {
      schedules: Number(linkage?.schedules ?? "-1"),
      invitations: Number(linkage?.invitations ?? "-1"),
      receipts: Number(linkage?.receipts ?? "-1"),
      audits: Number(linkage?.audits ?? "-1"),
      outbox: Number(linkage?.outbox ?? "-1"),
      linkedRows: Number(linkage?.linkedRows ?? "-1"),
      partialRows: Number(linkage?.partialRows ?? "-1"),
    },
  };

  assert.deepEqual(evidence.concurrency, {
    sameInterview: true,
    differentCommandsAccepted: 1,
    staleRevisionRejections: 1,
    identicalCommandsAccepted: 1,
    identicalCommandsReplayed: 1,
    exactReplayObservation: true,
  });
  assert.deepEqual(evidence.durableRows, {
    schedules: 2,
    invitations: 2,
    receipts: 2,
    audits: 2,
    outbox: 2,
    linkedRows: 2,
    partialRows: 0,
  });
  return evidence;
});

export const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(databaseUrl)),
    applicationName: "recruitment-scheduling-postgres-proof-0050",
    maxConnections: 4,
  });
  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );
  const supportLayer = Layer.mergeAll(
    databaseLayer,
    admissionsLayer,
    organizationLayer,
    profileLayer,
  );
  const recruitmentLayer = RecruitmentLive.pipe(Layer.provide(supportLayer));
  const evidence = yield* proof.pipe(Effect.provide(Layer.merge(supportLayer, recruitmentLayer)));
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});
