import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  RecruitmentActorSchema,
  RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { AdmissionsLive } from "../admissions/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { readInterviewConduct } from "./conduct-postgres.js";

const suiteLayer = Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(
  Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
);

const context = {
  actor: RecruitmentActorSchema.cases.Member.make({
    personId: PersonId.make("co-1"),
    departmentId: DepartmentId.make("department-1"),
    active: true,
  }),
  now: "2031-09-15T12:00:00.000Z",
};

layer(suiteLayer, { excludeTestServices: true, timeout: "30 seconds" })((it) => {
  it.effect(
    "denies incomplete conduct to a co-interviewer while admitting the primary interviewer",
    () =>
      Effect.gen(function* () {
        const observed = yield* Effect.gen(function* () {
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
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO recruitment_interview_schedules (interview_id, scheduled_at, room, campus, message, scheduled_by_person_id, committed_at, schedule_revision) VALUES ('interview-1', '2031-09-15T12:00:00.000Z', 'A1', 'Gløshaugen', 'Welcome', 'primary-1', '2031-09-01', 2)`;
              yield* sql`INSERT INTO recruitment_invitations (invitation_id, interview_id, schedule_revision, capability_sha256, response_state, response_revision, responded_at, created_at) VALUES ('invitation-1', 'interview-1', 2, repeat('a', 64), 'Accepted', 1, '2031-09-02', '2031-09-01')`;
              yield* sql`INSERT INTO recruitment_invitation_response_audit (invitation_id, interview_id, schedule_revision, response_revision, response_state, responded_at) VALUES ('invitation-1', 'interview-1', 2, 1, 'Accepted', '2031-09-02')`;
            }),
          );

          const denied = yield* Effect.flip(
            readInterviewConduct(RecruitmentInterviewId.make("interview-1"), context),
          );

          const primary = yield* readInterviewConduct(RecruitmentInterviewId.make("interview-1"), {
            ...context,
            actor: RecruitmentActorSchema.cases.Member.make({
              ...context.actor,
              personId: PersonId.make("primary-1"),
            }),
          });

          return { denied, primary };
        });

        expect(observed.denied._tag).toBe("RecruitmentScopeDenied");
        expect(observed.primary.interviewId).toBe("interview-1");
      }),
    15_000,
  );
});
