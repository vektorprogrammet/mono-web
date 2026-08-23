import { expect, it } from "@effect/vitest";
import {
  importLegacyOrganization,
  type LegacyOrganizationSnapshot,
} from "./import.js";

const snapshot = (memberships: ReadonlyArray<unknown>): LegacyOrganizationSnapshot => ({
  sourceRepository: "legacy-db",
  sourceRevision: "2026-08-23",
  snapshotId: "snapshot-organization-1",
  transformationRevision: "organization-0048.1",
  departments: [
    {
      id: 1,
      name: "Engineering",
      shortName: "ENG",
      email: "eng@example.test",
      city: "Trondheim",
      active: true,
    },
  ],
  teams: [
    {
      id: 10,
      departmentId: 1,
      name: "Platform",
      email: "platform@example.test",
      active: true,
    },
  ],
  memberships,
});

it("accepts resolved memberships and preserves valid multi-position identities", () => {
  const result = importLegacyOrganization(
    snapshot([
      {
        id: 100,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
        positionId: 1,
        isTeamLeader: true,
        isSuspended: false,
      },
      {
        id: 101,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
        positionId: 2,
        isTeamLeader: false,
        isSuspended: false,
      },
    ]),
  );
  expect(result.memberships).toHaveLength(2);
  expect(result.quarantined).toHaveLength(0);
  expect(result.ledger.filter((entry) => entry.result === "Accepted")).toHaveLength(4);
});

it("quarantines duplicate memberships deterministically", () => {
  const result = importLegacyOrganization(
    snapshot([
      {
        id: 102,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
        positionId: 1,
      },
      {
        id: 101,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
        positionId: 1,
      },
    ]),
  );
  expect(result.memberships.map((item) => item.membershipId)).toEqual(["101"]);
  expect(result.quarantined[0]?.reason).toBe("DUPLICATE_MEMBERSHIP");
  expect(result.quarantined[0]?.sourcePrimaryKey).toBe("102");
});

it("retains named nullable-team history and quarantines nameless null-team rows", () => {
  const result = importLegacyOrganization(
    snapshot([
      {
        id: 103,
        userId: 8,
        teamId: null,
        deletedTeamName: "Archived Platform",
        startAt: "2025-08-01T00:00:00.000Z",
        endAt: "2026-07-31T23:59:59.000Z",
      },
      {
        id: 104,
        userId: 9,
        teamId: null,
        deletedTeamName: null,
        startAt: "2025-08-01T00:00:00.000Z",
        endAt: null,
      },
    ]),
  );
  expect(result.memberships).toHaveLength(1);
  expect(result.memberships[0]?.teamId).toBeNull();
  expect(result.memberships[0]?.deletedTeamName).toBe("Archived Platform");
  expect(result.quarantined[0]?.reason).toBe("NULL_TEAM_WITHOUT_HISTORICAL_NAME");
});

it("does not guess a temporal interval from legacy semester IDs", () => {
  const result = importLegacyOrganization(
    snapshot([
      {
        id: 105,
        userId: 10,
        teamId: 10,
        startSemesterId: 1,
        endSemesterId: 2,
        positionId: 1,
      },
    ]),
  );
  expect(result.memberships).toHaveLength(0);
  expect(result.quarantined[0]?.reason).toBe("MISSING_TEMPORAL_INTERVAL");
});
