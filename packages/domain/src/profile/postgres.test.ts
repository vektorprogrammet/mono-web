import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { PersonId } from "../organization/schema.js";
import { ProfileContactNotFound } from "./errors.js";
import { readDirectoryPage, readOwnProfileHttpSourcePostgres } from "./postgres.js";

interface DirectoryRow {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

it.effect("fails the whole directory page when a scanned person has no contact row", () =>
  Effect.gen(function* () {
    const missing = PersonId.make("person-directory-missing-contact");
    const present = PersonId.make("person-directory-with-contact");
    const nameRows: ReadonlyArray<DirectoryRow> = [
      { personId: missing, firstName: "Ann", lastName: "Aardvark", email: null, phone: null },
      {
        personId: present,
        firstName: "Bob",
        lastName: "Zebra",
        email: "bob@example.invalid",
        phone: "+4700000001",
      },
    ];
    const sql = ((_strings: TemplateStringsArray) => {
      // Emulate the join over person_profiles x person_contact_profiles: the
      // second person has a contact row, the first does not. An INNER JOIN
      // silently drops the contact-less person from the scan; a LEFT JOIN
      // keeps them with NULL contacts for the typed null-check to reject.
      const joinsContacts = _strings.join("?").includes("LEFT JOIN");
      return Effect.succeed(
        joinsContacts ? nameRows : nameRows.filter((row) => row.email !== null),
      );
    }) as unknown as DatabaseShape;
    const failure = yield* Effect.flip(
      readDirectoryPage({ limit: 10 }).pipe(
        Effect.provideService(Database, sql),
        Effect.provideService(Organization, {} as never),
      ),
    );
    expect(failure._tag).toBe("ProfileContactNotFound");
    expect((failure as ProfileContactNotFound).personId).toBe(missing);
  }),
);

it.effect(
  "reads the persisted Profile HTTP representation revision with the profile snapshot",
  () =>
    Effect.gen(function* () {
      const personId = PersonId.make("person-profile-http-source");
      let statement = "";
      const sql = ((strings: TemplateStringsArray) => {
        statement = strings.join("?");
        return Effect.succeed([
          {
            personId,
            firstName: "Ada",
            lastName: "Lovelace",
            nameRevision: 4,
            representationRevision: 9,
            contactPersonId: personId,
            email: "ada@example.invalid",
            phone: "+4712345678",
            contactRevision: 6,
          },
        ]);
      }) as unknown as DatabaseShape;

      const source = yield* readOwnProfileHttpSourcePostgres(personId).pipe(
        Effect.provideService(Database, sql),
      );
      expect(statement).toContain("INNER JOIN public.profile_http_versions");

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
    }),
);
