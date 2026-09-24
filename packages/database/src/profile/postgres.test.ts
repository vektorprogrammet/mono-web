import { afterAll, expect, it } from "vitest";
import { Effect, Layer, Predicate } from "effect";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Database } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import { readDirectoryPage, readOwnProfileHttpSourcePostgres } from "./postgres.js";

const runtime = makeControlledTestRuntime(
  OrganizationLive.pipe(Layer.provideMerge(DatabaseTest())),
);

afterAll(() => runtime.dispose());

it("fails the whole directory page when a scanned person has no contact row", async () => {
  const missing = PersonId.make("person-directory-missing-contact");
  const present = PersonId.make("person-directory-with-contact");

  const failure = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name)
        VALUES (${missing}, 'Ann', 'Aardvark'), (${present}, 'Bob', 'Zebra')
      `;
      yield* sql`
        INSERT INTO person_contact_profiles (person_id, email, phone)
        VALUES (${present}, 'bob@example.invalid', '+4700000001')
      `;

      return yield* Effect.flip(readDirectoryPage({ limit: 10 }));
    }),
  );

  expect(failure._tag).toBe("ProfileContactNotFound");

  if (!Predicate.isTagged(failure, "ProfileContactNotFound")) {
    throw new Error("Expected a missing contact failure");
  }

  expect(failure.personId).toBe(missing);
}, 15_000);

it("reads the persisted Profile HTTP representation revision with the profile snapshot", async () => {
  const personId = PersonId.make("person-profile-http-source");

  const source = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* Database;
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name, revision)
        VALUES (${personId}, 'Ada', 'Lovelace', 4)
      `;
      yield* sql`
        INSERT INTO person_contact_profiles (person_id, email, phone, revision)
        VALUES (${personId}, 'ada@example.invalid', '+4712345678', 6)
      `;
      yield* sql`
        UPDATE profile_http_versions SET representation_revision = 9
        WHERE person_id = ${personId}
      `;

      return yield* readOwnProfileHttpSourcePostgres(personId);
    }),
  );

  expect(source.representationRevision).toBe(9);
  expect(source.profile).toEqual({
    personId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.invalid",
    phone: "+4712345678",
    nameRevision: 4,
    contactRevision: 6,
  });
}, 15_000);
