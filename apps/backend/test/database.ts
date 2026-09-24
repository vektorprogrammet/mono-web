import { Database } from "@vektorprogrammet/database";
import { backendPostgres } from "./postgres.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach } from "vitest";

const postgres = backendPostgres();

const active = new Set<() => Promise<void>>();

afterEach(async () => {
  const failures = [];

  for (const close of active) {
    active.delete(close);

    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, "Database fixture cleanup failed");
});

/** A migrated PostgreSQL engine retained across requests, never across test cases. */
export const backendDatabase = <E>(seed: Effect.Effect<void, E, Database> = Effect.void) => {
  let initialized: Promise<ManagedRuntime.ManagedRuntime<Database, never>> | undefined;

  const acquire = () => {
    initialized ??= (async () => {
      const database = await postgres.createDatabase();
      const runtime = ManagedRuntime.make(database.layer);
      active.add(async () => {
        initialized = undefined;

        try {
          await runtime.dispose();
        } finally {
          await database.drop();
        }
      });
      await runtime.runPromise(seed);

      return runtime;
    })();

    return initialized;
  };

  const run = async <A, Error>(effect: Effect.Effect<A, Error, Database>): Promise<A> =>
    (await acquire()).runPromise(effect);

  return {
    layer: Layer.effect(
      Database,
      Effect.promise(() => run(Database)),
    ),
    run,
  };
};
