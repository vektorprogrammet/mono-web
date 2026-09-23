import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { disposableHistoricalServiceDatabaseUrl } from "./historical-service-cohort-cli.js";
import {
  decodeHistoricalServiceSnapshot,
  HistoricalServiceFailure,
  historicalServiceSourceRowDigest,
  importHistoricalServiceCohort,
} from "./historical-service-cohort.js";

describe("historical service boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0108",
    sourceKind: "Synthetic" as const,
    occurrences: [{ occurrenceId: "one", row: {} }],
    mappings: [],
  };

  it("retains invalid rows for quarantine but rejects ambiguous occurrence identities", () => {
    expect(decodeHistoricalServiceSnapshot(fixture).occurrences).toHaveLength(1);
    expect(() =>
      decodeHistoricalServiceSnapshot({
        ...fixture,
        occurrences: [...fixture.occurrences, ...fixture.occurrences],
      }),
    ).toThrow("InvalidSnapshot");
    expect(() => decodeHistoricalServiceSnapshot({ ...fixture, sourceKind: "unsupported" })).toThrow(
      "InvalidSnapshot",
    );
  });

  it("requires numeric loopback and the disposable historical service namespace", () => {
    expect(
      disposableHistoricalServiceDatabaseUrl(
        "postgres://postgres@127.0.0.1:49123/historical_service_rehearsal",
      ),
    ).toContain("historical_service_rehearsal");
    for (const value of [
      undefined,
      "postgres://localhost:5432/historical_service_rehearsal",
      "postgres://example.com:5432/historical_service_rehearsal",
      "postgres://127.0.0.1:5432/production",
      "postgres://127.0.0.1/historical_service_rehearsal",
      "postgres://127.0.0.1:5432/person_cohort_rehearsal",
    ])
      expect(() => disposableHistoricalServiceDatabaseUrl(value)).toThrow("InvalidSnapshot");
  });
  it("quarantines missing, mismatched, and malformed backup rows without discarding the cohort", async () => {
    const rows = new Map<string, Array<{ occurrenceId: string; disposition: string; reason: string }>>();
    const snapshots = new Map<string, string>();

    const priorHistory: Array<Record<string, unknown>> = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock"))
            return { rows: [], rowCount: 0 };
          if (sql.startsWith("SELECT snapshot_digest")) {
            const snapshotDigest = snapshots.get(String(values[0]));
            return { rows: snapshotDigest ? [{ snapshot_digest: snapshotDigest }] : [] };
          }
          if (sql.startsWith("SELECT history.source_history_id")) return { rows: priorHistory };
          if (sql.startsWith("INSERT INTO public.historical_service_snapshots")) {
            snapshots.set(String(values[0]), String(values[5]));
            return { rows: [] };
          }
          if (sql.startsWith("INSERT INTO public.historical_service_occurrences")) {
            const key = String(values[0]);
            rows.set(key, [
              ...(rows.get(key) ?? []),
              {
                occurrenceId: String(values[1]),
                disposition: String(values[2]),
                reason: String(values[3]),
              },
            ]);
            return { rows: [] };
          }
          if (sql.startsWith('SELECT occurrence_id AS "occurrenceId"'))
            return {
              rows: [...(rows.get(String(values[0])) ?? [])].sort((a, b) =>
                a.occurrenceId.localeCompare(b.occurrenceId),
              ),
            };
          throw new Error("Unexpected import query");
        },
        release() {},
      }),
    } as unknown as Pool;
    const raw = {
      sourceHistoryId: "valid",
      sourceUserId: "user",
      sourceDepartmentId: "department",
      sourceSemesterId: "semester",
      sourceSchoolId: "school",
      workdays: "4",
      block: "Bolk 1",
      day: "Mandag",
    };
    const snapshot = {
      ...fixture,
      sourceKind: "LegacyBackup" as const,
      occurrences: [
        { occurrenceId: "valid", row: raw, sourceRowDigest: historicalServiceSourceRowDigest(raw) },
        {
          occurrenceId: "mismatch",
          row: { ...raw, sourceHistoryId: "mismatch" },
          sourceRowDigest: historicalServiceSourceRowDigest(raw),
        },
        { occurrenceId: "missing", row: { ...raw, sourceHistoryId: "missing" } },
        {
          occurrenceId: "bad-shape",
          row: { ...raw, sourceHistoryId: "bad", sourceSchoolId: null },
          sourceRowDigest: historicalServiceSourceRowDigest({
            ...raw,
            sourceHistoryId: "bad",
            sourceSchoolId: null,
          }),
        },
      ],
    };
    const first = await importHistoricalServiceCohort(pool, snapshot);
    expect(first.accepted).toBe(0);
    expect(
      Object.fromEntries(first.occurrences.map(({ occurrenceId, reason }) => [occurrenceId, reason])),
    ).toEqual({
      valid: "MappingMissing",
      mismatch: "InvalidRow",
      missing: "InvalidRow",
      "bad-shape": "InvalidRow",
    });
    expect(await importHistoricalServiceCohort(pool, snapshot)).toEqual(first);

    await expect(
      importHistoricalServiceCohort(pool, { ...snapshot, sourceRevision: "changed" }),
    ).rejects.toMatchObject({ code: "SnapshotConflict" } satisfies Partial<HistoricalServiceFailure>);

    priorHistory.push({
      source_history_id: "valid",
      source_digest: "0".repeat(64),
      raw_row_digest: historicalServiceSourceRowDigest(raw),
      source_kind: "LegacyBackup",
      person_id: "person",
      school_id: "1",
      semester_id: "semester",
      block: "1",
    });
    const changedRow = { ...raw, day: "Tirsdag" };
    await expect(
      importHistoricalServiceCohort(pool, {
        ...snapshot,
        snapshotId: "another-snapshot",
        occurrences: [{
          occurrenceId: "valid",
          row: changedRow,
          sourceRowDigest: historicalServiceSourceRowDigest(changedRow),
        }],
        mappings: [{
          sourceHistoryId: "valid",
          sourceUserId: "user",
          sourceDepartmentId: "department",
          sourceSemesterId: "semester",
          sourceSchoolId: "school",
          personId: "person",
          departmentId: "department",
          semesterId: "semester",
          schoolId: 1,
          evidenceRef: "history-valid",
        }],
      }),
    ).rejects.toMatchObject({ code: "SourceIdentityConflict" } satisfies Partial<HistoricalServiceFailure>);
  });

  it("accepts the real backup cohort size and rejects snapshots beyond the schema cap", () => {
    const occurrences = Array.from({ length: 1_815 }, (_, index) => ({
      occurrenceId: String(index),
      row: {},
      sourceRowDigest: historicalServiceSourceRowDigest({}),
    }));
    expect(decodeHistoricalServiceSnapshot({ ...fixture, sourceKind: "LegacyBackup", occurrences }).occurrences)
      .toHaveLength(1_815);
    expect(() => decodeHistoricalServiceSnapshot({
      ...fixture,
      occurrences: Array.from({ length: 10_001 }, (_, index) => ({ occurrenceId: String(index), row: {} })),
    })).toThrow("InvalidSnapshot");
  });
});
