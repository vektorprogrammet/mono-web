import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityEngineError,
  IdentityActor,
  IdentitySessionExpired,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect } from "effect";
import { expect, it } from "vitest";
import {
  resolveAuthenticatedPerson,
  resolveAuthenticatedPersonAtInstant,
  type AuthorityResolutionOptions,
} from "./authority.js";
import { runTestPromise } from "../test/runtime.js";

const makeRun =
  (identity: IdentityShape): AuthorityResolutionOptions["run"] =>
  <A, E>(effect: Effect.Effect<A, E, Organization | Identity>): Promise<A> => {
    const runnable = effect.pipe(Effect.provideService(Identity, identity)) as Effect.Effect<A, E>;
    return runTestPromise(runnable);
  };

const rejectingIdentity = (failure: unknown): IdentityShape => ({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: () => Promise.reject(failure),
  signOut: () => Promise.resolve(),
});

it("captures the Schools authorization instant exactly once after session decoding", async () => {
  const events: Array<string> = [];
  const identity = Identity.of({
    signIn: () => Promise.reject(new Error("unexpected sign-in")),
    resolveSession: async () => {
      events.push("session");
      return new IdentityActor({
        personId: PersonId.make("schools-authority-person"),
        sessionId: "schools-session",
        expiresAt: DateTime.makeUnsafe(new Date("2032-05-02T00:00:00.000Z")),
      });
    },
    signOut: () => Promise.resolve(),
  } satisfies IdentityShape);
  const run = makeRun(identity);
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

it.each([
  ["missing", new IdentitySessionNotFound({ sessionToken: "missing-session" })],
  ["expired", new IdentitySessionExpired({ sessionToken: "expired-session" })],
] as const)("maps a %s session to unauthenticated authority", async (_name, failure) => {
  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=invalid", {
      run: makeRun(rejectingIdentity(failure)),
    }),
  ).rejects.toBeInstanceOf(UnauthenticatedActor);
});

it("preserves a typed authentication engine failure", async () => {
  const failure = new IdentityEngineError({
    operation: "getSession",
    message: "authentication provider unavailable",
  });

  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=provider-failure", {
      run: makeRun(rejectingIdentity(failure)),
    }),
  ).rejects.toBe(failure);
});

it("maps an unknown session provider rejection to typed infrastructure", async () => {
  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=provider-failure", {
      run: makeRun(rejectingIdentity(new Error("connection refused"))),
    }),
  ).rejects.toMatchObject({
    _tag: "IdentityEngineError",
    operation: "resolveSession",
    message: "connection refused",
  });
});
