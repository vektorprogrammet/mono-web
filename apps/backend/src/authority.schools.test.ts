import { Auth, AuthenticatedActor, type AuthShape } from "@vektorprogrammet/domain/auth";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect } from "effect";
import { expect, it } from "vitest";
import {
  resolveAuthenticatedPersonAtInstant,
  type AuthorityResolutionOptions,
} from "./authority.js";

it("captures the Schools authorization instant exactly once after session decoding", async () => {
  const events: Array<string> = [];
  const auth = Auth.of({
    signIn: () => Promise.reject(new Error("unexpected sign-in")),
    resolveSession: async () => {
      events.push("session");
      return new AuthenticatedActor({
        personId: "schools-authority-person" as never,
        sessionId: "schools-session",
        expiresAt: DateTime.makeUnsafe(new Date("2032-05-02T00:00:00.000Z")),
      });
    },
    signOut: () => Promise.resolve(),
  } satisfies AuthShape);
  const run: AuthorityResolutionOptions["run"] = <A, E>(
    effect: Effect.Effect<A, E, Organization | Auth>,
  ): Promise<A> => {
    const runnable = effect.pipe(Effect.provideService(Auth, auth)) as Effect.Effect<A, E>;
    return Effect.runPromise(runnable);
  };
  let clockCalls = 0;

  const actor = await resolveAuthenticatedPersonAtInstant("session=valid", {
    run,
    now: () => {
      clockCalls += 1;
      events.push("now");
      return "2032-05-01T12:00:00.000Z";
    },
  });

  expect(actor).toEqual({
    personId: "schools-authority-person",
    authorizationInstant: "2032-05-01T12:00:00.000Z",
  });
  expect(clockCalls).toBe(1);
  expect(events).toEqual(["session", "now"]);
});
