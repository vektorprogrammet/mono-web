import { describe, expect, it } from "vitest";
import { disposablePersonCohortDatabaseUrl } from "./person-cohort-cli.js";
import { decodePersonCohort } from "./person-cohort.js";

describe("synthetic person cohort boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0106",
    synthetic: true,
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
    expect(() => decodePersonCohort({ ...fixture, synthetic: false })).toThrow("InvalidSnapshot");
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
});
