import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  Identity,
  IdentityEngineError,
  IdentityActor,
  IdentitySessionExpired,
  IdentitySessionNotFound,
  type IdentityOperations,
  type IdentitySessionFailure,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect } from "effect";
import { expect, it } from "@effect/vitest";
import { resolveAuthenticatedPerson, resolveAuthenticatedPersonAtInstant } from "./authority.js";

const unreachableSessionManagement = {
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} as const;

const failingIdentity = (failure: IdentitySessionFailure): IdentityOperations => ({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: () => Effect.fail(failure),
  ...unreachableSessionManagement,
});

it.effect("captures the Schools authorization instant exactly once after session decoding", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];

    const identity = Identity.of({
      signIn: () => Effect.die("unexpected sign-in"),
      resolveSession: () =>
        Effect.sync(() => {
          events.push("session");

          return new IdentityActor({
            personId: PersonId.make("schools-authority-person"),
            sessionId: "schools-session",
            expiresAt: DateTime.makeUnsafe("2032-05-02T00:00:00.000Z"),
          });
        }),
      ...unreachableSessionManagement,
    } satisfies IdentityOperations);

    let clockCalls = 0;

    const actor = yield* resolveAuthenticatedPersonAtInstant("session=valid", {
      now: () => {
        clockCalls += 1;
        events.push("now");

        return "2032-05-01T12:00:00.000Z";
      },
    }).pipe(Effect.provideService(Identity, identity));

    expect(actor).toEqual({
      personId: "schools-authority-person",
      authorizationInstant: "2032-05-01T12:00:00.000Z",
    });
    expect(clockCalls).toBe(1);
    expect(events).toEqual(["session", "now"]);
  }),
);

it.effect.each([
  ["missing", new IdentitySessionNotFound()],
  ["expired", new IdentitySessionExpired()],
] as const)("maps a %s session to unauthenticated authority", ([_name, failure]) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(
        resolveAuthenticatedPerson("better-auth.session_token=invalid").pipe(
          Effect.provideService(Identity, failingIdentity(failure)),
        ),
      ),
    ).toBeInstanceOf(UnauthenticatedActor);
  }),
);

it.effect("preserves a typed authentication engine failure", () =>
  Effect.gen(function* () {
    const failure = new IdentityEngineError({
      operation: "getSession",
      message: "authentication provider unavailable",
    });

    expect(
      yield* Effect.flip(
        resolveAuthenticatedPerson("better-auth.session_token=provider-failure").pipe(
          Effect.provideService(Identity, failingIdentity(failure)),
        ),
      ),
    ).toBe(failure);
  }),
);
