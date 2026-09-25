import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll } from "vitest";

const exec = promisify(execFile);

const isStopped = Schema.is(Schema.Struct({ code: Schema.Literal(3) }));

/** Independent PostgreSQL sessions on a private Unix socket, with no TCP listener. */
export const backendPostgres = () => {
  let root: string | undefined;
  let startupAttempted = false;
  let databaseSequence = 0;
  let primary: ManagedRuntime.ManagedRuntime<Database, never> | undefined;
  let contender: ManagedRuntime.ManagedRuntime<Database, never> | undefined;
  let migratedTemplate: Promise<string> | undefined;

  const connection = (database: string) => ({
    host: root,
    database,
    username: "postgres",
    maxConnections: 1,
  });

  /** Migrates once per cluster; fixtures clone it instead of replaying every migration. */
  const template = (admin: ManagedRuntime.ManagedRuntime<Database, never>) =>
    (migratedTemplate ??= (async () => {
      const name = "backend_fixture_template";
      await admin.runPromise(Database.use((sql) => sql`CREATE DATABASE ${sql(name)}`));
      const migrator = ManagedRuntime.make(DatabaseLive(connection(name)).pipe(Layer.orDie));

      try {
        await migrator.runPromise(Database.use((sql) => sql.health));
      } finally {
        await migrator.dispose();
      }

      return name;
    })());

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vkr-http-pg-"));
    await exec(
      "initdb",
      [
        "-D",
        root,
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=reject",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { timeout: 15_000 },
    );
    startupAttempted = true;
    await exec(
      "pg_ctl",
      ["-D", root, "-o", `-h '' -k ${root} -F`, "-l", join(root, "postgres.log"), "-w", "start"],
      { timeout: 15_000 },
    );
    const config = { host: root, database: "postgres", username: "postgres", maxConnections: 1 };
    primary = ManagedRuntime.make(DatabaseLive(config).pipe(Layer.orDie));
    await primary.runPromise(Database.use((sql) => sql.health));
    contender = ManagedRuntime.make(DatabaseLive(config).pipe(Layer.orDie));
    await contender.runPromise(Database.use((sql) => sql.health));
  }, 30_000);

  afterAll(async () => {
    try {
      await contender?.dispose();
    } finally {
      try {
        await primary?.dispose();
      } finally {
        if (root !== undefined) {
          if (startupAttempted) {
            const running = await exec("pg_ctl", ["-D", root, "status"]).then(
              () => true,
              (cause) => {
                if (isStopped(cause)) return false;
                throw cause;
              },
            );

            if (running) {
              await exec("pg_ctl", ["-D", root, "-m", "immediate", "-w", "stop"], {
                timeout: 15_000,
              });
            }
          }

          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);

  return {
    createDatabase: async () => {
      if (primary === undefined || root === undefined)
        throw new Error("PostgreSQL fixture is not initialized");

      const admin = primary;
      const source = await template(admin);
      const name = `backend_fixture_${++databaseSequence}`;
      await admin.runPromise(
        Database.use((sql) => sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(source)}`),
      );

      return {
        layer: DatabaseLive(connection(name)).pipe(Layer.orDie),
        drop: () => admin.runPromise(Database.use((sql) => sql`DROP DATABASE ${sql(name)}`)),
      };
    },
    run: <A, E>(effect: Effect.Effect<A, E, Database>): Promise<A> => {
      if (primary === undefined) throw new Error("PostgreSQL fixture is not initialized");

      return primary.runPromise(effect);
    },
    compete: <A, E>(effect: Effect.Effect<A, E, Database>): Promise<A> => {
      if (contender === undefined) throw new Error("PostgreSQL fixture is not initialized");

      return contender.runPromise(effect);
    },
  };
};
