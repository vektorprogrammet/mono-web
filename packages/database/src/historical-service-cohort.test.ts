import { withPostgresTestDatabase } from "./test-support/postgres.js";
import { PersonMapping, importPersonCohort as importPersonCohortEffect } from "./person-cohort.js";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, flow } from "effect";
import { describe, expect, it } from "vitest";
import { disposableHistoricalServiceDatabaseUrl } from "./historical-service-cohort-cli.js";
import {
  decodeHistoricalServiceSnapshot,
  HistoricalServiceFailure,
  historicalServiceSourceRowDigest,
  importHistoricalServiceCohort as importHistoricalServiceCohortEffect,
} from "./historical-service-cohort.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const importHistoricalServiceCohort = flow(importHistoricalServiceCohortEffect, Effect.runPromise);

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
    expect(() =>
      decodeHistoricalServiceSnapshot({ ...fixture, sourceKind: "unsupported" }),
    ).toThrow("InvalidSnapshot");
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
  it(
    "quarantines missing, mismatched, and malformed backup rows without discarding the cohort",
    () =>
      withPostgresTestDatabase(async (pool) => {
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

        const referenceDigest = "a".repeat(64);

        const referenceMappings = {
          departments: [{ sourceDepartmentId: "department", departmentId: "department" }],
          semesters: [{ sourceSemesterId: "semester", semesterId: "semester" }],
          schools: [{ sourceSchoolId: "school", schoolId: 1 }],
          relationships: [
            {
              sourceDepartmentId: "department",
              sourceSchoolId: "school",
              departmentId: "department",
              schoolId: 1,
            },
          ],
        };

        const referenceEvidence = {
          source_revision: fixture.sourceRevision,
          reference_digest: referenceDigest,
          source_id_mappings: referenceMappings,
        };

        const sourceMapping = {
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
        };

        const snapshot = {
          ...fixture,
          sourceKind: "LegacyBackup" as const,
          referenceDigest,
          occurrences: [
            {
              occurrenceId: "valid",
              row: raw,
              sourceRowDigest: historicalServiceSourceRowDigest(raw),
            },
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

        expect(() =>
          decodeHistoricalServiceSnapshot({ ...snapshot, referenceDigest: undefined }),
        ).toThrow("InvalidSnapshot");
        await expect(importHistoricalServiceCohort(pool, snapshot)).rejects.toMatchObject({
          code: "ReferenceProvenanceMissing",
        });

        const recordReferences = async (snapshotId: string, evidence = referenceEvidence) => {
          await pool.query(
            `INSERT INTO public.historical_service_reference_provenance
          (source_repository, snapshot_id, source_revision, reference_digest, source_id_mappings)
          VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              fixture.sourceRepository,
              snapshotId,
              evidence.source_revision,
              evidence.reference_digest,
              JSON.stringify(evidence.source_id_mappings),
            ],
          );
        };

        await pool.query(`
      INSERT INTO public.organization_departments (department_id,name,short_name,email,city) VALUES ('department','Department','D','department@example.invalid','Trondheim');
      INSERT INTO public.admission_period_semesters (semester_id,start_at,end_at) VALUES ('semester','2026-08-01','2027-01-01');
      INSERT INTO public.schools_directory_schools (name,contact_person,email,phone,language,active) VALUES ('School','Contact','school@example.invalid','90000000','Norwegian',true);
      INSERT INTO public.schools_directory_departments (school_id,department_id) VALUES (1,'department');
    `);

        const personRow = {
          sourceUserId: "user",
          active: true,
          firstName: "Legacy",
          lastName: "User",
          email: "user@example.invalid",
          phone: "90000000",
        };

        await importPersonCohort(pool, {
          ...fixture,
          snapshotId: "person",
          transformationRevision: "0106",
          occurrences: [{ occurrenceId: "person", row: personRow }],
          mappings: [
            PersonMapping.cases.CreatePerson.make({
              sourceUserId: "user",
              personId: PersonId.make("person"),
              emailOwnership: {
                email: personRow.email,
                attestedBy: "operator",
                evidenceRef: "attestation",
              },
            }),
          ],
        });
        await recordReferences(snapshot.snapshotId);
        const first = await importHistoricalServiceCohort(pool, snapshot);
        expect(first.accepted).toBe(0);
        expect(
          Object.fromEntries(
            first.occurrences.map(({ occurrenceId, reason }) => [occurrenceId, reason]),
          ),
        ).toEqual({
          valid: "MappingMissing",
          mismatch: "InvalidRow",
          missing: "InvalidRow",
          "bad-shape": "InvalidRow",
        });
        expect(await importHistoricalServiceCohort(pool, snapshot)).toEqual(first);

        await expect(
          importHistoricalServiceCohort(pool, { ...snapshot, sourceRevision: "changed" }),
        ).rejects.toMatchObject({
          code: "SnapshotConflict",
        } satisfies Partial<HistoricalServiceFailure>);

        const mappedSnapshot = {
          ...snapshot,
          snapshotId: "reference-conflict",
          occurrences: [
            {
              occurrenceId: "valid",
              row: raw,
              sourceRowDigest: historicalServiceSourceRowDigest(raw),
            },
          ],
          mappings: [sourceMapping],
        };

        const conflictingEvidence = [
          { ...referenceEvidence, source_revision: "changed" },
          { ...referenceEvidence, reference_digest: "b".repeat(64) },
          {
            ...referenceEvidence,
            source_id_mappings: {
              ...referenceMappings,
              schools: [{ sourceSchoolId: "school", schoolId: 2 }],
              relationships: [
                {
                  sourceDepartmentId: "department",
                  sourceSchoolId: "school",
                  departmentId: "department",
                  schoolId: 2,
                },
              ],
            },
          },
        ];

        for (const [index, evidence] of conflictingEvidence.entries()) {
          const rejectedSnapshot = { ...mappedSnapshot, snapshotId: "conflict-" + index };
          await recordReferences(rejectedSnapshot.snapshotId, evidence);
          await expect(importHistoricalServiceCohort(pool, rejectedSnapshot)).rejects.toMatchObject(
            { code: "ReferenceProvenanceConflict" },
          );
        }

        await recordReferences(mappedSnapshot.snapshotId);

        const imported = await importHistoricalServiceCohort(pool, mappedSnapshot);
        expect(imported.occurrences).toEqual([
          { occurrenceId: "valid", disposition: "Accepted", reason: "Imported" },
        ]);
        expect(await importHistoricalServiceCohort(pool, mappedSnapshot)).toEqual(imported);

        const staleRow = { ...raw, sourceHistoryId: "stale" };

        const staleSnapshot = {
          ...mappedSnapshot,
          snapshotId: "stale-directory-relationship",
          occurrences: [
            {
              occurrenceId: "stale",
              row: staleRow,
              sourceRowDigest: historicalServiceSourceRowDigest(staleRow),
            },
          ],
          mappings: [{ ...sourceMapping, sourceHistoryId: "stale" }],
        };

        await recordReferences(staleSnapshot.snapshotId, {
          ...referenceEvidence,
          source_id_mappings: { ...referenceMappings, relationships: [] },
        });
        expect((await importHistoricalServiceCohort(pool, staleSnapshot)).occurrences).toEqual([
          {
            occurrenceId: "stale",
            disposition: "Quarantined",
            reason: "SchoolDepartmentMismatch",
          },
        ]);

        const changedRow = { ...raw, day: "Tirsdag" };

        const anotherSnapshot = {
          ...mappedSnapshot,
          snapshotId: "another-snapshot",
          occurrences: [
            {
              occurrenceId: "valid",
              row: changedRow,
              sourceRowDigest: historicalServiceSourceRowDigest(changedRow),
            },
          ],
        };

        await recordReferences(anotherSnapshot.snapshotId);
        await expect(importHistoricalServiceCohort(pool, anotherSnapshot)).rejects.toMatchObject({
          code: "SourceIdentityConflict",
        } satisfies Partial<HistoricalServiceFailure>);
      }),
    20_000,
  );

  it("accepts the real backup cohort size and rejects snapshots beyond the schema cap", () => {
    const occurrences = Array.from({ length: 1_815 }, (_, index) => ({
      occurrenceId: String(index),
      row: {},
      sourceRowDigest: historicalServiceSourceRowDigest({}),
    }));

    expect(
      decodeHistoricalServiceSnapshot({
        ...fixture,
        sourceKind: "LegacyBackup",
        referenceDigest: "a".repeat(64),
        occurrences,
      }).occurrences,
    ).toHaveLength(1_815);
    expect(() =>
      decodeHistoricalServiceSnapshot({
        ...fixture,
        occurrences: Array.from({ length: 10_001 }, (_, index) => ({
          occurrenceId: String(index),
          row: {},
        })),
      }),
    ).toThrow("InvalidSnapshot");
  });
});
