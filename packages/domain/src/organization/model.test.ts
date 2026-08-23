import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  Department,
  Membership,
  MembershipInvariantSchema,
  Team,
} from "./schema.js";

const keys = (fields: object): ReadonlyArray<string> => Object.keys(fields).sort();

it("derives strict Department, Team, and Membership variants from their Models", () => {
  expect(keys(Department.fields)).toEqual([
    "active",
    "address",
    "city",
    "departmentId",
    "email",
    "latitude",
    "logoPath",
    "longitude",
    "name",
    "revision",
    "shortName",
    "slackChannel",
  ]);
  expect(keys(Department.insert.fields)).not.toContain("revision");
  expect(keys(Department.update.fields)).not.toContain("departmentId");
  expect(keys(Department.json.fields)).toContain("revision");

  expect(keys(Team.fields)).toEqual([
    "acceptApplication",
    "active",
    "deadline",
    "departmentId",
    "description",
    "email",
    "name",
    "revision",
    "shortDescription",
    "teamId",
  ]);
  expect(keys(Team.insert.fields)).not.toContain("revision");
  expect(keys(Team.update.fields)).not.toContain("teamId");

  expect(keys(Membership.fields)).toEqual([
    "deletedTeamName",
    "endAt",
    "isSuspended",
    "isTeamLeader",
    "membershipId",
    "personId",
    "positionId",
    "revision",
    "startAt",
    "teamId",
  ]);
  expect(keys(Membership.insert.fields)).not.toContain("revision");
  expect(keys(Membership.update.fields)).not.toContain("membershipId");
  expect(keys(Membership.json.fields)).not.toContain("deletedTeamName");
  expect(keys(Membership.jsonUpdate.fields)).not.toContain("teamId");
});

it.effect("decodes branded records and rejects excess or invalid persisted values", () => {
  const selected = {
    membershipId: "membership-1",
    personId: "person-1",
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
