import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Organization } from "./service.js";
import { Database } from "../database/service.js";
import { OrganizationLive } from "./postgres-layer.js";
import { MembershipInvariantSchema } from "./schema.js";

it.effect("decodes aliased PostgreSQL membership selections through the Model", () => {
  const selected = {
    membershipId: "membership-persisted-1",
    personId: "person-1",
    teamId: null,
    deletedTeamName: "Archived Platform",
    startAt: "2025-08-01T00:00:00.000Z",
    endAt: null,
    positionId: null,
    isTeamLeader: false,
    isSuspended: true,
    revision: 4,
  } as const;
  return Effect.gen(function* () {
    const membership = yield* Schema.decodeUnknownEffect(MembershipInvariantSchema)(selected, {
      onExcessProperty: "error",
    });
    expect(membership.teamId).toBeNull();
    expect(membership.deletedTeamName).toBe("Archived Platform");
    expect(membership.revision).toBe(4);
  });
});

it("keeps OrganizationLive open on Database instead of closing the capability", () => {
  const layer: Layer.Layer<Organization, never, Database> = OrganizationLive;
  expect(layer).toBeDefined();
});
