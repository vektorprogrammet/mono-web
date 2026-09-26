import assert from "node:assert/strict";
import { DatabaseTestLive } from "@vektorprogrammet/database/test-support/platform";
import {
  DepartmentId,
  OrganizationPersonAuthoritySchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Placements } from "@vektorprogrammet/domain/placements";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import { Effect, Layer } from "effect";

// Synthetic, unprivileged authority for an empty disposable database.
// A production caller resolves current authority inside its own transaction.
const authority = OrganizationPersonAuthoritySchema.make({
  personId: PersonId.make("documentation-reader"),
  evaluatedAt: "2026-09-24T00:00:00.000Z",
  globalAdministrator: "Absent",
  memberships: [],
  nationalBoardSeats: [],
  delegations: [],
});

const program = Effect.gen(function* () {
  const placements = yield* Placements;
  const scopes = yield* placements.listScopes(authority);
  assert.deepEqual(scopes, { departments: [], semesters: [] });

  const rejected = yield* placements
    .readOwnAffiliation(authority.personId, DepartmentId.make("missing-department"))
    .pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: () => assert.fail("An unknown department must not produce an affiliation"),
      }),
    );

  assert.equal(rejected._tag, "PlacementFailure");
  assert.equal(rejected.code, "scope.invalid");
  assert.equal(rejected.status, 422);
  console.log("Empty scopes read; unknown department rejected with scope.invalid (422)");
});

// DatabaseTestLive owns in-memory PGlite, canonical migrations, and database release.
const layer = PlacementsLive.pipe(Layer.provide(DatabaseTestLive()));

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
