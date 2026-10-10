/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { expect, layer } from "@effect/vitest";
import {
  type DisposablePgBouncer,
  startDisposablePgBouncer,
  startDisposablePostgres,
} from "@monoweb/postgres";
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { Mail, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";
import { TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationCommandId,
  TeamApplicationOutboxDelivery,
  TeamApplications,
  type TeamApplicationInput,
} from "@vektorprogrammet/domain/team-application";
import { DatabaseLive } from "../layers.js";
import { postgresTestClient } from "../test-support/postgres.js";
import { Database } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";
import { TeamApplicationsLive } from "./index.js";

class PgBouncerConsoleError extends Schema.TaggedError<PgBouncerConsoleError>()(
  "PgBouncerConsoleError",
  { cause: Schema.Defect() },
) {}

class PoolerProbeRollback extends Schema.TaggedError<PoolerProbeRollback>()(
  "PoolerProbeRollback",
  {},
) {}

/**
 * The transaction condition of the team-application PersistedQueue pilot on PostgreSQL through
 * PgBouncer in transaction mode (docs/specs/infrastructure-ports.md): every statement outside a
 * transaction may run on another server connection, and a transaction holds one.
 */

class Pooler extends Context.Service<Pooler, DisposablePgBouncer>()(
  "team-application/delivery-pgbouncer.test/Pooler",
) {}

/**
 * The production Database search path as a database default. `-c name=value` of the startup
 * options is the option form of `ALTER DATABASE ... SET name=value`, so one constant declares both.
 */
const databaseSearchPathSetting = NativeDatabaseStartupOptions.replace("-c ", "");

/**
 * A cluster with the pilot database behind a transaction pooler. The database names the
 * application's search path: PgBouncer restores a client's startup `search_path` only where the
 * server reports it, which PostgreSQL 17 does not. The database default is the declared
 * production path, so both majors resolve it alike.
 */
const pooler = Layer.effect(
  Pooler,
  Effect.gen(function* () {
    const cluster = yield* Effect.acquireRelease(
      Effect.promise(() => startDisposablePostgres({ listen: "socket", database: "pilot" })),
      (started) => Effect.promise(() => started.stop()),
    );

    const admin = yield* postgresTestClient({
      url: Redacted.make(cluster.url),
      maxConnections: 1,
      startupOptions: NativeDatabaseStartupOptions,
    });

    yield* admin.unsafe(`ALTER DATABASE pilot SET ${databaseSearchPathSetting}`).pipe(Effect.orDie);

    return yield* Effect.acquireRelease(
      Effect.promise(() => startDisposablePgBouncer(cluster, { poolSize: 4 })),
      (started) => Effect.promise(() => started.stop()),
    );
  }),
);

/** The application's pool, migrated and used through the pooler only. */
const database = Layer.unwrap(
  Effect.map(Pooler, (started) =>
    DatabaseLive({
      url: Redacted.make(started.urlOf("pilot")),
      applicationName: "team-application-pgbouncer-test",
      maxConnections: 4,
      prepare: false,
      startupOptions: NativeDatabaseStartupOptions,
    }).pipe(Layer.provide(TestPlatform)),
  ),
);

const seedTeam = Layer.effectDiscard(
  Database.use(
    (sql) => sql`
      WITH department AS (
        INSERT INTO organization_departments (department_id, name, short_name, email, city, active)
        VALUES ('pooled-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim', true)
        RETURNING department_id
      )
      INSERT INTO organization_teams
        (team_id, department_id, name, email, accept_application, deadline, active)
      SELECT 'pooled-team', department_id, 'IT', 'it@example.invalid', true, NULL, true
      FROM department
    `,
  ),
);

const pooledLayer = seedTeam.pipe(
  Layer.provideMerge(
    Layer.merge(
      database,
      TeamApplicationsLive({ pollInterval: "20 millis" }).pipe(Layer.provide(database)),
    ),
  ),
  Layer.provideMerge(pooler),
  Layer.provide(TestPlatform),
);

const input: TeamApplicationInput = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.",
  motivation: "Vil hjelpe elever med matematikk.",
};

const submitCommand = (command: string) =>
  TeamApplications.use((service) =>
    service.submit({
      commandId: TeamApplicationCommandId.make(command),
      teamId: TeamId.make("pooled-team"),
      application: input,
    }),
  );

const count = (query: string) =>
  Database.use((sql) =>
    sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count ${query}`),
  ).pipe(Effect.map((rows) => rows[0]?.count));

/** The pool mode of the pooler's pool of `database`, from its admin console. */
const poolMode = (database: string) =>
  Effect.gen(function* () {
    const started = yield* Pooler;

    const admin = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: started.urlOf("pgbouncer"),
            max: 1,
            connectionTimeoutMillis: 1_000,
            query_timeout: 1_000,
          }),
      ),
      (pool) => Effect.promise(() => pool.end()),
    );

    // EX-0031: PgBouncer's console requires simple protocol; the native app uses extended protocol.
    const { rows } = yield* Effect.tryPromise({
      try: () => admin.query("SHOW POOLS"),
      catch: (cause) => new PgBouncerConsoleError({ cause }),
    });

    const decoded = yield* Schema.decodeEffect(
      Schema.Array(Schema.Struct({ database: Schema.String, pool_mode: Schema.String })),
    )(rows);

    return decoded.filter((row) => row.database === database).map((row) => row.pool_mode);
  }).pipe(Effect.scoped);

// EX-0031: only the owned PgBouncer console uses the supported simple-protocol client.
const preparedCapacity = Effect.fnUntraced(function* () {
  const started = yield* Pooler;

  const admin = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Pool({
          connectionString: started.urlOf("pgbouncer"),
          max: 1,
          connectionTimeoutMillis: 1_000,
          query_timeout: 1_000,
        }),
    ),
    (pool) => Effect.promise(() => pool.end()),
  );

  const result = yield* Effect.tryPromise({
    try: () => admin.query("SHOW CONFIG"),
    catch: (cause) => new PgBouncerConsoleError({ cause }),
  });

  const rows = yield* Schema.decodeEffect(
    Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.NullOr(Schema.String) })),
  )(result.rows);

  return yield* Schema.decodeUnknownEffect(Schema.FiniteFromString.check(Schema.isGreaterThan(0)))(
    rows.find((row) => row.key === "max_prepared_statements")?.value,
  );
}, Effect.scoped);

layer(pooledLayer, { excludeTestServices: true, timeout: "120 seconds" })(
  "team application delivery through PgBouncer in transaction mode",
  (it) => {
    it.effect(
      "uses prepared native statements only when the real pooler declares prepared capacity",
      () =>
        Effect.gen(function* () {
          expect(yield* preparedCapacity()).toBeGreaterThan(0);
          const started = yield* Pooler;

          const sql = yield* postgresTestClient({
            url: Redacted.make(started.urlOf("pilot")),
            maxConnections: 1,
            prepare: true,
            applicationName: "native-prepared-pooler",
            startupOptions: NativeDatabaseStartupOptions,
          });

          for (let value = 0; value < 5; value++)
            expect(yield* sql`SELECT ${value}::integer AS value`).toEqual([{ value }]);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "reuses native unnamed statements and restores transaction-local settings after commit and rollback",
      () =>
        Database.use((sql) =>
          Effect.gen(function* () {
            const before =
              yield* sql`SELECT current_setting('TimeZone') AS zone, current_schemas(false) AS schemas`;

            const decoded = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({ zone: Schema.String, schemas: Schema.Array(Schema.String) }),
              ),
            )(before);

            expect(decoded[0]?.schemas).toEqual(["public"]);

            for (let value = 0; value < 5; value++)
              expect(yield* sql`SELECT ${value}::integer AS value`).toEqual([{ value }]);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL TimeZone = 'Europe/Oslo'`;
                expect(yield* sql`SELECT current_setting('TimeZone') AS zone`).toEqual([
                  { zone: "Europe/Oslo" },
                ]);
                const pids = yield* sql`SELECT pg_backend_pid() AS pid`;
                expect(yield* sql`SELECT pg_backend_pid() AS pid`).toEqual(pids);
              }),
            );
            expect(
              yield* sql`SELECT current_setting('TimeZone') AS zone, current_schemas(false) AS schemas`,
            ).toEqual(before);

            const rolledBack = yield* Effect.exit(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`SET LOCAL TimeZone = 'Pacific/Auckland'`;

                  return yield* new PoolerProbeRollback();
                }),
              ),
            );

            expect(rolledBack._tag).toBe("Failure");
            expect(
              yield* sql`SELECT current_setting('TimeZone') AS zone, current_schemas(false) AS schemas`,
            ).toEqual(before);
          }),
        ),
    );
    it.effect(
      "commits the application, its receipt, both envelopes, and their queue items together, or none, through PgBouncer in transaction mode",
      () =>
        Effect.gen(function* () {
          const { confirmation } = yield* Database.use((sql) =>
            sql.withTransaction(submitCommand("pooled-commit")),
          );

          expect(yield* poolMode("pilot")).toEqual(["transaction"]);
          expect(
            yield* count(
              `FROM team_applications WHERE application_id = '${confirmation.applicationId}'`,
            ),
          ).toBe(1);
          expect(
            yield* count(
              `FROM team_application_command_receipts WHERE command_id = 'pooled-commit'`,
            ),
          ).toBe(1);
          expect(
            yield* count(
              `FROM team_application_outbox WHERE command_id = 'pooled-commit'
                AND status = 'Pending' AND payload_json <> '{}'::jsonb`,
            ),
          ).toBe(2);
          expect(
            yield* count(`FROM effect_queue WHERE id LIKE 'pooled-commit:%' AND state = 'pending'`),
          ).toBe(2);

          const rolledBack = yield* Effect.exit(
            Database.use((sql) =>
              sql.withTransaction(
                submitCommand("pooled-rollback").pipe(
                  Effect.andThen(Effect.fail("caller receipt failed")),
                ),
              ),
            ),
          );

          expect(rolledBack._tag).toBe("Failure");
          expect(
            yield* count(
              `FROM team_application_command_receipts WHERE command_id = 'pooled-rollback'`,
            ),
          ).toBe(0);
          expect(yield* count(`FROM team_applications WHERE team_id = 'pooled-team'`)).toBe(1);
          expect(
            yield* count(`FROM team_application_outbox WHERE command_id = 'pooled-rollback'`),
          ).toBe(0);
          expect(yield* count(`FROM effect_queue WHERE id LIKE 'pooled-rollback:%'`)).toBe(0);
        }),
    );

    it.effect("takes, leases, and settles the queued notifications through the pooler", () =>
      Effect.gen(function* () {
        const deliveries: Array<MailDeliveryRequest> = [];

        const mail = Layer.succeed(
          Mail,
          Mail.of({
            deliver: (request) =>
              Effect.sync(() => {
                deliveries.push(request);

                return { providerReference: `pooled:${request.deliveryId}` };
              }),
          }),
        );

        const deliverNext = TeamApplications.use((service) =>
          service.deliverNextOutboxEffect("noreply@example.invalid", Duration.seconds(5)),
        ).pipe(Effect.provide(mail));

        expect([yield* deliverNext, yield* deliverNext]).toEqual(
          ["pooled-commit:SendTeamApplicationReceipt", "pooled-commit:NotifyTeamOfApplication"].map(
            (effectId) => TeamApplicationOutboxDelivery.Delivered({ effectId }),
          ),
        );
        expect(deliveries.map(({ deliveryId }) => deliveryId)).toEqual([
          "pooled-commit:SendTeamApplicationReceipt",
          "pooled-commit:NotifyTeamOfApplication",
        ]);
        expect(
          yield* count(
            `FROM team_application_delivery_state WHERE command_id = 'pooled-commit'
              AND status = 'Delivered' AND attempts = 1`,
          ),
        ).toBe(2);
      }),
    );
  },
);
