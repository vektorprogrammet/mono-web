import { Database } from "@vektorprogrammet/database";
import { Cause, Context, Duration, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterEach } from "vitest";
import { backendPostgres } from "./postgres.js";

const postgres = backendPostgres();

/** Releases the databases that the running test acquired. */
const active = new Set<Effect.Effect<void>>();

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const releases = [...active];
      active.clear();
      const exits = yield* Effect.forEach(releases, Effect.exit);

      const failures = exits.flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );

      if (failures.length > 0)
        return yield* Effect.die(new AggregateError(failures, "Database fixture cleanup failed"));
    }),
  ),
);

/** A migrated PostgreSQL engine retained across requests, never across test cases. */
export const backendDatabase = <E>(seed: Effect.Effect<void, E, Database> = Effect.void) => {
  const [database, forget] = Effect.runSync(
    Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        const created = yield* postgres.createDatabase;
        const runtime = ManagedRuntime.make(created.layer);

        active.add(
          forget.pipe(
            Effect.andThen(runtime.disposeEffect),
            Effect.ensuring(Effect.orDie(created.drop)),
          ),
        );

        const context = yield* runtime.contextEffect;
        yield* Effect.provide(seed, context);

        return context;
      }).pipe(Effect.orDie),
      Duration.infinity,
    ),
  );

  return {
    /** Provides the test's database to a request's services. */
    layer: Layer.effect(Database, Effect.map(database, Context.get(Database))),
    /** Runs in the test's database. */
    run: <A, Failure>(effect: Effect.Effect<A, Failure, Database>) =>
      Effect.flatMap(database, (context) => Effect.provide(effect, context)),
  };
};
