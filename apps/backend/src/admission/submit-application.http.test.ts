import { randomBytes } from "node:crypto";
import { Database } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { readOnboardingBoard } from "@vektorprogrammet/database/onboarding";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { OnboardingBoard } from "@vektorprogrammet/domain/onboarding";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { PublicApplicationSubmitInputSchema } from "@vektorprogrammet/domain/application";
import {
  AdmissionsSubmitApplicationProblem,
  PublicApplicationConfirmationSchema,
} from "@vektorprogrammet/http-api";
import { makeNativeValidationError } from "@vektorprogrammet/http-api/http-semantics";
import { Deferred, Effect, Fiber, Layer, Predicate, Schedule, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
import { jsonText } from "../http-api/problem.js";
import { makeBackendTestHttp } from "../test/native-http.js";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "admission-http-test-secret-with-32-characters",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
  ADMISSION_FIXED_NOW: "2031-09-15T12:00:00.000Z",
  ADMISSION_RATE_LIMIT_MAX: "100",
} as const;

/** One open period for one department, with one active field of study. */
const openPeriod = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES ('department-http', 'Trondheim')`;
    yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('semester-http', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z')`;
    yield* sql`
      INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id)
      VALUES ('period-http', 'department-http', 'semester-http', '2031-09-01T08:00:00.000Z', '2031-10-01T20:00:00.000Z', 'period-http-created')
    `;
    yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name) VALUES ('field-http', 'department-http', 'Matematikk')`;
  }),
);

const unavailableAuthHandler = {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
};

const application = {
  departmentId: "department-http",
  firstName: "Ada",
  lastName: "Applicant",
  phone: "+47 900 00 000",
  email: "ada@example.invalid",
  gender: 0,
  fieldOfStudyId: "field-http",
  yearOfStudy: 3,
  availability: {
    mondayUnavailable: false,
    tuesdayUnavailable: true,
    wednesdayUnavailable: false,
    thursdayUnavailable: false,
    fridayUnavailable: true,
    positionWeeks: 4,
    preferredGroup: "block-2",
    language: "Norsk og engelsk",
  },
};

/** Each fixture is one backend process with its own database and public rate limit. */
const fixture = () => {
  const database = backendDatabase(openPeriod);

  const http = makeBackendTestHttp(
    Effect.runSync(decodeBackendConfig(environment)),
    Layer.mergeAll(database.layer, AdmissionsLive.pipe(Layer.provide(database.layer))),
    unavailableAuthHandler,
  );

  const submit = (
    idempotencyKey: string,
    request: {
      readonly body?: string;
      readonly contentType?: string;
      readonly path?: string;
    } = {},
  ) =>
    http.fetch(
      new Request(`http://backend.test${request.path ?? "/api/applications"}`, {
        method: "POST",
        headers: {
          "content-type": request.contentType ?? "application/json",
          "idempotency-key": idempotencyKey.padEnd(22, "0"),
        },
        body: request.body ?? JSON.stringify(application),
      }),
    );

  const read = (applicationId: string) =>
    http.fetch(new Request(`http://backend.test/api/applications/${applicationId}`));

  const count = (table: string) =>
    database.run(
      Database.use((sql) =>
        sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count FROM ${table}`),
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    );

  /** A second PostgreSQL session on the fixture database, outside the handler's connection. */
  const competitor = () =>
    Effect.gen(function* () {
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

      return DatabaseRuntimeLive({ ...target, maxConnections: 1 }).pipe(Layer.orDie);
    });

  return { database, submit, read, count, competitor };
};

/** Decodes a rejection through the endpoint's closed Problem Details union. */
const problem = (response: Response) =>
  Effect.gen(function* () {
    expect(response.headers.get("content-type")).toBe("application/problem+json");

    return yield* Schema.decodeUnknownEffect(AdmissionsSubmitApplicationProblem)(
      yield* Effect.promise(() => response.json()),
      {
        onExcessProperty: "error",
      },
    );
  });

describe("public application submission over HTTP", () => {
  it.live("rejects an unknown department as a validation failure at /departmentId", () =>
    Effect.gen(function* () {
      const { submit, count } = fixture();

      const response = yield* submit("unknownDepartment", {
        body: yield* jsonText({ ...application, departmentId: "department-unknown" }),
      });

      expect(response.status).toBe(422);
      expect(yield* problem(response)).toMatchObject({
        code: "validation.failed",
        validation: {
          errors: [{ pointer: "/departmentId", code: "invalid" }],
          truncated: false,
        },
      });
      expect(yield* count("admission_applications")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("reads the confirmation of a submitted application and stores its availability", () =>
    Effect.gen(function* () {
      const { database, submit, read } = fixture();
      const submitted = yield* submit("confirmedApplication");

      expect(submitted.status).toBe(201);

      const { applicationId } = yield* Schema.decodeUnknownEffect(
        PublicApplicationConfirmationSchema,
      )(yield* Effect.promise(() => submitted.json()), { onExcessProperty: "error" });

      const confirmation = yield* read(applicationId);

      expect(confirmation.status).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(PublicApplicationConfirmationSchema)(
          yield* Effect.promise(() => confirmation.json()),
          {
            onExcessProperty: "error",
          },
        ),
      ).toEqual(PublicApplicationConfirmationSchema.make({ applicationId }));

      const stored = yield* database.run(
        Database.use(
          (sql) => sql`
          SELECT monday_unavailable AS "mondayUnavailable",
            tuesday_unavailable AS "tuesdayUnavailable",
            wednesday_unavailable AS "wednesdayUnavailable",
            thursday_unavailable AS "thursdayUnavailable",
            friday_unavailable AS "fridayUnavailable",
            position_weeks AS "positionWeeks",
            preferred_group AS "preferredGroup",
            language
          FROM admission_applications
          WHERE application_id = ${applicationId}
        `,
        ),
      );

      expect(stored).toEqual([application.availability]);
    }),
  );

  it.live("answers the loser of a concurrent same-applicant race as a duplicate", () =>
    Effect.gen(function* () {
      const { submit, count, competitor } = fixture();
      const connection = yield* competitor();
      const lockHeld = yield* Deferred.make<void>();

      const input = yield* Schema.decodeUnknownEffect(PublicApplicationSubmitInputSchema)({
        ...application,
        commandId: "race-winner",
      });

      // The competing submission commits only after the HTTP submission waits for the
      // applicant identity lock, so the HTTP transaction's SERIALIZABLE snapshot is
      // older than the committed winner.
      const winner = yield* Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* Admissions.use((admissions) =>
              admissions.executePublicApplication(input, {
                now: environment.ADMISSION_FIXED_NOW,
                activationToken: randomBytes(32).toString("base64url"),
              }),
            );
            yield* Deferred.succeed(lockHeld, undefined);

            return yield* sql<{ readonly waiting: number }>`
              SELECT count(*)::integer AS waiting
              FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
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
      ).pipe(
        Effect.provide(AdmissionsLive),
        Effect.provide(connection, { local: true }),
        Effect.forkChild,
      );

      yield* Deferred.await(lockHeld);

      const loser = yield* submit("raceLoser", {
        body: yield* jsonText({ ...application, email: "ADA@example.invalid" }),
      });

      expect(yield* Fiber.join(winner)).toBe(1);
      expect(loser.status).toBe(409);
      expect((yield* problem(loser)).code).toBe("application.duplicate");
      expect(yield* count("admission_applicants")).toBe(1);
      expect(yield* count("admission_applications")).toBe(1);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("answers a failed application write as dependency.unavailable", () =>
    Effect.gen(function* () {
      const { database, submit, count } = fixture();

      yield* database.run(
        Database.use((sql) =>
          Effect.gen(function* () {
            yield* sql`CREATE FUNCTION reject_application_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'application write rejected'; END $$`;
            yield* sql`CREATE TRIGGER reject_application_write BEFORE INSERT ON admission_applications FOR EACH ROW EXECUTE FUNCTION reject_application_write()`;
          }),
        ),
      );

      const response = yield* submit("rejectedWrite");

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect((yield* problem(response)).code).toBe("dependency.unavailable");
      expect(yield* count("admission_applicants")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live(
    "rejects a foreign media type, unparsable JSON, and a query string as request failures",
    () =>
      Effect.gen(function* () {
        const { submit, count } = fixture();
        const textPlain = yield* submit("textPlain", { contentType: "text/plain" });
        const unparsable = yield* submit("unparsable", { body: "{" });
        const query = yield* submit("query", { path: "/api/applications?source=homepage" });

        expect(textPlain.status).toBe(415);
        expect((yield* problem(textPlain)).code).toBe("media-type.unsupported");
        expect(unparsable.status).toBe(400);
        expect((yield* problem(unparsable)).code).toBe("request.malformed");
        expect(query.status).toBe(400);
        expect((yield* problem(query)).code).toBe("request.malformed");
        expect(yield* count("admission_applications")).toBe(0);
      }),
  );

  it.live("names every rejected member of an application in its validation member", () =>
    Effect.gen(function* () {
      const { submit, count } = fixture();
      const { lastName: _omitted, ...withoutLastName } = application;

      const response = yield* submit("invalidMembers", {
        body: yield* jsonText({
          ...withoutLastName,
          firstName: "",
          email: "not-an-email",
          nickname: "Ada",
          availability: { ...application.availability, positionWeeks: 6 },
        }),
      });

      expect(response.status).toBe(422);
      expect(yield* problem(response)).toMatchObject({
        code: "validation.failed",
        validation: {
          errors: [
            makeNativeValidationError("/availability/positionWeeks", "invalid"),
            makeNativeValidationError("/email", "invalid"),
            makeNativeValidationError("/firstName", "invalid"),
            makeNativeValidationError("/lastName", "missing"),
            makeNativeValidationError("/nickname", "unknown"),
          ],
          truncated: false,
        },
      });
      expect(yield* count("admission_applications")).toBe(0);
    }),
  );
});

const linkedOwner = PersonId.make("same-email-linked-owner");

const historicalApplicant = Database.use((sql) =>
  Effect.gen(function* () {
    // A department has at most one admission period per semester.
    yield* sql`INSERT INTO admission_period_semesters (semester_id,start_at,end_at) VALUES ('semester-prior','2031-01-01','2031-09-01')`;
    yield* sql`INSERT INTO admission_periods (admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES ('period-prior','department-http','semester-prior','2031-08-01','2031-09-01','prior-period-created')`;
    yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id,department_id,name) VALUES ('field-prior','department-http','Physics')`;
    yield* sql`INSERT INTO admission_applicants (applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest) VALUES ('linked-applicant','ada@example.invalid','ada@example.invalid','Original','Owner','91111111',1,'field-prior',1,${"a".repeat(64)})`;
    yield* sql`INSERT INTO admission_applications (application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES ('prior-application','linked-applicant','period-prior','department-http','field-prior',1,'2031-08-15')`;
    yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES (${linkedOwner},'Original','Owner')`;
    yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES (${linkedOwner},'Original Owner','owner@example.invalid',true)`;
    yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at) VALUES ('linked-owner-grant',${linkedOwner},'2020-01-01')`;
    yield* sql`INSERT INTO applicant_account_invitations (invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES ('prior-invitation','prior-application','linked-applicant',${"b".repeat(64)},'2031-08-17','Claimed',${linkedOwner},'2031-08-16')`;
    yield* sql`INSERT INTO applicant_account_links (applicant_id,person_id,linked_at,invitation_id) VALUES ('linked-applicant',${linkedOwner},'2031-08-16','prior-invitation')`;
    yield* sql`INSERT INTO recruitment_interview_schemas (interview_schema_id,name,question_count) VALUES ('prior-schema','Historical questionnaire',1)`;
    yield* sql`INSERT INTO recruitment_interview_schema_questions (interview_schema_id,question_id,ordinal,prompt,kind,alternatives) VALUES ('prior-schema','prior-question',0,'Why?','text','[]'::jsonb)`;
    yield* sql`INSERT INTO recruitment_interviews (interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at) VALUES ('prior-interview','prior-application','department-http',${linkedOwner},'prior-schema',${linkedOwner},'2031-08-16')`;
  }),
).pipe(
  // Preserve the typed SQL failure; report metadata, never row details or tokens.
  Effect.tapError((error) => {
    const cause = error.reason.cause;

    return Effect.logError("Historical linked-identity fixture SQL failed", {
      reason: error.reason._tag,
      sqlState:
        Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
          ? cause.code
          : undefined,
      constraint:
        Predicate.hasProperty(cause, "constraint") && Predicate.isString(cause.constraint)
          ? cause.constraint
          : undefined,
    });
  }),
);

// Compare the actual owning projections, not a test copy of their joins/classifiers.
const priorIdentity = Effect.gen(function* () {
  const sql = yield* Database;

  const owner =
    yield* sql`SELECT p.*,l.person_id,l.linked_at,l.invitation_id FROM admission_applicants p JOIN applicant_account_links l USING(applicant_id) WHERE p.applicant_id='linked-applicant'`;

  const priorApplication =
    yield* sql`SELECT * FROM admission_applications WHERE application_id='prior-application'`;

  const onboarding = yield* Schema.decodeUnknownEffect(OnboardingBoard)(
    yield* readOnboardingBoard(DepartmentId.make("department-http")),
  );

  const staffing = yield* Recruitment.use((service) => service.readInterviewStaffing(linkedOwner));

  return {
    owner,
    priorApplication,
    onboarding: onboarding.items.filter((item) => item.applicationId === "prior-application"),
    staffing: staffing.interviews.filter((item) => item.interviewId === "prior-interview"),
  };
});

const recruitmentProjections = RecruitmentLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(Layer.provideMerge(OrganizationLive)),
  ),
);

describe("anonymous submission cannot acquire a linked same-email identity", () => {
  it.live(
    "preserves linked owner identity and prior Recruitment/onboarding projections across another period and replay",
    () =>
      Effect.gen(function* () {
        const { database, submit, count } = fixture();
        yield* database.run(historicalApplicant);
        const projections = recruitmentProjections.pipe(Layer.provideMerge(database.layer));
        const before = yield* priorIdentity.pipe(Effect.provide(projections));

        const body = yield* jsonText({
          ...application,
          email: "ADA@example.invalid",
          firstName: "New",
          lastName: "Submission",
        });

        const response = yield* submit("independentSameEmail", { body });
        expect(response.status).toBe(201);
        const bytes = yield* Effect.promise(() => response.text());

        const confirmation = yield* Schema.decodeEffect(
          Schema.fromJsonString(PublicApplicationConfirmationSchema),
        )(bytes);

        const [submitted] = yield* database.run(
          Database.use(
            (sql) => sql`
      SELECT a.applicant_id AS "applicantId",p.first_name AS "firstName",p.last_name AS "lastName",p.activation_digest AS "activationDigest",l.person_id AS "personId"
      FROM admission_applications a JOIN admission_applicants p USING(applicant_id) LEFT JOIN applicant_account_links l USING(applicant_id) WHERE a.application_id=${confirmation.applicationId}
    `,
          ),
        );

        expect(yield* priorIdentity.pipe(Effect.provide(projections))).toEqual(before);
        expect(submitted).toMatchObject({
          firstName: "New",
          lastName: "Submission",
          personId: null,
          activationDigest: expect.any(String),
        });
        expect(submitted?.applicantId).not.toBe("linked-applicant");
        const replay = yield* submit("independentSameEmail", { body });
        expect(replay.status).toBe(201);
        expect(yield* Effect.promise(() => replay.text())).toBe(bytes);
        const duplicate = yield* submit("samePeriodCollision", { body });
        expect(duplicate.status).toBe(409);
        expect((yield* problem(duplicate)).code).toBe("application.duplicate");
        expect(yield* count("admission_applicants")).toBe(2);
        expect(yield* count("admission_applications")).toBe(2);
        expect(yield* count("admission_application_command_receipts")).toBe(1);
        expect(yield* count("native_http_idempotency_receipts")).toBe(1);
        expect(yield* priorIdentity.pipe(Effect.provide(projections))).toEqual(before);
      }),
  );

  it.live(
    "serializes concurrent same-period same-email submissions without attaching either to the linked owner",
    () =>
      Effect.gen(function* () {
        const { database, submit, count, competitor } = fixture();
        yield* database.run(historicalApplicant);
        const projections = recruitmentProjections.pipe(Layer.provideMerge(database.layer));
        const before = yield* priorIdentity.pipe(Effect.provide(projections));
        const connection = yield* competitor();
        const lockHeld = yield* Deferred.make<void>();

        const input = yield* Schema.decodeUnknownEffect(PublicApplicationSubmitInputSchema)({
          ...application,
          firstName: "Concurrent",
          commandId: "independent-race-winner",
        });

        const winner = yield* Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* Admissions.use((admissions) =>
                admissions.executePublicApplication(input, {
                  now: environment.ADMISSION_FIXED_NOW,
                  activationToken: "independent".padEnd(43, "_"),
                }),
              );
              yield* Deferred.succeed(lockHeld, undefined);

              return yield* sql`SELECT count(*)::integer AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted`.pipe(
                Effect.map((rows) => rows[0]?.waiting ?? 0),
                Effect.repeat({
                  until: (waiting) => waiting > 0,
                  times: 400,
                  schedule: Schedule.spaced("10 millis"),
                }),
              );
            }),
          ),
        ).pipe(
          Effect.provide(AdmissionsLive),
          Effect.provide(connection, { local: true }),
          Effect.forkChild,
        );

        yield* Deferred.await(lockHeld);

        const loser = yield* submit("independentRaceLoser", {
          body: yield* jsonText({
            ...application,
            email: "ADA@example.invalid",
            firstName: "Loser",
          }),
        });

        expect(yield* Fiber.join(winner)).toBe(1);
        expect(loser.status).toBe(409);
        expect((yield* problem(loser)).code).toBe("application.duplicate");
        expect(yield* count("admission_applicants")).toBe(2);
        expect(yield* count("admission_applications")).toBe(2);
        expect(yield* count("admission_application_command_receipts")).toBe(1);
        expect(yield* count("native_http_idempotency_receipts")).toBe(0);
        expect(yield* priorIdentity.pipe(Effect.provide(projections))).toEqual(before);

        const rows = yield* database.run(
          Database.use(
            (sql) =>
              sql`SELECT applicant_id FROM admission_applications WHERE admission_period_id='period-http'`,
          ),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.applicant_id).not.toBe("linked-applicant");
      }),
  );
});
