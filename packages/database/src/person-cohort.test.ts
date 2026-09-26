import { withPostgresTestDatabase } from "./test-support/postgres.js";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, flow } from "effect";
import { describe, expect, it } from "vitest";
import { disposablePersonCohortDatabaseUrl } from "./person-cohort-cli.js";
import {
  PersonMapping,
  decodePersonCohort,
  importPersonCohort as importPersonCohortEffect,
  personCohortSourceRowDigest,
} from "./person-cohort.js";
import { importHistoricalServiceCohort as importHistoricalServiceCohortEffect } from "./historical-service-cohort.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const importHistoricalServiceCohort = flow(importHistoricalServiceCohortEffect, Effect.runPromise);

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

  it("rolls both imports back on a later failure and replays committed evidence", async () =>
    withPostgresTestDatabase(async (pool) => {
      await pool.query(`
        INSERT INTO public.organization_departments (department_id,name,short_name,email,city)
        VALUES ('department','Department','D','department@example.invalid','Trondheim');
        INSERT INTO public.admission_period_semesters (semester_id,start_at,end_at)
        VALUES ('semester','2026-08-01T00:00:00Z','2026-12-31T00:00:00Z');
        INSERT INTO public.schools_directory_schools (name,contact_person,email,phone,language,active)
        VALUES ('School','Contact','school@example.invalid','+47 900 10 001','Norwegian',true);
        INSERT INTO public.schools_directory_departments (school_id,department_id)
        SELECT school_id,'department' FROM public.schools_directory_schools;
        CREATE FUNCTION public.reject_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'history insert rejected'; END $$;
        CREATE TRIGGER reject_history BEFORE INSERT ON public.assistant_service_history
        FOR EACH ROW EXECUTE FUNCTION public.reject_history();
      `);

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
        mappings: [
          PersonMapping.cases.CreatePerson.make({
            sourceUserId: "user",
            personId: PersonId.make("person"),
            emailOwnership: {
              email: row.email,
              attestedBy: "operator",
              evidenceRef: "attestation",
            },
          }),
        ],
      };

      const serviceSnapshot = {
        sourceRepository: "synthetic",
        sourceRevision: "source",
        snapshotId: "history",
        transformationRevision: "0108",
        sourceKind: "Synthetic" as const,
        occurrences: [
          {
            occurrenceId: "history-occurrence",
            row: {
              sourceHistoryId: "history",
              sourceUserId: "user",
              sourceDepartmentId: "department",
              sourceSemesterId: "semester",
              sourceSchoolId: "school",
              workdays: "4",
              block: "Bolk 1",
              day: "Mandag",
            },
          },
        ],
        mappings: [
          {
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
          },
        ],
      };

      const counts = async () =>
        (
          await pool.query<{
            profiles: number;
            persons: number;
            history: number;
            snapshots: number;
          }>(`
        SELECT (SELECT count(*)::int FROM public.person_profiles) AS profiles,
        (SELECT count(*)::int FROM public.person_cohort_imports) AS persons,
        (SELECT count(*)::int FROM public.assistant_service_history) AS history,
        (SELECT count(*)::int FROM public.historical_service_snapshots) AS snapshots
      `)
        ).rows[0];

      const failed = await pool.connect();

      try {
        await failed.query("BEGIN");
        expect((await importPersonCohort(pool, personSnapshot, failed)).occurrences).toEqual([
          { occurrenceId: "person-occurrence", disposition: "Accepted", reason: "CreatedPerson" },
        ]);
        await expect(
          importHistoricalServiceCohort(pool, serviceSnapshot, failed),
        ).rejects.toMatchObject({ code: "PersistenceFailure" });
      } finally {
        await failed.query("ROLLBACK");
        failed.release();
      }

      expect(await counts()).toEqual({ profiles: 0, persons: 0, history: 0, snapshots: 0 });
      await pool.query(
        "DROP TRIGGER reject_history ON public.assistant_service_history; DROP FUNCTION public.reject_history()",
      );
      const tx = await pool.connect();
      let service;

      try {
        await tx.query("BEGIN");
        const person = await importPersonCohort(pool, personSnapshot, tx);
        service = await importHistoricalServiceCohort(pool, serviceSnapshot, tx);
        expect(person.replay).toBe(false);
        expect(service.occurrences).toEqual([
          { occurrenceId: "history-occurrence", disposition: "Accepted", reason: "Imported" },
        ]);
        expect((await importPersonCohort(pool, personSnapshot, tx)).replay).toBe(true);
        expect(await importHistoricalServiceCohort(pool, serviceSnapshot, tx)).toEqual(service);
        await tx.query("COMMIT");
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }

      expect(await counts()).toEqual({ profiles: 1, persons: 1, history: 1, snapshots: 1 });
      expect((await importPersonCohort(pool, personSnapshot)).replay).toBe(true);
      expect(await importHistoricalServiceCohort(pool, serviceSnapshot)).toEqual(service);
      expect(await counts()).toEqual({ profiles: 1, persons: 1, history: 1, snapshots: 1 });
    }));
});
