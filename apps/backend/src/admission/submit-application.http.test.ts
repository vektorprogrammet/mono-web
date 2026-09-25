import { randomBytes } from "node:crypto";
import { Database } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { PublicApplicationSubmitInputSchema } from "@vektorprogrammet/domain/application";
import { AdmissionsSubmitApplicationProblem } from "@vektorprogrammet/http-api";
import { Effect, Layer, ManagedRuntime, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
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
  handle: async () => new Response(null, { status: 404 }),
  recordTrustedOriginRejection: async () => undefined,
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
};

/** Each fixture is one backend process with its own database and public rate limit. */
const fixture = () => {
  const database = backendDatabase(openPeriod);

  const http = makeBackendTestHttp(
    decodeBackendConfig(environment),
    Layer.mergeAll(database.layer, AdmissionsLive.pipe(Layer.provide(database.layer))),
    unavailableAuthHandler,
  );

  const submit = (
    idempotencyKey: string,
    body: string = JSON.stringify(application),
    contentType = "application/json",
  ) =>
    http.fetch(
      new Request("http://backend.test/api/applications", {
        method: "POST",
        headers: { "content-type": contentType, "idempotency-key": idempotencyKey.padEnd(22, "0") },
        body,
      }),
    );

  const count = (table: string) =>
    database.run(
      Database.use((sql) =>
        sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count FROM ${table}`),
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    );

  /** A second PostgreSQL session on the fixture database, outside the handler's connection. */
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

  return { database, submit, count, competitor };
};

/** Decodes a rejection through the endpoint's closed Problem Details union. */
const problem = async (response: Response) => {
  expect(response.headers.get("content-type")).toBe("application/problem+json");

  return Schema.decodeUnknownSync(AdmissionsSubmitApplicationProblem)(await response.json(), {
    onExcessProperty: "error",
  });
};

describe("public application submission over HTTP", () => {
  it("rejects an unknown department as a validation failure at /departmentId", async () => {
    const { submit, count } = fixture();

    const response = await submit(
      "unknownDepartment",
      JSON.stringify({ ...application, departmentId: "department-unknown" }),
    );

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({
      code: "validation.failed",
      validation: {
        errors: [{ pointer: "/departmentId", code: "invalid" }],
        truncated: false,
      },
    });
    await expect(count("admission_applications")).resolves.toBe(0);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(0);
  });

  it("answers the loser of a concurrent same-applicant race as a duplicate", async () => {
    const { submit, count, competitor } = fixture();
    const runtime = await competitor();

    try {
      const lockHeld = Promise.withResolvers<void>();

      // The competing submission commits only after the HTTP submission waits for the
      // applicant identity lock, so the HTTP transaction's SERIALIZABLE snapshot is
      // older than the committed winner.
      const winner = runtime.runPromise(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* Admissions.use((admissions) =>
                admissions.executePublicApplication(
                  Schema.decodeUnknownSync(PublicApplicationSubmitInputSchema)({
                    ...application,
                    commandId: "race-winner",
                  }),
                  {
                    now: environment.ADMISSION_FIXED_NOW,
                    activationToken: randomBytes(32).toString("base64url"),
                  },
                ),
              );
              yield* Effect.sync(() => lockHeld.resolve());

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
        ).pipe(Effect.provide(AdmissionsLive)),
      );

      await lockHeld.promise;

      const loser = await submit(
        "raceLoser",
        JSON.stringify({ ...application, email: "ADA@example.invalid" }),
      );

      await expect(winner).resolves.toBe(1);
      expect(loser.status).toBe(409);
      expect((await problem(loser)).code).toBe("application.duplicate");
    } finally {
      await runtime.dispose();
    }

    await expect(count("admission_applicants")).resolves.toBe(1);
    await expect(count("admission_applications")).resolves.toBe(1);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(0);
  });

  it("answers a failed application write as dependency.unavailable", async () => {
    const { database, submit, count } = fixture();

    await database.run(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE FUNCTION reject_application_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'application write rejected'; END $$`;
          yield* sql`CREATE TRIGGER reject_application_write BEFORE INSERT ON admission_applications FOR EACH ROW EXECUTE FUNCTION reject_application_write()`;
        }),
      ),
    );

    const response = await submit("rejectedWrite");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect((await problem(response)).code).toBe("dependency.unavailable");
    await expect(count("admission_applicants")).resolves.toBe(0);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(0);
  });
});
