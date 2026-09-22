import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import {
  SchoolSurveyCommandId,
  SurveyId,
  SurveyQuestionId,
  SurveyResponseId,
} from "@vektorprogrammet/domain/surveys";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { readSchoolSurveyFormPostgres } from "./postgres.js";
import {
  closeSchoolSurveyAdminSurveyPostgres,
  createSchoolSurveyAdminSurveyPostgres,
  listSchoolSurveyAdminSurveysPostgres,
  persistSchoolSurveyResponsePostgres,
  prepareSchoolSurveyResponsePostgres,
  readSchoolSurveyAdminCatalogPostgres,
  readSchoolSurveyAdminResultsPostgres,
} from "./postgres.js";

const runtime = makeControlledTestRuntime(DatabaseTest());

const departmentId = DepartmentId.make("school-survey-postgres-department");
const semesterId = SemesterId.make(`school-survey-postgres-semester-${"s".repeat(101)}`);
const managerPersonId = PersonId.make("school-survey-postgres-manager");
const volunteerPersonId = PersonId.make("school-survey-postgres-volunteer");
const surveyId = SurveyId.make("survey_123e4567-e89b-12d3-a456-426614174000");
const createdAt = "2035-09-22T10:00:00.000Z";

const questionId = (position: number) => SurveyQuestionId.make(`${surveyId}_q_${position}`);

const createCommand = {
  commandId: SchoolSurveyCommandId.make("school-survey-postgres-create"),
  surveyId,
  actorPersonId: managerPersonId,
  occurredAt: createdAt,
  request: {
    departmentId,
    semesterId,
    title: "School feedback",
    completionText: "Thank you for your feedback.",
    resultsVisibility: "DepartmentManagers" as const,
    questions: [
      { kind: "Text" as const, label: "Text", help: null, required: true },
      {
        kind: "List" as const,
        label: "List",
        help: "Select one",
        required: true,
        alternatives: ["One", "Two"],
      },
      {
        kind: "Radio" as const,
        label: "Radio",
        help: null,
        required: true,
        alternatives: ["Yes", "No"],
      },
      {
        kind: "Check" as const,
        label: "Check",
        help: null,
        required: false,
        alternatives: ["First", "Second"],
      },
    ],
  },
};

const responseRequest = (schoolId: number, text: string) => ({
  schoolId,
  answers: [
    { kind: "Text" as const, questionId: questionId(0), value: text },
    { kind: "List" as const, questionId: questionId(1), value: "Two" },
    { kind: "Radio" as const, questionId: questionId(2), value: "Yes" },
    {
      kind: "Check" as const,
      questionId: questionId(3),
      values: ["Second", "First"],
    },
  ],
});

afterAll(async () => {
  await runtime.dispose();
});

describe("School-survey PostgreSQL administration", () => {
  it("creates an auditable definition, orders results, and conceals a closed public form", async () => {
    const evidence = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO public.organization_departments (
                department_id, name, short_name, email, city, active
              ) VALUES (
                ${departmentId}, 'Survey department', 'SD', 'survey@example.invalid', 'Oslo', TRUE
              )
            `;
            yield* sql`
              INSERT INTO public.admission_period_departments (department_id, name)
              VALUES (${departmentId}, 'Survey department')
            `;
            yield* sql`
              INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
              VALUES (${semesterId}, '2035-08-01T00:00:00.000Z', '2035-12-31T23:59:59.000Z')
            `;
            yield* sql`
              INSERT INTO public.admission_periods (
                admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id
              ) VALUES (
                'school-survey-postgres-period', ${departmentId}, ${semesterId},
                '2035-08-01T00:00:00.000Z', '2035-12-31T23:59:59.000Z', 0, 'school-survey-postgres-seed'
              )
            `;
            yield* sql`
              INSERT INTO public.person_profiles (person_id, first_name, last_name)
              VALUES
                (${managerPersonId}, 'Survey', 'Manager'),
                (${volunteerPersonId}, 'Survey', 'Volunteer')
            `;
            yield* sql`
              INSERT INTO public.organization_volunteer_affiliations (
                person_id, department_id, status, revision
              ) VALUES (${volunteerPersonId}, ${departmentId}, 'Active', 1)
            `;
            const schoolRows = yield* sql<{ readonly schoolId: number }>`
              INSERT INTO public.schools_directory_schools (
                school_id, name, contact_person, email, phone, language, active
              ) OVERRIDING SYSTEM VALUE
              VALUES (
                2147483648,
                'Survey school',
                'Contact',
                'school@example.invalid',
                '12345678',
                'Norwegian',
                TRUE
              )
              RETURNING school_id::double precision AS "schoolId"
            `;
            const schoolId = schoolRows[0]?.schoolId;
            if (schoolId === undefined)
              return yield* Effect.die("school seed did not return an ID");
            yield* sql`
              INSERT INTO public.schools_directory_departments (school_id, department_id)
              VALUES (${schoolId}, ${departmentId})
            `;
            yield* sql`
              INSERT INTO public.assistant_placements (
                placement_id, person_id, department_id, semester_id, school_id, day, workdays, block, active, revision
              ) VALUES (
                ${`placement-${"a".repeat(64)}`}, ${volunteerPersonId}, ${departmentId}, ${semesterId},
                ${schoolId}, 'Monday', 1, '1', TRUE, 1
              )
            `;
            const authority = {
              personId: managerPersonId,
              evaluatedAt: createdAt,
              globalAdministrator: "Active" as const,
              memberships: [],
            };
            const catalog = yield* readSchoolSurveyAdminCatalogPostgres(authority).pipe(
              Effect.provideService(Database, sql),
            );
            const created = yield* createSchoolSurveyAdminSurveyPostgres(createCommand).pipe(
              Effect.provideService(Database, sql),
            );
            const replayed = yield* createSchoolSurveyAdminSurveyPostgres(createCommand).pipe(
              Effect.provideService(Database, sql),
            );
            const listed = yield* listSchoolSurveyAdminSurveysPostgres({
              departmentId,
              semesterId,
            }).pipe(Effect.provideService(Database, sql));
            const firstPrepared = yield* prepareSchoolSurveyResponsePostgres({
              surveyId,
              request: responseRequest(schoolId, "first response"),
            }).pipe(Effect.provideService(Database, sql));
            const secondPrepared = yield* prepareSchoolSurveyResponsePostgres({
              surveyId,
              request: responseRequest(schoolId, "second response"),
            }).pipe(Effect.provideService(Database, sql));
            yield* persistSchoolSurveyResponsePostgres({
              responseId: SurveyResponseId.make("survey_response_a"),
              prepared: firstPrepared,
            }).pipe(Effect.provideService(Database, sql));
            yield* persistSchoolSurveyResponsePostgres({
              responseId: SurveyResponseId.make("survey_response_b"),
              prepared: secondPrepared,
            }).pipe(Effect.provideService(Database, sql));
            const stale = yield* Effect.flip(
              closeSchoolSurveyAdminSurveyPostgres({
                commandId: SchoolSurveyCommandId.make("school-survey-postgres-stale-close"),
                surveyId,
                actorPersonId: managerPersonId,
                occurredAt: "2035-09-22T10:05:00.000Z",
                request: { expectedRevision: 7 },
              }).pipe(Effect.provideService(Database, sql)),
            );
            const closed = yield* closeSchoolSurveyAdminSurveyPostgres({
              commandId: SchoolSurveyCommandId.make("school-survey-postgres-close"),
              surveyId,
              actorPersonId: managerPersonId,
              occurredAt: "2035-09-22T10:10:00.000Z",
              request: { expectedRevision: 0 },
            }).pipe(Effect.provideService(Database, sql));
            const repeated = yield* Effect.flip(
              closeSchoolSurveyAdminSurveyPostgres({
                commandId: SchoolSurveyCommandId.make("school-survey-postgres-repeated-close"),
                surveyId,
                actorPersonId: managerPersonId,
                occurredAt: "2035-09-22T10:11:00.000Z",
                request: { expectedRevision: 1 },
              }).pipe(Effect.provideService(Database, sql)),
            );
            const closedForm = yield* Effect.flip(
              readSchoolSurveyFormPostgres(surveyId).pipe(Effect.provideService(Database, sql)),
            );
            const closedPrepare = yield* Effect.flip(
              prepareSchoolSurveyResponsePostgres({
                surveyId,
                request: responseRequest(schoolId, "after closure"),
              }).pipe(Effect.provideService(Database, sql)),
            );
            const closedWrite = yield* Effect.flip(
              persistSchoolSurveyResponsePostgres({
                responseId: SurveyResponseId.make("survey_response_after_close"),
                prepared: firstPrepared,
              }).pipe(Effect.provideService(Database, sql)),
            );
            const results = yield* readSchoolSurveyAdminResultsPostgres(surveyId).pipe(
              Effect.provideService(Database, sql),
            );
            const auditRows = yield* sql<{
              readonly action: string;
              readonly surveyRevision: number;
            }>`
              SELECT action, survey_revision AS "surveyRevision"
              FROM public.school_survey_audit
              WHERE survey_id = ${surveyId}
              ORDER BY audit_id ASC
            `;
            const responseCountRows = yield* sql<{ readonly count: number }>`
              SELECT count(*)::integer AS count
              FROM public.school_survey_responses
              WHERE survey_id = ${surveyId}
            `;
            return {
              catalog,
              created,
              replayed,
              listed,
              stale,
              closed,
              repeated,
              closedForm,
              closedPrepare,
              closedWrite,
              results,
              auditRows,
              responseCount: responseCountRows[0]?.count,
            };
          }).pipe(Effect.provideService(Database, sql)),
        ),
      ),
    );

    expect(evidence.catalog.departments).toEqual([{ departmentId, name: "Survey department" }]);
    expect(evidence.catalog.semesters.map((semester) => semester.semesterId)).toEqual([semesterId]);
    expect(evidence.created).toMatchObject({
      surveyId,
      semesterLabel: "2035-08-01 – 2035-12-31",
      state: "Open",
      revision: 0,
      responseCount: 0,
      createdByPersonId: managerPersonId,
      questions: [
        { questionId: questionId(0), kind: "Text" },
        { questionId: questionId(1), kind: "List", alternatives: ["One", "Two"] },
        { questionId: questionId(2), kind: "Radio", alternatives: ["Yes", "No"] },
        { questionId: questionId(3), kind: "Check", alternatives: ["First", "Second"] },
      ],
    });
    expect(evidence.replayed).toEqual(evidence.created);
    expect(evidence.listed.surveys).toHaveLength(1);
    expect(evidence.stale).toMatchObject({ _tag: "SchoolSurveyStaleRevision", actualRevision: 0 });
    expect(evidence.closed).toMatchObject({
      state: "Closed",
      revision: 1,
      closedByPersonId: managerPersonId,
    });
    expect(evidence.repeated).toMatchObject({ _tag: "SchoolSurveyInvalidState", state: "Closed" });
    expect(evidence.closedForm).toMatchObject({ _tag: "SchoolSurveyNotFound" });
    expect(evidence.closedPrepare).toMatchObject({ _tag: "SchoolSurveyNotFound" });
    expect(evidence.closedWrite).toMatchObject({ _tag: "SchoolSurveyNotFound" });
    expect(evidence.responseCount).toBe(2);
    expect(evidence.auditRows).toEqual([
      { action: "Created", surveyRevision: 0 },
      { action: "Closed", surveyRevision: 1 },
    ]);
    expect(evidence.results.responseCount).toBe(2);
    expect(evidence.results.responses[0]?.school.schoolId).toBe(2147483648);
    expect(evidence.results.responses.map((response) => response.answers[0])).toEqual([
      { kind: "Text", questionId: questionId(0), value: "first response" },
      { kind: "Text", questionId: questionId(0), value: "second response" },
    ]);
    expect(evidence.results.responses[0]?.answers[3]).toEqual({
      kind: "Check",
      questionId: questionId(3),
      values: ["First", "Second"],
    });
  }, 15_000);
});
