import { Database, IdentitySnapshot, type DatabaseOperations } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { SemesterId } from "@vektorprogrammet/domain";
import {
  IdempotencyKey,
  isProblem,
  makeNativeValidationError,
} from "@vektorprogrammet/rpc/problem";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schedule } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { SqlError } from "effect/unstable/sql/SqlError";
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
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
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
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookie: string | undefined) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
  },
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

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

/** The problem code of a failed call, or `ok`. */
const codeOf = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => (isProblem(error) ? error.code : "defect"),
      });

/**
 * Each request opens its own PostgreSQL connection, as separate backend requests do, so two
 * requests can run their transactions at the same time.
 */
const fixture = () =>
  Effect.gen(function* () {
    const database = backendDatabase(seed);

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

    const connection = () =>
      DatabaseRuntimeLive({ ...target, maxConnections: 1 }).pipe(Layer.orDie);

    const backend = makeBackendTestRpc(
      yield* decodeBackendConfig(environment),
      Layer.mergeAll(
        AdmissionsLive,
        OrganizationLive,
        Layer.succeed(IdentitySnapshot, identitySnapshot),
        Layer.succeed(Identity, identity),
      ).pipe(Layer.provideMerge(connection())),
    );

    const client = yield* backend.client;

    /** Runs one call as `personId`, with that person's session cookie. */
    const as = <A, E, R>(effect: Effect.Effect<A, E, R>, personId = leaderPersonId) =>
      RpcClient.withHeaders(effect, { cookie: `better-auth.session_token=${personId}` });

    /**
     * Holds `lock` on a separate connection until `waiters` requests queue behind it, then
     * commits without writing, so the queued requests continue in arrival order.
     */
    const holdUntilQueued = (
      lock: (sql: DatabaseOperations) => Effect.Effect<unknown, SqlError>,
      waiters: number,
    ) =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();

        const holder = yield* Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* lock(sql);
              yield* Deferred.succeed(held, undefined);

              return yield* waitingRequests(sql, waiters);
            }),
          ),
        ).pipe(Effect.provide(connection(), { local: true }), Effect.forkChild);

        yield* Deferred.await(held);

        return { released: Fiber.join(holder) };
      });

    const count = (query: string) =>
      database.run(
        Database.use((sql) => sql.unsafe<{ readonly count: number }>(query)).pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
        ),
      );

    return { client, as, holdUntilQueued, count };
  });

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

describe("admission period management over RPC and PostgreSQL", () => {
  it.live("answers the loser of a concurrent revision with precondition.failed", () =>
    Effect.gen(function* () {
      const { client, as, holdUntilQueued, count } = yield* fixture();
      const listed = yield* as(client["admissions.listAdmissionPeriods"]());
      const current = listed.items.find((item) => item.id === "period-autumn");

      if (current === undefined) throw new Error("The seeded period is not listed");

      const revise = (idempotencyKey: string) =>
        as(
          client["admissions.reviseAdmissionPeriod"]({
            admissionPeriodId: AdmissionPeriodId.make("period-autumn"),
            idempotencyKey: key(idempotencyKey),
            ifMatch: current.etag,
            request: { endAt: "2031-10-02T20:00:00.000Z" },
          }),
        ).pipe(Effect.exit);

      // Both revisions read revision 0 and pass If-Match before either may lock the row.
      const { released } = yield* holdUntilQueued(
        (sql) =>
          sql`SELECT 1 FROM public.admission_periods WHERE admission_period_id = 'period-autumn' FOR UPDATE`,
        2,
      );

      const exits = yield* Effect.all([revise("reviseRaceA"), revise("reviseRaceB")], {
        concurrency: "unbounded",
      });

      expect(yield* released).toBe(2);
      expect(exits.map(codeOf).sort()).toEqual(["ok", "precondition.failed"]);

      const winner = exits.find(Exit.isSuccess);

      expect(winner?.value).toMatchObject({
        id: "period-autumn",
        endAt: "2031-10-02T20:00:00.000Z",
        revision: 1,
      });
      expect(
        yield* count(
          "SELECT revision AS count FROM admission_periods WHERE admission_period_id = 'period-autumn'",
        ),
      ).toBe(1);
      expect(
        yield* count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
      ).toBe(1);
      expect(
        yield* count("SELECT count(*)::integer AS count FROM native_http_idempotency_receipts"),
      ).toBe(1);
    }),
  );

  it.live("answers the loser of a concurrent create with admission-period.already-exists", () =>
    Effect.gen(function* () {
      const { client, as, holdUntilQueued, count } = yield* fixture();

      const create = (idempotencyKey: string) =>
        as(
          client["admissions.createAdmissionPeriod"]({
            idempotencyKey: key(idempotencyKey),
            request: {
              semesterId: SemesterId.make("semester-spring"),
              startAt: "2032-01-10T08:00:00.000Z",
              endAt: "2032-02-01T20:00:00.000Z",
              departmentId: DepartmentId.make(departmentId),
            },
          }),
        ).pipe(Effect.exit);

      // Both creates read the spring semester without a period before either may write one.
      const { released } = yield* holdUntilQueued(
        (sql) => sql`LOCK TABLE public.admission_periods IN EXCLUSIVE MODE`,
        2,
      );

      const exits = yield* Effect.all([create("createRaceA"), create("createRaceB")], {
        concurrency: "unbounded",
      });

      expect(yield* released).toBe(2);
      expect(exits.map(codeOf).sort()).toEqual(["admission-period.already-exists", "ok"]);
      expect(exits.find(Exit.isSuccess)?.value).toMatchObject({
        departmentId,
        semesterId: "semester-spring",
      });
      expect(
        yield* count(
          "SELECT count(*)::integer AS count FROM admission_periods WHERE semester_id = 'semester-spring'",
        ),
      ).toBe(1);
    }),
  );

  it.live("replays a create by its idempotency key with the first answer", () =>
    Effect.gen(function* () {
      const { client, as, count } = yield* fixture();

      const create = as(
        client["admissions.createAdmissionPeriod"]({
          idempotencyKey: key("replayedCreate"),
          request: {
            semesterId: SemesterId.make("semester-spring"),
            startAt: "2032-01-10T08:00:00.000Z",
            endAt: "2032-02-01T20:00:00.000Z",
            departmentId: DepartmentId.make(departmentId),
          },
        }),
      );

      const first = yield* create;
      const replayed = yield* create;

      expect(replayed).toEqual(first);
      expect(
        yield* count(
          "SELECT count(*)::integer AS count FROM admission_periods WHERE semester_id = 'semester-spring'",
        ),
      ).toBe(1);
    }),
  );

  it.live("answers an empty and a deleting patch with their merge-patch problems", () =>
    Effect.gen(function* () {
      const { client, as, count } = yield* fixture();
      const listed = yield* as(client["admissions.listAdmissionPeriods"]());
      const current = listed.items.find((item) => item.id === "period-autumn");

      if (current === undefined) throw new Error("The seeded period is not listed");

      const patch = (idempotencyKey: string, request: { readonly endAt?: string | null }) =>
        as(
          client["admissions.reviseAdmissionPeriod"]({
            admissionPeriodId: AdmissionPeriodId.make("period-autumn"),
            idempotencyKey: key(idempotencyKey),
            ifMatch: current.etag,
            request,
          }),
        ).pipe(Effect.flip);

      const empty = yield* patch("emptyPatch", {});
      const deleted = yield* patch("deletingPatch", { endAt: null });

      expect(empty).toMatchObject({
        code: "validation.no-change",
        validation: { errors: [makeNativeValidationError("", "no-change")], truncated: false },
      });
      expect(deleted).toMatchObject({
        code: "validation.field-not-deletable",
        validation: {
          errors: [makeNativeValidationError("/endAt", "field-not-deletable")],
          truncated: false,
        },
      });
      expect(
        yield* count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
      ).toBe(0);
    }),
  );

  it.live("names the semester or department that a create cannot resolve", () =>
    Effect.gen(function* () {
      const { client, as, count } = yield* fixture();

      const create = (idempotencyKey: string, semesterId: string, personId?: string) =>
        as(
          client["admissions.createAdmissionPeriod"]({
            idempotencyKey: key(idempotencyKey),
            request: {
              semesterId: SemesterId.make(semesterId),
              startAt: "2032-01-10T08:00:00.000Z",
              endAt: "2032-02-01T20:00:00.000Z",
            },
          }),
          personId,
        ).pipe(Effect.flip);

      const unknownSemester = yield* create("unknownSemester", "semester-unknown");

      // A global administrator acts in no department of its own, so the create must name one.
      const withoutDepartment = yield* create(
        "globalWithoutDepartment",
        "semester-spring",
        adminPersonId,
      );

      expect(unknownSemester).toMatchObject({
        code: "validation.failed",
        validation: {
          errors: [makeNativeValidationError("/semesterId", "invalid")],
          truncated: false,
        },
      });
      expect(withoutDepartment).toMatchObject({
        code: "validation.failed",
        validation: {
          errors: [makeNativeValidationError("/departmentId", "missing")],
          truncated: false,
        },
      });
      expect(
        yield* count("SELECT count(*)::integer AS count FROM admission_period_command_receipts"),
      ).toBe(0);
    }),
  );

  it.live("denies a person without admission authority", () =>
    Effect.gen(function* () {
      const { client, as } = yield* fixture();

      const denied = yield* as(client["admissions.listAdmissionPeriods"](), "periods-stranger").pipe(
        Effect.flip,
      );

      expect(isProblem(denied) && denied.code).toBe("authority.denied");
    }),
  );
});
