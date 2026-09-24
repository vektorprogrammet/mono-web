import assert from "node:assert/strict";
import { Database } from "@vektorprogrammet/database";
import { DatabaseTest } from "@vektorprogrammet/database/live";
import { SubstitutesLive } from "@vektorprogrammet/database/substitutes";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Substitutes } from "@vektorprogrammet/domain/substitutes";
import { Effect, Layer } from "effect";

// Fixture prerequisites only. No membership, coverage, or attendance is fabricated.
const database = DatabaseTest();

const layer = Layer.merge(database, SubstitutesLive.pipe(Layer.provide(database)));

const program = Effect.gen(function* () {
  yield* Database.use(
    (sql) =>
      sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES('example-semester','2026-01-01','2027-01-01')`,
  );
  const substitutes = yield* Substitutes;

  const scope = {
    departmentId: DepartmentId.make("example-department"),
    semesterId: SemesterId.make("example-semester"),
  };

  const pool = yield* substitutes.readPool(scope);
  assert.deepEqual(pool, { admissionPeriodId: null, entries: [] });

  const failure = yield* Effect.flip(
    substitutes.readPool({ ...scope, semesterId: SemesterId.make("missing-semester") }),
  );

  assert.equal(failure._tag, "SubstituteFailure");
  assert.equal(failure.code, "scope.invalid");
  assert.equal(failure.status, 422);
  console.log(
    "Known semester without an admission period: empty pool; unknown semester: scope.invalid (422)",
  );
});

const controller = new AbortController();

const interrupt = () => controller.abort();

process.once("SIGINT", interrupt);

process.once("SIGTERM", interrupt);

try {
  await Effect.runPromise(program.pipe(Effect.provide(layer)), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
