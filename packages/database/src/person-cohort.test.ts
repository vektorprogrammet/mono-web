import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { disposablePersonCohortDatabaseUrl } from "./person-cohort-cli.js";
import {
  decodePersonCohort,
  importPersonCohort,
  personCohortSourceRowDigest,
} from "./person-cohort.js";
import { importHistoricalServiceCohort } from "./historical-service-cohort.js";

describe("synthetic person cohort boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0106",
    sourceKind: "Synthetic" as const,
    occurrences: [{ occurrenceId: "one", row: {} }],
    mappings: [],
  };

  it("retains invalid rows for quarantine but rejects ambiguous occurrence identities", () => {
    expect(decodePersonCohort(fixture).occurrences).toHaveLength(1);
    expect(() =>
      decodePersonCohort({
        ...fixture,
        occurrences: [...fixture.occurrences, ...fixture.occurrences],
      }),
    ).toThrow("InvalidSnapshot");
    const legacyRow = {};
    expect(
      decodePersonCohort({
        ...fixture,
        sourceKind: "LegacyBackup",
        occurrences: [
          {
            occurrenceId: "one",
            row: legacyRow,
            sourceRowDigest: personCohortSourceRowDigest(legacyRow),
          },
        ],
      }).sourceKind,
    ).toBe("LegacyBackup");
    expect(() =>
      decodePersonCohort({
        ...fixture,
        sourceKind: "LegacyBackup",
        occurrences: [{ occurrenceId: "one", row: legacyRow }],
      }),
    ).toThrow("InvalidSnapshot");
  });

  it("requires numeric loopback and the disposable person namespace", () => {
    expect(
      disposablePersonCohortDatabaseUrl(
        "postgres://postgres@127.0.0.1:49123/person_cohort_rehearsal",
      ),
    ).toContain("person_cohort_rehearsal");
    for (const value of [
      undefined,
      "postgres://localhost:5432/person_cohort_rehearsal",
      "postgres://example.com:5432/person_cohort_rehearsal",
      "postgres://127.0.0.1:5432/production",
      "postgres://127.0.0.1/person_cohort_rehearsal",
      "postgres://127.0.0.1:5432/identity_cohort_rehearsal",
    ])
      expect(() => disposablePersonCohortDatabaseUrl(value)).toThrow("InvalidSnapshot");
  });

  it("rolls both imports back on a later failure and replays committed evidence", async () => {
    type Occurrence = { occurrenceId: string; disposition: string; reason: string };
    const empty = () => ({
      personSnapshots: new Map<string, string>(),
      personOccurrences: new Map<string, Occurrence[]>(),
      personImports: [] as Array<{ repository: string; user: string; person: string }>,
      profiles: new Set<string>(),
      emails: new Set<string>(),
      historySnapshots: new Map<string, string>(),
      historyOccurrences: new Map<string, Occurrence[]>(),
      historyCount: 0,
    });
    let committed = empty();
    let current = committed;
    let active = false;
    let failHistory = true;
    let connects = 0;
    let releases = 0;
    const commands: string[] = [];
    const locks: string[] = [];
    const client = {
      async query(sql: string, values: ReadonlyArray<unknown> = []) {
        if (sql === "BEGIN") {
          if (active) throw new Error("nested transaction");
          active = true;
          current = structuredClone(committed);
          commands.push(sql);
          return { rows: [] };
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          if (!active) throw new Error("no transaction");
          if (sql === "COMMIT") committed = current;
          else current = committed;
          active = false;
          commands.push(sql);
          return { rows: [] };
        }
        if (!active) throw new Error("query outside transaction");
        if (sql.includes("pg_advisory_xact_lock")) {
          locks.push(sql);
          return { rows: [] };
        }
        if (sql.startsWith("SELECT snapshot_digest FROM public.person_cohort_snapshots")) {
          const digest = current.personSnapshots.get(String(values[0]));
          return { rows: digest ? [{ snapshot_digest: digest }] : [] };
        }
        if (sql.startsWith("SELECT source_user_id, source_digest")) return { rows: [] };
        if (
          sql.startsWith("SELECT person_id") &&
          sql.includes("FROM public.person_cohort_imports")
        )
          return { rows: [] };
        if (sql.startsWith("SELECT 1 FROM public.person_profiles"))
          return { rowCount: Number(current.profiles.has(String(values[0]))) };
        if (sql.startsWith("SELECT 1 FROM public.person_contact_profiles"))
          return { rowCount: Number(current.emails.has(String(values[0]))) };
        if (sql.startsWith("INSERT INTO public.person_cohort_snapshots")) {
          current.personSnapshots.set(String(values[0]), String(values[5]));
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.person_cohort_occurrences")) {
          const key = String(values[0]);
          current.personOccurrences.set(key, [
            ...(current.personOccurrences.get(key) ?? []),
            {
              occurrenceId: String(values[1]),
              disposition: String(values[2]),
              reason: String(values[3]),
            },
          ]);
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.person_profiles")) {
          current.profiles.add(String(values[0]));
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.person_contact_profiles")) {
          current.emails.add(String(values[1]));
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.person_cohort_imports")) {
          current.personImports.push({
            repository: String(values[0]),
            user: String(values[1]),
            person: String(values[2]),
          });
          return { rows: [] };
        }
        if (sql.includes("FROM public.person_cohort_occurrences"))
          return { rows: current.personOccurrences.get(String(values[0])) ?? [] };
        if (sql.startsWith("SELECT snapshot_digest FROM public.historical_service_snapshots")) {
          const digest = current.historySnapshots.get(String(values[0]));
          return { rows: digest ? [{ snapshot_digest: digest }] : [] };
        }
        if (sql.startsWith("SELECT history.source_history_id")) return { rows: [] };
        if (sql.startsWith("SELECT 1 FROM public.person_cohort_imports"))
          return {
            rowCount: Number(
              current.personImports.some(
                (record) =>
                  record.repository === values[0] &&
                  record.user === values[1] &&
                  record.person === values[2],
              ),
            ),
          };
        if (sql.includes("AS school_department_exists"))
          return {
            rows: [{
              department_exists: true,
              semester_exists: true,
              school_exists: true,
              school_department_exists: true,
            }],
          };
        if (sql.startsWith("INSERT INTO public.historical_service_snapshots")) {
          current.historySnapshots.set(String(values[0]), String(values[5]));
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.historical_service_occurrences")) {
          const key = String(values[0]);
          current.historyOccurrences.set(key, [
            ...(current.historyOccurrences.get(key) ?? []),
            {
              occurrenceId: String(values[1]),
              disposition: String(values[2]),
              reason: String(values[3]),
            },
          ]);
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO public.assistant_service_history")) {
          if (failHistory) {
            failHistory = false;
            throw new Error("target insert failed");
          }
          current.historyCount++;
          return { rows: [] };
        }
        if (sql.includes("FROM public.historical_service_occurrences"))
          return { rows: current.historyOccurrences.get(String(values[0])) ?? [] };
        throw new Error("Unexpected import query: " + sql);
      },
      release() {
        releases++;
      },
    } as unknown as PoolClient;
    const pool = {
      async connect() {
        connects++;
        return client;
      },
    } as unknown as Pool;
    const row = {
      sourceUserId: "user",
      active: true,
      firstName: "Legacy",
      lastName: "User",
      email: "user@example.invalid",
      phone: "+47 999 00 000",
    };
    const personSnapshot = {
      sourceRepository: "synthetic",
      sourceRevision: "source",
      snapshotId: "person",
      transformationRevision: "0106",
      sourceKind: "Synthetic" as const,
      occurrences: [{ occurrenceId: "person-occurrence", row }],
      mappings: [{
        _tag: "CreatePerson",
        sourceUserId: "user",
        personId: "person",
        emailOwnership: { email: row.email, attestedBy: "operator", evidenceRef: "attestation" },
      }],
    };
    const serviceRow = {
      sourceHistoryId: "history",
      sourceUserId: "user",
      sourceDepartmentId: "department",
      sourceSemesterId: "semester",
      sourceSchoolId: "school",
      workdays: "4",
      block: "Bolk 1",
      day: "Mandag",
    };
    const serviceSnapshot = {
      sourceRepository: "synthetic",
      sourceRevision: "source",
      snapshotId: "history",
      transformationRevision: "0108",
      sourceKind: "Synthetic" as const,
      occurrences: [{ occurrenceId: "history-occurrence", row: serviceRow }],
      mappings: [{
        sourceHistoryId: "history",
        sourceUserId: "user",
        sourceDepartmentId: "department",
        sourceSemesterId: "semester",
        sourceSchoolId: "school",
        personId: "person",
        departmentId: "department",
        semesterId: "semester",
        schoolId: 1,
        evidenceRef: "service-evidence",
      }],
    };

    const tx = await pool.connect();
    await tx.query("BEGIN");
    expect((await importPersonCohort(pool, personSnapshot, tx)).occurrences).toEqual([
      { occurrenceId: "person-occurrence", disposition: "Accepted", reason: "CreatedPerson" },
    ]);
    await expect(importHistoricalServiceCohort(pool, serviceSnapshot, tx)).rejects.toMatchObject({
      code: "PersistenceFailure",
    });
    expect(commands).toEqual(["BEGIN"]);
    expect(connects).toBe(1);
    expect(releases).toBe(0);
    expect(current.profiles.has("person")).toBe(true);
    expect(current.personImports).toHaveLength(1);
    expect(current.historySnapshots.size).toBe(1);
    await tx.query("ROLLBACK");
    expect(current.personSnapshots.size).toBe(0);
    expect(current.profiles.size).toBe(0);
    expect(current.personImports).toHaveLength(0);
    expect(current.historySnapshots.size).toBe(0);
    expect(current.historyCount).toBe(0);

    await tx.query("BEGIN");
    const person = await importPersonCohort(pool, personSnapshot, tx);
    const service = await importHistoricalServiceCohort(pool, serviceSnapshot, tx);
    expect(person.replay).toBe(false);
    expect(service.occurrences).toEqual([
      { occurrenceId: "history-occurrence", disposition: "Accepted", reason: "Imported" },
    ]);
    expect((await importPersonCohort(pool, personSnapshot, tx)).replay).toBe(true);
    expect(await importHistoricalServiceCohort(pool, serviceSnapshot, tx)).toEqual(service);
    expect(commands).toEqual(["BEGIN", "ROLLBACK", "BEGIN"]);
    expect(connects).toBe(1);
    expect(releases).toBe(0);
    await tx.query("COMMIT");
    tx.release();
    expect(committed.personImports).toHaveLength(1);
    expect(committed.historyCount).toBe(1);
    expect((await importPersonCohort(pool, personSnapshot)).replay).toBe(true);
    expect(await importHistoricalServiceCohort(pool, serviceSnapshot)).toEqual(service);
    expect(commands).toEqual([
      "BEGIN", "ROLLBACK", "BEGIN", "COMMIT", "BEGIN", "COMMIT", "BEGIN", "COMMIT",
    ]);
    expect(connects).toBe(3);
    expect(releases).toBe(3);
    expect(locks.filter((sql) => sql.includes("native-person-cohort-import"))).toHaveLength(4);
    expect(
      locks.filter((sql) => sql.includes("native-historical-service-import")),
    ).toHaveLength(4);
  });
});
