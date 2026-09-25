import { Database } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { AdmissionsSubmitApplicationProblem } from "@vektorprogrammet/http-api";
import { Effect, Layer, Schema } from "effect";
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

  return { database, submit, count };
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
});
