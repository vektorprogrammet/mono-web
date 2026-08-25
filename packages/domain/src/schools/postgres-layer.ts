import { Effect, Layer } from "effect";
import { Database } from "../database/service.js";
import { listSchoolDirectoryPostgres } from "./postgres.js";
import { Schools } from "./service.js";

/** Live Schools authority; it reuses the process Database and constructs no runtime. */
export const SchoolsLive: Layer.Layer<Schools, never, Database> = Layer.effect(
  Schools,
  Effect.gen(function* () {
    const database = yield* Database;
    return Schools.of({
      listDirectory: (input) =>
        listSchoolDirectoryPostgres(input).pipe(Effect.provideService(Database, database)),
    });
  }),
);
