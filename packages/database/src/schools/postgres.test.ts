import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SchoolDirectoryScopeSchema } from "@vektorprogrammet/domain/schools";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { listSchoolDirectoryPostgres } from "./postgres.js";

const suiteLayer = DatabaseTestLive();

layer(suiteLayer, { excludeTestServices: true, timeout: "30 seconds" })((it) => {
  it.effect(
    "rejects a persisted school that fails the directory schema",
    () =>
      Effect.gen(function* () {
        const observed = yield* Effect.gen(function* () {
          const sql = yield* Database;
          // PostgreSQL btrim accepts a tab; the domain requires visible name text.
          yield* sql`
    INSERT INTO schools_directory_schools (
      name, contact_person, email, phone, language, active
    ) VALUES (${"\t"}, 'Strict Contact', 'strict@example.invalid',
      '+47 900 00 020', 'Norwegian', TRUE)
  `;
          const scope = SchoolDirectoryScopeSchema.cases.All.make({});
          const failure = yield* Effect.flip(listSchoolDirectoryPostgres({ scope }));
          yield* sql`UPDATE schools_directory_schools SET name = 'Strict School'`;
          const repaired = yield* listSchoolDirectoryPostgres({ scope });

          return { failure, repaired };
        });

        expect(observed.failure._tag).toBe("SchoolsDecodeError");
        expect(observed.repaired.activeSchools[0]?.name).toBe("Strict School");
      }),
    15_000,
  );
});
