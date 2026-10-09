import { PersonId } from "../organization/schema.js";
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { PersonContactEmail, PersonProfile, personProfileDisplayName } from "./schema.js";

it("derives strict PersonProfile persistence variants", () => {
  expect(Object.keys(PersonProfile.fields).sort()).toEqual([
    "firstName",
    "lastName",
    "personId",
    "revision",
  ]);
  expect(Object.keys(PersonProfile.insert.fields)).not.toContain("revision");
  expect(Object.keys(PersonProfile.update.fields)).not.toContain("personId");
});

it.effect("decodes canonical names and rejects excess fields", () =>
  Effect.gen(function* () {
    const profile = yield* Schema.decodeEffect(PersonProfile)(
      { personId: PersonId.make("person-1"), firstName: "Ada", lastName: "Lovelace", revision: 0 },
      { onExcessProperty: "error" },
    );

    expect(personProfileDisplayName(profile)).toBe("Ada Lovelace");

    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(PersonProfile)(
        {
          personId: PersonId.make("person-1"),
          firstName: "Ada",
          lastName: "Lovelace",
          revision: 0,
          displayName: "Ada Lovelace",
        },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(failure)).toContain("displayName");
  }),
);

it("matches the persisted visible-ASCII email boundary", () => {
  const decodeEmail = Schema.decodeResult(PersonContactEmail);

  expect(Result.isSuccess(decodeEmail("ada@example.invalid"))).toBe(true);
  expect(Result.isFailure(decodeEmail("søker@example.invalid"))).toBe(true);
});
