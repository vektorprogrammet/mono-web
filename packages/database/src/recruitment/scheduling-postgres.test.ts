import { afterAll, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { RecruitmentActorSchema } from "@vektorprogrammet/domain/recruitment";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { AdmissionsLive } from "../admissions/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { readSchedulingBoard } from "./scheduling-postgres.js";

const runtime = makeControlledTestRuntime(
  Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(
    Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
  ),
);

afterAll(() => runtime.dispose());

const context = {
  actor: RecruitmentActorSchema.cases.Member.make({
    personId: PersonId.make("co-1"),
    departmentId: DepartmentId.make("department-1"),
    active: true,
  }),
  now: "2031-09-15T12:00:00.000Z",
};

it("shows a co-interviewer only their completed interviews", async () => {
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
      const before = yield* readSchedulingBoard(context);
      yield* sql`INSERT INTO recruitment_interview_conducts (interview_id, answers, explanatory_power, role_model, suitability, recommendation, finalized_by_person_id, finalized_at, interview_revision) VALUES ('interview-1', '[]'::jsonb, 5, 6, 7, 'Ja', 'primary-1', '2031-09-14', 3)`;
      const after = yield* readSchedulingBoard(context);
      yield* sql`UPDATE recruitment_interviews SET co_interviewer_person_id = 'other-1' WHERE interview_id = 'interview-1'`;
      const noLongerDesignated = yield* readSchedulingBoard(context);

      return { before, after, noLongerDesignated };
    }),
  );

  expect(observed.before.interviews).toEqual([]);
  expect(observed.after.interviews.map(({ interviewId }) => interviewId)).toEqual(["interview-1"]);
  expect(observed.after.interviews[0]?.coInterviewer).toEqual({
    personId: "co-1",
    displayName: "Kari Kollega",
  });
  expect(observed.noLongerDesignated.interviews).toEqual([]);
}, 15_000);
