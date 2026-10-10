import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Result, Schema } from "effect";
import {
  IdentityActor,
  IdentitySecurityEvent,
  IdentitySession,
  decodeIdentityActor,
} from "./identity/index.js";
import { PersonId } from "./organization/schema.js";

const instant = (text: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(text));

it.effect("decodes session actors to the canonical Organization PersonId", () =>
  Effect.gen(function* () {
    const actor = yield* decodeIdentityActor({
      personId: PersonId.make("person-identity-test"),
      sessionId: "session-identity-test",
      expiresAt: instant("2032-05-01T12:00:00.000Z"),
    });

    expect(actor).toBeInstanceOf(IdentityActor);
    expect(actor.personId).toBe(PersonId.make("person-identity-test"));
  }),
);

it.effect("rejects an identity actor without a canonical person id", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      decodeIdentityActor({
        personId: "",
        sessionId: "session-identity-test",
        expiresAt: instant("2032-05-01T12:00:00.000Z"),
      }),
    );

    expect(exit._tag).toBe("Failure");
  }),
);

it("accepts only credential-free native session metadata", () => {
  const session = {
    sessionId: "opaque-session-id",
    createdAt: instant("2032-04-01T12:00:00.000Z"),
    updatedAt: instant("2032-04-02T12:00:00.000Z"),
    expiresAt: instant("2032-05-01T12:00:00.000Z"),
    ipAddress: "127.0.0.1",
    userAgent: "identity-test",
    current: true,
  };

  const decodeSession = Schema.decodeUnknownResult(IdentitySession, { onExcessProperty: "error" });

  expect(
    Result.getOrThrow(Schema.decodeResult(IdentitySession, { onExcessProperty: "error" })(session)),
  ).toBeInstanceOf(IdentitySession);
  expect(Result.isFailure(decodeSession({ ...session, token: "must-not-be-exposed" }))).toBe(true);
  expect(
    Result.isFailure(
      decodeSession({ ...session, personId: PersonId.make("person-identity-test") }),
    ),
  ).toBe(true);
});

it("keeps identity security events closed, bounded, and request-correlated", () => {
  const event = {
    eventKind: "sign-in-failure",
    subjectPersonId: null,
    sessionId: null,
    actorPrincipal: null,
    requestCorrelation: "identity-test-request",
    sourceIp: "127.0.0.1",
    userAgent: "identity-test",
    details: {
      outcomeCode: "credential-rejected",
      affectedSessionCount: 0,
    },
  };

  const decodeEvent = Schema.decodeUnknownResult(IdentitySecurityEvent, {
    onExcessProperty: "error",
  });

  expect(Result.getOrThrow(decodeEvent(event))).toBeInstanceOf(IdentitySecurityEvent);
  expect(Result.isFailure(decodeEvent({ ...event, eventKind: "arbitrary-provider-event" }))).toBe(
    true,
  );
  expect(
    Result.isFailure(
      decodeEvent({
        ...event,
        details: {
          ...event.details,
          affectedSessionCount: 10_001,
          password: "must-not-persist",
        },
      }),
    ),
  ).toBe(true);
});
