import { withPostgresTestDatabase } from "./test-support/postgres.js";
import { TestPlatform } from "./test-support/platform.js";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import { expect, layer } from "@effect/vitest";
import { disposablePersonCohortDatabaseUrl } from "./person-cohort-cli.js";
import {
  PersonMapping,
  decodePersonCohort,
  importPersonCohort,
  personCohortSourceRowDigest,
} from "./person-cohort.js";
import { importHistoricalServiceCohort } from "./historical-service-cohort.js";
import { pgQuery, pgWithClient } from "./pg-pool.js";

layer(TestPlatform, { excludeTestServices: true })("synthetic person cohort boundary", (it) => {
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

  it.effect("rolls both imports back on a later failure and replays committed evidence", () =>
    withPostgresTestDatabase((pool) =>
      Effect.gen(function* () {
        yield* pgQuery(
          pool,
          `
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
      `,
        );

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

        const counts = pgQuery<{
          profiles: number;
          persons: number;
          history: number;
          snapshots: number;
        }>(
          pool,
          `
        SELECT (SELECT count(*)::int FROM public.person_profiles) AS profiles,
        (SELECT count(*)::int FROM public.person_cohort_imports) AS persons,
        (SELECT count(*)::int FROM public.assistant_service_history) AS history,
        (SELECT count(*)::int FROM public.historical_service_snapshots) AS snapshots
      `,
        ).pipe(Effect.map(({ rows }) => rows[0]));

        yield* pgWithClient(pool, (failed) =>
          Effect.gen(function* () {
            yield* pgQuery(failed, "BEGIN");
            expect((yield* importPersonCohort(pool, personSnapshot, failed)).occurrences).toEqual([
              {
                occurrenceId: "person-occurrence",
                disposition: "Accepted",
                reason: "CreatedPerson",
              },
            ]);
            expect(
              yield* Effect.flip(importHistoricalServiceCohort(pool, serviceSnapshot, failed)),
            ).toMatchObject({ code: "PersistenceFailure" });
          }).pipe(Effect.ensuring(pgQuery(failed, "ROLLBACK").pipe(Effect.orDie))),
        );

        expect(yield* counts).toEqual({ profiles: 0, persons: 0, history: 0, snapshots: 0 });
        yield* pgQuery(
          pool,
          "DROP TRIGGER reject_history ON public.assistant_service_history; DROP FUNCTION public.reject_history()",
        );

        const service = yield* pgWithClient(pool, (tx) =>
          Effect.gen(function* () {
            yield* pgQuery(tx, "BEGIN");
            const person = yield* importPersonCohort(pool, personSnapshot, tx);
            const imported = yield* importHistoricalServiceCohort(pool, serviceSnapshot, tx);
            expect(person.replay).toBe(false);
            expect(imported.occurrences).toEqual([
              { occurrenceId: "history-occurrence", disposition: "Accepted", reason: "Imported" },
            ]);
            expect((yield* importPersonCohort(pool, personSnapshot, tx)).replay).toBe(true);
            expect(yield* importHistoricalServiceCohort(pool, serviceSnapshot, tx)).toEqual(
              imported,
            );
            yield* pgQuery(tx, "COMMIT");

            return imported;
          }).pipe(Effect.ensuring(pgQuery(tx, "ROLLBACK").pipe(Effect.orDie))),
        );

        expect(yield* counts).toEqual({ profiles: 1, persons: 1, history: 1, snapshots: 1 });
        expect((yield* importPersonCohort(pool, personSnapshot)).replay).toBe(true);
        expect(yield* importHistoricalServiceCohort(pool, serviceSnapshot)).toEqual(service);
        expect(yield* counts).toEqual({ profiles: 1, persons: 1, history: 1, snapshots: 1 });
      }),
    ),
  );
});
