import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Auth,
  AuthEngineError,
  AuthenticatedActor,
  AuthSessionExpired,
  AuthSessionNotFound,
  type AuthShape,
} from "@vektorprogrammet/domain/auth";
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
  (auth: AuthShape): AuthorityResolutionOptions["run"] =>
  <A, E>(effect: Effect.Effect<A, E, Organization | Auth>): Promise<A> => {
    const runnable = effect.pipe(Effect.provideService(Auth, auth)) as Effect.Effect<A, E>;
    return runTestPromise(runnable);
  };

const rejectingAuth = (failure: unknown): AuthShape => ({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: () => Promise.reject(failure),
  signOut: () => Promise.resolve(),
});

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
  const run = makeRun(auth);
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
  ["missing", new AuthSessionNotFound({ sessionToken: "missing-session" })],
  ["expired", new AuthSessionExpired({ sessionToken: "expired-session" })],
] as const)("maps a %s session to unauthenticated authority", async (_name, failure) => {
  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=invalid", {
      run: makeRun(rejectingAuth(failure)),
    }),
  ).rejects.toBeInstanceOf(UnauthenticatedActor);
});

it("preserves a typed authentication engine failure", async () => {
  const failure = new AuthEngineError({
    operation: "getSession",
    message: "authentication provider unavailable",
  });

  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=provider-failure", {
      run: makeRun(rejectingAuth(failure)),
    }),
  ).rejects.toBe(failure);
});

it("maps an unknown session provider rejection to typed infrastructure", async () => {
  await expect(
    resolveAuthenticatedPerson("better-auth.session_token=provider-failure", {
      run: makeRun(rejectingAuth(new Error("connection refused"))),
    }),
  ).rejects.toMatchObject({
    _tag: "AuthEngineError",
    operation: "resolveSession",
    message: "connection refused",
  });
});
