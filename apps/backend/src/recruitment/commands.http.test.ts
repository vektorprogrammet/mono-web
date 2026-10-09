import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { NativeDatabaseStartupOptions } from "@vektorprogrammet/database/search-path";
import { commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { Placements } from "@vektorprogrammet/domain/placements";
import { AdmissionPeriodActorSchema } from "@vektorprogrammet/domain/admission-period";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { Admissions, AdmissionOutcomeEntry } from "@vektorprogrammet/domain/admissions";
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  InterviewSchemaId,
  CorrectInterviewAssessmentCommandSchema,
  Recruitment,
  RecruitmentAssignmentCommandId,
  RecruitmentConductCommandId,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationId,
  RecruitmentInvitationTransition,
  RecruitmentMaintenanceResult,
  InterviewStaffingManagement,
  RecruitmentScheduleCommandId,
} from "@vektorprogrammet/domain/recruitment";
import {
  ConductObservation,
  CorrectInterviewAssessmentRequest,
  CorrectInterviewAssessmentResponse,
  NativeProblem,
} from "@vektorprogrammet/http-api";
import {
  NativeProblemRegistry,
  type NativeProblemCode,
} from "@vektorprogrammet/http-api/http-semantics";
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { describe, expect, it } from "@effect/vitest";
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
const seedInterview = Effect.fnUntraced(function* (complete: boolean) {
  const sql = yield* Database;
  const recruitment = yield* Recruitment;

  const leader = AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
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
  // Native board-leader reach requires a recognized independent home department.
  yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city, independent) VALUES (${departmentId}, 'Commands', 'CMD', 'commands-department@example.invalid', 'Bergen', true)`;
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

  if (!complete) return;
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
}, Effect.provide(domain));

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(person),
            sessionId: `session-${person}`,
            expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
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

const correctionBody = JSON.stringify({
  expectedRevision: 2,
  answers: questionIds.map((questionId) => ({ questionId, answer: `Corrected ${questionId}` })),
  score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
  recommendation: "Kanskje",
});

const fixture = <E = never>(
  setup: Effect.Effect<void, E, Database> = Effect.void,
  complete = true,
) => {
  const database = backendDatabase(seedInterview(complete).pipe(Effect.andThen(setup)));
  let now = "2031-09-15T12:05:00.000Z";

  const clock = Layer.effect(
    Clock.Clock,
    Clock.clockWith((live) =>
      Effect.succeed({
        currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
        currentTimeNanos: live.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
        currentTimeMillisUnsafe: () => DateTime.toEpochMillis(DateTime.makeUnsafe(now)),
        currentTimeMillis: Effect.sync(() => DateTime.toEpochMillis(DateTime.makeUnsafe(now))),
      }),
    ),
  );

  const http = makeRecruitmentTestHttp(
    {
      config: {
        maxBodyBytes: 65_536,
        now: () => now,
        nextInterviewId: Effect.succeed(
          RecruitmentInterviewId.make("commands-unexpected-interview"),
        ),
        nextInvitationId: Effect.succeed(
          RecruitmentInvitationId.make("commands-unexpected-invitation"),
        ),
        nextResponseCapability: Effect.succeed("unexpected".padEnd(43, "_")),
      },
      resolveActor: () => Effect.die("unexpected recruitment board actor"),
    },
    Layer.mergeAll(
      database.layer,
      domain.pipe(Layer.provide(database.layer)),
      Layer.succeed(IdentitySnapshot, identitySnapshot),
      clock,
    ),
  );

  const request = (pathname: string, init: RequestInit = {}, personId = interviewerPersonId) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `better-auth.session_token=${personId}`);

    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", "http://127.0.0.1:5174");
    }

    return http.fetch(new Request(`http://backend.test${pathname}`, { ...init, headers }));
  };

  /** A second session on the fixture database, outside the handler's single connection. */
  const competitor = Effect.fnUntraced(function* (maxConnections = 1) {
    const [target] = yield* database.run(
      Database.use(
        (sql) =>
          sql<{
            readonly host: string;
            readonly port: number;
            readonly database: string;
            readonly username: string;
          }>`SELECT current_setting('unix_socket_directories') AS host, current_setting('port')::integer AS port, current_database() AS database, current_user AS username`,
      ),
    );

    if (target === undefined) throw new Error("Missing PostgreSQL connection configuration");

    return DatabaseRuntimeLive({
      ...target,
      maxConnections,
      startupOptions: NativeDatabaseStartupOptions,
    }).pipe(Layer.orDie);
  });

  return {
    database,
    request,
    competitor,
    clock,
    setNow: (instant: string) => {
      now = instant;
    },
  };
};

describe("recruitment commands over HTTP and PostgreSQL", () => {
  it.live("retries an assessment correction once after a PostgreSQL serialization failure", () =>
    Effect.gen(function* () {
      const { database, request, competitor } = fixture();
      const conduct = yield* request(`/api/recruitment/interviews/${interviewId}`);
      const etag = conduct.headers.get("etag");

      expect(conduct.status).toBe(200);

      if (etag === null) throw new Error("The conduct read returned no entity tag");
      expect(yield* database.run(persistedCorrection)).toEqual({
        corrections: 0,
        correctionReceipts: 0,
        audits: 0,
        httpReceipts: 0,
        revision: 2,
      });

      const competing = yield* competitor();
      const rowHeld = yield* Deferred.make<void>();

      // The concurrent transaction commits only after the command waits on its
      // row lock, so the command's SERIALIZABLE snapshot is already older than
      // the committed update and its first attempt fails with SQLSTATE 40001.
      const concurrentUpdate = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE public.recruitment_interviews SET revision = revision WHERE interview_id = ${interviewId}`;
            yield* Deferred.succeed(rowHeld, undefined);

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
      ).pipe(Effect.provide(competing, { local: true }), Effect.forkChild);

      yield* Deferred.await(rowHeld);

      const correction = yield* request(`/api/recruitment/interviews/${interviewId}:correct`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "commands-correction".padEnd(22, "0"),
          "if-match": etag,
        },
        body: correctionBody,
      });

      expect(yield* Fiber.join(concurrentUpdate)).toBe(1);
      expect(correction.status).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(CorrectInterviewAssessmentResponse)(
          yield* Effect.promise(() => correction.json()),
          { onExcessProperty: "error" },
        ),
      ).toMatchObject({
        interviewId,
        predecessorRevision: 2,
        resultingRevision: 3,
        replayed: false,
      });

      expect(yield* database.run(persistedCorrection)).toEqual({
        corrections: 1,
        correctionReceipts: 1,
        audits: 1,
        httpReceipts: 1,
        revision: 3,
      });
    }),
  );

  it.live("rejects an exponent Content-Length before the correction starts", () =>
    Effect.gen(function* () {
      const { database, request } = fixture();
      const conduct = yield* request(`/api/recruitment/interviews/${interviewId}`);
      const etag = conduct.headers.get("etag");

      if (etag === null) throw new Error("The conduct read returned no entity tag");

      const correction = yield* request(`/api/recruitment/interviews/${interviewId}:correct`, {
        method: "POST",
        headers: {
          "content-length": "1e3",
          "content-type": "application/json",
          "idempotency-key": "commands-exponent".padEnd(22, "0"),
          "if-match": etag,
        },
        body: correctionBody,
      });

      expect(correction.status).toBe(400);
      expect(yield* Effect.promise(() => correction.json())).toMatchObject({
        code: "request.malformed",
      });
      expect(yield* database.run(persistedCorrection)).toEqual({
        corrections: 0,
        correctionReceipts: 0,
        audits: 0,
        httpReceipts: 0,
        revision: 2,
      });
    }),
  );
});

// Spec 0029 R2: these commands must remain on the existing maintenance operation.
// Raw wire variants exercise the maintenance request boundary, not a second command surface.
const coPersonId = PersonId.make("commands-co");

const adminPersonId = PersonId.make("commands-admin");

const unrelatedPersonId = PersonId.make("commands-unrelated");

const correctionActors = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES
    (${coPersonId}, 'Co', 'Interviewer'), (${adminPersonId}, 'Global', 'Administrator'),
    (${unrelatedPersonId}, 'Unrelated', 'Member')`;
    yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
    SELECT person_id, first_name, person_id || '@example.invalid', true FROM person_profiles`;
    yield* sql`INSERT INTO organization_memberships (membership_id,person_id,team_id,start_at)
    VALUES ('commands-co-membership',${coPersonId},'commands-team','2031-01-01'),
    ('commands-unrelated-membership',${unrelatedPersonId},'commands-team','2031-01-01')`;
    yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind,team_scope)
    VALUES ('commands-board',${departmentId},'Styret','DepartmentBoard','HomeDepartment')`;
    yield* sql`INSERT INTO organization_memberships (membership_id,person_id,team_id,start_at,is_team_leader)
    VALUES ('commands-board-leader',${leaderPersonId},'commands-board','2031-01-01',true)`;
    yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at,revision)
    VALUES ('commands-admin-grant',${adminPersonId},'2031-01-01',0)`;
    yield* sql`UPDATE recruitment_interviews SET co_interviewer_person_id=${coPersonId} WHERE interview_id=${interviewId}`;
  }),
);

type CorrectionFixture = ReturnType<typeof fixture>;

const runDomain = <A, E>(
  f: CorrectionFixture,
  program: Effect.Effect<A, E, Admissions | Recruitment | Database>,
) => f.database.run(program.pipe(Effect.provide(domain.pipe(Layer.provideMerge(f.clock)))));

const outcomeEntry = Admissions.use((service) => service.readAdmissionOutcome(applicationId));

const announceOutcome = Admissions.use((service) =>
  service.announceAdmissionOutcome(
    { applicationId, actor: leaderPersonId, now: "2031-09-15T12:04:00.000Z" },
    () => Effect.void,
    ({ kind }) => Effect.succeed({ subject: kind, html: "<p>" + kind + "</p>", text: kind }),
  ),
);

const commitAnnouncement = Effect.fnUntraced(function* (f: CorrectionFixture) {
  return yield* runDomain(
    f,
    Database.use((sql) => sql.withTransaction(announceOutcome)),
  );
});

const correctionRequest = Effect.fnUntraced(function* (
  f: CorrectionFixture,
  personId = interviewerPersonId,
  recommendation: CorrectInterviewAssessmentRequest["recommendation"] = "Nei",
  key = "r2-correction",
  revision = 2,
) {
  const conduct = yield* f.request("/api/recruitment/interviews/" + interviewId, {}, personId);
  expect(conduct.status).toBe(200);
  const etag = conduct.headers.get("etag");
  expect(etag).not.toBeNull();

  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key.padEnd(22, "0"),
      "if-match": etag ?? "",
    },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(CorrectInterviewAssessmentRequest))({
      expectedRevision: revision,
      answers: questionIds.map((questionId) => ({ questionId, answer: "R2 correction" })),
      score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
      recommendation,
    }),
  };
});

const correct = Effect.fnUntraced(function* (
  f: CorrectionFixture,
  personId = interviewerPersonId,
  recommendation: CorrectInterviewAssessmentRequest["recommendation"] = "Nei",
  key = "r2-correction",
  revision = 2,
) {
  const init = yield* correctionRequest(f, personId, recommendation, key, revision);

  return yield* f.request(
    "/api/recruitment/interviews/" + interviewId + ":correct",
    init,
    personId,
  );
});

const maintenance = Effect.fnUntraced(function* (
  f: CorrectionFixture,
  wire: { readonly commandId: string; readonly body: string },
  personId = leaderPersonId,
) {
  return yield* f.request(
    "/api/recruitment/maintenance/commands",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": wire.commandId },
      body: wire.body,
    },
    personId,
  );
});

const reopenWire = (
  key = "r2-reopen",
  expectedWindowSequence = 0,
  endsAt = "2031-09-16T12:00:00.000Z",
  reason = "Correct transcription without changing the final decision",
) => {
  const commandId = key.padEnd(22, "0");

  return {
    commandId,
    body:
      '{"_tag":"ReopenAssessmentCorrection",' +
      canonicalJson({
        commandId,
        interviewId,
        reason,
        expectedSequence: expectedWindowSequence,
        endsAt,
      }).slice(1),
  };
};

const closeWire = (windowSequence = 1, key = "r2-close", reason = "Review complete") => {
  const commandId = key.padEnd(22, "0");

  return {
    commandId,
    body:
      '{"_tag":"CloseAssessmentCorrection",' +
      canonicalJson({ commandId, interviewId, reason, expectedSequence: windowSequence }).slice(1),
  };
};

const decodeMaintenance = Effect.fnUntraced(function* (response: Response) {
  expect(response.status).toBe(200);

  return yield* Schema.decodeUnknownEffect(RecruitmentMaintenanceResult)(
    yield* Effect.promise(() => response.json()),
  );
});

const decideMaybe = Effect.fnUntraced(function* (f: CorrectionFixture) {
  expect((yield* correct(f, interviewerPersonId, "Kanskje", "r2-maybe")).status).toBe(200);

  return yield* runDomain(
    f,
    Database.use((sql) =>
      sql.withTransaction(
        Admissions.use((service) =>
          service.decideAdmissionOutcome(
            {
              applicationId,
              command: { outcome: "Admitted" },
              actor: leaderPersonId,
              now: "2031-09-15T12:04:00.000Z",
            },
            () => Effect.void,
          ),
        ),
      ),
    ),
  );
});

describe("R2 correction closure and frozen admission evidence", () => {
  for (const personId of [interviewerPersonId, coPersonId]) {
    it.live("allows ordinary correction before closure by " + personId, () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        const response = yield* correct(f, personId);
        expect(response.status).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(CorrectInterviewAssessmentResponse)(
            yield* Effect.promise(() => response.json()),
          ),
        ).toMatchObject({ predecessorRevision: 2, resultingRevision: 3 });
      }),
    );
  }

  it.live(
    "Ja announcement followed by attempted Nei correction never projects final Rejected",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        expect(yield* commitAnnouncement(f)).toMatchObject({
          outcome: "Admitted",
          state: "OutcomeAnnounced",
        });
        yield* correct(f);
        const current = yield* runDomain(f, outcomeEntry);
        expect(yield* Schema.decodeEffect(AdmissionOutcomeEntry)(current)).toMatchObject({
          outcome: "Admitted",
          basis: "Ja",
          state: "OutcomeAnnounced",
        });
      }),
  );

  for (const basis of ["Ja", "Nei"] as const) {
    it.live(basis + " derived announcement closes ordinary correction for both interviewers", () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        let revision = 2;

        if (basis === "Nei") {
          expect((yield* correct(f)).status).toBe(200);
          revision = 3;
        }

        yield* commitAnnouncement(f);

        for (const personId of [interviewerPersonId, coPersonId]) {
          expect(
            (yield* correct(f, personId, "Kanskje", "r2-closed-" + personId, revision)).status,
          ).toBe(409);
        }

        expect((yield* f.database.run(persistedCorrection))?.revision).toBe(revision);
      }),
    );
  }

  it.live("first explicit Kanskje decision closes ordinary correction before announcement", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* decideMaybe(f);

      for (const personId of [interviewerPersonId, coPersonId]) {
        expect(
          (yield* correct(f, personId, "Nei", "r2-after-decision-" + personId, 3)).status,
        ).toBe(409);
      }

      expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
        basis: "Kanskje",
        outcome: "Admitted",
        state: "ApplicationSubmitted",
      });
    }),
  );

  for (const personId of [adminPersonId, unrelatedPersonId]) {
    it.live("denies correction by nonparticipant " + personId, () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);

        // The GET itself must deny raw conduct; admin/board power grants no assessment access.
        const response = yield* f.request(
          "/api/recruitment/interviews/" + interviewId + ":correct",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": ("r2-denied-" + personId).padEnd(22, "0"),
              "if-match": '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
            },
            body: correctionBody,
          },
          personId,
        );

        expect(response.status).toBe(403);
        expect((yield* f.database.run(persistedCorrection))?.corrections).toBe(0);
      }),
    );
  }

  it.live("denies a known-self interviewer correction before receipt replay", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      const init = yield* correctionRequest(f, interviewerPersonId, "Kanskje", "r2-self");
      expect(
        (yield* f.request("/api/recruitment/interviews/" + interviewId + ":correct", init)).status,
      ).toBe(200);
      yield* f.database.run(
        Database.use((sql) =>
          sql`INSERT INTO applicant_account_invitations
      (invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
      VALUES ('r2-link',${applicationId},'commands-applicant',repeat('b',64),'2031-09-17','Claimed',${leaderPersonId},'2031-09-15')`.pipe(
            Effect.andThen(sql`INSERT INTO applicant_account_links (applicant_id,person_id,linked_at,invitation_id)
      VALUES ('commands-applicant',${interviewerPersonId},'2031-09-15','r2-link')`),
          ),
        ),
      );

      // Replay the exact committed request: only the current identity fact changed.
      const response = yield* f.request(
        "/api/recruitment/interviews/" + interviewId + ":correct",
        init,
      );

      expect(response.status).toBe(403);
      expect((yield* f.database.run(persistedCorrection))?.corrections).toBe(1);
    }),
  );
  it.live(
    "reopens and closes through maintainRecruitment with sequence fencing and no overlap",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);
        const reopened = yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
        expect(reopened._tag).toBe("AssessmentCorrectionReopened");
        expect(reopened).toMatchObject({ sequence: 1 });
        yield* assertProblemCode(
          yield* maintenance(f, reopenWire("r2-overlap", 1)),
          "recruitment.terminal",
        );
        yield* assertProblemCode(
          yield* maintenance(f, closeWire(2, "r2-stale-close")),
          "precondition.failed",
        );
        const closed = yield* decodeMaintenance(yield* maintenance(f, closeWire()));
        expect(closed._tag).toBe("AssessmentCorrectionClosed");
        expect(closed).toMatchObject({ sequence: 1 });
        expect((yield* correct(f)).status).toBe(409);
        yield* assertProblemCode(
          yield* maintenance(f, reopenWire("r2-stale-open", 0)),
          "precondition.failed",
        );
        const second = yield* decodeMaintenance(yield* maintenance(f, reopenWire("r2-second", 1)));
        expect(second._tag).toBe("AssessmentCorrectionReopened");
        expect(second).toMatchObject({ sequence: 2 });
      }),
  );

  it.live(
    "normalizes a reopened Instant through conduct and staffing reads and exact receipt replay",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);
        const wire = reopenWire("r2-normalized", 0, "2031-09-16T14:00:00.000+02:00");
        const response = yield* maintenance(f, wire);
        const reopened = yield* decodeMaintenance(response);
        expect(response.headers.get("etag")).not.toBeNull();
        expect(reopened).toMatchObject({ sequence: 1 });

        const conduct = yield* f.request("/api/recruitment/interviews/" + interviewId);
        expect(conduct.status).toBe(200);

        const observation = yield* Schema.decodeUnknownEffect(ConductObservation)(
          yield* Effect.promise(() => conduct.json()),
          { onExcessProperty: "error" },
        );

        expect(observation.assessmentCorrection._tag).toBe("Open");

        if (!("endsAt" in observation.assessmentCorrection))
          return yield* Effect.die("Missing reopened correction instant");
        expect(DateTime.formatIso(observation.assessmentCorrection.endsAt)).toBe(
          "2031-09-16T12:00:00.000Z",
        );

        const staffing = yield* f.request(
          "/api/recruitment/interview-staffing",
          {},
          leaderPersonId,
        );

        expect(staffing.status).toBe(200);

        const management = yield* Schema.decodeUnknownEffect(InterviewStaffingManagement)(
          yield* Effect.promise(() => staffing.json()),
          { onExcessProperty: "error" },
        );

        expect(management.interviews[0]?.assessmentCorrection).toEqual({
          ...observation.assessmentCorrection,
          canCorrect: false,
          canClose: true,
        });

        // Equivalent wire spellings identify the same normalized command, not a second window.
        expect(
          yield* decodeMaintenance(
            yield* maintenance(f, reopenWire("r2-normalized", 0, "2031-09-16T12:00:00.000Z")),
          ),
        ).toEqual(reopened);
        expect(
          yield* f.database.run(
            Database.use(
              (sql) => sql`SELECT
                (SELECT count(*)::integer FROM recruitment_assessment_correction_windows) AS windows,
                (SELECT count(*)::integer FROM recruitment_assessment_correction_window_audit) AS audits,
                (SELECT count(*)::integer FROM recruitment_maintenance_command_receipts) AS receipts`,
            ),
          ),
        ).toEqual([{ windows: 1, audits: 1, receipts: 1 }]);
      }),
  );

  it.live("rejects a missing or malformed reopen Instant before storing any receipt", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* commitAnnouncement(f);
      const commandId = "r2-missing-instant".padEnd(22, "0");

      const missing = {
        commandId,
        body:
          '{"_tag":"ReopenAssessmentCorrection",' +
          canonicalJson({
            commandId,
            interviewId,
            expectedSequence: 0,
            reason: "A correction window requires an explicit instant",
          }).slice(1),
      };

      for (const wire of [
        missing,
        reopenWire("r2-invalid-instant", 0, "not-an-instant"),
        reopenWire("r2-missing-offset", 0, "2031-09-16T12:00:00.000"),
      ]) {
        yield* assertProblemStatus(yield* maintenance(f, wire), 422);
      }

      expect((yield* f.database.run(persistedCorrection))?.httpReceipts).toBe(0);
    }),
  );

  for (const endsAt of ["2032-01-01T00:00:00.000Z", "2032-01-01T00:00:00.001Z"]) {
    it.live("bounds reopen to own semester end " + endsAt, () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);
        const response = yield* maintenance(f, reopenWire("r2-semester", 0, endsAt));
        expect(response.status).toBe(endsAt.endsWith(".001Z") ? 422 : 200);
      }),
    );
  }

  for (const variant of ["ReopenAssessmentCorrection", "CloseAssessmentCorrection"]) {
    it.live("requires a nonblank reason for " + variant, () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);

        const wire =
          variant === "ReopenAssessmentCorrection"
            ? reopenWire("r2-blank", 0, "2031-09-16T12:00:00.000Z", "   ")
            : closeWire(1, "r2-blank", "   ");

        expect((yield* maintenance(f, wire)).status).toBe(422);
        expect((yield* f.database.run(persistedCorrection))?.httpReceipts).toBe(0);
      }),
    );
  }

  it.live("reopened correction end is half-open and does not authorize at endsAt", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* commitAnnouncement(f);
      yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
      f.setNow("2031-09-16T11:59:59.999Z");
      expect((yield* correct(f, coPersonId, "Kanskje", "r2-before-end")).status).toBe(200);
      f.setNow("2031-09-16T12:00:00.000Z");
      expect((yield* correct(f, coPersonId, "Nei", "r2-at-end", 3)).status).toBe(409);
    }),
  );
  it.live("window opener cannot correct even when they are the assigned interviewer", () =>
    Effect.gen(function* () {
      const f = fixture(
        correctionActors.pipe(
          Effect.andThen(
            Database.use(
              (sql) => sql`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,start_at,is_team_leader) VALUES ('r2-primary-board',${interviewerPersonId},'commands-board','2031-01-01',true)`,
            ),
          ),
          Effect.asVoid,
        ),
      );

      yield* commitAnnouncement(f);
      yield* decodeMaintenance(yield* maintenance(f, reopenWire(), interviewerPersonId));
      expect((yield* correct(f)).status).toBe(403);
      expect((yield* correct(f, coPersonId)).status).toBe(200);
    }),
  );
  it.live(
    "postclosure correction records evidence but preserves announcement outcome and mail",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);

        const before = yield* f.database.run(
          Database.use(
            (sql) => sql`SELECT to_jsonb(a) AS announcement,
      (SELECT jsonb_agg(to_jsonb(o)) FROM admission_outcome_outbox o WHERE o.application_id=a.application_id) AS envelopes
      FROM admission_outcome_announcements a WHERE a.application_id=${applicationId}`,
          ),
        );

        yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
        expect((yield* correct(f)).status).toBe(200);
        expect((yield* f.database.run(persistedCorrection))?.corrections).toBe(1);
        expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
          outcome: "Admitted",
          basis: "Ja",
          state: "OutcomeAnnounced",
        });
        expect(
          yield* f.database.run(
            Database.use(
              (sql) => sql`SELECT to_jsonb(a) AS announcement,
      (SELECT jsonb_agg(to_jsonb(o)) FROM admission_outcome_outbox o WHERE o.application_id=a.application_id) AS envelopes
      FROM admission_outcome_announcements a WHERE a.application_id=${applicationId}`,
            ),
          ),
        ).toEqual(before);
      }),
  );
});

const correctionCommand = Schema.decodeEffect(CorrectInterviewAssessmentCommandSchema)({
  commandId: "r2-fenced-correction",
  interviewId,
  expectedRevision: 2,
  answers: questionIds.map((questionId) => ({ questionId, answer: "Old snapshot" })),
  score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
  recommendation: "Nei",
});

const correctionContext = {
  actor: AdmissionPeriodActorSchema.cases.Member.make({
    personId: interviewerPersonId,
    departmentId,
    active: true,
  }),
  now: "2031-09-15T12:05:00.000Z",
};

const applyFencedCorrection = Effect.gen(function* () {
  const command = yield* correctionCommand;

  return yield* Recruitment.use((service) =>
    service.correctInterviewAssessment(command, correctionContext),
  );
});

const assertProblemStatus = Effect.fnUntraced(function* (response: Response, status: number) {
  expect(response.status).toBe(status);

  const problem = yield* Schema.decodeUnknownEffect(NativeProblem)(
    yield* Effect.promise(() => response.json()),
  );

  expect(problem.status).toBe(status);
});

const assertProblemCode = Effect.fnUntraced(function* (
  response: Response,
  code: NativeProblemCode,
) {
  const problem = yield* Schema.decodeUnknownEffect(NativeProblem)(
    yield* Effect.promise(() => response.json()),
  );

  expect(problem.code).toBe(code);
  expect(problem.status).toBe(NativeProblemRegistry[code].status);
  expect(response.status).toBe(NativeProblemRegistry[code].status);
});

describe("R2 decision fence, refusal and interruption", () => {
  it.live("old predecision snapshot cannot commit correction after Ja announcement", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      // Initialize before acquiring the independent connection.
      yield* f.database.run(persistedCorrection);
      const competing = yield* f.competitor();
      const snapshotRead = yield* Deferred.make<void>();
      const decisionCommitted = yield* Deferred.make<void>();

      const oldSnapshot = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
            const before = yield* outcomeEntry;
            expect(before.state).toBe("ApplicationSubmitted");
            yield* Deferred.succeed(snapshotRead, undefined);
            yield* Deferred.await(decisionCommitted);

            return yield* applyFencedCorrection;
          }),
        ),
      ).pipe(
        Effect.provide(domain.pipe(Layer.provideMerge(competing))),
        Effect.exit,
        Effect.forkChild,
      );

      yield* Deferred.await(snapshotRead);
      yield* commitAnnouncement(f);
      yield* Deferred.succeed(decisionCommitted, undefined);
      const exit = yield* Fiber.join(oldSnapshot);
      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* f.database.run(persistedCorrection))?.corrections).toBe(0);
      expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
        outcome: "Admitted",
        state: "OutcomeAnnounced",
      });
    }),
  );
  it.live(
    "interrupting a correction waiting behind the decision fence leaves no partial writes or held lock",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* f.database.run(persistedCorrection);
        const competing = yield* f.competitor();
        // Native pg cancellation uses a second connection from the same pool.
        const correctionSession = yield* f.competitor(2);
        const observer = yield* f.competitor();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const holder = yield* Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT application_id FROM admission_applications WHERE application_id=${applicationId} FOR UPDATE`;
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
            }),
          ),
        ).pipe(Effect.provide(competing), Effect.forkChild);

        yield* Deferred.await(held);

        const waiter = yield* applyFencedCorrection.pipe(
          Effect.provide(
            domain.pipe(Layer.provideMerge(correctionSession), Layer.provideMerge(f.clock)),
          ),
          Effect.forkChild,
        );

        // The observer has its own connection, independent of holder and waiter.
        // On the unfenced baseline the correction completes instead of waiting.
        const observed = yield* Effect.race(
          Fiber.await(waiter).pipe(Effect.as("completed" as const)),
          Database.use(
            (sql) => sql`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='transactionid'`,
          ).pipe(
            Effect.repeat({ until: (rows) => rows.length > 0 }),
            Effect.as("waiting" as const),
            Effect.provide(observer),
          ),
        );

        expect(observed).toBe("waiting");
        yield* Fiber.interrupt(waiter);
        const interrupted = yield* Fiber.await(waiter);
        expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect(yield* f.database.run(persistedCorrection)).toEqual({
          corrections: 0,
          correctionReceipts: 0,
          audits: 0,
          httpReceipts: 0,
          revision: 2,
        });
        // A new command after releasing both owners proves the connection/fence is usable.
        expect((yield* correct(f)).status).toBe(200);
      }),
  );

  for (const cancelled of [false, true]) {
    it.live(
      "refuses reopen and correction for " +
        (cancelled ? "cancelled" : "uncompleted") +
        " interview",
      () =>
        Effect.gen(function* () {
          const f = fixture(correctionActors, false);

          if (cancelled) {
            const conduct = yield* f.request("/api/recruitment/interviews/" + interviewId);

            const cancel = yield* f.request(
              "/api/recruitment/interviews/" + interviewId + ":cancel",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": "r2-cancel".padEnd(22, "0"),
                  "if-match": conduct.headers.get("etag") ?? "",
                },
                body: "{}",
              },
            );

            expect(cancel.status).toBe(200);
          }

          yield* assertProblemStatus(yield* maintenance(f, reopenWire()), 409);
          yield* assertProblemStatus(
            yield* correct(f, interviewerPersonId, "Nei", "r2-incomplete", cancelled ? 2 : 1),
            cancelled ? 409 : 422,
          );
          expect((yield* f.database.run(persistedCorrection))?.corrections).toBe(0);
        }),
    );
  }

  for (const personId of [coPersonId, unrelatedPersonId]) {
    it.live("refuses window maintenance without scoped staffing authority for " + personId, () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        yield* commitAnnouncement(f);
        yield* assertProblemStatus(yield* maintenance(f, reopenWire(), personId), 403);
      }),
    );
  }

  it.live("does not permit reopen before decision closure", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* assertProblemStatus(yield* maintenance(f, reopenWire()), 409);
    }),
  );
});

const applicantPersonId = PersonId.make("r2-applicant-person");

const linkApplicant = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES (${applicantPersonId},'Applicant','Owner')`;
    yield* sql`INSERT INTO applicant_account_invitations (invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
    VALUES ('r2-claimed-invitation',${applicationId},'commands-applicant',repeat('c',64),'2031-09-17','Claimed',${leaderPersonId},'2031-09-15')`;
    yield* sql`INSERT INTO applicant_account_links (applicant_id,person_id,linked_at,invitation_id)
    VALUES ('commands-applicant',${applicantPersonId},'2031-09-15','r2-claimed-invitation')`;
  }),
);

const seedReturningEvidence = Database.use((sql) =>
  Effect.gen(function* () {
    yield* linkApplicant;
    yield* sql`INSERT INTO organization_volunteer_affiliations (person_id,department_id,status,revision)
    VALUES (${applicantPersonId},${departmentId},'Active',1)`;

    const [school] = yield* sql<{ readonly schoolId: number }>`INSERT INTO schools_directory_schools
    (name,contact_person,email,phone,language,active) VALUES ('R2 school','Contact','r2-school@example.invalid','90000001','Norwegian',true)
    RETURNING school_id AS "schoolId"`;

    if (school === undefined) return yield* Effect.die("Missing inserted school");
    yield* sql`INSERT INTO schools_directory_departments (school_id,department_id) VALUES (${school.schoolId},${departmentId})`;
    yield* sql`INSERT INTO assistant_placements (placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
    VALUES (${"placement-" + "d".repeat(64)},${applicantPersonId},${departmentId},'commands-semester',${school.schoolId},'Monday',4,'1',false,1)`;
    yield* sql`INSERT INTO admission_returning_registrations (registration_id,application_id,applicant_id,person_id,placement_id,department_id,
    semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,
    thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at)
    VALUES (${"returning-registration-" + "e".repeat(64)},${applicationId},'commands-applicant',${applicantPersonId},${"placement-" + "d".repeat(64)},${departmentId},
    'commands-semester','commands-period',1,'r2-returning',2,false,false,false,false,false,4,'all','Norsk',NULL,false,'[]'::jsonb,'2031-09-10')`;
  }),
);

const issueAfterCorrection = commandOnboarding({
  departmentId,
  command: { applicationId, action: "Issue" },
  actor: leaderPersonId,
  now: Effect.sync(() => DateTime.makeUnsafe("2031-09-15T12:10:00.000Z")),
  invitationId: "r2-onboarding",
  token: "r2-onboarding".padEnd(43, "_"),
  digest: "f".repeat(64),
});

const requestAffiliation = Placements.use((service) =>
  service.execute(
    {
      mutation: { mode: "affiliation", scope: { departmentId }, command: { action: "Request" } },
      actor: applicantPersonId,
      now: "2031-09-15T12:10:00.000Z",
      commandId: "r2-affiliation",
    },
    () => Effect.void,
  ),
);

describe("R2 frozen standing consumers and Returning closure", () => {
  it.live(
    "first explicit Returning decision closes correction without inventing a completed interview",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors.pipe(Effect.andThen(seedReturningEvidence)), false);
        expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
          basis: "Returning",
          outcome: null,
        });

        const decided = yield* runDomain(
          f,
          Database.use((sql) =>
            sql.withTransaction(
              Admissions.use((service) =>
                service.decideAdmissionOutcome(
                  {
                    applicationId,
                    command: { outcome: "Admitted" },
                    actor: leaderPersonId,
                    now: "2031-09-15T12:04:00.000Z",
                  },
                  () => Effect.void,
                ),
              ),
            ),
          ),
        );

        expect(decided).toMatchObject({
          basis: "Returning",
          outcome: "Admitted",
          state: "ApplicationSubmitted",
        });
        yield* assertProblemStatus(
          yield* correct(f, interviewerPersonId, "Nei", "r2-returning-correct", 1),
          422,
        );
        yield* assertProblemStatus(yield* maintenance(f, reopenWire()), 409);
        expect(yield* runDomain(f, outcomeEntry)).toEqual(decided);
      }),
  );

  for (const basis of ["Ja", "Nei"] as const) {
    it.live("postclosure assessment cannot change " + basis + " onboarding standing", () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        let revision = 2;

        if (basis === "Nei") {
          expect((yield* correct(f)).status).toBe(200);
          revision = 3;
        }

        yield* commitAnnouncement(f);
        yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
        expect(
          (yield* correct(f, coPersonId, basis === "Ja" ? "Nei" : "Ja", "r2-standing", revision))
            .status,
        ).toBe(200);

        const result = yield* f.database.run(
          Database.use((sql) => sql.withTransaction(issueAfterCorrection)).pipe(Effect.exit),
        );

        expect(Exit.isSuccess(result)).toBe(basis === "Ja");

        if (Exit.isFailure(result)) expect(Cause.hasFails(result.cause)).toBe(true);
        expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
          basis,
          outcome: basis === "Ja" ? "Admitted" : "Rejected",
        });
      }),
    );
    it.live("postclosure assessment cannot change " + basis + " affiliation standing", () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        let revision = 2;

        if (basis === "Nei") {
          expect((yield* correct(f)).status).toBe(200);
          revision = 3;
        }

        yield* commitAnnouncement(f);
        yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
        expect(
          (yield* correct(
            f,
            coPersonId,
            basis === "Ja" ? "Nei" : "Ja",
            "r2-affiliation-standing",
            revision,
          )).status,
        ).toBe(200);
        yield* f.database.run(linkApplicant);

        const result = yield* f.database.run(
          Database.use((sql) => sql.withTransaction(requestAffiliation)).pipe(
            Effect.provide(PlacementsLive),
            Effect.exit,
          ),
        );

        expect(Exit.isSuccess(result)).toBe(basis === "Ja");

        if (Exit.isFailure(result)) expect(Cause.hasFails(result.cause)).toBe(true);
        expect(yield* runDomain(f, outcomeEntry)).toMatchObject({
          basis,
          outcome: basis === "Ja" ? "Admitted" : "Rejected",
        });
      }),
    );
  }
});

describe("R2 scoped reopen authority and explicit-decision citation", () => {
  for (const scope of ["own", "other"] as const) {
    it.live("staffing delegation reopens and closes only its " + scope + " department", () =>
      Effect.gen(function* () {
        const f = fixture(
          correctionActors.pipe(
            Effect.andThen(
              Database.use((sql) =>
                Effect.gen(function* () {
                  yield* sql`INSERT INTO organization_departments (department_id,name,short_name,email,city)
          VALUES ('r2-other-department','Other','OTH','other@example.invalid','Bergen')`;
                  yield* sql`INSERT INTO organization_delegations (delegation_id,name,team_id,capability,area,area_department_id,holders,start_at)
          VALUES (${"delegation-" + "a".repeat(64)},'Correction review','commands-team','recruitment.interviews','Department',
          ${scope === "own" ? departmentId : "r2-other-department"},'AllMembers','2031-01-01')`;
                }),
              ),
            ),
          ),
        );

        yield* commitAnnouncement(f);
        const response = yield* maintenance(f, reopenWire(), unrelatedPersonId);

        if (scope === "other") {
          yield* assertProblemStatus(response, 403);
        } else {
          yield* decodeMaintenance(response);
          yield* decodeMaintenance(yield* maintenance(f, closeWire(), unrelatedPersonId));
        }
      }),
    );
  }

  it.live(
    "reopened Kanskje assessment does not change the first explicit unannounced decision",
    () =>
      Effect.gen(function* () {
        const f = fixture(correctionActors);
        const firstDecision = yield* decideMaybe(f);
        yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
        expect((yield* correct(f, coPersonId, "Nei", "r2-frozen-maybe", 3)).status).toBe(200);
        expect(yield* runDomain(f, outcomeEntry)).toEqual(firstDecision);
        expect(yield* commitAnnouncement(f)).toMatchObject({
          outcome: "Admitted",
          basis: "Kanskje",
          state: "OutcomeAnnounced",
        });
      }),
  );
  it.live("authorized unannounced revision uses frozen Kanskje, never the later corrected Ja", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* decideMaybe(f);
      yield* decodeMaintenance(yield* maintenance(f, reopenWire()));
      expect((yield* correct(f, coPersonId, "Ja", "r2-same-citation-revision", 3)).status).toBe(
        200,
      );

      const revised = yield* runDomain(
        f,
        Database.use((sql) =>
          sql.withTransaction(
            Admissions.use((service) =>
              service.decideAdmissionOutcome(
                {
                  applicationId,
                  command: { outcome: "Rejected" },
                  actor: leaderPersonId,
                  now: "2031-09-15T12:06:00.000Z",
                },
                () => Effect.void,
              ),
            ),
          ),
        ),
      );

      expect(revised).toMatchObject({
        basis: "Kanskje",
        outcome: "Rejected",
        state: "ApplicationSubmitted",
      });
      expect(yield* commitAnnouncement(f)).toMatchObject({
        basis: "Kanskje",
        outcome: "Rejected",
        state: "OutcomeAnnounced",
      });
    }),
  );
  it.live("reopen must end strictly after its committing instant", () =>
    Effect.gen(function* () {
      const f = fixture(correctionActors);
      yield* commitAnnouncement(f);
      yield* assertProblemStatus(
        yield* maintenance(f, reopenWire("r2-empty-window", 0, "2031-09-15T12:05:00.000Z")),
        422,
      );
    }),
  );
});
