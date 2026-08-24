import { afterAll, describe, expect, it } from "vitest";
import {
  deliverNextPublicApplicationOutbox,
  makeRecordingPublicApplicationEffectInterpreter,
  publicApplicationActivationDigest,
  runPublicApplicationOutboxWorker,
} from "@vektorprogrammet/domain/application";
import {
  ApplicantIdSchema,
  PublicApplicationIdSchema,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { executePublicApplicationCommand } from "../../domain/src/application/postgres.js";
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodId,
} from "../../domain/src/admission-period/schema.js";
import {
  executeAdmissionPeriodCommand,
  listOpenAdmissionPeriods,
} from "../../domain/src/admission-period/postgres.js";
import { importOrganizationSnapshot } from "../../domain/src/organization/postgres.js";
import { DepartmentId, PersonId, SemesterId } from "../../domain/src/organization/schema.js";
import { Database } from "@vektorprogrammet/domain/database";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import {
  departmentIdForCommand,
  Organization,
  OrganizationCommandId,
  OrganizationLive,
} from "@vektorprogrammet/domain/organization";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import {
  deliverNextRecruitmentInvitation,
  deliverNextRecruitmentInvitationResponse,
  InterviewSchemaId,
  Recruitment,
  RecruitmentAssignmentCommandId,
  RecruitmentInterviewId,
  RecruitmentInvitationId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentLive,
  RecruitmentScheduleCommandId,
  RecruitmentNotificationDeliveryError,
} from "@vektorprogrammet/domain/recruitment";
import {
  makeRecordingNotificationGateway,
  NotificationGateway,
} from "@vektorprogrammet/domain/notification";
import { Economy, importLegacyReceipt } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { storeReceiptImportResult } from "../../domain/src/receipt/postgres.js";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { DatabaseTest } from "./layers.js";

const databaseLayer = DatabaseTest();
const runtime = ManagedRuntime.make(
  Layer.merge(databaseLayer, EconomyLive.pipe(Layer.provide(databaseLayer))),
);
const recruitmentDatabaseLayer = DatabaseTest();
const recruitmentAdmissionsLayer = AdmissionsLive.pipe(Layer.provide(recruitmentDatabaseLayer));
const recruitmentOrganizationLayer = OrganizationLive.pipe(Layer.provide(recruitmentDatabaseLayer));
const recruitmentProfileLayer = ProfileLive.pipe(
  Layer.provide(Layer.merge(recruitmentDatabaseLayer, recruitmentOrganizationLayer)),
);
const recruitmentCapabilityLayer = RecruitmentLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      recruitmentDatabaseLayer,
      recruitmentAdmissionsLayer,
      recruitmentOrganizationLayer,
      recruitmentProfileLayer,
    ),
  ),
);
const recruitmentRuntime = ManagedRuntime.make(
  Layer.merge(
    recruitmentDatabaseLayer,
    Layer.mergeAll(
      recruitmentAdmissionsLayer,
      recruitmentOrganizationLayer,
      recruitmentProfileLayer,
      recruitmentCapabilityLayer,
    ),
  ),
);

const seedSchedulingFixture = (fixtureId: string) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const recruitment = yield* Recruitment;
    const departmentId = DepartmentId.make(`${fixtureId}-department`);
    const semesterId = SemesterId.make(`${fixtureId}-semester`);
    const admissionPeriodId = AdmissionPeriodId.make(`${fixtureId}-period`);
    const applicantId = ApplicantIdSchema.make(`${fixtureId}-applicant`);
    const applicationId = PublicApplicationIdSchema.make(`${fixtureId}-application`);
    const leaderPersonId = PersonId.make(`${fixtureId}-leader`);
    const interviewerPersonId = PersonId.make(`${fixtureId}-interviewer`);
    const interviewSchemaId = InterviewSchemaId.make(`${fixtureId}-schema`);
    const interviewId = RecruitmentInterviewId.make(`${fixtureId}-interview`);
    const now = "2031-09-15T12:00:00.000Z";
    const actor = {
      _tag: "DepartmentLeader" as const,
      personId: leaderPersonId,
      departmentId,
      active: true,
    };

    yield* database`
      INSERT INTO admission_period_departments (department_id, name)
      VALUES (${departmentId}, ${`Department ${fixtureId}`})
    `;
    yield* database`
      INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
      VALUES (
        ${semesterId},
        '2031-08-01T00:00:00.000Z',
        '2032-01-01T00:00:00.000Z'
      )
    `;
    yield* database`
      INSERT INTO admission_periods (
        admission_period_id,
        department_id,
        semester_id,
        start_at,
        end_at,
        last_command_id
      )
      VALUES (
        ${admissionPeriodId},
        ${departmentId},
        ${semesterId},
        '2031-09-01T00:00:00.000Z',
        '2031-10-01T00:00:00.000Z',
        ${`${fixtureId}-period-created`}
      )
    `;
    yield* database`
      INSERT INTO admission_period_fields_of_study (
        field_of_study_id,
        department_id,
        name
      )
      VALUES (${`${fixtureId}-field`}, ${departmentId}, 'Computer Science')
    `;
    yield* database`
      INSERT INTO admission_applicants (
        applicant_id,
        normalized_email,
        email,
        first_name,
        last_name,
        phone,
        gender,
        field_of_study_id,
        year_of_study
      )
      VALUES (
        ${applicantId},
        ${`${fixtureId}@example.invalid`},
        ${`${fixtureId}@example.invalid`},
        'Ada',
        'Applicant',
        '90000000',
        1,
        ${`${fixtureId}-field`},
        2
      )
    `;
    yield* database`
      INSERT INTO admission_applications (
        application_id,
        applicant_id,
        admission_period_id,
        department_id,
        field_of_study_id,
        year_of_study,
        submitted_at
      )
      VALUES (
        ${applicationId},
        ${applicantId},
        ${admissionPeriodId},
        ${departmentId},
        ${`${fixtureId}-field`},
        2,
        '2031-09-10T12:00:00.000Z'
      )
    `;
    yield* database`
      INSERT INTO organization_departments (
        department_id,
        name,
        short_name,
        email,
        city
      )
      VALUES (
        ${departmentId},
        ${`Department ${fixtureId}`},
        ${fixtureId.slice(0, 12)},
        ${`${fixtureId}-department@example.invalid`},
        'Bergen'
      )
    `;
    yield* database`
      INSERT INTO organization_teams (team_id, department_id, name)
      VALUES (${`${fixtureId}-team`}, ${departmentId}, ${`Team ${fixtureId}`})
    `;
    yield* database`
      INSERT INTO organization_memberships (
        membership_id,
        person_id,
        team_id,
        start_at,
        position_id,
        is_team_leader
      )
      VALUES
        (
          ${`${fixtureId}-leader-membership`},
          ${leaderPersonId},
          ${`${fixtureId}-team`},
          '2031-01-01T00:00:00.000Z',
          'leader',
          TRUE
        ),
        (
          ${`${fixtureId}-interviewer-membership`},
          ${interviewerPersonId},
          ${`${fixtureId}-team`},
          '2031-01-01T00:00:00.000Z',
          'assistant',
          FALSE
        )
    `;
    yield* database`
      INSERT INTO person_profiles (person_id, first_name, last_name)
      VALUES
        (${leaderPersonId}, 'Lise', 'Leader'),
        (${interviewerPersonId}, 'Ivar', 'Interviewer')
    `;
    yield* database`
      INSERT INTO person_contact_profiles (person_id, email, phone)
      VALUES (
        ${interviewerPersonId},
        ${`${fixtureId}-interviewer@example.invalid`},
        '91111111'
      )
    `;
    yield* database`
      INSERT INTO recruitment_interview_schemas (
        interview_schema_id,
        name,
        question_count
      )
      VALUES (${interviewSchemaId}, 'Standard interview', 8)
    `;
    yield* recruitment.assignApplicant(
      {
        commandId: RecruitmentAssignmentCommandId.make(`${fixtureId}-assignment-command`),
        applicationId,
        interviewerPersonId,
        interviewSchemaId,
      },
      { actor, now, interviewId },
    );

    return {
      actor,
      now,
      departmentId,
      applicationId,
      applicantId,
      interviewerPersonId,
      interviewId,
      invitationId: RecruitmentInvitationId.make(`${fixtureId}-invitation`),
      responseCapability: fixtureId.padEnd(43, "_").slice(0, 43),
      command: {
        commandId: RecruitmentScheduleCommandId.make(`${fixtureId}-schedule-command`),
        interviewId,
        expectedRevision: 0,
        scheduledAt: "2031-09-20T10:00:00.000Z",
        room: "A-101",
        campus: "Main Campus",
        mapLink: "https://maps.example.invalid/interview-room",
        message: "Welcome to your interview.",
      },
    };
  });

afterAll(async () => {
  await runtime.dispose();
  await recruitmentRuntime.dispose();
});

describe("DatabaseTest", () => {
  it("constructs the complete schema before it exposes the capability", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.health;
        const migrations = yield* database<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM vektorprogrammet_schema_migrations
          ORDER BY migration_id
        `;
        const tables = yield* database<{ readonly table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'economy_receipts',
              'admission_periods',
              'admission_applications',
              'organization_departments',
              'organization_teams',
              'organization_memberships',
              'organization_field_of_studies',
              'organization_command_receipts',
              'organization_creation_audit',
              'person_profiles',
              'person_contact_profiles',
              'recruitment_interview_schemas',
              'recruitment_interviews',
              'recruitment_assignment_command_receipts',
              'recruitment_assignment_audit',
              'recruitment_interview_schedules',
              'recruitment_invitations',
              'recruitment_schedule_command_receipts',
              'recruitment_schedule_audit',
              'recruitment_invitation_outbox',
              'recruitment_invitation_response_audit',
              'recruitment_invitation_response_outbox'
            )
          ORDER BY table_name
        `;
        return {
          revision: database.schemaRevision,
          migrations,
          tables: tables.map((row) => row.table_name),
        };
      }),
    );

    expect(evidence).toEqual({
      revision: "13_native-organization-administration",
      migrations: [
        { migration_id: 1, name: "receipt-authority" },
        { migration_id: 2, name: "admission-period-authority" },
        { migration_id: 3, name: "public-applicant-admission" },
        { migration_id: 4, name: "receipt-authority-upgrade-replay" },
        { migration_id: 5, name: "public-applicant-effect-lifecycle" },
        { migration_id: 6, name: "public-applicant-delivered-payload-cleanup" },
        { migration_id: 7, name: "public-applicant-activation-snapshot" },
        { migration_id: 8, name: "organization-authority" },
        { migration_id: 9, name: "import-occurrence-authority" },
        { migration_id: 10, name: "native-recruitment-applicant-assignment" },
        { migration_id: 11, name: "native-recruitment-interview-scheduling" },
        { migration_id: 12, name: "native-recruitment-invitation-response" },
        { migration_id: 13, name: "native-organization-administration" },
      ],
      tables: [
        "admission_applications",
        "admission_periods",
        "economy_receipts",
        "organization_command_receipts",
        "organization_creation_audit",
        "organization_departments",
        "organization_field_of_studies",
        "organization_memberships",
        "organization_teams",
        "person_contact_profiles",
        "person_profiles",
        "recruitment_assignment_audit",
        "recruitment_assignment_command_receipts",
        "recruitment_interview_schedules",
        "recruitment_interview_schemas",
        "recruitment_interviews",
        "recruitment_invitation_outbox",
        "recruitment_invitation_response_audit",
        "recruitment_invitation_response_outbox",
        "recruitment_invitations",
        "recruitment_schedule_audit",
        "recruitment_schedule_command_receipts",
      ],
    });
  });

  it("executes native Recruitment assignment atomically against PGlite", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        yield* database`
          INSERT INTO admission_period_departments (department_id, name)
          VALUES ('recruitment-department', 'Recruitment Department')
        `;
        yield* database`
          INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
          VALUES (
            'recruitment-semester',
            '2031-08-01T00:00:00.000Z',
            '2032-01-01T00:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO admission_periods (
            admission_period_id,
            department_id,
            semester_id,
            start_at,
            end_at,
            last_command_id
          )
          VALUES (
            'recruitment-period',
            'recruitment-department',
            'recruitment-semester',
            '2031-09-01T00:00:00.000Z',
            '2031-10-01T00:00:00.000Z',
            'recruitment-period-created'
          )
        `;
        yield* database`
          INSERT INTO admission_period_fields_of_study (
            field_of_study_id,
            department_id,
            name
          )
          VALUES ('recruitment-field', 'recruitment-department', 'Computer Science')
        `;
        yield* database`
          INSERT INTO admission_applicants (
            applicant_id,
            normalized_email,
            email,
            first_name,
            last_name,
            phone,
            gender,
            field_of_study_id,
            year_of_study
          )
          VALUES (
            'recruitment-applicant',
            'applicant@example.invalid',
            'applicant@example.invalid',
            'Ada',
            'Applicant',
            '90000000',
            1,
            'recruitment-field',
            2
          )
        `;
        yield* database`
          INSERT INTO admission_applications (
            application_id,
            applicant_id,
            admission_period_id,
            department_id,
            field_of_study_id,
            year_of_study,
            submitted_at
          )
          VALUES (
            'recruitment-application',
            'recruitment-applicant',
            'recruitment-period',
            'recruitment-department',
            'recruitment-field',
            2,
            '2031-09-10T12:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO organization_departments (
            department_id,
            name,
            short_name,
            email,
            city
          )
          VALUES (
            'recruitment-department',
            'Recruitment Department',
            'RD',
            'recruitment@example.invalid',
            'Bergen'
          )
        `;
        yield* database`
          INSERT INTO organization_teams (team_id, department_id, name)
          VALUES ('recruitment-team', 'recruitment-department', 'Recruitment Team')
        `;
        yield* database`
          INSERT INTO organization_memberships (
            membership_id,
            person_id,
            team_id,
            start_at,
            position_id,
            is_team_leader
          )
          VALUES
            (
              'recruitment-leader-membership',
              'recruitment-leader',
              'recruitment-team',
              '2031-01-01T00:00:00.000Z',
              'leader',
              TRUE
            ),
            (
              'recruitment-interviewer-membership',
              'recruitment-interviewer',
              'recruitment-team',
              '2031-01-01T00:00:00.000Z',
              'assistant',
              FALSE
            )
        `;
        yield* database`
          INSERT INTO person_profiles (person_id, first_name, last_name)
          VALUES
            ('recruitment-leader', 'Lise', 'Leader'),
            ('recruitment-interviewer', 'Ivar', 'Interviewer')
        `;
        yield* database`
          INSERT INTO recruitment_interview_schemas (
            interview_schema_id,
            name,
            question_count
          )
          VALUES ('recruitment-schema', 'Standard interview', 8)
        `;

        const actor = {
          _tag: "DepartmentLeader" as const,
          personId: PersonId.make("recruitment-leader"),
          departmentId: DepartmentId.make("recruitment-department"),
          active: true,
        };
        const now = "2031-09-15T12:00:00.000Z";
        const before = yield* recruitment.readAssignmentBoard({ status: "new" }, { actor, now });
        const command = {
          commandId: RecruitmentAssignmentCommandId.make("recruitment-command"),
          applicationId: PublicApplicationIdSchema.make("recruitment-application"),
          interviewerPersonId: PersonId.make("recruitment-interviewer"),
          interviewSchemaId: InterviewSchemaId.make("recruitment-schema"),
        };
        const assigned = yield* recruitment.assignApplicant(command, {
          actor,
          now,
          interviewId: RecruitmentInterviewId.make("recruitment-interview"),
        });
        const replayed = yield* recruitment.assignApplicant(command, {
          actor,
          now,
          interviewId: RecruitmentInterviewId.make("ignored-replay-interview"),
        });
        const conflictingReplay = yield* Effect.flip(
          recruitment.assignApplicant(
            {
              ...command,
              interviewerPersonId: PersonId.make("recruitment-leader"),
            },
            {
              actor,
              now,
              interviewId: RecruitmentInterviewId.make("conflicting-replay-interview"),
            },
          ),
        );
        const duplicateAssignment = yield* Effect.flip(
          recruitment.assignApplicant(
            {
              ...command,
              commandId: RecruitmentAssignmentCommandId.make("duplicate-assignment-command"),
            },
            {
              actor,
              now,
              interviewId: RecruitmentInterviewId.make("duplicate-assignment-interview"),
            },
          ),
        );
        const closedPeriodReplay = yield* Effect.flip(
          recruitment.assignApplicant(command, {
            actor,
            now: "2031-10-02T12:00:00.000Z",
            interviewId: RecruitmentInterviewId.make("closed-period-replay-interview"),
          }),
        );
        const after = yield* recruitment.readAssignmentBoard({ status: "new" }, { actor, now });
        const persistence = yield* database<{
          readonly receipts: string;
          readonly audits: string;
          readonly interviews: string;
        }>`
          SELECT
            (SELECT count(*)::text FROM recruitment_assignment_command_receipts) AS receipts,
            (SELECT count(*)::text FROM recruitment_assignment_audit) AS audits,
            (SELECT count(*)::text FROM recruitment_interviews) AS interviews
        `;
        const applicationScopeResult = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                INSERT INTO admission_period_departments (department_id, name)
                VALUES ('other-department', 'Other Department')
              `;
              yield* database`
                UPDATE admission_applications
                SET department_id = 'other-department'
                WHERE application_id = 'recruitment-application'
              `;
            }),
          ),
        );
        const blankAssignerResult = yield* Effect.result(database`
          UPDATE recruitment_interviews
          SET assigned_by_person_id = ''
          WHERE interview_id = 'recruitment-interview'
        `);
        const blankAuditActorResult = yield* Effect.result(database`
          UPDATE recruitment_assignment_audit
          SET actor_person_id = ''
          WHERE command_id = 'recruitment-command'
        `);
        const receiptLinkResult = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                DELETE FROM recruitment_assignment_audit
                WHERE command_id = 'recruitment-command'
              `;
              yield* database`
                DELETE FROM recruitment_assignment_command_receipts
                WHERE command_id = 'recruitment-command'
              `;
              yield* database`
                INSERT INTO recruitment_assignment_command_receipts (
                  command_id,
                  command_sha256,
                  command_json,
                  observation_json,
                  application_id,
                  interview_id,
                  committed_at
                )
                VALUES (
                  'cross-linked-command',
                  '0000000000000000000000000000000000000000000000000000000000000000',
                  '{}'::jsonb,
                  '{}'::jsonb,
                  'different-application',
                  'recruitment-interview',
                  '2031-09-15T12:00:00.000Z'
                )
              `;
            }),
          ),
        );
        return {
          before,
          assigned,
          replayed,
          conflictingReplay,
          duplicateAssignment,
          closedPeriodReplay,
          after,
          persistence,
          applicationScopeResult,
          receiptLinkResult,
          blankAssignerResult,
          blankAuditActorResult,
        };
      }),
    );

    expect(evidence.before.candidates).toEqual([
      expect.objectContaining({
        applicationId: "recruitment-application",
        firstName: "Ada",
        lastName: "Applicant",
        applicationState: "Received",
        interviewState: "Unassigned",
      }),
    ]);
    expect(evidence.before.interviewers).toEqual([
      {
        personId: "recruitment-interviewer",
        displayName: "Ivar Interviewer",
      },
      {
        personId: "recruitment-leader",
        displayName: "Lise Leader",
      },
    ]);
    expect(evidence.assigned).toEqual({
      observation: {
        _tag: "ApplicantAssigned",
        commandId: "recruitment-command",
        interview: {
          interviewId: "recruitment-interview",
          applicationId: "recruitment-application",
          departmentId: "recruitment-department",
          interviewerPersonId: "recruitment-interviewer",
          interviewSchemaId: "recruitment-schema",
          assignedByPersonId: "recruitment-leader",
          assignedAt: "2031-09-15T12:00:00.000Z",
          revision: 0,
        },
      },
      replayed: false,
    });
    expect(evidence.replayed).toEqual({
      observation: evidence.assigned.observation,
      replayed: true,
    });
    expect(evidence.conflictingReplay._tag).toBe("RecruitmentAssignmentCommandConflict");
    expect(evidence.duplicateAssignment._tag).toBe("RecruitmentApplicationAlreadyAssigned");
    expect(evidence.closedPeriodReplay._tag).toBe("RecruitmentAdmissionPeriodNotFound");
    expect(evidence.after.candidates).toEqual([]);
    expect(evidence.persistence).toEqual([{ receipts: "1", audits: "1", interviews: "1" }]);
    const constraintResults = [
      evidence.applicationScopeResult,
      evidence.receiptLinkResult,
      evidence.blankAssignerResult,
      evidence.blankAuditActorResult,
    ];
    expect(constraintResults.map((result) => result._tag)).toEqual([
      "Failure",
      "Failure",
      "Failure",
      "Failure",
    ]);
    for (const result of constraintResults) {
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ _tag: "SqlError" });
    }
  });

  it("projects and schedules Recruitment interviews atomically against PGlite", async () => {
    const fixtureId = "scheduling-main";
    const deliveredAt = "2031-09-15T12:05:00.000Z";
    const gateway = makeRecordingNotificationGateway(deliveredAt);
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const fixture = yield* seedSchedulingFixture(fixtureId);
        const context = {
          actor: fixture.actor,
          now: fixture.now,
          invitationId: fixture.invitationId,
          responseCapability: fixture.responseCapability,
        };
        const before = yield* recruitment.readSchedulingBoard({
          actor: fixture.actor,
          now: fixture.now,
        });
        const accepted = yield* recruitment.scheduleInterview(fixture.command, context);
        const replayed = yield* recruitment.scheduleInterview(fixture.command, context);
        const conflictingReplay = yield* Effect.flip(
          recruitment.scheduleInterview({ ...fixture.command, room: "A-102" }, context),
        );
        const pendingPersistence = yield* database<{
          readonly schedules: string;
          readonly invitations: string;
          readonly receipts: string;
          readonly audits: string;
          readonly outbox: string;
          readonly interviewRevision: string;
        }>`
          SELECT
            (
              SELECT count(*)::text
              FROM recruitment_interview_schedules
              WHERE interview_id = ${fixture.interviewId}
            ) AS schedules,
            (
              SELECT count(*)::text
              FROM recruitment_invitations
              WHERE interview_id = ${fixture.interviewId}
            ) AS invitations,
            (
              SELECT count(*)::text
              FROM recruitment_schedule_command_receipts
              WHERE interview_id = ${fixture.interviewId}
            ) AS receipts,
            (
              SELECT count(*)::text
              FROM recruitment_schedule_audit
              WHERE interview_id = ${fixture.interviewId}
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_outbox
              WHERE interview_id = ${fixture.interviewId}
            ) AS outbox,
            (
              SELECT revision::text
              FROM recruitment_interviews
              WHERE interview_id = ${fixture.interviewId}
            ) AS "interviewRevision"
        `;
        const pendingBoard = yield* recruitment.readSchedulingBoard({
          actor: fixture.actor,
          now: fixture.now,
        });
        const delivery = yield* deliverNextRecruitmentInvitation(
          `${fixtureId}-claim`,
          "2031-09-15T12:04:00.000Z",
        ).pipe(Effect.provide(gateway.layer));
        const deliveredBoard = yield* recruitment.readSchedulingBoard({
          actor: fixture.actor,
          now: fixture.now,
        });
        const deliveredOutbox = yield* database<{
          readonly status: string;
          readonly attempts: number;
          readonly payload: string;
          readonly deliveredAt: string | null;
        }>`
          SELECT
            status,
            attempts,
            payload_json::text AS payload,
            CASE WHEN delivered_at IS NULL THEN NULL
              ELSE to_char(
                delivered_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            END AS "deliveredAt"
          FROM recruitment_invitation_outbox
          WHERE command_id = ${fixture.command.commandId}
        `;
        return {
          before,
          accepted,
          replayed,
          conflictingReplay,
          pendingPersistence,
          pendingBoard,
          delivery,
          deliveredBoard,
          deliveredOutbox,
        };
      }),
    );

    expect(evidence.before).toEqual({
      departmentId: `${fixtureId}-department`,
      interviews: [
        {
          interviewId: `${fixtureId}-interview`,
          applicationId: `${fixtureId}-application`,
          departmentId: `${fixtureId}-department`,
          interviewer: {
            personId: `${fixtureId}-interviewer`,
            displayName: "Ivar Interviewer",
            email: `${fixtureId}-interviewer@example.invalid`,
            phone: "91111111",
          },
          applicant: {
            applicationId: `${fixtureId}-application`,
            applicantId: `${fixtureId}-applicant`,
            firstName: "Ada",
            lastName: "Applicant",
            email: `${fixtureId}@example.invalid`,
            phone: "90000000",
          },
          revision: 0,
          schedule: null,
          responseState: null,
          responseMessage: null,
          notificationState: null,
        },
      ],
    });
    expect(evidence.accepted).toEqual({
      observation: {
        _tag: "InterviewScheduled",
        commandId: `${fixtureId}-schedule-command`,
        interviewId: `${fixtureId}-interview`,
        schedule: {
          interviewId: `${fixtureId}-interview`,
          scheduledAt: "2031-09-20T10:00:00.000Z",
          room: "A-101",
          campus: "Main Campus",
          mapLink: "https://maps.example.invalid/interview-room",
          message: "Welcome to your interview.",
          scheduledByPersonId: `${fixtureId}-leader`,
          committedAt: "2031-09-15T12:00:00.000Z",
          scheduleRevision: 1,
        },
        interviewRevision: 1,
        responseState: "Pending",
        notificationState: "Pending",
      },
      replayed: false,
    });
    expect(evidence.replayed).toEqual({
      observation: evidence.accepted.observation,
      replayed: true,
    });
    expect(evidence.conflictingReplay._tag).toBe("RecruitmentScheduleCommandConflict");
    expect(evidence.pendingPersistence).toEqual([
      {
        schedules: "1",
        invitations: "1",
        receipts: "1",
        audits: "1",
        outbox: "1",
        interviewRevision: "1",
      },
    ]);
    expect(evidence.pendingBoard.interviews).toEqual([
      expect.objectContaining({
        interviewId: `${fixtureId}-interview`,
        revision: 1,
        schedule: evidence.accepted.observation.schedule,
        responseState: "Pending",
        notificationState: "Pending",
      }),
    ]);
    expect(evidence.delivery._tag).toBe("Delivered");
    expect(gateway.requests).toEqual([
      expect.objectContaining({
        _tag: "SendInterviewInvitation",
        commandId: `${fixtureId}-schedule-command`,
        interviewId: `${fixtureId}-interview`,
        invitationId: `${fixtureId}-invitation`,
        scheduleRevision: 1,
        applicantEmail: `${fixtureId}@example.invalid`,
        applicantPhone: "90000000",
        interviewerDisplayName: "Ivar Interviewer",
        interviewerEmail: `${fixtureId}-interviewer@example.invalid`,
        interviewerPhone: "91111111",
        scheduledAt: "2031-09-20T10:00:00.000Z",
        room: "A-101",
        responseCapability: fixtureId.padEnd(43, "_").slice(0, 43),
      }),
    ]);
    expect(evidence.deliveredOutbox).toEqual([
      {
        status: "Delivered",
        attempts: 1,
        payload: "{}",
        deliveredAt,
      },
    ]);
    expect(evidence.deliveredBoard.interviews[0]).toEqual(
      expect.objectContaining({
        interviewId: `${fixtureId}-interview`,
        responseState: "Pending",
        notificationState: "Delivered",
      }),
    );
  });

  it("quarantines a poison invitation and keeps a later Pending invitation eligible", async () => {
    const firstFixtureId = "scheduling-poison-first";
    const laterFixtureId = "scheduling-poison-later";
    const gateway = makeRecordingNotificationGateway("2031-09-15T12:04:00.000Z");
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const first = yield* seedSchedulingFixture(firstFixtureId);
        const later = yield* seedSchedulingFixture(laterFixtureId);
        yield* recruitment.scheduleInterview(first.command, {
          actor: first.actor,
          now: first.now,
          invitationId: first.invitationId,
          responseCapability: first.responseCapability,
        });
        yield* recruitment.scheduleInterview(later.command, {
          actor: later.actor,
          now: "2031-09-15T12:01:00.000Z",
          invitationId: later.invitationId,
          responseCapability: later.responseCapability,
        });
        yield* database`
          UPDATE recruitment_invitation_outbox
          SET payload_json = '{"_tag":"Poison"}'::jsonb
          WHERE command_id = ${first.command.commandId}
        `;
        const quarantinePass = yield* deliverNextRecruitmentInvitation(
          "scheduling-poison-claim",
          "2031-09-15T12:02:00.000Z",
        ).pipe(Effect.provide(gateway.layer));
        const requestsAfterQuarantine = gateway.requests.length;
        const afterQuarantine = yield* database<{
          readonly commandId: string;
          readonly status: string;
          readonly attempts: number;
          readonly payloadScrubbed: boolean;
          readonly lastFailureTag: string | null;
        }>`
          SELECT
            command_id AS "commandId",
            status,
            attempts,
            payload_json = '{}'::jsonb AS "payloadScrubbed",
            last_failure_tag AS "lastFailureTag"
          FROM recruitment_invitation_outbox
          WHERE command_id IN (
            ${first.command.commandId},
            ${later.command.commandId}
          )
          ORDER BY CASE
            WHEN command_id = ${first.command.commandId} THEN 0
            ELSE 1
          END
        `;
        const continuedPass = yield* deliverNextRecruitmentInvitation(
          "scheduling-later-claim",
          "2031-09-15T12:03:00.000Z",
        ).pipe(Effect.provide(gateway.layer));
        const finalRows = yield* database<{
          readonly commandId: string;
          readonly status: string;
          readonly attempts: number;
          readonly payloadScrubbed: boolean;
          readonly lastFailureTag: string | null;
        }>`
          SELECT
            command_id AS "commandId",
            status,
            attempts,
            payload_json = '{}'::jsonb AS "payloadScrubbed",
            last_failure_tag AS "lastFailureTag"
          FROM recruitment_invitation_outbox
          WHERE command_id IN (
            ${first.command.commandId},
            ${later.command.commandId}
          )
          ORDER BY CASE
            WHEN command_id = ${first.command.commandId} THEN 0
            ELSE 1
          END
        `;
        return {
          quarantinePass,
          requestsAfterQuarantine,
          afterQuarantine,
          continuedPass,
          finalRows,
        };
      }),
    );

    expect(evidence.quarantinePass).toEqual({ _tag: "Idle" });
    expect(evidence.requestsAfterQuarantine).toBe(0);
    expect(evidence.afterQuarantine).toEqual([
      {
        commandId: `${firstFixtureId}-schedule-command`,
        status: "Quarantined",
        attempts: 1,
        payloadScrubbed: true,
        lastFailureTag: "RecruitmentDecodeError",
      },
      {
        commandId: `${laterFixtureId}-schedule-command`,
        status: "Pending",
        attempts: 0,
        payloadScrubbed: false,
        lastFailureTag: null,
      },
    ]);
    expect(evidence.continuedPass._tag).toBe("Delivered");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.commandId).toBe(`${laterFixtureId}-schedule-command`);
    expect(evidence.finalRows).toEqual([
      {
        commandId: `${firstFixtureId}-schedule-command`,
        status: "Quarantined",
        attempts: 1,
        payloadScrubbed: true,
        lastFailureTag: "RecruitmentDecodeError",
      },
      {
        commandId: `${laterFixtureId}-schedule-command`,
        status: "Delivered",
        attempts: 1,
        payloadScrubbed: true,
        lastFailureTag: null,
      },
    ]);
  });

  it("rolls back failed schedules and leaves stale or already-scheduled interviews unchanged", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const readScheduleWrites = (interviewId: string) =>
          database<{
            readonly revision: string;
            readonly schedules: string;
            readonly invitations: string;
            readonly receipts: string;
            readonly audits: string;
            readonly outbox: string;
          }>`
            SELECT
              (
                SELECT revision::text
                FROM recruitment_interviews
                WHERE interview_id = ${interviewId}
              ) AS revision,
              (
                SELECT count(*)::text
                FROM recruitment_interview_schedules
                WHERE interview_id = ${interviewId}
              ) AS schedules,
              (
                SELECT count(*)::text
                FROM recruitment_invitations
                WHERE interview_id = ${interviewId}
              ) AS invitations,
              (
                SELECT count(*)::text
                FROM recruitment_schedule_command_receipts
                WHERE interview_id = ${interviewId}
              ) AS receipts,
              (
                SELECT count(*)::text
                FROM recruitment_schedule_audit
                WHERE interview_id = ${interviewId}
              ) AS audits,
              (
                SELECT count(*)::text
                FROM recruitment_invitation_outbox
                WHERE interview_id = ${interviewId}
              ) AS outbox
          `;

        const staleFixture = yield* seedSchedulingFixture("scheduling-stale");
        const staleFailure = yield* Effect.flip(
          recruitment.scheduleInterview(
            { ...staleFixture.command, expectedRevision: 1 },
            {
              actor: staleFixture.actor,
              now: staleFixture.now,
              invitationId: staleFixture.invitationId,
              responseCapability: staleFixture.responseCapability,
            },
          ),
        );
        const staleWrites = yield* readScheduleWrites(staleFixture.interviewId);

        const scheduledFixture = yield* seedSchedulingFixture("scheduling-already");
        yield* recruitment.scheduleInterview(scheduledFixture.command, {
          actor: scheduledFixture.actor,
          now: scheduledFixture.now,
          invitationId: scheduledFixture.invitationId,
          responseCapability: scheduledFixture.responseCapability,
        });
        const beforeAlreadyScheduled = yield* readScheduleWrites(scheduledFixture.interviewId);
        const alreadyScheduledFailure = yield* Effect.flip(
          recruitment.scheduleInterview(
            {
              ...scheduledFixture.command,
              commandId: RecruitmentScheduleCommandId.make(
                "scheduling-already-second-schedule-command",
              ),
              expectedRevision: 1,
            },
            {
              actor: scheduledFixture.actor,
              now: scheduledFixture.now,
              invitationId: RecruitmentInvitationId.make("scheduling-already-second-invitation"),
              responseCapability: "scheduling-already-second".padEnd(43, "_"),
            },
          ),
        );
        const afterAlreadyScheduled = yield* readScheduleWrites(scheduledFixture.interviewId);

        const rollbackFixture = yield* seedSchedulingFixture("scheduling-rollback");
        const rollbackFailure = yield* Effect.flip(
          recruitment.scheduleInterview(rollbackFixture.command, {
            actor: rollbackFixture.actor,
            now: rollbackFixture.now,
            invitationId: scheduledFixture.invitationId,
            responseCapability: rollbackFixture.responseCapability,
          }),
        );
        const rollbackWrites = yield* readScheduleWrites(rollbackFixture.interviewId);
        return {
          staleFailure,
          staleWrites,
          alreadyScheduledFailure,
          beforeAlreadyScheduled,
          afterAlreadyScheduled,
          rollbackFailure,
          rollbackWrites,
        };
      }),
    );

    expect(evidence.staleFailure).toMatchObject({
      _tag: "RecruitmentInterviewStaleRevision",
      interviewId: "scheduling-stale-interview",
      expectedRevision: 1,
      actualRevision: 0,
    });
    expect(evidence.staleWrites).toEqual([
      {
        revision: "0",
        schedules: "0",
        invitations: "0",
        receipts: "0",
        audits: "0",
        outbox: "0",
      },
    ]);
    expect(evidence.alreadyScheduledFailure).toMatchObject({
      _tag: "RecruitmentInterviewAlreadyScheduled",
      interviewId: "scheduling-already-interview",
    });
    expect(evidence.beforeAlreadyScheduled).toEqual([
      {
        revision: "1",
        schedules: "1",
        invitations: "1",
        receipts: "1",
        audits: "1",
        outbox: "1",
      },
    ]);
    expect(evidence.afterAlreadyScheduled).toEqual(evidence.beforeAlreadyScheduled);
    expect(evidence.rollbackFailure._tag).toBe("RecruitmentPersistenceError");
    expect(evidence.rollbackWrites).toEqual([
      {
        revision: "0",
        schedules: "0",
        invitations: "0",
        receipts: "0",
        audits: "0",
        outbox: "0",
      },
    ]);
  });

  it("records all invitation outcomes with atomic audits, conditional outbox, and fresh projections", async () => {
    const gateway = makeRecordingNotificationGateway("2031-09-15T12:10:00.000Z");
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const cases = [
          { fixtureId: "response-accepted", action: "Accepted" as const },
          { fixtureId: "response-rejected", action: "Rejected" as const },
          { fixtureId: "response-new-time", action: "RequestedNewTime" as const },
        ];
        const observations = [];
        for (const item of cases) {
          const fixture = yield* seedSchedulingFixture(item.fixtureId);
          yield* recruitment.scheduleInterview(fixture.command, {
            actor: fixture.actor,
            now: fixture.now,
            invitationId: fixture.invitationId,
            responseCapability: fixture.responseCapability,
          });
          const capability = RecruitmentInvitationCapabilitySchema.make(fixture.responseCapability);
          const pending = yield* recruitment.readInvitationResponse(capability);
          const context = { now: "2031-09-15T12:03:00.000Z" };
          const result =
            item.action === "Accepted"
              ? yield* recruitment.confirmInvitation(capability, context)
              : item.action === "Rejected"
                ? yield* recruitment.rejectInvitation(capability, { message: "   " }, context)
                : yield* recruitment.requestNewInvitationTime(
                    capability,
                    { message: "  Please offer an afternoon time.  " },
                    context,
                  );
          const freshApplicant = yield* recruitment.readInvitationResponse(capability);
          const freshLeader = yield* recruitment.readSchedulingBoard({
            actor: fixture.actor,
            now: context.now,
          });
          const freshMember = yield* recruitment.readSchedulingBoard({
            actor: {
              _tag: "Member",
              personId: fixture.interviewerPersonId,
              departmentId: fixture.departmentId,
              active: true,
            },
            now: context.now,
          });
          const persisted = yield* database<{
            readonly responseState: string;
            readonly responseMessage: string | null;
            readonly responded: boolean;
            readonly responseRevision: number;
            readonly audits: string;
            readonly outbox: string;
            readonly capabilityAbsent: boolean;
          }>`
            SELECT
              invitation.response_state AS "responseState",
              invitation.response_message AS "responseMessage",
              invitation.responded_at IS NOT NULL AS responded,
              invitation.response_revision AS "responseRevision",
              (
                SELECT count(*)::text
                FROM recruitment_invitation_response_audit AS audit
                WHERE audit.invitation_id = invitation.invitation_id
              ) AS audits,
              (
                SELECT count(*)::text
                FROM recruitment_invitation_response_outbox AS outbox
                WHERE outbox.invitation_id = invitation.invitation_id
              ) AS outbox,
              NOT EXISTS (
                SELECT 1
                FROM (
                  SELECT to_jsonb(canonical_invitation)::text AS artifact
                  FROM recruitment_invitations AS canonical_invitation
                  WHERE canonical_invitation.invitation_id = invitation.invitation_id
                  UNION ALL
                  SELECT to_jsonb(audit)::text
                  FROM recruitment_invitation_response_audit AS audit
                  WHERE audit.invitation_id = invitation.invitation_id
                  UNION ALL
                  SELECT to_jsonb(outbox)::text
                  FROM recruitment_invitation_response_outbox AS outbox
                  WHERE outbox.invitation_id = invitation.invitation_id
                ) AS canonical_artifacts
                WHERE strpos(canonical_artifacts.artifact, ${fixture.responseCapability}) > 0
              ) AS "capabilityAbsent"
            FROM recruitment_invitations AS invitation
            WHERE invitation.invitation_id = ${fixture.invitationId}
          `;
          observations.push({
            action: item.action,
            pending,
            result,
            freshApplicant,
            leader: freshLeader.interviews.map((interview) => ({
              responseState: interview.responseState,
              responseMessage: interview.responseMessage,
            })),
            member: freshMember.interviews.map((interview) => ({
              responseState: interview.responseState,
              responseMessage: interview.responseMessage,
            })),
            persisted,
          });
        }
        const deliveries = [
          yield* deliverNextRecruitmentInvitationResponse(
            "response-recording-claim-1",
            "2031-09-15T12:08:00.000Z",
          ).pipe(Effect.provide(gateway.layer)),
          yield* deliverNextRecruitmentInvitationResponse(
            "response-recording-claim-2",
            "2031-09-15T12:09:00.000Z",
          ).pipe(Effect.provide(gateway.layer)),
        ];
        return { observations, deliveries };
      }),
    );

    expect(evidence.observations.map((item) => item.pending.responseState)).toEqual([
      "Pending",
      "Pending",
      "Pending",
    ]);
    expect(evidence.observations.map((item) => item.result)).toEqual([
      expect.objectContaining({
        _tag: "InvitationResponseRecorded",
        responseState: "Accepted",
        responseMessage: null,
        responseRevision: 1,
        notificationState: "NotRequired",
      }),
      expect.objectContaining({
        _tag: "InvitationResponseRecorded",
        responseState: "Rejected",
        responseMessage: null,
        responseRevision: 1,
        notificationState: "Pending",
      }),
      expect.objectContaining({
        _tag: "InvitationResponseRecorded",
        responseState: "RequestedNewTime",
        responseMessage: "Please offer an afternoon time.",
        responseRevision: 1,
        notificationState: "Pending",
      }),
    ]);
    expect(evidence.observations.map((item) => item.freshApplicant.responseState)).toEqual([
      "Accepted",
      "Rejected",
      "RequestedNewTime",
    ]);
    expect(evidence.observations.map((item) => item.persisted)).toEqual([
      [
        {
          responseState: "Accepted",
          responseMessage: null,
          responded: true,
          responseRevision: 1,
          audits: "1",
          outbox: "0",
          capabilityAbsent: true,
        },
      ],
      [
        {
          responseState: "Rejected",
          responseMessage: null,
          responded: true,
          responseRevision: 1,
          audits: "1",
          outbox: "1",
          capabilityAbsent: true,
        },
      ],
      [
        {
          responseState: "RequestedNewTime",
          responseMessage: "Please offer an afternoon time.",
          responded: true,
          responseRevision: 1,
          audits: "1",
          outbox: "1",
          capabilityAbsent: true,
        },
      ],
    ]);
    expect(evidence.observations.map((item) => item.leader)).toEqual([
      [{ responseState: "Accepted", responseMessage: null }],
      [{ responseState: "Rejected", responseMessage: null }],
      [
        {
          responseState: "RequestedNewTime",
          responseMessage: "Please offer an afternoon time.",
        },
      ],
    ]);
    expect(evidence.observations.map((item) => item.member)).toEqual([
      [{ responseState: "Accepted", responseMessage: null }],
      [],
      [
        {
          responseState: "RequestedNewTime",
          responseMessage: "Please offer an afternoon time.",
        },
      ],
    ]);
    expect(evidence.deliveries.map((delivery) => delivery._tag)).toEqual([
      "Delivered",
      "Delivered",
    ]);
    expect(gateway.requests).toEqual([]);
    expect(gateway.responseRequests).toHaveLength(2);
    expect(gateway.responseRequests.every((request) => !("responseCapability" in request))).toBe(
      true,
    );
  });

  it("replays message confinement and rolls back every capability-shaped response surface", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        yield* database`
          DELETE FROM vektorprogrammet_schema_migrations
          WHERE migration_id = 13
        `;
        yield* database.migrate;
        const [replayedMigration] = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS count
          FROM vektorprogrammet_schema_migrations
          WHERE migration_id = 13
        `;

        const fixture = yield* seedSchedulingFixture(
          "response-message-confinement-with-long-stable-identifier",
        );
        yield* recruitment.scheduleInterview(fixture.command, {
          actor: fixture.actor,
          now: fixture.now,
          invitationId: fixture.invitationId,
          responseCapability: fixture.responseCapability,
        });
        const responseInstant = "2031-09-15T12:03:00.000Z";
        const ordinaryMessage = "Cannot attend the proposed time.";
        const capabilitySequence = "C".repeat(43);
        const embeddedCapabilitySequence = `Do not persist (${capabilitySequence}) here`;
        const outboxEffectId = `recruitment-invitation-response:${fixture.invitationId}:1`;
        const before = yield* database<{
          readonly responseState: string;
          readonly responseMessage: string | null;
          readonly responseRevision: number;
          readonly audits: string;
          readonly outbox: string;
        }>`
          SELECT
            invitation.response_state AS "responseState",
            invitation.response_message AS "responseMessage",
            invitation.response_revision AS "responseRevision",
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = invitation.invitation_id
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = invitation.invitation_id
            ) AS outbox
          FROM recruitment_invitations AS invitation
          WHERE invitation.invitation_id = ${fixture.invitationId}
        `;
        const stageRejectedInvitation = (message: string) => database`
          UPDATE recruitment_invitations
          SET response_state = 'Rejected',
            response_message = ${message},
            responded_at = ${responseInstant},
            response_revision = 1
          WHERE invitation_id = ${fixture.invitationId}
        `;
        const insertAudit = (message: string) => database`
          INSERT INTO recruitment_invitation_response_audit (
            invitation_id,
            interview_id,
            schedule_revision,
            response_revision,
            response_state,
            response_message,
            responded_at
          ) VALUES (
            ${fixture.invitationId},
            ${fixture.interviewId},
            1,
            1,
            'Rejected',
            ${message},
            ${responseInstant}
          )
        `;
        const invitationMessage = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* stageRejectedInvitation(capabilitySequence);
              return yield* Effect.fail("InvitationMessageConfinementMissing");
            }),
          ),
        );
        const auditMessage = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* stageRejectedInvitation(ordinaryMessage);
              yield* insertAudit(embeddedCapabilitySequence);
              return yield* Effect.fail("AuditMessageConfinementMissing");
            }),
          ),
        );
        const outboxMessage = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* stageRejectedInvitation(ordinaryMessage);
              yield* insertAudit(ordinaryMessage);
              yield* database`
                INSERT INTO recruitment_invitation_response_outbox (
                  effect_id,
                  effect_type,
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  ordinal,
                  payload_json
                ) VALUES (
                  ${outboxEffectId},
                  'SendInterviewInvitationResponse',
                  ${fixture.invitationId},
                  ${fixture.interviewId},
                  1,
                  1,
                  'Rejected',
                  ${capabilitySequence},
                  0,
                  '{}'::jsonb
                )
              `;
              return yield* Effect.fail("OutboxMessageConfinementMissing");
            }),
          ),
        );
        const outboxPayload = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* stageRejectedInvitation(ordinaryMessage);
              yield* insertAudit(ordinaryMessage);
              yield* database`
                INSERT INTO recruitment_invitation_response_outbox (
                  effect_id,
                  effect_type,
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  ordinal,
                  payload_json
                ) VALUES (
                  ${outboxEffectId},
                  'SendInterviewInvitationResponse',
                  ${fixture.invitationId},
                  ${fixture.interviewId},
                  1,
                  1,
                  'Rejected',
                  ${ordinaryMessage},
                  0,
                  jsonb_build_object('note', ${embeddedCapabilitySequence})
                )
              `;
              return yield* Effect.fail("OutboxPayloadConfinementMissing");
            }),
          ),
        );
        const afterCounterexamples = yield* database<{
          readonly responseState: string;
          readonly responseMessage: string | null;
          readonly responseRevision: number;
          readonly audits: string;
          readonly outbox: string;
        }>`
          SELECT
            invitation.response_state AS "responseState",
            invitation.response_message AS "responseMessage",
            invitation.response_revision AS "responseRevision",
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = invitation.invitation_id
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = invitation.invitation_id
            ) AS outbox
          FROM recruitment_invitations AS invitation
          WHERE invitation.invitation_id = ${fixture.invitationId}
        `;

        const validNearbyMessage = "V".repeat(42);
        const validResult = yield* recruitment.rejectInvitation(
          RecruitmentInvitationCapabilitySchema.make(fixture.responseCapability),
          { message: validNearbyMessage },
          { now: responseInstant },
        );
        const validRows = yield* database<{
          readonly invitationMessage: string | null;
          readonly auditMessage: string | null;
          readonly outboxMessage: string | null;
          readonly payloadMessage: string | null;
        }>`
          SELECT
            invitation.response_message AS "invitationMessage",
            audit.response_message AS "auditMessage",
            outbox.response_message AS "outboxMessage",
            outbox.payload_json ->> 'responseMessage' AS "payloadMessage"
          FROM recruitment_invitations AS invitation
          INNER JOIN recruitment_invitation_response_audit AS audit
            ON audit.invitation_id = invitation.invitation_id
          INNER JOIN recruitment_invitation_response_outbox AS outbox
            ON outbox.invitation_id = invitation.invitation_id
          WHERE invitation.invitation_id = ${fixture.invitationId}
        `;
        return {
          replayedMigration,
          counterexamples: [invitationMessage, auditMessage, outboxMessage, outboxPayload],
          before,
          afterCounterexamples,
          validNearbyMessage,
          validResult,
          validRows,
        };
      }),
    );

    expect(evidence.replayedMigration).toEqual({ count: "1" });
    for (const counterexample of evidence.counterexamples) {
      expect(counterexample._tag).toBe("Failure");
      if (counterexample._tag === "Failure") {
        expect(counterexample.failure).toMatchObject({ _tag: "SqlError" });
      }
    }
    expect(evidence.afterCounterexamples).toEqual(evidence.before);
    expect(evidence.before).toEqual([
      {
        responseState: "Pending",
        responseMessage: null,
        responseRevision: 0,
        audits: "0",
        outbox: "0",
      },
    ]);
    expect(evidence.validResult.responseMessage).toBe(evidence.validNearbyMessage);
    expect(evidence.validRows).toEqual([
      {
        invitationMessage: evidence.validNearbyMessage,
        auditMessage: evidence.validNearbyMessage,
        outboxMessage: evidence.validNearbyMessage,
        payloadMessage: evidence.validNearbyMessage,
      },
    ]);
  });

  it("rejects relationally incomplete invitation response commits", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const missingAuditFixture = yield* seedSchedulingFixture("response-link-missing-audit");
        const missingOutboxFixture = yield* seedSchedulingFixture("response-link-missing-outbox");
        const mismatchedOutboxFixture = yield* seedSchedulingFixture(
          "response-link-mismatched-outbox",
        );

        for (const fixture of [
          missingAuditFixture,
          missingOutboxFixture,
          mismatchedOutboxFixture,
        ]) {
          yield* recruitment.scheduleInterview(fixture.command, {
            actor: fixture.actor,
            now: fixture.now,
            invitationId: fixture.invitationId,
            responseCapability: fixture.responseCapability,
          });
        }

        const missingAudit = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                UPDATE recruitment_invitations
                SET response_state = 'Accepted',
                  response_message = NULL,
                  responded_at = '2031-09-15T12:03:00.000Z',
                  response_revision = 1
                WHERE invitation_id = ${missingAuditFixture.invitationId}
              `;
              yield* database`SET CONSTRAINTS ALL IMMEDIATE`;
            }),
          ),
        );
        const missingOutbox = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                UPDATE recruitment_invitations
                SET response_state = 'Rejected',
                  response_message = NULL,
                  responded_at = '2031-09-15T12:03:00.000Z',
                  response_revision = 1
                WHERE invitation_id = ${missingOutboxFixture.invitationId}
              `;
              yield* database`
                INSERT INTO recruitment_invitation_response_audit (
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  responded_at
                ) VALUES (
                  ${missingOutboxFixture.invitationId},
                  ${missingOutboxFixture.interviewId},
                  1,
                  1,
                  'Rejected',
                  NULL,
                  '2031-09-15T12:03:00.000Z'
                )
              `;
              yield* database`SET CONSTRAINTS ALL IMMEDIATE`;
            }),
          ),
        );
        const mismatchedOutbox = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                UPDATE recruitment_invitations
                SET response_state = 'Rejected',
                  response_message = NULL,
                  responded_at = '2031-09-15T12:03:00.000Z',
                  response_revision = 1
                WHERE invitation_id = ${mismatchedOutboxFixture.invitationId}
              `;
              yield* database`
                INSERT INTO recruitment_invitation_response_audit (
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  responded_at
                ) VALUES (
                  ${mismatchedOutboxFixture.invitationId},
                  ${mismatchedOutboxFixture.interviewId},
                  1,
                  1,
                  'Rejected',
                  NULL,
                  '2031-09-15T12:03:00.000Z'
                )
              `;
              yield* database`
                INSERT INTO recruitment_invitation_response_outbox (
                  effect_id,
                  effect_type,
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  ordinal,
                  payload_json
                ) VALUES (
                  ${`recruitment-invitation-response:${mismatchedOutboxFixture.invitationId}:1`},
                  'SendInterviewInvitationResponse',
                  ${mismatchedOutboxFixture.invitationId},
                  ${mismatchedOutboxFixture.interviewId},
                  1,
                  1,
                  'Rejected',
                  'Different message',
                  0,
                  '{}'::jsonb
                )
              `;
              yield* database`SET CONSTRAINTS ALL IMMEDIATE`;
            }),
          ),
        );
        const rows = yield* database<{
          readonly invitationId: string;
          readonly responseState: string;
          readonly responseRevision: number;
          readonly audits: string;
          readonly outbox: string;
        }>`
          SELECT
            invitation.invitation_id AS "invitationId",
            invitation.response_state AS "responseState",
            invitation.response_revision AS "responseRevision",
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = invitation.invitation_id
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = invitation.invitation_id
            ) AS outbox
          FROM recruitment_invitations AS invitation
          WHERE invitation.invitation_id IN (
            ${missingAuditFixture.invitationId},
            ${missingOutboxFixture.invitationId},
            ${mismatchedOutboxFixture.invitationId}
          )
          ORDER BY invitation.invitation_id
        `;
        return {
          failures: [missingAudit, missingOutbox, mismatchedOutbox].map((result) => result._tag),
          rows,
        };
      }),
    );

    expect(evidence.failures).toEqual(["Failure", "Failure", "Failure"]);
    expect(evidence.rows).toEqual([
      {
        invitationId: "response-link-mismatched-outbox-invitation",
        responseState: "Pending",
        responseRevision: 0,
        audits: "0",
        outbox: "0",
      },
      {
        invitationId: "response-link-missing-audit-invitation",
        responseState: "Pending",
        responseRevision: 0,
        audits: "0",
        outbox: "0",
      },
      {
        invitationId: "response-link-missing-outbox-invitation",
        responseState: "Pending",
        responseRevision: 0,
        audits: "0",
        outbox: "0",
      },
    ]);
  });

  it("isolates unknown and superseded capabilities and keeps one response winner", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;

        const winnerFixture = yield* seedSchedulingFixture("response-one-winner");
        yield* recruitment.scheduleInterview(winnerFixture.command, {
          actor: winnerFixture.actor,
          now: winnerFixture.now,
          invitationId: winnerFixture.invitationId,
          responseCapability: winnerFixture.responseCapability,
        });
        const winnerCapability = RecruitmentInvitationCapabilitySchema.make(
          winnerFixture.responseCapability,
        );
        const outcomes = yield* Effect.all(
          [
            Effect.result(
              recruitment.confirmInvitation(winnerCapability, {
                now: "2031-09-15T12:03:00.000Z",
              }),
            ),
            Effect.result(
              recruitment.confirmInvitation(winnerCapability, {
                now: "2031-09-15T12:03:00.000Z",
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const outcomeTags = outcomes.map((outcome) =>
          outcome._tag === "Success"
            ? `Recorded:${outcome.success.responseState}`
            : outcome.failure._tag,
        );
        const winnerRows = yield* database<{
          readonly audits: string;
          readonly outbox: string;
          readonly responseRevision: number;
        }>`
          SELECT
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = ${winnerFixture.invitationId}
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = ${winnerFixture.invitationId}
            ) AS outbox,
            response_revision AS "responseRevision"
          FROM recruitment_invitations
          WHERE invitation_id = ${winnerFixture.invitationId}
        `;

        const unknown = yield* Effect.flip(
          recruitment.readInvitationResponse(
            RecruitmentInvitationCapabilitySchema.make("u".repeat(43)),
          ),
        );

        const supersededFixture = yield* seedSchedulingFixture("response-superseded");
        yield* recruitment.scheduleInterview(supersededFixture.command, {
          actor: supersededFixture.actor,
          now: supersededFixture.now,
          invitationId: supersededFixture.invitationId,
          responseCapability: supersededFixture.responseCapability,
        });
        yield* database`
          UPDATE recruitment_invitations
          SET superseded_at = '2031-09-15T12:01:00.000Z'
          WHERE invitation_id = ${supersededFixture.invitationId}
        `;
        const supersededCapability = RecruitmentInvitationCapabilitySchema.make(
          supersededFixture.responseCapability,
        );
        const supersededRead = yield* Effect.flip(
          recruitment.readInvitationResponse(supersededCapability),
        );
        const supersededWrite = yield* Effect.flip(
          recruitment.confirmInvitation(supersededCapability, {
            now: "2031-09-15T12:03:00.000Z",
          }),
        );

        const invalidFixture = yield* seedSchedulingFixture("response-invalid-new-time");
        yield* recruitment.scheduleInterview(invalidFixture.command, {
          actor: invalidFixture.actor,
          now: invalidFixture.now,
          invitationId: invalidFixture.invitationId,
          responseCapability: invalidFixture.responseCapability,
        });
        const invalidInput = yield* Effect.flip(
          recruitment.requestNewInvitationTime(
            RecruitmentInvitationCapabilitySchema.make(invalidFixture.responseCapability),
            { message: "   " },
            { now: "2031-09-15T12:03:00.000Z" },
          ),
        );

        const rollbackFixture = yield* seedSchedulingFixture("response-rollback");
        yield* recruitment.scheduleInterview(rollbackFixture.command, {
          actor: rollbackFixture.actor,
          now: rollbackFixture.now,
          invitationId: rollbackFixture.invitationId,
          responseCapability: rollbackFixture.responseCapability,
        });
        const rollback = yield* Effect.result(
          database.withTransaction(
            Effect.gen(function* () {
              yield* database`
                UPDATE recruitment_invitations
                SET response_state = 'Accepted',
                  response_message = NULL,
                  responded_at = '2031-09-15T12:03:00.000Z',
                  response_revision = 1
                WHERE invitation_id = ${rollbackFixture.invitationId}
              `;
              yield* database`
                INSERT INTO recruitment_invitation_response_audit (
                  invitation_id,
                  interview_id,
                  schedule_revision,
                  response_revision,
                  response_state,
                  response_message,
                  responded_at
                ) VALUES (
                  ${rollbackFixture.invitationId},
                  ${rollbackFixture.interviewId},
                  1,
                  1,
                  'RequestedNewTime',
                  NULL,
                  '2031-09-15T12:03:00.000Z'
                )
              `;
            }),
          ),
        );
        const afterRollback = yield* database<{
          readonly responseState: string;
          readonly responseRevision: number;
          readonly audits: string;
          readonly outbox: string;
        }>`
          SELECT
            invitation.response_state AS "responseState",
            invitation.response_revision AS "responseRevision",
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = invitation.invitation_id
            ) AS audits,
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = invitation.invitation_id
            ) AS outbox
          FROM recruitment_invitations AS invitation
          WHERE invitation.invitation_id = ${rollbackFixture.invitationId}
        `;
        const illegalRow = yield* Effect.result(database`
          UPDATE recruitment_invitations
          SET response_state = 'RequestedNewTime',
            response_message = NULL,
            responded_at = '2031-09-15T12:03:00.000Z',
            response_revision = 1
          WHERE invitation_id = ${rollbackFixture.invitationId}
        `);
        return {
          outcomeTags,
          winnerRows,
          unknown,
          supersededRead,
          supersededWrite,
          invalidInput,
          rollback,
          afterRollback,
          illegalRow,
        };
      }),
    );

    expect(evidence.outcomeTags).toHaveLength(2);
    expect(evidence.outcomeTags.filter((tag) => tag.startsWith("Recorded:"))).toHaveLength(1);
    expect(evidence.outcomeTags).toContain("RecruitmentInvitationAlreadyResponded");
    expect(evidence.winnerRows[0]).toEqual({
      audits: "1",
      outbox: "0",
      responseRevision: 1,
    });
    expect(evidence.unknown._tag).toBe("RecruitmentInvitationNotFound");
    expect(evidence.supersededRead._tag).toBe("RecruitmentInvitationNotFound");
    expect(evidence.supersededWrite._tag).toBe("RecruitmentInvitationNotFound");
    expect(evidence.invalidInput._tag).toBe("RecruitmentDecodeError");
    expect(evidence.rollback._tag).toBe("Failure");
    expect(evidence.afterRollback).toEqual([
      { responseState: "Pending", responseRevision: 0, audits: "0", outbox: "0" },
    ]);
    expect(evidence.illegalRow._tag).toBe("Failure");
  });

  it("keeps a committed response when response-notification delivery fails", async () => {
    const fixtureId = "response-delivery-failure";
    const failingGateway = Layer.succeed(
      NotificationGateway,
      NotificationGateway.of({
        deliverInterviewInvitation: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "Recording delivery failed",
            }),
          ),
        deliverInterviewInvitationResponse: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "Recording delivery failed",
            }),
          ),
      }),
    );
    const recording = makeRecordingNotificationGateway("2031-09-15T12:08:00.000Z");
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const recruitment = yield* Recruitment;
        const fixture = yield* seedSchedulingFixture(fixtureId);
        yield* recruitment.scheduleInterview(fixture.command, {
          actor: fixture.actor,
          now: fixture.now,
          invitationId: fixture.invitationId,
          responseCapability: fixture.responseCapability,
        });
        const recorded = yield* recruitment.rejectInvitation(
          RecruitmentInvitationCapabilitySchema.make(fixture.responseCapability),
          { message: "Cannot attend." },
          { now: "2031-09-15T12:03:00.000Z" },
        );
        const failedDelivery = yield* deliverNextRecruitmentInvitationResponse(
          "response-failure-claim",
          "2031-09-15T12:04:00.000Z",
        ).pipe(Effect.provide(failingGateway));
        const afterFailure = yield* database<{
          readonly responseState: string;
          readonly responseRevision: number;
          readonly audits: string;
          readonly outboxStatus: string;
        }>`
          SELECT
            invitation.response_state AS "responseState",
            invitation.response_revision AS "responseRevision",
            (
              SELECT count(*)::text
              FROM recruitment_invitation_response_audit
              WHERE invitation_id = invitation.invitation_id
            ) AS audits,
            (
              SELECT status
              FROM recruitment_invitation_response_outbox
              WHERE invitation_id = invitation.invitation_id
            ) AS "outboxStatus"
          FROM recruitment_invitations AS invitation
          WHERE invitation.invitation_id = ${fixture.invitationId}
        `;
        const recoveredDelivery = yield* deliverNextRecruitmentInvitationResponse(
          "response-retry-claim",
          "2031-09-15T12:05:00.000Z",
        ).pipe(Effect.provide(recording.layer));
        return { recorded, failedDelivery, afterFailure, recoveredDelivery };
      }),
    );

    expect(evidence.recorded.responseState).toBe("Rejected");
    expect(evidence.failedDelivery._tag).toBe("Failed");
    expect(evidence.afterFailure).toEqual([
      {
        responseState: "Rejected",
        responseRevision: 1,
        audits: "1",
        outboxStatus: "Failed",
      },
    ]);
    expect(evidence.recoveredDelivery._tag).toBe("Delivered");
    expect(recording.requests).toEqual([]);
    expect(recording.responseRequests).toHaveLength(1);
  });

  it("enforces scheduling map and contact-email relational constraints", async () => {
    const fixtureId = "scheduling-constraints";
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const fixture = yield* seedSchedulingFixture(fixtureId);
        const invalidMap = yield* Effect.result(database`
          INSERT INTO recruitment_interview_schedules (
            interview_id,
            scheduled_at,
            room,
            campus,
            map_link,
            message,
            scheduled_by_person_id,
            committed_at,
            schedule_revision
          )
          VALUES (
            ${fixture.interviewId},
            '2031-09-20T10:00:00.000Z',
            'A-101',
            'Main Campus',
            'http://maps.example.invalid/interview-room',
            'Welcome to your interview.',
            ${fixture.actor.personId},
            ${fixture.now},
            1
          )
        `);
        const invalidEmail = yield* Effect.result(database`
          UPDATE person_contact_profiles
          SET email = 'not-an-email'
          WHERE person_id = ${fixture.interviewerPersonId}
        `);
        const persisted = yield* database<{
          readonly schedules: string;
          readonly interviewRevision: string;
          readonly interviewerEmail: string;
        }>`
          SELECT
            (
              SELECT count(*)::text
              FROM recruitment_interview_schedules
              WHERE interview_id = ${fixture.interviewId}
            ) AS schedules,
            (
              SELECT revision::text
              FROM recruitment_interviews
              WHERE interview_id = ${fixture.interviewId}
            ) AS "interviewRevision",
            (
              SELECT email
              FROM person_contact_profiles
              WHERE person_id = ${fixture.interviewerPersonId}
            ) AS "interviewerEmail"
        `;
        return { invalidMap, invalidEmail, persisted };
      }),
    );

    expect([evidence.invalidMap._tag, evidence.invalidEmail._tag]).toEqual(["Failure", "Failure"]);
    if (evidence.invalidMap._tag === "Failure") {
      expect(evidence.invalidMap.failure).toMatchObject({ _tag: "SqlError" });
    }
    if (evidence.invalidEmail._tag === "Failure") {
      expect(evidence.invalidEmail.failure).toMatchObject({ _tag: "SqlError" });
    }
    expect(evidence.persisted).toEqual([
      {
        schedules: "0",
        interviewRevision: "0",
        interviewerEmail: `${fixtureId}-interviewer@example.invalid`,
      },
    ]);
  });

  it("reuses one capability and reruns the manifest without duplicate migrations", async () => {
    const first = await runtime.runPromise(Database);
    await runtime.runPromise(Database.use((database) => database.migrate));
    const second = await runtime.runPromise(Database);
    const rows = await runtime.runPromise(
      Database.use(
        (database) =>
          database<{ readonly migration_count: string }>`
          SELECT count(*)::text AS migration_count
          FROM vektorprogrammet_schema_migrations
        `,
      ),
    );

    expect(second).toBe(first);
    expect(rows).toEqual([{ migration_count: "13" }]);
  });

  it("executes Admissions and Organization authority adapters against PGlite", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO admission_period_departments (department_id, name)
          VALUES ('adapter-department', 'Adapter Department')
        `;
        yield* database`
          INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
          VALUES ('adapter-semester', '2035-01-01T00:00:00.000Z', '2035-07-01T00:00:00.000Z')
        `;
        const created = yield* executeAdmissionPeriodCommand(
          {
            _tag: "CreateAdmissionPeriod",
            commandId: AdmissionPeriodCommandId.make("adapter-create"),
            departmentId: DepartmentId.make("adapter-department"),
            semesterId: SemesterId.make("adapter-semester"),
            startAt: "2035-02-01T00:00:00.000Z",
            endAt: "2035-03-01T00:00:00.000Z",
          },
          {
            actor: {
              _tag: "GlobalAdmin",
              personId: PersonId.make("adapter-admin"),
              active: true,
            },
            now: "2035-01-15T00:00:00.000Z",
            admissionPeriodId: AdmissionPeriodId.make("adapter-period"),
          },
        );
        const open = yield* listOpenAdmissionPeriods("2035-02-15T00:00:00.000Z");

        const organizationSnapshot = {
          sourceRepository: "database-test",
          sourceRevision: "adapter-revision-1",
          snapshotId: "adapter-snapshot-1",
          transformationRevision: "adapter-transform-1",
          departments: [
            {
              id: 700,
              name: "Organization Adapter",
              shortName: "OA",
              email: "adapter@example.invalid",
              city: "Bergen",
            },
          ],
          teams: [],
          memberships: [{ id: "malformed" }],
        } as const;
        const imported = yield* importOrganizationSnapshot(organizationSnapshot);
        yield* importOrganizationSnapshot({
          ...organizationSnapshot,
          sourceRevision: "adapter-revision-2",
          snapshotId: "adapter-snapshot-2",
          departments: [
            {
              ...organizationSnapshot.departments[0],
              name: "Conflicting Organization Adapter",
            },
          ],
          memberships: [],
        });
        const collisions = yield* database<{ readonly reason: string }>`
          SELECT reason
          FROM organization_membership_quarantine
          WHERE source_revision = 'adapter-revision-2'
        `;
        return {
          created: created.observation._tag,
          open: open.map((period) => period.id),
          quarantined: imported.quarantined.map((row) => row.reason),
          collisions: collisions.map((row) => row.reason),
        };
      }),
    );
    expect(evidence).toEqual({
      created: "Created",
      open: ["adapter-period"],
      quarantined: ["DECODE_FAILURE"],
      collisions: ["DESTINATION_IDENTITY_COLLISION"],
    });
  });

  it("replays accepted and collision-classified Receipt imports idempotently", async () => {
    const makeImport = (
      sourcePrimaryKey: string,
      sourceRevision: string,
      receiptId: string,
      visualId: string,
    ) =>
      importLegacyReceipt(
        {
          sourcePrimaryKey,
          ownerPersonId: PersonId.make("receipt-import-owner"),
          departmentId: DepartmentId.make("receipt-import-department"),
          visualId,
          amountDecimal: "123.45",
          description: "PGlite replay evidence",
          receiptDate: "2035-02-15",
          submittedAt: "2035-02-15T12:00:00.000Z",
          status: "pending",
          refundDate: null,
          paymentAccountCiphertext: "ciphertext:v1:receipt-import",
          file: {
            fileRef: `staged/${sourcePrimaryKey}`,
            objectKey: `receipts/${sourcePrimaryKey}`,
            contentType: "application/pdf",
            byteLength: 128,
            sha256: "a".repeat(64),
          },
        },
        receiptId,
        {
          sourceRepository: "database-test",
          sourceRevision,
          snapshotId: `snapshot-${sourceRevision}`,
          sourceWatermark: `watermark-${sourceRevision}`,
          transformationRevision: "receipt-import-replay-v1",
          sourceDigest: "b".repeat(64),
          destinationIdentity: receiptId,
        },
      );
    const accepted = makeImport(
      "receipt-replay-source",
      "receipt-replay-1",
      "receipt-replay-canonical",
      "REPLAY-VISUAL",
    );
    const collision = makeImport(
      "receipt-collision-source",
      "receipt-replay-2",
      "receipt-collision-canonical",
      "REPLAY-VISUAL",
    );
    await runtime.runPromise(storeReceiptImportResult(accepted));
    await runtime.runPromise(storeReceiptImportResult(accepted));
    await runtime.runPromise(storeReceiptImportResult(collision));
    await runtime.runPromise(storeReceiptImportResult(collision));
    const rows = await runtime.runPromise(
      Database.use(
        (database) =>
          database<{ readonly result: string; readonly reconciliation_result: string }>`
          SELECT result, reconciliation_result
          FROM economy_receipt_import_ledger
          WHERE source_primary_key IN ('receipt-replay-source', 'receipt-collision-source')
          ORDER BY source_primary_key
        `,
      ),
    );
    expect(rows).toEqual([
      { result: "Quarantined", reconciliation_result: "NotApplicable" },
      { result: "Accepted", reconciliation_result: "Pending" },
    ]);
  });

  it("runs the Economy authority contract against PGlite", async () => {
    const command = {
      _tag: "SubmitReceipt" as const,
      commandId: "pglite-command-submit",
      actor: {
        personId: "pglite-owner",
        departmentId: "pglite-department",
        active: true,
        approvalScope: { _tag: "None" as const },
      },
      departmentId: "pglite-department",
      paymentAccountCiphertext: "ciphertext:v1:pglite-account",
      description: "PGlite authority contract",
      amountOre: 12_345,
      receiptDate: "2026-08-23",
      file: {
        fileRef: "pglite-file",
        objectKey: "temporary/pglite-file",
        contentType: "application/pdf",
        byteLength: 256,
        sha256: "c".repeat(64),
      },
    };
    const context = {
      receiptId: "pglite-receipt",
      visualId: "PGLITE-0001",
      now: "2026-08-23T12:00:00.000Z",
    };
    await expect(
      runtime.runPromise(
        Economy.use(({ executeReceipt }) =>
          executeReceipt(command, { ...context, now: "2026-08-23 12:00:00" }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ReceiptDecodeError" });

    const execute = Economy.use(({ executeReceipt }) => executeReceipt(command, context));

    const first = await runtime.runPromise(execute);
    const replayWithIgnoredContext = await runtime.runPromise(
      Economy.use(({ executeReceipt }) =>
        executeReceipt(command, {
          receiptId: "",
          visualId: "",
          now: "not-an-instant",
        }),
      ),
    );
    expect(replayWithIgnoredContext).toMatchObject({
      replayed: true,
      observation: { ...first.observation, replayed: true },
    });
    await runtime.runPromise(
      Database.use((database) =>
        database`
          UPDATE economy_receipt_command_receipts
          SET observation_json = ${database.json({ ...first.observation, unexpected: true })}
          WHERE command_id = ${command.commandId}
        `.pipe(Effect.asVoid),
      ),
    );
    await expect(runtime.runPromise(execute)).rejects.toMatchObject({
      _tag: "ReceiptPersistenceError",
      operation: "decode stored observation",
    });
    await runtime.runPromise(
      Database.use((database) =>
        database`
          UPDATE economy_receipt_command_receipts
          SET observation_json = ${database.json(first.observation)}
          WHERE command_id = ${command.commandId}
        `.pipe(Effect.asVoid),
      ),
    );
    const replay = await runtime.runPromise(execute);

    expect(first.observation.status).toBe("Pending");
    expect(first.observation.replayed).toBe(false);
    expect(first.replayed).toBe(false);
    expect(replay.observation).toEqual({ ...first.observation, replayed: true });
    expect(replay.replayed).toBe(true);
  });

  it("returns failed applicant effects to the durable retry queue", async () => {
    const interpreter = makeRecordingPublicApplicationEffectInterpreter();
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.unsafe(
          "INSERT INTO admission_period_departments (department_id, name) VALUES ('outbox-department', 'Outbox Department')",
        );
        yield* database.unsafe(`
          INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
          VALUES (
            'outbox-semester',
            '2031-08-01T00:00:00.000Z',
            '2031-12-31T00:00:00.000Z'
          )
        `);
        yield* database.unsafe(`
          INSERT INTO admission_period_fields_of_study (
            field_of_study_id, department_id, name, active
          ) VALUES (
            'outbox-field',
            'outbox-department',
            'Outbox Field',
            TRUE
          )
        `);
        yield* database.unsafe(`
          INSERT INTO admission_periods (
            admission_period_id, department_id, semester_id, start_at, end_at,
            revision, last_command_id
          ) VALUES (
            'outbox-period',
            'outbox-department',
            'outbox-semester',
            '2031-09-01T00:00:00.000Z',
            '2031-10-01T00:00:00.000Z',
            0,
            'outbox-period-seed'
          )
        `);
        yield* executePublicApplicationCommand(
          {
            commandId: "outbox-application-submit",
            departmentId: "outbox-department",
            firstName: "Ada",
            lastName: "Lovelace",
            phone: "+47 12345678",
            email: "ada.outbox@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 3,
          },
          {
            now: "2031-09-15T12:00:00.000Z",
            applicantId: ApplicantIdSchema.make("outbox-applicant"),
            applicationId: PublicApplicationIdSchema.make("outbox-application"),
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        const rows = yield* database<{
          readonly effect_id: string;
          readonly effect_type: string;
          readonly ordinal: number;
          readonly payload_json: unknown;
        }>`
          SELECT effect_id, effect_type, ordinal, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'outbox-application-submit'
          ORDER BY ordinal
        `;
        const firstEffectId = rows[0]?.effect_id;
        if (firstEffectId === undefined) throw new Error("missing applicant outbox effect");
        const applicantRows = yield* database<{ readonly activation_digest: string | null }>`
          SELECT activation_digest
          FROM admission_applicants
          WHERE applicant_id = 'outbox-applicant'
        `;
        interpreter.failOnce(firstEffectId);
        const failed = yield* deliverNextPublicApplicationOutbox(
          "outbox-failed-claim",
          "2031-09-15T12:00:01.000Z",
          interpreter,
        );
        const failedRows = yield* database<{
          readonly status: string;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
        }>`
          SELECT status, claim_id, last_failure_tag
          FROM admission_application_outbox
          WHERE effect_id = ${firstEffectId}
        `;
        const retried = yield* deliverNextPublicApplicationOutbox(
          "outbox-retry-claim",
          "2031-09-15T12:00:02.000Z",
          interpreter,
        );
        const remaining = [
          yield* deliverNextPublicApplicationOutbox(
            "outbox-remaining-claim-1",
            "2031-09-15T12:00:03.000Z",
            interpreter,
          ),
          yield* deliverNextPublicApplicationOutbox(
            "outbox-remaining-claim-2",
            "2031-09-15T12:00:04.000Z",
            interpreter,
          ),
        ];
        const deliveredRows = yield* database<{
          readonly ordinal: number;
          readonly status: string;
          readonly payload_json: unknown;
        }>`
          SELECT ordinal, status, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'outbox-application-submit'
          ORDER BY ordinal
        `;
        const deliveryEvidence = interpreter.snapshot();
        yield* executePublicApplicationCommand(
          {
            commandId: "outbox-fairness-old",
            departmentId: "outbox-department",
            firstName: "Old",
            lastName: "Failure",
            phone: "+47 11111111",
            email: "old.failure@example.invalid",
            gender: 0,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 1,
          },
          {
            now: "2031-09-15T12:10:00.000Z",
            applicantId: ApplicantIdSchema.make("outbox-fairness-old-applicant"),
            applicationId: PublicApplicationIdSchema.make("outbox-fairness-old-application"),
            activationToken: "oldfailureabcdefghijklmnopqrstuvwxyzABCDEFG",
          },
        );
        yield* executePublicApplicationCommand(
          {
            commandId: "outbox-fairness-new",
            departmentId: "outbox-department",
            firstName: "New",
            lastName: "Application",
            phone: "+47 22222222",
            email: "new.application@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:11:00.000Z",
            applicantId: ApplicantIdSchema.make("outbox-fairness-new-applicant"),
            applicationId: PublicApplicationIdSchema.make("outbox-fairness-new-application"),
            activationToken: "newapplicationabcdefghijklmnopqrstuvwxyzABC",
          },
        );
        const fairnessRows = yield* database<{ readonly effect_id: string }>`
          SELECT effect_id
          FROM admission_application_outbox
          WHERE command_id = 'outbox-fairness-old' AND ordinal = 0
        `;
        const fairnessOldEffectId = fairnessRows[0]?.effect_id;
        if (fairnessOldEffectId === undefined) throw new Error("missing fairness outbox effect");
        interpreter.failOnce(fairnessOldEffectId);
        const fairnessFailure = yield* deliverNextPublicApplicationOutbox(
          "outbox-fairness-failed",
          "2031-09-15T12:12:00.000Z",
          interpreter,
        );
        const fairnessNext = yield* deliverNextPublicApplicationOutbox(
          "outbox-fairness-next",
          "2031-09-15T12:12:01.000Z",
          interpreter,
        );
        const fairnessDrain = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) =>
            deliverNextPublicApplicationOutbox(
              `outbox-fairness-drain-${index}`,
              `2031-09-15T12:12:0${index + 2}.000Z`,
              interpreter,
            ),
        );
        const fairnessIdle = yield* deliverNextPublicApplicationOutbox(
          "outbox-fairness-idle",
          "2031-09-15T12:12:07.000Z",
          interpreter,
        );

        return {
          activationPayload: rows[0]?.payload_json,
          applicantDigest: applicantRows[0]?.activation_digest,
          failed,
          failedRow: failedRows[0],
          retried,
          deliveredPayload: deliveredRows,
          effects: rows.map(({ effect_id, effect_type, ordinal }) => ({
            effectId: effect_id,
            effectType: effect_type,
            ordinal,
          })),
          remaining,
          deliveryEvidence,
          fairnessFailure,
          fairnessNext,
          fairnessDrain,
          fairnessIdle,
        };
      }),
    );

    expect(evidence.activationPayload).toMatchObject({
      activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    });
    expect(evidence.applicantDigest).toBe(
      publicApplicationActivationDigest("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"),
    );
    expect(evidence.failed).toMatchObject({
      _tag: "Failed",
      failureTag: "PublicApplicationEffectDeliveryError",
    });
    expect(evidence.failedRow).toEqual({
      status: "Failed",
      claim_id: null,
      last_failure_tag: "PublicApplicationEffectDeliveryError",
    });
    expect(evidence.retried).toMatchObject({ _tag: "Delivered" });
    expect(evidence.effects).toEqual([
      {
        effectId: expect.any(String),
        effectType: "SendApplicantActivationOrConfirmation",
        ordinal: 0,
      },
      {
        effectId: expect.any(String),
        effectType: "CreateAdmissionSubscription",
        ordinal: 1,
      },
      {
        effectId: expect.any(String),
        effectType: "WriteApplicationAudit",
        ordinal: 2,
      },
    ]);
    expect(evidence.failed).toMatchObject({
      claim: { effectId: evidence.effects[0]?.effectId },
    });
    expect(evidence.retried).toMatchObject({
      _tag: "Delivered",
      claim: { effectId: evidence.effects[0]?.effectId, ordinal: 0 },
    });
    expect(evidence.remaining).toMatchObject([
      { _tag: "Delivered", claim: { effectId: evidence.effects[1]?.effectId, ordinal: 1 } },
      { _tag: "Delivered", claim: { effectId: evidence.effects[2]?.effectId, ordinal: 2 } },
    ]);
    expect(evidence.deliveryEvidence).toMatchObject([
      { effectId: evidence.effects[0]?.effectId, ordinal: 0, attempts: 2 },
      { effectId: evidence.effects[1]?.effectId, ordinal: 1, attempts: 1 },
      { effectId: evidence.effects[2]?.effectId, ordinal: 2, attempts: 1 },
    ]);
    expect(evidence.deliveredPayload).toEqual([
      { ordinal: 0, status: "Delivered", payload_json: {} },
      { ordinal: 1, status: "Delivered", payload_json: {} },
      { ordinal: 2, status: "Delivered", payload_json: {} },
    ]);
    expect(evidence.fairnessFailure).toMatchObject({
      _tag: "Failed",
      claim: { commandId: "outbox-fairness-old", ordinal: 0 },
    });
    expect(evidence.fairnessNext).toMatchObject({
      _tag: "Delivered",
      claim: { commandId: "outbox-fairness-new", ordinal: 0 },
    });
    expect(evidence.fairnessDrain).toHaveLength(5);
    expect(evidence.fairnessDrain.every((result) => result._tag === "Delivered")).toBe(true);
    expect(evidence.fairnessIdle).toEqual({ _tag: "Idle" });
  });

  it("makes applicant transaction linkage and effect ordering unrepresentable", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const orderFailure = yield* Effect.flip(database`
          UPDATE admission_application_outbox
          SET effect_type = 'CreateAdmissionSubscription'
          WHERE command_id = 'outbox-application-submit' AND ordinal = 0
        `);
        const receiptFailure = yield* Effect.flip(database`
          DELETE FROM admission_application_command_receipts
          WHERE command_id = 'outbox-application-submit'
        `);
        const rows = yield* database<{
          readonly ordinal: number;
          readonly effect_type: string;
        }>`
          SELECT ordinal, effect_type
          FROM admission_application_outbox
          WHERE command_id = 'outbox-application-submit' AND ordinal = 0
        `;
        return { orderFailure, receiptFailure, row: rows[0] };
      }),
    );

    expect(evidence.orderFailure).toMatchObject({ _tag: "SqlError" });
    expect(evidence.receiptFailure).toMatchObject({ _tag: "SqlError" });
    expect(evidence.row).toEqual({
      ordinal: 0,
      effect_type: "SendApplicantActivationOrConfirmation",
    });
  });

  it("quarantines incompatible pre-0041 applicant effects during upgrade", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "legacy-effect-application-submit",
            departmentId: "outbox-department",
            firstName: "Legacy",
            lastName: "Payload",
            phone: "+47 33333333",
            email: "legacy.payload@example.invalid",
            gender: 0,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:20:00.000Z",
            applicantId: ApplicantIdSchema.make("legacy-effect-applicant"),
            applicationId: PublicApplicationIdSchema.make("legacy-effect-application"),
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        yield* database`
          UPDATE admission_application_outbox
          SET payload_json =
            (payload_json - 'activationToken')
            || jsonb_build_object('activationDigest', ${"a".repeat(64)}::text)
          WHERE command_id = 'legacy-effect-application-submit' AND ordinal = 0
        `;
        yield* database`
          UPDATE admission_application_outbox
          SET payload_json = payload_json - 'departmentId'
          WHERE command_id = 'legacy-effect-application-submit' AND ordinal = 1
        `;
        yield* database`
          DELETE FROM vektorprogrammet_schema_migrations
          WHERE migration_id >= 5
        `;
        yield* database.migrate;
        return yield* database<{
          readonly ordinal: number;
          readonly status: string;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
          readonly payload_json: unknown;
        }>`
          SELECT ordinal, status, claim_id, last_failure_tag, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'legacy-effect-application-submit'
          ORDER BY ordinal
        `;
      }),
    );

    expect(evidence).toEqual([
      {
        ordinal: 0,
        status: "Quarantined",
        claim_id: null,
        last_failure_tag: "LegacyPublicApplicationEffectPayload",
        payload_json: {},
      },
      {
        ordinal: 1,
        status: "Quarantined",
        claim_id: null,
        last_failure_tag: "LegacyPublicApplicationEffectPayload",
        payload_json: {},
      },
      {
        ordinal: 2,
        status: "Quarantined",
        claim_id: null,
        last_failure_tag: "LegacyPublicApplicationEffectPayload",
        payload_json: {},
      },
    ]);
  });

  it("clears delivered legacy payloads in a later immutable migration", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "legacy-delivered-application-submit",
            departmentId: "outbox-department",
            firstName: "Delivered",
            lastName: "Legacy",
            phone: "+47 44444444",
            email: "legacy.delivered@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 3,
          },
          {
            now: "2031-09-15T12:21:00.000Z",
            applicantId: ApplicantIdSchema.make("legacy-delivered-applicant"),
            applicationId: PublicApplicationIdSchema.make("legacy-delivered-application"),
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        yield* database`
          UPDATE admission_applications
          SET activation_digest = NULL
          WHERE application_id = 'legacy-delivered-application'
        `;
        yield* database`
          UPDATE admission_applicants
          SET activation_digest = ${publicApplicationActivationDigest(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
          )}
          WHERE applicant_id = 'legacy-delivered-applicant'
        `;
        yield* database`
          UPDATE admission_application_outbox
          SET payload_json =
            (payload_json - 'activationToken')
            || jsonb_build_object(
              'activationDigest',
              ${publicApplicationActivationDigest(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
              )}::text
            )
          WHERE command_id = 'legacy-delivered-application-submit' AND ordinal = 0
        `;
        yield* database`
          UPDATE admission_application_outbox
          SET status = 'Delivered'
          WHERE command_id = 'legacy-delivered-application-submit'
        `;
        yield* database`
          DELETE FROM vektorprogrammet_schema_migrations
          WHERE migration_id >= 6
        `;
        yield* database.migrate;
        const outbox = yield* database<{
          readonly ordinal: number;
          readonly status: string;
          readonly payload_json: unknown;
        }>`
          SELECT ordinal, status, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'legacy-delivered-application-submit'
          ORDER BY ordinal
        `;
        const snapshots = yield* database<{
          readonly application_digest: string | null;
          readonly applicant_digest: string | null;
        }>`
          SELECT application.activation_digest AS application_digest,
            applicant.activation_digest AS applicant_digest
          FROM admission_applications AS application
          INNER JOIN admission_applicants AS applicant
            ON applicant.applicant_id = application.applicant_id
          WHERE application.application_id = 'legacy-delivered-application'
        `;
        return { outbox, snapshot: snapshots[0] };
      }),
    );

    expect(evidence.outbox).toEqual([
      { ordinal: 0, status: "Delivered", payload_json: {} },
      { ordinal: 1, status: "Delivered", payload_json: {} },
      { ordinal: 2, status: "Delivered", payload_json: {} },
    ]);
    expect(evidence.snapshot).toEqual({
      application_digest: publicApplicationActivationDigest(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
      ),
      applicant_digest: publicApplicationActivationDigest(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
      ),
    });
  });

  it("quarantines an invalid persisted payload without stopping the queue", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "malformed-effect-application-submit",
            departmentId: "outbox-department",
            firstName: "Malformed",
            lastName: "Payload",
            phone: "+47 44444444",
            email: "malformed.payload@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:21:00.000Z",
            applicantId: ApplicantIdSchema.make("malformed-effect-applicant"),
            applicationId: PublicApplicationIdSchema.make("malformed-effect-application"),
            activationToken: "malformedpayloadabcdefghijklmnopqrstuvwxyzA",
          },
        );
        yield* database`
          UPDATE admission_application_outbox
          SET payload_json = '{"_tag":"SendApplicantActivationOrConfirmation"}'::jsonb
          WHERE command_id = 'malformed-effect-application-submit' AND ordinal = 0
        `;
        const result = yield* deliverNextPublicApplicationOutbox(
          "malformed-effect-claim",
          "2031-09-15T12:21:01.000Z",
          makeRecordingPublicApplicationEffectInterpreter(),
        );
        const rows = yield* database<{
          readonly status: string;
          readonly attempts: number;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
          readonly payload_json: unknown;
        }>`
          SELECT status, attempts, claim_id, last_failure_tag, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'malformed-effect-application-submit' AND ordinal = 0
        `;
        yield* database`
          DELETE FROM admission_application_outbox
          WHERE command_id = 'malformed-effect-application-submit'
        `;
        return { result, row: rows[0] };
      }),
    );

    expect(evidence.result).toEqual({ _tag: "Idle" });
    expect(evidence.row).toEqual({
      status: "Quarantined",
      attempts: 1,
      claim_id: null,
      last_failure_tag: "InvalidPublicApplicationEffectPayload",
      payload_json: {},
    });
  });

  it("quarantines a valid outbox payload that diverges from application authority", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "tampered-effect-application-submit",
            departmentId: "outbox-department",
            firstName: "Tampered",
            lastName: "Payload",
            phone: "+47 45555555",
            email: "tampered.payload@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:22:00.000Z",
            applicantId: ApplicantIdSchema.make("tampered-effect-applicant"),
            applicationId: PublicApplicationIdSchema.make("tampered-effect-application"),
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        yield* database`
          UPDATE admission_application_outbox
          SET payload_json = jsonb_set(
            payload_json,
            '{activationToken}',
            to_jsonb(${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"}::text)
          )
          WHERE command_id = 'tampered-effect-application-submit' AND ordinal = 0
        `;
        const result = yield* deliverNextPublicApplicationOutbox(
          "tampered-effect-claim",
          "2031-09-15T12:22:01.000Z",
          makeRecordingPublicApplicationEffectInterpreter(),
        );
        const rows = yield* database<{
          readonly status: string;
          readonly attempts: number;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
          readonly payload_json: unknown;
        }>`
          SELECT status, attempts, claim_id, last_failure_tag, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'tampered-effect-application-submit' AND ordinal = 0
        `;
        yield* database`
          DELETE FROM admission_application_outbox
          WHERE command_id = 'tampered-effect-application-submit'
        `;
        return { result, row: rows[0] };
      }),
    );

    expect(evidence.result).toEqual({ _tag: "Idle" });
    expect(evidence.row).toEqual({
      status: "Quarantined",
      attempts: 1,
      claim_id: null,
      last_failure_tag: "InvalidPublicApplicationEffectAuthority",
      payload_json: {},
    });
  });

  it("delivers an older-period activation from its immutable application snapshot", async () => {
    const firstToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const secondToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
    const interpreter = makeRecordingPublicApplicationEffectInterpreter();
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "snapshot-first-period-submit",
            departmentId: "outbox-department",
            firstName: "Snapshot",
            lastName: "Applicant",
            phone: "+47 48888888",
            email: "snapshot.applicant@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:22:30.000Z",
            applicantId: ApplicantIdSchema.make("snapshot-applicant"),
            applicationId: PublicApplicationIdSchema.make("snapshot-first-application"),
            activationToken: firstToken,
          },
        );
        yield* database`
          INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
          VALUES (
            'outbox-second-semester',
            '2032-08-01T00:00:00.000Z',
            '2032-12-31T00:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO admission_periods (
            admission_period_id, department_id, semester_id, start_at, end_at,
            revision, last_command_id
          ) VALUES (
            'outbox-second-period',
            'outbox-department',
            'outbox-second-semester',
            '2032-09-01T00:00:00.000Z',
            '2032-10-01T00:00:00.000Z',
            0,
            'outbox-second-period-seed'
          )
        `;
        yield* executePublicApplicationCommand(
          {
            commandId: "snapshot-second-period-submit",
            departmentId: "outbox-department",
            firstName: "Snapshot",
            lastName: "Applicant",
            phone: "+47 49999999",
            email: "SNAPSHOT.APPLICANT@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 3,
          },
          {
            now: "2032-09-15T12:22:30.000Z",
            applicantId: ApplicantIdSchema.make("ignored-existing-applicant"),
            applicationId: PublicApplicationIdSchema.make("snapshot-second-application"),
            activationToken: secondToken,
          },
        );
        const delivery = yield* deliverNextPublicApplicationOutbox(
          "snapshot-old-period-claim",
          "2032-09-15T12:22:31.000Z",
          interpreter,
        );
        const applications = yield* database<{
          readonly application_id: string;
          readonly activation_digest: string | null;
        }>`
          SELECT application_id, activation_digest
          FROM admission_applications
          WHERE application_id IN (
            'snapshot-first-application',
            'snapshot-second-application'
          )
          ORDER BY application_id
        `;
        const applicants = yield* database<{ readonly activation_digest: string | null }>`
          SELECT activation_digest
          FROM admission_applicants
          WHERE applicant_id = 'snapshot-applicant'
        `;
        yield* database`
          DELETE FROM admission_application_outbox
          WHERE command_id IN (
            'snapshot-first-period-submit',
            'snapshot-second-period-submit'
          )
        `;
        return {
          delivery,
          applications,
          applicantDigest: applicants[0]?.activation_digest,
        };
      }),
    );

    expect(evidence.delivery).toMatchObject({
      _tag: "Delivered",
      claim: {
        commandId: "snapshot-first-period-submit",
        request: { activationToken: firstToken },
      },
    });
    expect(evidence.applications).toEqual([
      {
        application_id: "snapshot-first-application",
        activation_digest: publicApplicationActivationDigest(firstToken),
      },
      {
        application_id: "snapshot-second-application",
        activation_digest: publicApplicationActivationDigest(secondToken),
      },
    ]);
    expect(evidence.applicantDigest).toBe(publicApplicationActivationDigest(secondToken));
  });

  it("quarantines an outbox row cross-linked to another command transaction", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* executePublicApplicationCommand(
          {
            commandId: "cross-linked-target-submit",
            departmentId: "outbox-department",
            firstName: "Target",
            lastName: "Application",
            phone: "+47 46666666",
            email: "cross.linked.target@example.invalid",
            gender: 0,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 2,
          },
          {
            now: "2031-09-15T12:23:00.000Z",
            applicantId: ApplicantIdSchema.make("cross-linked-target-applicant"),
            applicationId: PublicApplicationIdSchema.make("cross-linked-target-application"),
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        yield* database`
          DELETE FROM admission_application_outbox
          WHERE command_id = 'cross-linked-target-submit'
        `;
        yield* executePublicApplicationCommand(
          {
            commandId: "cross-linked-source-submit",
            departmentId: "outbox-department",
            firstName: "Source",
            lastName: "Application",
            phone: "+47 47777777",
            email: "cross.linked.source@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 3,
          },
          {
            now: "2031-09-15T12:23:01.000Z",
            applicantId: ApplicantIdSchema.make("cross-linked-source-applicant"),
            applicationId: PublicApplicationIdSchema.make("cross-linked-source-application"),
            activationToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
          },
        );
        yield* database`
          UPDATE admission_application_command_receipts
          SET application_id = 'cross-linked-target-application'
          WHERE command_id = 'cross-linked-source-submit'
        `;
        const result = yield* deliverNextPublicApplicationOutbox(
          "cross-linked-claim",
          "2031-09-15T12:23:02.000Z",
          makeRecordingPublicApplicationEffectInterpreter(),
        );
        const rows = yield* database<{
          readonly status: string;
          readonly attempts: number;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
          readonly payload_json: unknown;
        }>`
          SELECT status, attempts, claim_id, last_failure_tag, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'cross-linked-source-submit' AND ordinal = 0
        `;
        yield* database`
          DELETE FROM admission_application_outbox
          WHERE command_id = 'cross-linked-source-submit'
        `;
        yield* database`
          UPDATE admission_application_command_receipts
          SET application_id = 'cross-linked-source-application'
          WHERE command_id = 'cross-linked-source-submit'
        `;
        return { result, row: rows[0] };
      }),
    );

    expect(evidence.result).toEqual({ _tag: "Idle" });
    expect(evidence.row).toEqual({
      status: "Quarantined",
      attempts: 1,
      claim_id: null,
      last_failure_tag: "InvalidPublicApplicationEffectAuthority",
      payload_json: {},
    });
  });

  it("releases an interrupted applicant worker claim before shutdown", async () => {
    let starts = 0;
    let stops = 0;
    const evidence = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Database;
          yield* executePublicApplicationCommand(
            {
              commandId: "worker-application-submit",
              departmentId: "outbox-department",
              firstName: "Grace",
              lastName: "Hopper",
              phone: "+47 87654321",
              email: "grace.worker@example.invalid",
              gender: 0,
              fieldOfStudyId: "outbox-field",
              yearOfStudy: 4,
            },
            {
              now: "2031-09-15T12:01:00.000Z",
              applicantId: ApplicantIdSchema.make("worker-applicant"),
              applicationId: PublicApplicationIdSchema.make("worker-application"),
              activationToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
            },
          );
          yield* database`
            UPDATE admission_application_outbox
            SET status = 'Processing',
              claim_id = 'stale-worker-claim',
              claimed_at = '2031-09-15T10:00:00.000Z'
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;
          const deliveryStarted = yield* Deferred.make<void>();
          const interpreter = {
            deliver: (
              request: PublicApplicationOutboxRequest,
              ordinal: number,
              attempts: number,
            ) =>
              request.commandId === "worker-application-submit"
                ? Deferred.succeed(deliveryStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({
                    effectId: request.effectId,
                    kind: request._tag,
                    ordinal,
                    attempts,
                    status: "Delivered" as const,
                  }),
          };
          const fiber = yield* Effect.forkScoped(
            runPublicApplicationOutboxWorker(interpreter, {
              workerId: "database-test-worker",
              pollIntervalMilliseconds: 5,
              staleClaimMilliseconds: 60_000,
              now: () => "2031-09-15T12:02:00.000Z",
              onStart: () => {
                starts += 1;
              },
              onStop: () => {
                stops += 1;
              },
            }),
          );
          yield* Deferred.await(deliveryStarted);
          const processing = yield* database<{
            readonly status: string;
            readonly claim_id: string | null;
          }>`
            SELECT status, claim_id
            FROM admission_application_outbox
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;
          yield* Fiber.interrupt(fiber);
          const released = yield* database<{
            readonly status: string;
            readonly claim_id: string | null;
            readonly last_failure_tag: string | null;
          }>`
            SELECT status, claim_id, last_failure_tag
            FROM admission_application_outbox
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;
          return { processing: processing[0], released: released[0] };
        }),
      ),
    );

    expect(evidence.processing?.status).toBe("Processing");
    expect(evidence.processing?.claim_id).toMatch(/^database-test-worker:/);
    expect(evidence.released).toEqual({
      status: "Pending",
      claim_id: null,
      last_failure_tag: "InterruptedPublicApplicationOutboxClaim",
    });
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });

  it("acquires, migrates, and releases one shared database capability", async () => {
    let acquisitionCount = 0;
    let migrationCount = 0;
    let releaseCount = 0;
    const observedRuntime = ManagedRuntime.make(
      DatabaseTest(undefined, {
        onAcquire: () => {
          acquisitionCount += 1;
        },
        onMigration: () => {
          migrationCount += 1;
        },
        onRelease: () => {
          releaseCount += 1;
        },
      }),
    );

    try {
      await Promise.all(
        Array.from({ length: 32 }, () =>
          observedRuntime.runPromise(Database.use((database) => database.health)),
        ),
      );
      expect({ acquisitionCount, migrationCount, releaseCount }).toEqual({
        acquisitionCount: 1,
        migrationCount: 1,
        releaseCount: 0,
      });
    } finally {
      await observedRuntime.dispose();
    }

    expect(releaseCount).toBe(1);
  });

  it("executes native Organization administration atomically against PGlite", async () => {
    const evidence = await recruitmentRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const organization = yield* Organization;
        yield* database.migrate;
        yield* database.migrate;

        const administrator = {
          _tag: "OrganizationAdministrator" as const,
          personId: PersonId.make("organization-pglite-administrator"),
        };
        const member = {
          _tag: "OrganizationMember" as const,
          personId: PersonId.make("organization-pglite-member"),
        };

        const deniedCommand = {
          _tag: "CreateDepartment" as const,
          commandId: OrganizationCommandId.make("organization-pglite-denied-department"),
          name: "Denied Department",
          shortName: "DENY",
          email: "denied@example.invalid",
          address: null,
          city: "Bergen",
          latitude: null,
          longitude: null,
        };
        const denied = yield* Effect.flip(organization.createDepartment(deniedCommand, member));
        const deniedRows = yield* database<{ readonly count: string }>`
          SELECT (
            (SELECT count(*) FROM organization_departments
              WHERE native_creation_command_id = ${deniedCommand.commandId})
            + (SELECT count(*) FROM organization_command_receipts
              WHERE command_id = ${deniedCommand.commandId})
            + (SELECT count(*) FROM organization_creation_audit
              WHERE command_id = ${deniedCommand.commandId})
          )::text AS count
        `;

        const departmentCommand = {
          _tag: "CreateDepartment" as const,
          commandId: OrganizationCommandId.make("organization-pglite-department"),
          name: "PGlite Department",
          shortName: "PGL",
          email: "pglite-department@example.invalid",
          address: "Test Street 1",
          city: "Bergen",
          latitude: "60.3913",
          longitude: "5.3221",
        };
        const departmentCreated = yield* organization.createDepartment(
          departmentCommand,
          administrator,
        );
        const departmentReplayed = yield* organization.createDepartment(
          departmentCommand,
          administrator,
        );
        const departmentConflict = yield* Effect.flip(
          organization.createDepartment(
            { ...departmentCommand, name: "Changed PGlite Department" },
            administrator,
          ),
        );
        if (departmentCreated.observation._tag !== "DepartmentCreated") {
          return yield* Effect.fail(new Error("expected DepartmentCreated"));
        }
        if (departmentReplayed.observation._tag !== "Replayed") {
          return yield* Effect.fail(new Error("expected Department replay"));
        }
        expect(departmentReplayed.observation.original).toEqual(departmentCreated.observation);
        const departmentId = departmentCreated.observation.department.departmentId;

        const teamCommand = {
          _tag: "CreateTeam" as const,
          commandId: OrganizationCommandId.make("organization-pglite-team"),
          departmentId,
          name: "PGlite Team",
          email: null,
          description: "Native Organization team",
          shortDescription: null,
          acceptApplication: true,
          deadline: "2036-09-20T10:00:00.000Z",
          active: true,
        };
        const teamCreated = yield* organization.createTeam(teamCommand, administrator);
        const teamReplayed = yield* organization.createTeam(teamCommand, administrator);
        if (
          teamCreated.observation._tag !== "TeamCreated" ||
          teamReplayed.observation._tag !== "Replayed"
        ) {
          return yield* Effect.fail(new Error("expected Team create and replay"));
        }
        expect(teamReplayed.observation.original).toEqual(teamCreated.observation);

        const fieldCommand = {
          _tag: "CreateFieldOfStudy" as const,
          commandId: OrganizationCommandId.make("organization-pglite-field"),
          name: "Computer Science",
          shortName: "CS",
          departmentId: null,
        };
        const fieldCreated = yield* organization.createFieldOfStudy(fieldCommand, administrator);
        const fieldReplayed = yield* organization.createFieldOfStudy(fieldCommand, administrator);
        if (
          fieldCreated.observation._tag !== "FieldOfStudyCreated" ||
          fieldReplayed.observation._tag !== "Replayed"
        ) {
          return yield* Effect.fail(new Error("expected FieldOfStudy create and replay"));
        }
        expect(fieldReplayed.observation.original).toEqual(fieldCreated.observation);
        const scopedFieldCommand = {
          ...fieldCommand,
          commandId: OrganizationCommandId.make("organization-pglite-scoped-field"),
          name: "Department Computer Science",
          shortName: "DCS",
          departmentId,
        };
        const scopedFieldCreated = yield* organization.createFieldOfStudy(
          scopedFieldCommand,
          administrator,
        );

        const invalidTeamCommand = {
          ...teamCommand,
          commandId: OrganizationCommandId.make("organization-pglite-invalid-team"),
          departmentId: DepartmentId.make("organization-pglite-unknown-department"),
        };
        const invalidReference = yield* Effect.flip(
          organization.createTeam(invalidTeamCommand, administrator),
        );
        const invalidFieldCommand = {
          ...fieldCommand,
          commandId: OrganizationCommandId.make("organization-pglite-invalid-field"),
          departmentId: DepartmentId.make("organization-pglite-unknown-field-department"),
        };
        const invalidFieldReference = yield* Effect.flip(
          organization.createFieldOfStudy(invalidFieldCommand, administrator),
        );
        const invalidRows = yield* database<{ readonly count: string }>`
          SELECT (
            (SELECT count(*) FROM organization_teams
              WHERE native_creation_command_id = ${invalidTeamCommand.commandId})
            + (SELECT count(*) FROM organization_command_receipts
              WHERE command_id = ${invalidTeamCommand.commandId})
            + (SELECT count(*) FROM organization_creation_audit
              WHERE command_id = ${invalidTeamCommand.commandId})
            + (SELECT count(*) FROM organization_field_of_studies
              WHERE native_creation_command_id = ${invalidFieldCommand.commandId})
            + (SELECT count(*) FROM organization_command_receipts
              WHERE command_id = ${invalidFieldCommand.commandId})
            + (SELECT count(*) FROM organization_creation_audit
              WHERE command_id = ${invalidFieldCommand.commandId})
          )::text AS count
        `;

        const rollbackCommandId = OrganizationCommandId.make(
          "organization-pglite-deferred-rollback",
        );
        const rollbackDepartmentId = departmentIdForCommand(rollbackCommandId);
        const rollback = yield* Effect.exit(
          database.withTransaction(
            database`
              INSERT INTO organization_departments (
                department_id,
                name,
                short_name,
                email,
                city,
                native_creation_command_id
              ) VALUES (
                ${rollbackDepartmentId},
                'Rollback Department',
                'ROLL',
                'rollback@example.invalid',
                'Bergen',
                ${rollbackCommandId}
              )
            `,
          ),
        );
        const rollbackRows = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS count
          FROM organization_departments
          WHERE department_id = ${rollbackDepartmentId}
        `;

        yield* database`
          INSERT INTO organization_departments (
            department_id,
            name,
            short_name,
            email,
            city
          ) VALUES (
            'organization-pglite-imported-department',
            'Imported Department',
            'IMP',
            'imported@example.invalid',
            'Bergen'
          )
        `;
        yield* database`
          INSERT INTO organization_teams (team_id, department_id, name)
          VALUES (
            'organization-pglite-imported-team',
            'organization-pglite-imported-department',
            'Imported Team'
          )
        `;
        const imported = yield* database<{
          readonly departmentCommandId: string | null;
          readonly teamCommandId: string | null;
        }>`
          SELECT
            department.native_creation_command_id AS "departmentCommandId",
            team.native_creation_command_id AS "teamCommandId"
          FROM organization_departments AS department
          INNER JOIN organization_teams AS team
            ON team.department_id = department.department_id
          WHERE department.department_id = 'organization-pglite-imported-department'
            AND team.team_id = 'organization-pglite-imported-team'
        `;

        const linkage = yield* database<{
          readonly receipts: string;
          readonly audits: string;
          readonly entities: string;
          readonly exactLinks: string;
        }>`
          WITH accepted(command_id) AS (
            VALUES
              (${departmentCommand.commandId}::text),
              (${teamCommand.commandId}::text),
              (${fieldCommand.commandId}::text),
              (${scopedFieldCommand.commandId}::text)
          ),
          linked AS (
            SELECT
              receipt.command_id,
              receipt.entity_kind,
              receipt.entity_id,
              receipt.actor_person_id,
              receipt.committed_at,
              audit.command_id AS audit_command_id,
              CASE receipt.entity_kind
                WHEN 'Department' THEN department.native_creation_command_id
                WHEN 'Team' THEN team.native_creation_command_id
                WHEN 'FieldOfStudy' THEN field.native_creation_command_id
              END AS entity_command_id
            FROM accepted
            INNER JOIN organization_command_receipts AS receipt
              ON receipt.command_id = accepted.command_id
            INNER JOIN organization_creation_audit AS audit
              ON audit.command_id = receipt.command_id
              AND audit.entity_kind = receipt.entity_kind
              AND audit.entity_id = receipt.entity_id
              AND audit.actor_person_id = receipt.actor_person_id
              AND audit.occurred_at = receipt.committed_at
            LEFT JOIN organization_departments AS department
              ON receipt.entity_kind = 'Department'
              AND department.department_id = receipt.entity_id
            LEFT JOIN organization_teams AS team
              ON receipt.entity_kind = 'Team'
              AND team.team_id = receipt.entity_id
            LEFT JOIN organization_field_of_studies AS field
              ON receipt.entity_kind = 'FieldOfStudy'
              AND field.field_of_study_id = receipt.entity_id
          )
          SELECT
            (SELECT count(*)::text
              FROM organization_command_receipts
              INNER JOIN accepted USING (command_id)) AS receipts,
            (SELECT count(*)::text
              FROM organization_creation_audit
              INNER JOIN accepted USING (command_id)) AS audits,
            (SELECT count(*)::text FROM linked
              WHERE entity_command_id = command_id) AS entities,
            (SELECT count(*)::text FROM linked
              WHERE audit_command_id = command_id
                AND entity_command_id = command_id) AS "exactLinks"
        `;

        const departments = yield* organization.listDepartments;
        const teams = yield* organization.listTeams();
        const fields = yield* organization.listFieldOfStudies;

        return {
          schemaRevision: database.schemaRevision,
          denied,
          deniedRows: Number(deniedRows[0]?.count ?? "-1"),
          departmentCreated,
          departmentReplayed,
          departmentConflict,
          teamCreated,
          teamReplayed,
          fieldCreated,
          fieldReplayed,
          scopedFieldCreated,
          invalidReference,
          invalidFieldReference,
          invalidRows: Number(invalidRows[0]?.count ?? "-1"),
          rollbackTag: rollback._tag,
          rollbackRows: Number(rollbackRows[0]?.count ?? "-1"),
          imported: imported[0],
          linkage: {
            receipts: Number(linkage[0]?.receipts ?? "-1"),
            audits: Number(linkage[0]?.audits ?? "-1"),
            entities: Number(linkage[0]?.entities ?? "-1"),
            exactLinks: Number(linkage[0]?.exactLinks ?? "-1"),
          },
          publicLists: {
            departments: departments.some((department) => department.departmentId === departmentId),
            teams: teams.some(
              (team) =>
                teamCreated.observation._tag === "TeamCreated" &&
                team.teamId === teamCreated.observation.team.teamId,
            ),
            fields: fields.some(
              (field) =>
                fieldCreated.observation._tag === "FieldOfStudyCreated" &&
                field.fieldOfStudyId === fieldCreated.observation.fieldOfStudy.fieldOfStudyId,
            ),
          },
        };
      }),
    );

    expect(evidence.schemaRevision).toBe("13_native-organization-administration");
    expect(evidence.denied._tag).toBe("OrganizationRoleDenied");
    expect(evidence.deniedRows).toBe(0);
    expect(evidence.departmentCreated.committed).toBe(true);
    expect(evidence.departmentReplayed.committed).toBe(false);
    expect(evidence.departmentReplayed.observation._tag).toBe("Replayed");
    expect(evidence.departmentConflict._tag).toBe("OrganizationCommandConflict");
    expect(evidence.teamCreated.committed).toBe(true);
    expect(evidence.teamReplayed.committed).toBe(false);
    expect(evidence.fieldCreated.committed).toBe(true);
    expect(evidence.fieldReplayed.committed).toBe(false);
    expect(evidence.scopedFieldCreated.committed).toBe(true);
    expect(evidence.invalidReference._tag).toBe("OrganizationInvalidReference");
    expect(evidence.invalidFieldReference._tag).toBe("OrganizationInvalidReference");
    expect(evidence.invalidRows).toBe(0);
    expect(evidence.rollbackTag).toBe("Failure");
    expect(evidence.rollbackRows).toBe(0);
    expect(evidence.imported).toEqual({
      departmentCommandId: null,
      teamCommandId: null,
    });
    expect(evidence.linkage).toEqual({
      receipts: 4,
      audits: 4,
      entities: 4,
      exactLinks: 4,
    });
    expect(evidence.publicLists).toEqual({
      departments: true,
      teams: true,
      fields: true,
    });
  });
});
