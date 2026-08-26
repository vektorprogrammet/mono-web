import { Effect } from "effect";
import { expect, it } from "vitest";
import { IdentityActor, decodeIdentityActor } from "./identity/index.js";
import { PersonId } from "./organization/schema.js";

it("decodes session actors to the canonical Organization PersonId", async () => {
  const actor = await Effect.runPromise(
    decodeIdentityActor({
      personId: "person-identity-test",
      sessionId: "session-identity-test",
      expiresAt: new Date("2032-05-01T12:00:00.000Z"),
    }),
  );

  expect(actor).toBeInstanceOf(IdentityActor);
  expect(actor.personId).toBe(PersonId.make("person-identity-test"));
});

it("rejects an identity actor without a canonical person id", async () => {
  const exit = await Effect.runPromiseExit(
    decodeIdentityActor({
      personId: "",
      sessionId: "session-identity-test",
      expiresAt: new Date("2032-05-01T12:00:00.000Z"),
    }),
  );

  expect(exit._tag).toBe("Failure");
});
