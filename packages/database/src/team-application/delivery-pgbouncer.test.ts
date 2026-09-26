import { expect, layer } from "@effect/vitest";
import {
  type DisposablePgBouncer,
  startDisposablePgBouncer,
  startDisposablePostgres,
} from "@monoweb/postgres";
import { Context, Duration, Effect, Layer, Redacted } from "effect";
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
import { pgQuery } from "../pg-pool.js";
import { Database } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { TeamApplicationsLive } from "./index.js";

/**
 * The transaction condition of the team-application PersistedQueue pilot on PostgreSQL through
 * PgBouncer in transaction mode (docs/specs/infrastructure-ports.md): every statement outside a
 * transaction may run on another server connection, and a transaction holds one.
 */
class Pooler extends Context.Service<Pooler, DisposablePgBouncer>()(
  "team-application/delivery-pgbouncer.test/Pooler",
) {}

/**
 * A cluster with the pilot database behind a transaction pooler. The database names the
 * application's search path: PgBouncer restores a client's startup `search_path` only where the
 * server reports it, which PostgreSQL 17 does not.
 */
const pooler = Layer.effect(
  Pooler,
  Effect.gen(function* () {
    const cluster = yield* Effect.acquireRelease(
      Effect.promise(() => startDisposablePostgres({ listen: "socket", database: "pilot" })),
      (started) => Effect.promise(() => started.stop()),
    );

    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: cluster.url, max: 1 })),
      (pool) => Effect.promise(() => pool.end()),
    );

    yield* pgQuery(admin, "ALTER DATABASE pilot SET search_path = auth, public").pipe(Effect.orDie);

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
      Effect.sync(() => new Pool({ connectionString: started.urlOf("pgbouncer"), max: 1 })),
      (pool) => Effect.promise(() => pool.end()),
    );

    // The admin console answers the simple query protocol, which a query without values uses.
    const { rows } = yield* pgQuery<{ readonly database: string; readonly pool_mode: string }>(
      admin,
      "SHOW POOLS",
    );

    return rows.filter((row) => row.database === database).map((row) => row.pool_mode);
  }).pipe(Effect.scoped);

layer(pooledLayer, { excludeTestServices: true, timeout: "120 seconds" })(
  "team application delivery through PgBouncer in transaction mode",
  (it) => {
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
