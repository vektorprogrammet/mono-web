import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { AdmissionPeriodActorSchema } from "@vektorprogrammet/domain/admission-period";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  InterviewSchemaId,
  Recruitment,
  RecruitmentAssignmentCommandId,
  RecruitmentConductCommandId,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationId,
  RecruitmentInvitationTransition,
  RecruitmentScheduleCommandId,
} from "@vektorprogrammet/domain/recruitment";
import { CorrectInterviewAssessmentResponse } from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, ManagedRuntime, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
import { makeRecruitmentTestHttp } from "../test/native-http.js";

const departmentId = DepartmentId.make("commands-department");

const leaderPersonId = PersonId.make("commands-leader");

const interviewerPersonId = PersonId.make("commands-interviewer");

const applicationId = PublicApplicationIdSchema.make("commands-application");

const interviewId = RecruitmentInterviewId.make("commands-interview");

const capability = RecruitmentInvitationCapabilitySchema.make("commands".padEnd(43, "_"));

const questionIds = Array.from({ length: 8 }, (_, ordinal) => `commands-q${ordinal}`);

const domain = RecruitmentLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(Layer.provideMerge(OrganizationLive)),
  ),
);

/** A finalized interview at revision 2, conducted by the assigned interviewer. */
const finalizedInterview = Effect.gen(function* () {
  const sql = yield* Database;
  const recruitment = yield* Recruitment;

  const leader = AdmissionPeriodActorSchema.cases.DepartmentLeader.make({
    personId: leaderPersonId,
    departmentId,
    active: true,
  });

  yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES (${departmentId}, 'Commands')`;
  yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('commands-semester', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z')`;
  yield* sql`
    INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id)
    VALUES ('commands-period', ${departmentId}, 'commands-semester', '2031-09-01T00:00:00.000Z', '2031-10-01T00:00:00.000Z', 'commands-period-created')
  `;
  yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name) VALUES ('commands-field', ${departmentId}, 'Computer Science')`;
  yield* sql`
    INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study)
    VALUES ('commands-applicant', 'commands@example.invalid', 'commands@example.invalid', 'Ada', 'Applicant', '90000000', 1, 'commands-field', 2)
  `;
  yield* sql`
    INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at)
    VALUES (${applicationId}, 'commands-applicant', 'commands-period', ${departmentId}, 'commands-field', 2, '2031-09-10T12:00:00.000Z')
  `;
  yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city) VALUES (${departmentId}, 'Commands', 'CMD', 'commands-department@example.invalid', 'Bergen')`;
  yield* sql`INSERT INTO organization_teams (team_id, department_id, name) VALUES ('commands-team', ${departmentId}, 'Commands team')`;
  yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${leaderPersonId}, 'Lise', 'Leader'), (${interviewerPersonId}, 'Ivar', 'Interviewer')`;
  yield* sql`
    INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, position_id, is_team_leader)
    VALUES
      ('commands-leader-membership', ${leaderPersonId}, 'commands-team', '2031-01-01T00:00:00.000Z', 'leader', TRUE),
      ('commands-interviewer-membership', ${interviewerPersonId}, 'commands-team', '2031-01-01T00:00:00.000Z', 'assistant', FALSE)
  `;
  yield* sql`INSERT INTO person_contact_profiles (person_id, email, phone) VALUES (${interviewerPersonId}, 'commands-interviewer@example.invalid', '91111111')`;
  yield* sql`INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count) VALUES ('commands-schema', 'Standard interview', 8)`;

  for (const [ordinal, questionId] of questionIds.entries()) {
    yield* sql`
      INSERT INTO public.recruitment_interview_schema_questions (interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives)
      VALUES ('commands-schema', ${questionId}, ${ordinal}, ${`Question ${ordinal}`}, NULL, 'text', '[]'::jsonb)
    `;
  }

  yield* recruitment.assignApplicant(
    {
      commandId: RecruitmentAssignmentCommandId.make("commands-assignment"),
      applicationId,
      interviewerPersonId,
      interviewSchemaId: InterviewSchemaId.make("commands-schema"),
    },
    { actor: leader, now: "2031-09-15T12:00:00.000Z", interviewId },
  );
  yield* recruitment.scheduleInterview(
    {
      commandId: RecruitmentScheduleCommandId.make("commands-schedule"),
      interviewId,
      expectedRevision: 0,
      scheduledAt: "2031-09-20T10:00:00.000Z",
      room: "A-101",
      campus: "Main Campus",
      mapLink: "https://maps.example.invalid/interview-room",
      message: "Welcome to your interview.",
    },
    {
      actor: leader,
      now: "2031-09-15T12:00:00.000Z",
      invitationId: RecruitmentInvitationId.make("commands-invitation"),
      responseCapability: capability,
    },
  );
  yield* recruitment.transitionInvitation({
    capability,
    transition: RecruitmentInvitationTransition.Confirm(),
    now: "2031-09-15T12:01:00.000Z",
  });
  yield* recruitment.finalizeInterview(
    {
      commandId: RecruitmentConductCommandId.make("commands-finalize"),
      interviewId,
      expectedRevision: 1,
      answers: questionIds.map((questionId) => ({ questionId, answer: `Original ${questionId}` })),
      score: { explanatoryPower: 4, roleModel: 5, suitability: 6 },
      recommendation: "Ja",
    },
    {
      actor: AdmissionPeriodActorSchema.cases.Member.make({
        personId: interviewerPersonId,
        departmentId,
        active: true,
      }),
      now: "2031-09-15T12:02:00.000Z",
    },
  );
}).pipe(Effect.provide(domain));

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(person),
            sessionId: `session-${person}`,
            expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
          }),
        );
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const persistedCorrection = Database.use(
  (sql) => sql<{
    readonly corrections: number;
    readonly correctionReceipts: number;
    readonly audits: number;
    readonly httpReceipts: number;
    readonly revision: number;
  }>`
    SELECT
      (SELECT count(*)::integer FROM public.recruitment_interview_correction_assessments) AS corrections,
      (SELECT count(*)::integer FROM public.recruitment_interview_correction_command_receipts) AS "correctionReceipts",
      (SELECT count(*)::integer FROM public.recruitment_interview_correction_audit) AS audits,
      (SELECT count(*)::integer FROM public.native_http_idempotency_receipts) AS "httpReceipts",
      (SELECT revision FROM public.recruitment_interviews WHERE interview_id = ${interviewId}) AS revision
  `,
).pipe(Effect.map((rows) => rows[0]));

const fixture = () => {
  const database = backendDatabase(finalizedInterview);

  const http = makeRecruitmentTestHttp(
    {
      config: {
        maxBodyBytes: 65_536,
        now: () => "2031-09-15T12:05:00.000Z",
        nextInterviewId: () => RecruitmentInterviewId.make("commands-unexpected-interview"),
        nextInvitationId: () => RecruitmentInvitationId.make("commands-unexpected-invitation"),
        nextResponseCapability: () => "unexpected".padEnd(43, "_"),
      },
      resolveActor: () => Effect.die("unexpected recruitment board actor"),
    },
    Layer.mergeAll(
      database.layer,
      domain.pipe(Layer.provide(database.layer)),
      Layer.succeed(IdentitySnapshot, identitySnapshot),
    ),
  );

  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `better-auth.session_token=${interviewerPersonId}`);

    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", "http://127.0.0.1:5174");
    }

    return http.fetch(new Request(`http://backend.test${pathname}`, { ...init, headers }));
  };

  /** A second session on the fixture database, outside the handler's single connection. */
  const competitor = async () => {
    const [target] = await database.run(
      Database.use(
        (sql) =>
          sql<{
            readonly host: string;
            readonly database: string;
            readonly username: string;
          }>`SELECT current_setting('unix_socket_directories') AS host, current_database() AS database, current_user AS username`,
      ),
    );

    if (target === undefined) throw new Error("Missing PostgreSQL connection configuration");

    return ManagedRuntime.make(
      DatabaseRuntimeLive({ ...target, maxConnections: 1 }).pipe(Layer.orDie),
    );
  };

  return { database, request, competitor };
};

describe("recruitment commands over HTTP and PostgreSQL", () => {
  it("retries an assessment correction once after a PostgreSQL serialization failure", async () => {
    const { database, request, competitor } = fixture();
    const conduct = await request(`/api/recruitment/interviews/${interviewId}`);
    const etag = conduct.headers.get("etag");

    expect(conduct.status).toBe(200);

    if (etag === null) throw new Error("The conduct read returned no entity tag");
    await expect(database.run(persistedCorrection)).resolves.toEqual({
      corrections: 0,
      correctionReceipts: 0,
      audits: 0,
      httpReceipts: 0,
      revision: 2,
    });

    const runtime = await competitor();

    try {
      const rowHeld = Promise.withResolvers<void>();

      // The concurrent transaction commits only after the command waits on its
      // row lock, so the command's SERIALIZABLE snapshot is already older than
      // the committed update and its first attempt fails with SQLSTATE 40001.
      const concurrentUpdate = runtime.runPromise(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE public.recruitment_interviews SET revision = revision WHERE interview_id = ${interviewId}`;
              yield* Effect.sync(() => rowHeld.resolve());

              return yield* sql<{ readonly waiting: number }>`
                SELECT count(*)::integer AS waiting
                FROM pg_locks
                WHERE locktype = 'transactionid' AND NOT granted
              `.pipe(
                Effect.map((rows) => rows[0]?.waiting ?? 0),
                Effect.repeat({
                  until: (waiting) => waiting > 0,
                  times: 400,
                  schedule: Schedule.spaced("10 millis"),
                }),
              );
            }),
          ),
        ),
      );

      await rowHeld.promise;

      const correction = await request(`/api/recruitment/interviews/${interviewId}:correct`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "commands-correction".padEnd(22, "0"),
          "if-match": etag,
        },
        body: JSON.stringify({
          expectedRevision: 2,
          answers: questionIds.map((questionId) => ({
            questionId,
            answer: `Corrected ${questionId}`,
          })),
          score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
          recommendation: "Kanskje",
        }),
      });

      await expect(concurrentUpdate).resolves.toBe(1);
      expect(correction.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(CorrectInterviewAssessmentResponse)(await correction.json(), {
          onExcessProperty: "error",
        }),
      ).toMatchObject({
        interviewId,
        predecessorRevision: 2,
        resultingRevision: 3,
        replayed: false,
      });
    } finally {
      await runtime.dispose();
    }

    await expect(database.run(persistedCorrection)).resolves.toEqual({
      corrections: 1,
      correctionReceipts: 1,
      audits: 1,
      httpReceipts: 1,
      revision: 3,
    });
  });
});
