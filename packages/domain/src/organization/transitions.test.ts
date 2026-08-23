import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { MembershipInvariantSchema, Membership } from "./schema.js";
import {
  MembershipRevisionCommandSchema,
  membershipIsActiveAt,
  reviseMembership,
  suspendMembership,
  reinstateMembership,
} from "./transitions.js";

const membership = (isSuspended = false): Membership =>
  Schema.decodeUnknownSync(MembershipInvariantSchema)({
    membershipId: "membership-transition-1",
    personId: "person-1",
    teamId: "team-1",
    deletedTeamName: null,
    startAt: "2026-08-20T10:00:00.000Z",
    endAt: "2026-09-20T10:00:00.000Z",
    positionId: null,
    isTeamLeader: false,
    isSuspended,
    revision: 0,
  });

it("keeps temporal and suspension dimensions independent", () => {
  const current = membership();
  expect(membershipIsActiveAt(current, "2026-08-20T10:00:00.000Z")).toBe(true);
  expect(membershipIsActiveAt(current, "2026-09-20T10:00:00.000Z")).toBe(false);
  expect(membershipIsActiveAt({ ...current, isSuspended: true }, "2026-08-21T10:00:00.000Z")).toBe(
    false,
  );
  expect(membershipIsActiveAt({ ...current, isSuspended: true }, "2026-09-21T10:00:00.000Z")).toBe(
    false,
  );
});

it.effect("revises only permitted dimensions and rejects stale or invalid transitions", () => {
  const current = membership();
  return Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(MembershipRevisionCommandSchema)({
      _tag: "ReviseMembership",
      membershipId: "membership-transition-1",
      expectedRevision: 0,
      endAt: "2026-10-01T10:00:00.000Z",
      positionId: "position-1",
      isTeamLeader: true,
      isSuspended: false,
    });
    if (command._tag !== "ReviseMembership") {
      return yield* Effect.fail(new Error("expected ReviseMembership"));
    }
    const next = yield* reviseMembership(current, command);
    expect(next.revision).toBe(1);
    expect(next.startAt).toBe(current.startAt);
    expect(next.teamId).toBe(current.teamId);
    expect(next.endAt).toBe("2026-10-01T10:00:00.000Z");

    const stale = yield* Effect.flip(
      reviseMembership(current, { ...command, expectedRevision: 4 }),
    );
    expect(stale._tag).toBe("MembershipStaleRevision");

    const invalid = yield* Effect.flip(
      reviseMembership(current, { ...command, endAt: "2026-08-01T10:00:00.000Z" }),
    );
    expect(invalid._tag).toBe("MembershipInvalidInterval");

    const suspendCommand = yield* Schema.decodeUnknownEffect(MembershipRevisionCommandSchema)({
      _tag: "SuspendMembership",
      membershipId: "membership-transition-1",
      expectedRevision: 0,
    });
    if (suspendCommand._tag !== "SuspendMembership") {
      return yield* Effect.fail(new Error("expected SuspendMembership"));
    }
    const suspended = yield* suspendMembership(current, suspendCommand);
    expect(suspended.isSuspended).toBe(true);
    expect(suspended.startAt).toBe(current.startAt);
    expect(suspended.endAt).toBe(current.endAt);

    const reinstateCommand = yield* Schema.decodeUnknownEffect(MembershipRevisionCommandSchema)({
      _tag: "ReinstateMembership",
      membershipId: "membership-transition-1",
      expectedRevision: 1,
    });
    if (reinstateCommand._tag !== "ReinstateMembership") {
      return yield* Effect.fail(new Error("expected ReinstateMembership"));
    }
    const reinstated = yield* reinstateMembership(suspended, reinstateCommand);
    expect(reinstated.isSuspended).toBe(false);
  });
});

it.effect("does not accept immutable membership fields through a revision boundary", () =>
  Effect.flip(
    Schema.decodeUnknownEffect(MembershipRevisionCommandSchema)(
      {
        _tag: "ReviseMembership",
        membershipId: "membership-transition-1",
        expectedRevision: 0,
        endAt: "2026-10-01T10:00:00.000Z",
        positionId: null,
        isTeamLeader: false,
        isSuspended: false,
        teamId: "other-team",
      },
      { onExcessProperty: "error" },
    ),
  ).pipe(Effect.tap((failure) => Effect.sync(() => expect(String(failure)).toContain("teamId")))),
);
