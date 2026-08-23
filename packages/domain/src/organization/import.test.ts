import { expect, it } from "@effect/vitest";
import { canonicalJson } from "../tutor/evidence.js";
import { importLegacyOrganization, type LegacyOrganizationSnapshot } from "./import.js";

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
  expect(result.memberships).toEqual([]);
  expect(result.quarantined.map((item) => item.reason)).toEqual([
    "DUPLICATE_MEMBERSHIP",
    "DUPLICATE_MEMBERSHIP",
  ]);
  expect(result.quarantined.map((item) => item.sourcePrimaryKey)).toEqual(["101", "102"]);
  expect(result.quarantined.map((item) => item.sourceOccurrence)).toEqual([0, 0]);
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

it("normalizes equivalent instants before duplicate classification", () => {
  const result = importLegacyOrganization(
    snapshot([
      {
        id: 102,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T02:00:00.000+02:00",
        endAt: null,
        positionId: null,
      },
      {
        id: 101,
        userId: 7,
        teamId: 10,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
        positionId: null,
      },
    ]),
  );
  expect(result.memberships).toEqual([]);
  expect(result.quarantined.map((item) => item.reason)).toEqual([
    "DUPLICATE_MEMBERSHIP",
    "DUPLICATE_MEMBERSHIP",
  ]);
});

it("derives stable malformed-row keys and deterministic output order", () => {
  const base = snapshot([]);
  const invalidRows = [{ id: "invalid-b" }, { id: "invalid-a" }];
  const first = importLegacyOrganization({
    ...base,
    departments: [...base.departments, ...invalidRows],
    teams: [...base.teams, { id: 11, departmentId: 1, name: "Second", active: true }],
  });
  const second = importLegacyOrganization({
    ...base,
    departments: [...[...invalidRows].reverse(), ...base.departments],
    teams: [{ id: 11, departmentId: 1, name: "Second", active: true }, ...base.teams],
  });
  expect(canonicalJson(first)).toBe(canonicalJson(second));
  expect(first.quarantined.every((item) => item.sourcePrimaryKey.startsWith("unknown:"))).toBe(
    true,
  );
});

it("keeps source kinds distinct when legacy primary keys overlap", () => {
  const base = snapshot([
    {
      id: 1,
      userId: 7,
      teamId: 1,
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: null,
      positionId: null,
    },
  ]);
  const result = importLegacyOrganization({
    ...base,
    teams: [{ id: 1, departmentId: 1, name: "Platform", active: true }],
  });
  expect(result.ledger.map((entry) => `${entry.sourceKind}:${entry.sourcePrimaryKey}`)).toEqual([
    "department:1",
    "team:1",
    "membership:1",
  ]);
});

it("quarantines canonical records rejected by their Model", () => {
  const base = snapshot([]);
  const result = importLegacyOrganization({
    ...base,
    departments: [
      {
        id: 1,
        name: "x".repeat(251),
        shortName: "ENG",
        email: "eng@example.test",
        city: "Trondheim",
      },
    ],
  });
  expect(result.departments).toHaveLength(0);
  expect(result.quarantined.map((item) => item.reason)).toContain("MISSING_DEPARTMENT_FIELD");
});
