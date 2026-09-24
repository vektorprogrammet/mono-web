import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { PersonId, Membership, MembershipInvariantSchema } from "./schema.js";

it.effect("decodes branded records and rejects excess or invalid persisted values", () => {
  const selected = {
    membershipId: "membership-1",
    personId: PersonId.make("person-1"),
    teamId: "team-1",
    deletedTeamName: null,
    startAt: "2026-08-20T10:00:00.000Z",
    endAt: "2026-09-20T10:00:00.000Z",
    positionId: "position-1",
    isTeamLeader: false,
    isSuspended: false,
    revision: 0,
  } as const;

  return Effect.gen(function* () {
    const membership = yield* Schema.decodeUnknownEffect(MembershipInvariantSchema)(selected, {
      onExcessProperty: "error",
    });

    expect(membership.membershipId).toBe("membership-1");

    const excess = yield* Effect.flip(
      Schema.decodeUnknownEffect(MembershipInvariantSchema)(
        { ...selected, duplicateAuthority: true },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(excess)).toContain("duplicateAuthority");

    const invalidEnd = yield* Effect.flip(
      Schema.decodeUnknownEffect(MembershipInvariantSchema)(
        { ...selected, endAt: "2026-08-20T09:00:00.000Z" },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(invalidEnd)).toContain("membership");

    const missingHistory = yield* Effect.flip(
      Schema.decodeUnknownEffect(MembershipInvariantSchema)(
        { ...selected, teamId: null, deletedTeamName: null },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(missingHistory)).toContain("membership");

    const fractionalRevision = yield* Effect.flip(
      Schema.decodeUnknownEffect(MembershipInvariantSchema)(
        { ...selected, revision: 1.5 },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(fractionalRevision)).toContain("revision");
  });
});

it("keeps immutable and private membership fields out of update projections", () => {
  expect(Object.keys(Membership.update.fields)).not.toContain("deletedTeamName");
  expect(Object.keys(Membership.jsonUpdate.fields)).not.toContain("deletedTeamName");
  expect(Object.keys(Membership.json.fields)).not.toContain("deletedTeamName");
});
