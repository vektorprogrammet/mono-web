import { afterAll, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  Recruitment,
  RecruitmentInvitationTransition,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
} from "@vektorprogrammet/domain/recruitment";
import { Database } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { RecruitmentLive } from "./postgres-layer.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { AdmissionsLive } from "../admissions/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";

const runtime = makeControlledTestRuntime(
  RecruitmentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(
        Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTest()))),
      ),
    ),
  ),
);

afterAll(() => runtime.dispose());

it("reads persisted authority revisions, co-interviewers, and invitation state", async () => {
  const capability = RecruitmentInvitationCapabilitySchema.make("a".repeat(43));
  const digest = sha256Hex(new TextEncoder().encode(capability));

  const observed = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city) VALUES ('department-1', 'Realfag', 'RF', 'rf@example.invalid', 'Trondheim')`;
      yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES ('department-1', 'Realfag')`;
      yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('semester-1', '2031-08-01', '2032-01-01')`;
      yield* sql`INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id) VALUES ('period-1', 'department-1', 'semester-1', '2031-08-01', '2031-10-01', 'seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name, active) VALUES ('field-1', 'department-1', 'Matematikk', TRUE)`;
      yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES ('primary-1', 'Ivar', 'Intervjuer'), ('co-1', 'Kari', 'Kollega'), ('other-1', 'Andre', 'Medlem')`;
      yield* sql`INSERT INTO person_contact_profiles (person_id, email, phone) VALUES ('primary-1', 'primary@example.invalid', '90000000')`;
      yield* sql`INSERT INTO organization_teams (team_id, department_id, name) VALUES ('team-1', 'department-1', 'Team')`;
      yield* sql`INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at) VALUES ('membership-1', 'co-1', 'team-1', '2031-08-01'), ('membership-2', 'primary-1', 'team-1', '2031-08-01')`;
      yield* sql`INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study) VALUES ('applicant-1', 'applicant@example.invalid', 'applicant@example.invalid', 'Ada', 'Søker', '90000001', 0, 'field-1', 2)`;
      yield* sql`INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at) VALUES ('application-1', 'applicant-1', 'period-1', 'department-1', 'field-1', 2, '2031-08-15')`;
      yield* sql`INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count, active, revision) VALUES ('schema-1', 'Interview', 0, TRUE, 0)`;
      yield* sql`INSERT INTO recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, co_interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at, revision) VALUES ('interview-1', 'application-1', 'department-1', 'primary-1', 'co-1', 'schema-1', 'primary-1', '2031-09-01', 3)`;
      yield* sql`INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, revision) VALUES ('grant-1', 'co-1', '2031-08-01', 2)`;
      yield* sql`UPDATE organization_memberships SET revision = 3 WHERE membership_id = 'membership-1'`;
      yield* sql`UPDATE organization_teams SET revision = 5 WHERE team_id = 'team-1'`;
      yield* sql`UPDATE organization_departments SET revision = 7 WHERE department_id = 'department-1'`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO recruitment_interview_schedules (interview_id, scheduled_at, room, campus, message, scheduled_by_person_id, committed_at, schedule_revision) VALUES ('interview-1', '2031-09-15T12:00:00.000Z', 'A1', 'Gløshaugen', 'Welcome', 'primary-1', '2031-09-01', 2)`;
          yield* sql`INSERT INTO recruitment_invitations (invitation_id, interview_id, schedule_revision, capability_sha256, response_state, response_revision, created_at) VALUES ('invitation-1', 'interview-1', 2, ${digest}, 'Pending', 0, '2031-09-01')`;
        }),
      );

      const authority = yield* Recruitment.use((service) =>
        service.readPersonAuthoritySources(PersonId.make("co-1")),
      );

      const interview = yield* Recruitment.use((service) =>
        service.readInterviewSource(
          RecruitmentInterviewId.make("interview-1"),
          PersonId.make("co-1"),
        ),
      );

      const snapshot = yield* Recruitment.use((service) =>
        service.transitionInvitation({
          capability,
          transition: RecruitmentInvitationTransition.Confirm(),
          now: "2031-09-02T00:00:00.000Z",
        }),
      );

      yield* sql`UPDATE recruitment_invitations SET superseded_at = '2031-09-16' WHERE invitation_id = 'invitation-1'`;

      const superseded = yield* Effect.flip(
        Recruitment.use((service) => service.readInvitationSnapshot(capability)),
      );

      yield* sql`INSERT INTO applicant_account_invitations (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at) VALUES ('account-invitation', 'application-1', 'applicant-1', repeat('b',64), '2031-10-01', 'Claimed', 'primary-1', '2031-09-01')`;
      yield* sql`INSERT INTO applicant_account_links (applicant_id, person_id, linked_at, invitation_id) VALUES ('applicant-1', 'co-1', '2031-09-02', 'account-invitation')`;

      const selfDenied = yield* Effect.flip(
        sql.withTransaction(
          Recruitment.use((service) =>
            service.prepareInterview({
              interviewId: RecruitmentInterviewId.make("interview-1"),
              personId: PersonId.make("co-1"),
              authorizationInstant: "2031-09-15T12:00:00.000Z",
            }),
          ),
        ),
      );

      return { authority, interview, snapshot, superseded, selfDenied };
    }),
  );

  expect(observed.authority).toEqual([
    { kind: "GlobalAdministrator", identity: "grant-1", revisions: [2] },
    { kind: "Membership", identity: "membership-1", revisions: [3, 5, 7] },
  ]);
  expect(observed.interview).toEqual({
    interviewId: "interview-1",
    departmentId: "department-1",
    interviewerPersonId: "primary-1",
    coInterviewerPersonId: "co-1",
    interviewRevision: 3,
    linkedApplicantPersonId: null,
    authority: observed.authority,
  });
  expect(observed.snapshot).toEqual({
    source: {
      capabilitySha256: digest,
      invitationId: "invitation-1",
      interviewId: "interview-1",
      departmentId: "department-1",
      scheduleRevision: 2,
      responseRevision: 1,
      responseState: "Accepted",
      supersededAt: null,
    },
    observation: {
      scheduledAt: "2031-09-15T12:00:00.000Z",
      room: "A1",
      campus: "Gløshaugen",
      responseState: "Accepted",
      responseMessage: null,
    },
  });
  expect(observed.superseded._tag).toBe("RecruitmentInvitationNotFound");
  expect(observed.selfDenied._tag).toBe("RecruitmentScopeDenied");
}, 15_000);
