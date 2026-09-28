import { randomBytes } from "node:crypto";
import { Database } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  PublicApplicationIdSchema,
  PublicApplicationSubmitInputSchema,
} from "@vektorprogrammet/domain/application";
import { PublicApplicationConfirmationSchema, SubmitApplicationRequest } from "@vektorprogrammet/rpc";
import { IdempotencyKey, isProblem, type Problem } from "@vektorprogrammet/rpc/problem";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

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

const applicationSource = {
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

const application = Schema.decodeUnknownSync(SubmitApplicationRequest)(applicationSource);

/** Each fixture is one backend process with its own database and public rate limit. */
const fixture = () =>
  Effect.gen(function* () {
    const database = backendDatabase(openPeriod);

    const backend = makeBackendTestRpc(
      yield* decodeBackendConfig(environment),
      Layer.mergeAll(database.layer, AdmissionsLive.pipe(Layer.provide(database.layer))),
    );

    const client = yield* backend.client;

    const submit = (idempotencyKey: string, request: typeof application = application) =>
      client["admissions.submitApplication"]({
        idempotencyKey: IdempotencyKey.make(idempotencyKey.padEnd(22, "0")),
        request,
      });

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

    return { database, client, submit, count, competitor };
  });

/** The problem code of a failed call; a transport failure has none. */
const codeOf = (failure: Problem | RpcClientError) => (isProblem(failure) ? failure.code : "defect");

describe("public application submission over RPC", () => {
  it.live("rejects an unknown department as a validation failure at /departmentId", () =>
    Effect.gen(function* () {
      const { submit, count } = yield* fixture();

      const request = yield* Schema.decodeUnknownEffect(SubmitApplicationRequest)({
        ...applicationSource,
        departmentId: "department-unknown",
      });

      const failure = yield* submit("unknownDepartment", request).pipe(Effect.flip);

      expect(failure).toMatchObject({
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
      const { database, client, submit } = yield* fixture();
      const submitted = yield* submit("confirmedApplication");

      const confirmation = yield* client["admissions.readApplicationConfirmation"]({
        applicationId: submitted.applicationId,
      });

      expect(confirmation).toEqual(
        PublicApplicationConfirmationSchema.make({ applicationId: submitted.applicationId }),
      );

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
          WHERE application_id = ${submitted.applicationId}
        `,
        ),
      );

      expect(stored).toEqual([applicationSource.availability]);
    }),
  );

  it.live("replays a submission by its idempotency key with the first answer", () =>
    Effect.gen(function* () {
      const { submit, count } = yield* fixture();
      const first = yield* submit("replayedApplication");
      const replayed = yield* submit("replayedApplication");

      expect(replayed).toEqual(first);
      expect(yield* count("admission_applications")).toBe(1);
      expect(yield* count("native_http_idempotency_receipts")).toBe(1);
    }),
  );

  it.live("answers the loser of a concurrent same-applicant race as a duplicate", () =>
    Effect.gen(function* () {
      const { submit, count, competitor } = yield* fixture();
      const connection = yield* competitor();
      const lockHeld = yield* Deferred.make<void>();

      const input = yield* Schema.decodeUnknownEffect(PublicApplicationSubmitInputSchema)({
        ...applicationSource,
        commandId: "race-winner",
      });

      // The competing submission commits only after the RPC submission waits for the applicant
      // identity lock, so the RPC transaction's SERIALIZABLE snapshot is older than the winner.
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

      const loserRequest = yield* Schema.decodeUnknownEffect(SubmitApplicationRequest)({
        ...applicationSource,
        email: "ADA@example.invalid",
      });

      const loser = yield* submit("raceLoser", loserRequest).pipe(Effect.flip);

      expect(yield* Fiber.join(winner)).toBe(1);
      expect(codeOf(loser)).toBe("application.duplicate");
      expect(yield* count("admission_applicants")).toBe(1);
      expect(yield* count("admission_applications")).toBe(1);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("answers a failed application write as dependency.unavailable", () =>
    Effect.gen(function* () {
      const { database, submit, count } = yield* fixture();

      yield* database.run(
        Database.use((sql) =>
          Effect.gen(function* () {
            yield* sql`CREATE FUNCTION reject_application_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'application write rejected'; END $$`;
            yield* sql`CREATE TRIGGER reject_application_write BEFORE INSERT ON admission_applications FOR EACH ROW EXECUTE FUNCTION reject_application_write()`;
          }),
        ),
      );

      const failure = yield* submit("rejectedWrite").pipe(Effect.flip);

      expect(codeOf(failure)).toBe("dependency.unavailable");
      expect(yield* count("admission_applicants")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("answers an unknown application confirmation with application.not-found", () =>
    Effect.gen(function* () {
      const { client } = yield* fixture();

      const failure = yield* client["admissions.readApplicationConfirmation"]({
        applicationId: PublicApplicationIdSchema.make("application-unknown"),
      }).pipe(Effect.flip);

      expect(codeOf(failure)).toBe("application.not-found");
    }),
  );
});
