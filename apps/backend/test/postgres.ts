import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll } from "vitest";

/** Independent PostgreSQL sessions on a private Unix socket, with no TCP listener. */
export const backendPostgres = () => {
  let cluster: DisposablePostgres | undefined;
  let databaseSequence = 0;
  let primary: ManagedRuntime.ManagedRuntime<Database, never> | undefined;
  let contender: ManagedRuntime.ManagedRuntime<Database, never> | undefined;
  let migratedTemplate: Promise<string> | undefined;

  const connection = (database: string) => ({
    host: cluster?.socketDirectory,
    port: cluster?.port,
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
    cluster = await startDisposablePostgres({ listen: "socket" });
    primary = ManagedRuntime.make(DatabaseLive(connection("postgres")).pipe(Layer.orDie));
    await primary.runPromise(Database.use((sql) => sql.health));
    contender = ManagedRuntime.make(DatabaseLive(connection("postgres")).pipe(Layer.orDie));
    await contender.runPromise(Database.use((sql) => sql.health));
  }, 30_000);

  afterAll(async () => {
    try {
      await contender?.dispose();
    } finally {
      try {
        await primary?.dispose();
      } finally {
        await cluster?.stop();
      }
    }
  }, 30_000);

  return {
    createDatabase: async () => {
      if (primary === undefined || cluster === undefined)
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
