import { afterAll, describe, expect, it } from "vitest";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { readApplicantProgress } from "./application/postgres.js";
import { Database } from "./service.js";
import { Effect } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const runtime = makeControlledTestRuntime(DatabaseTest());
afterAll(() => runtime.dispose());

const now = "2038-09-01T12:00:00.000Z";
const personId = PersonId.make("applicant-progress-person");

const readProgress = () => runtime.runPromise(readApplicantProgress(personId, now));

describe("applicant progress projection", () => {
  it("uses explicit account custody, current-semester facts and completed-conduct precedence", async () => {
    await runtime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO organization_departments (
              department_id, name, short_name, email, city
            ) VALUES (
              'applicant-progress-department', 'Applicant progress', 'AP',
              'applicant-progress@example.invalid', 'Trondheim'
            )
          `;
          yield* sql`
            INSERT INTO admission_period_departments (department_id, name)
            VALUES ('applicant-progress-department', 'Applicant progress')
          `;
          yield* sql`
            INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
            VALUES
              ('applicant-progress-current', '2038-08-01T00:00:00.000Z', '2039-01-01T00:00:00.000Z'),
              ('applicant-progress-historical', '2037-08-01T00:00:00.000Z', '2038-01-01T00:00:00.000Z'),
              ('applicant-progress-future', '2039-08-01T00:00:00.000Z', '2040-01-01T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO admission_periods (
              admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id
            ) VALUES
              (
                'applicant-progress-period', 'applicant-progress-department',
                'applicant-progress-current', '2038-08-01T00:00:00.000Z',
                '2038-09-15T00:00:00.000Z', 0, 'applicant-progress-period-current'
              ),
              (
                'applicant-progress-old-period', 'applicant-progress-department',
                'applicant-progress-historical', '2037-08-01T00:00:00.000Z',
                '2037-09-15T00:00:00.000Z', 0, 'applicant-progress-period-old'
              ),
              (
                'applicant-progress-future-period', 'applicant-progress-department',
                'applicant-progress-future', '2039-08-01T00:00:00.000Z',
                '2039-09-15T00:00:00.000Z', 0, 'applicant-progress-period-future'
              )
          `;
          yield* sql`
            INSERT INTO admission_period_fields_of_study (
              field_of_study_id, department_id, name, active
            ) VALUES ('applicant-progress-study', 'applicant-progress-department', 'Matematikk', true)
          `;
          yield* sql`
            INSERT INTO person_profiles (person_id, first_name, last_name)
            VALUES
              (${personId}, 'Ada', 'Applicant'),
              ('applicant-progress-interviewer', 'Ivar', 'Intervjuer')
          `;
          yield* sql`
            INSERT INTO admission_applicants (
              applicant_id, normalized_email, email, first_name, last_name, phone,
              gender, field_of_study_id, year_of_study
            ) VALUES
              (
                'applicant-progress-applicant', 'ada.progress@example.invalid',
                'ada.progress@example.invalid', 'Ada', 'Applicant', '90000000', 0,
                'applicant-progress-study', 2
              ),
              (
                'applicant-progress-other', 'other.progress@example.invalid',
                'other.progress@example.invalid', 'Other', 'Applicant', '90000001', 1,
                'applicant-progress-study', 1
              )
          `;
          yield* sql`
            INSERT INTO admission_applications (
              application_id, applicant_id, admission_period_id, department_id,
              field_of_study_id, year_of_study, submitted_at
            ) VALUES
              (
                'applicant-progress-current-application', 'applicant-progress-applicant',
                'applicant-progress-period', 'applicant-progress-department',
                'applicant-progress-study', 2, '2038-08-20T10:00:00.000Z'
              ),
              (
                'applicant-progress-historical-application', 'applicant-progress-applicant',
                'applicant-progress-old-period', 'applicant-progress-department',
                'applicant-progress-study', 2, '2037-08-20T10:00:00.000Z'
              ),
              (
                'applicant-progress-future-application', 'applicant-progress-applicant',
                'applicant-progress-future-period', 'applicant-progress-department',
                'applicant-progress-study', 2, '2039-08-20T10:00:00.000Z'
              ),
              (
                'applicant-progress-other-application', 'applicant-progress-other',
                'applicant-progress-period', 'applicant-progress-department',
                'applicant-progress-study', 1, '2038-08-21T10:00:00.000Z'
              )
          `;
          yield* sql`
            INSERT INTO applicant_account_invitations (
              invitation_id, application_id, applicant_id, token_digest, expires_at,
              state, issued_by, issued_at
            ) VALUES (
              'applicant-progress-account-invitation',
              'applicant-progress-current-application',
              'applicant-progress-applicant', ${"a".repeat(64)},
              '2039-01-01T00:00:00.000Z', 'Claimed',
              'applicant-progress-interviewer', '2038-08-21T00:00:00.000Z'
            )
          `;
          yield* sql`
            INSERT INTO applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
            VALUES (
              'applicant-progress-applicant', ${personId},
              '2038-08-21T00:00:00.000Z', 'applicant-progress-account-invitation'
            )
          `;
        }),
      ),
    );

    const received = await readProgress();
    expect(received.applications).toHaveLength(1);
    expect(received.applications[0]).toMatchObject({
      applicationId: "applicant-progress-current-application",
      departmentName: "Applicant progress",
      progress: { _tag: "ApplicationReceived" },
    });

    await runtime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO recruitment_interview_schemas (
              interview_schema_id, name, question_count, active, revision
            ) VALUES ('applicant-progress-schema', 'Progress', 0, true, 0)
          `;
          yield* sql`
            INSERT INTO recruitment_interviews (
              interview_id, application_id, department_id, interviewer_person_id,
              interview_schema_id, assigned_by_person_id, assigned_at, revision
            ) VALUES (
              'applicant-progress-interview', 'applicant-progress-current-application',
              'applicant-progress-department', 'applicant-progress-interviewer',
              'applicant-progress-schema', 'applicant-progress-interviewer',
              '2038-08-22T00:00:00.000Z', 1
            )
          `;
          yield* sql`
            INSERT INTO recruitment_interview_schedules (
              interview_id, scheduled_at, room, campus, map_link, message,
              scheduled_by_person_id, committed_at, schedule_revision
            ) VALUES (
              'applicant-progress-interview', '2038-09-03T10:00:00.000Z',
              'A-101', 'Gløshaugen', 'https://example.invalid/map', 'Velkommen',
              'applicant-progress-interviewer', '2038-08-22T00:00:00.000Z', 1
            )
          `;
          yield* sql`
            INSERT INTO recruitment_invitations (
              invitation_id, interview_id, schedule_revision, capability_sha256,
              response_state, created_at
            ) VALUES (
              'applicant-progress-interview-invitation', 'applicant-progress-interview', 1,
              ${"b".repeat(64)}, 'Pending', '2038-08-22T00:00:00.000Z'
            )
          `;
        }),
      ),
    );

    const invited = await readProgress();
    expect(invited.applications[0]?.progress).toEqual({
      _tag: "InvitedToInterview",
      schedule: {
        scheduledAt: "2038-09-03T10:00:00.000Z",
        room: "A-101",
        campus: "Gløshaugen",
        mapLink: "https://example.invalid/map",
      },
    });

    await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE recruitment_invitations
              SET response_state = 'Accepted', responded_at = '2038-08-23T00:00:00.000Z',
                  response_revision = 1
              WHERE invitation_id = 'applicant-progress-interview-invitation'
            `;
            yield* sql`
              INSERT INTO recruitment_invitation_response_audit (
                invitation_id, interview_id, schedule_revision, response_revision,
                response_state, response_message, responded_at
              ) VALUES (
                'applicant-progress-interview-invitation', 'applicant-progress-interview',
                1, 1, 'Accepted', NULL, '2038-08-23T00:00:00.000Z'
              )
            `;
            yield* sql`
              INSERT INTO recruitment_interview_conducts (
                interview_id, answers, explanatory_power, role_model, suitability,
                finalized_by_person_id, finalized_at, interview_revision, recommendation
              ) VALUES (
                'applicant-progress-interview', '[]'::jsonb, 7, 8, 9,
                'applicant-progress-interviewer', '2038-09-03T11:00:00.000Z', 2, 'Ja'
              )
            `;
          }),
        ),
      ),
    );

    const completed = await readProgress();
    expect(completed.applications[0]?.progress).toEqual({ _tag: "InterviewCompleted" });

    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`
          INSERT INTO organization_volunteer_affiliations (
            person_id, department_id, status, revision
          ) VALUES (
            ${personId}, 'applicant-progress-department', 'Pending', 1
          )
        `,
      ),
    );
    expect((await readProgress()).applications[0]?.progress).toEqual({
      _tag: "AffiliationPending",
    });

    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`
          UPDATE organization_volunteer_affiliations
          SET status = 'Active', revision = 2
          WHERE person_id = ${personId}
            AND department_id = 'applicant-progress-department'
        `,
      ),
    );
    expect((await readProgress()).applications[0]?.progress).toEqual({
      _tag: "AffiliationActive",
    });

    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`
          UPDATE organization_volunteer_affiliations
          SET status = 'Inactive', revision = 3
          WHERE person_id = ${personId}
            AND department_id = 'applicant-progress-department'
        `,
      ),
    );
    expect((await readProgress()).applications[0]?.progress).toEqual({
      _tag: "InterviewCompleted",
    });

    await runtime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE organization_volunteer_affiliations
            SET status = 'Active', revision = 4
            WHERE person_id = ${personId}
              AND department_id = 'applicant-progress-department'
          `;
          const schools = yield* sql<{ readonly schoolId: number }>`
            INSERT INTO schools_directory_schools (
              name, contact_person, email, phone, language, active
            ) VALUES (
              'Applicant progress school', 'School Contact',
              'applicant-progress-school@example.invalid', '90000002',
              'Norwegian', true
            )
            RETURNING school_id::double precision AS "schoolId"
          `;
          const schoolId = schools[0]!.schoolId;
          yield* sql`
            INSERT INTO schools_directory_departments (school_id, department_id)
            VALUES (${schoolId}, 'applicant-progress-department')
          `;
          yield* sql`
            INSERT INTO assistant_placements (
              placement_id, person_id, department_id, semester_id, school_id,
              day, workdays, block, active, revision
            ) VALUES (
              ${`placement-${"a".repeat(64)}`}, ${personId},
              'applicant-progress-department', 'applicant-progress-current',
              ${schoolId}, 'Monday', 4, '1', true, 1
            )
          `;
        }),
      ),
    );
    expect((await readProgress()).applications[0]?.progress).toEqual({
      _tag: "AssignedToSchool",
    });
    expect(JSON.stringify(completed)).not.toMatch(
      /email|phone|recommendation|answers|capability|interviewer/iu,
    );
  });
});
