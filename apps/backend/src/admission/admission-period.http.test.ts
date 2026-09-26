import { Database, IdentitySnapshot, type DatabaseOperations } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodManagementListResponse,
  AdmissionsCreateAdmissionPeriodProblem,
  AdmissionsReviseAdmissionPeriodProblem,
} from "@vektorprogrammet/http-api";
import { makeNativeValidationError } from "@vektorprogrammet/http-api/http-semantics";
import { DateTime, Effect, Layer, ManagedRuntime, Schedule, Schema } from "effect";
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
} as const;

const departmentId = "department-periods";

const leaderPersonId = "periods-leader";

const adminPersonId = "periods-admin";

/** One open autumn period and an empty spring semester, a Styret leader, and a global administrator. */
const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES (${departmentId}, 'Trondheim')`;
    yield* sql`
      INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
      VALUES
        ('semester-autumn', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z'),
        ('semester-spring', '2032-01-01T00:00:00.000Z', '2032-07-01T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id)
      VALUES ('period-autumn', ${departmentId}, 'semester-autumn', '2031-09-01T08:00:00.000Z', '2031-10-01T20:00:00.000Z', 'period-autumn-created')
    `;
    yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city, independent) VALUES (${departmentId}, 'Trondheim', 'TRD', 'periods@example.invalid', 'Trondheim', TRUE)`;
    // The department's board (Styret) of an independent department: its leader manages admission periods.
    yield* sql`INSERT INTO organization_teams (team_id, department_id, name, kind) VALUES ('periods-team', ${departmentId}, 'Styret', 'DepartmentBoard')`;
    yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${leaderPersonId}, 'Lise', 'Leader'), (${adminPersonId}, 'Ada', 'Admin')`;
    yield* sql`INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at) VALUES ('periods-admin-grant', ${adminPersonId}, '2020-01-01T00:00:00.000Z')`;
    yield* sql`
      INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, position_id, is_team_leader)
      VALUES ('periods-leader-membership', ${leaderPersonId}, 'periods-team', '2020-01-01T00:00:00.000Z', 'leader', TRUE)
    `;
  }),
);

/** Every session cookie names its person. */
const sessionActor = (cookie: string | undefined) => {
  const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

  return person === undefined
    ? undefined
    : new IdentityActor({
        personId: PersonId.make(person),
        sessionId: `session-${person}`,
        expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
      });
};

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const identity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookie: string | undefined) => {
    const actor = sessionActor(cookie);

    if (actor === undefined) throw new IdentitySessionNotFound();

    return actor;
  },
  readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
  listSessions: () => Promise.reject(new Error("unexpected session list")),
  revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
  revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
  recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
  signOut: async () => ({ setCookies: [] }),
} satisfies IdentityOperations);

const unavailableAuthHandler = {
  handle: async () => new Response(null, { status: 404 }),
  recordTrustedOriginRejection: async () => undefined,
};

/** Requests that queue behind a lock in the fixture database. */
const waitingRequests = (sql: DatabaseOperations, expected: number) =>
  sql<{ readonly waiting: number }>`
    SELECT count(*)::integer AS waiting
    FROM pg_locks JOIN pg_stat_activity USING (pid)
    WHERE NOT pg_locks.granted AND pg_stat_activity.datname = current_database()
  `.pipe(
    Effect.map((rows) => rows[0]?.waiting ?? 0),
    Effect.repeat({
      until: (waiting) => waiting >= expected,
      times: 400,
      schedule: Schedule.spaced("10 millis"),
    }),
  );

/**
 * Each request opens its own PostgreSQL connection, as separate backend requests do,
 * so two requests can run their transactions at the same time.
 */
const fixture = async () => {
  const database = backendDatabase(seed);

  const [target] = await database.run(
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

  const connection = () => DatabaseRuntimeLive({ ...target, maxConnections: 1 }).pipe(Layer.orDie);

  const http = makeBackendTestHttp(
    decodeBackendConfig(environment),
    Layer.mergeAll(
      AdmissionsLive,
      OrganizationLive,
      Layer.succeed(IdentitySnapshot, identitySnapshot),
      Layer.succeed(Identity, identity),
    ).pipe(Layer.provideMerge(connection())),
    unavailableAuthHandler,
  );

  const manage = (path: string, init: RequestInit = {}, personId = leaderPersonId) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `better-auth.session_token=${personId}`);

    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", "http://127.0.0.1:5174");
    }

    return http.fetch(new Request(`http://backend.test${path}`, { ...init, headers }));
  };

  /**
   * Holds `lock` on a separate connection until `waiters` requests queue behind it, then
   * commits without writing, so the queued requests continue in arrival order.
   */
  const holdUntilQueued = async (
    lock: (sql: DatabaseOperations) => Effect.Effect<unknown, unknown>,
    waiters: number,
  ) => {
    const runtime = ManagedRuntime.make(connection());
    const held = Promise.withResolvers<void>();

    const released = runtime
      .runPromise(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* lock(sql);
              yield* Effect.sync(() => held.resolve());

              return yield* waitingRequests(sql, waiters);
            }),
          ),
        ),
      )
      .finally(() => runtime.dispose());

    await held.promise;

    // Wrapped, so that awaiting the hold does not also await its release.
    return { released };
  };

  const count = (query: string) =>
    database.run(
      Database.use((sql) => sql.unsafe<{ readonly count: number }>(query)).pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    );

  return { manage, holdUntilQueued, count };
};

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  response: Response,
) =>
  response
    .json()
    .then((body) => Schema.decodeUnknownSync(schema)(body, { onExcessProperty: "error" }));

describe("admission period management over HTTP and PostgreSQL", () => {
  it("answers the loser of a concurrent revision with 412 precondition.failed", async () => {
    const { manage, holdUntilQueued, count } = await fixture();
    const list = await manage("/api/admission-periods");

    expect(list.status).toBe(200);

    const listed = await decodeStrict(AdmissionPeriodManagementListResponse, list);
    const current = listed.items.find((item) => item.id === "period-autumn");

    if (current === undefined) throw new Error("The seeded period is not listed");

    const revise = (key: string) =>
      manage("/api/admission-periods/period-autumn", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "if-match": current.etag,
          "idempotency-key": key.padEnd(22, "0"),
        },
        body: JSON.stringify({ endAt: "2031-10-02T20:00:00.000Z" }),
      });

    // Both revisions read revision 0 and pass If-Match before either may lock the row.
    const { released } = await holdUntilQueued(
      (sql) =>
        sql`SELECT 1 FROM public.admission_periods WHERE admission_period_id = 'period-autumn' FOR UPDATE`,
      2,
    );

    const responses = await Promise.all([revise("reviseRaceA"), revise("reviseRaceB")]);

    await expect(released).resolves.toBe(2);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 412]);

    const winner = responses.find((response) => response.status === 200)!;
    const loser = responses.find((response) => response.status === 412)!;

    await expect(decodeStrict(AdmissionPeriodManagementItem, winner)).resolves.toMatchObject({
      id: "period-autumn",
      endAt: "2031-10-02T20:00:00.000Z",
      revision: 1,
    });
    expect(loser.headers.get("content-type")).toBe("application/problem+json");
    await expect(
      decodeStrict(AdmissionsReviseAdmissionPeriodProblem, loser),
    ).resolves.toMatchObject({ code: "precondition.failed" });
    await expect(
      count(
        "SELECT revision AS count FROM admission_periods WHERE admission_period_id = 'period-autumn'",
      ),
    ).resolves.toBe(1);
    await expect(
      count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
    ).resolves.toBe(1);
    await expect(
      count("SELECT count(*)::integer AS count FROM native_http_idempotency_receipts"),
    ).resolves.toBe(1);
  });

  it("answers the loser of a concurrent create with 409 admission-period.already-exists", async () => {
    const { manage, holdUntilQueued, count } = await fixture();

    const create = (key: string) =>
      manage("/api/admission-periods", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key.padEnd(22, "0"),
        },
        body: JSON.stringify({
          semesterId: "semester-spring",
          startAt: "2032-01-10T08:00:00.000Z",
          endAt: "2032-02-01T20:00:00.000Z",
          departmentId,
        }),
      });

    // Both creates read the spring semester without a period before either may write one.
    const { released } = await holdUntilQueued(
      (sql) => sql`LOCK TABLE public.admission_periods IN EXCLUSIVE MODE`,
      2,
    );

    const responses = await Promise.all([create("createRaceA"), create("createRaceB")]);

    await expect(released).resolves.toBe(2);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);

    const winner = responses.find((response) => response.status === 201)!;
    const loser = responses.find((response) => response.status === 409)!;

    await expect(decodeStrict(AdmissionPeriodManagementItem, winner)).resolves.toMatchObject({
      departmentId,
      semesterId: "semester-spring",
    });
    await expect(
      decodeStrict(AdmissionsCreateAdmissionPeriodProblem, loser),
    ).resolves.toMatchObject({ code: "admission-period.already-exists" });
    await expect(
      count(
        "SELECT count(*)::integer AS count FROM admission_periods WHERE semester_id = 'semester-spring'",
      ),
    ).resolves.toBe(1);
  });

  it("names the rejected members of a malformed create and patch", async () => {
    const { manage, count } = await fixture();

    const listed = await decodeStrict(
      AdmissionPeriodManagementListResponse,
      await manage("/api/admission-periods"),
    );

    const current = listed.items.find((item) => item.id === "period-autumn");

    if (current === undefined) throw new Error("The seeded period is not listed");

    const created = await manage("/api/admission-periods", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "malformedCreate".padEnd(22, "0"),
      },
      body: JSON.stringify({
        semesterId: "semester-spring",
        startAt: "2032-01-10T08:00:00.000Z",
        endAt: "2032-02-01T20:00:00.000Z",
        departmentId,
        color: "blue",
      }),
    });

    const patch = (key: string, body: string) =>
      manage("/api/admission-periods/period-autumn", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "if-match": current.etag,
          "idempotency-key": key.padEnd(22, "0"),
        },
        body,
      });

    const empty = await patch("emptyPatch", "{}");
    const deleted = await patch("deletingPatch", JSON.stringify({ endAt: null }));
    const invalid = await patch("invalidPatch", JSON.stringify({ endAt: "soon" }));

    expect([created.status, empty.status, deleted.status, invalid.status]).toEqual([
      422, 422, 422, 422,
    ]);
    await expect(
      decodeStrict(AdmissionsCreateAdmissionPeriodProblem, created),
    ).resolves.toMatchObject({
      code: "validation.failed",
      validation: { errors: [makeNativeValidationError("/color", "unknown")], truncated: false },
    });
    await expect(
      decodeStrict(AdmissionsReviseAdmissionPeriodProblem, empty),
    ).resolves.toMatchObject({
      code: "validation.no-change",
      validation: { errors: [makeNativeValidationError("", "no-change")], truncated: false },
    });
    await expect(
      decodeStrict(AdmissionsReviseAdmissionPeriodProblem, deleted),
    ).resolves.toMatchObject({
      code: "validation.field-not-deletable",
      validation: {
        errors: [makeNativeValidationError("/endAt", "field-not-deletable")],
        truncated: false,
      },
    });
    await expect(
      decodeStrict(AdmissionsReviseAdmissionPeriodProblem, invalid),
    ).resolves.toMatchObject({
      code: "validation.failed",
      validation: { errors: [makeNativeValidationError("/endAt", "invalid")], truncated: false },
    });
    await expect(
      count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
    ).resolves.toBe(0);
  });

  it("names the semester or department that a create cannot resolve", async () => {
    const { manage, count } = await fixture();

    const create = (key: string, semesterId: string, personId?: string) =>
      manage(
        "/api/admission-periods",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key.padEnd(22, "0"),
          },
          body: JSON.stringify({
            semesterId,
            startAt: "2032-01-10T08:00:00.000Z",
            endAt: "2032-02-01T20:00:00.000Z",
          }),
        },
        personId,
      );

    const unknownSemester = await create("unknownSemester", "semester-unknown");

    // A global administrator acts in no department of its own, so the create must name one.
    const withoutDepartment = await create(
      "globalWithoutDepartment",
      "semester-spring",
      adminPersonId,
    );

    expect([unknownSemester.status, withoutDepartment.status]).toEqual([422, 422]);
    await expect(
      decodeStrict(AdmissionsCreateAdmissionPeriodProblem, unknownSemester),
    ).resolves.toMatchObject({
      code: "validation.failed",
      validation: {
        errors: [makeNativeValidationError("/semesterId", "invalid")],
        truncated: false,
      },
    });
    await expect(
      decodeStrict(AdmissionsCreateAdmissionPeriodProblem, withoutDepartment),
    ).resolves.toMatchObject({
      code: "validation.failed",
      validation: {
        errors: [makeNativeValidationError("/departmentId", "missing")],
        truncated: false,
      },
    });
    await expect(
      count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
    ).resolves.toBe(0);
  });
});
