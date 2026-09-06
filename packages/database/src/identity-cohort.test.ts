import { describe, expect, it } from "vitest";
import { decodeIdentityCohort } from "./identity-cohort.js";
import { disposableCohortDatabaseUrl } from "./identity-cohort-cli.js";
describe("synthetic credential cohort boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0100",
    synthetic: true,
    occurrences: [{ occurrenceId: "one", row: {} }],
    mappings: [],
  };
  it("retains invalid rows for accountable quarantine but rejects ambiguous occurrence identities", () => {
    expect(decodeIdentityCohort(fixture).occurrences).toHaveLength(1);
    expect(() =>
      decodeIdentityCohort({
        ...fixture,
        occurrences: [...fixture.occurrences, ...fixture.occurrences],
      }),
    ).toThrow("InvalidSnapshot");
    expect(() => decodeIdentityCohort({ ...fixture, synthetic: false })).toThrow("InvalidSnapshot");
  });
  it("requires explicit numeric loopback and disposable database namespace", () => {
    expect(
      disposableCohortDatabaseUrl("postgres://postgres@127.0.0.1:49123/identity_cohort_rehearsal"),
    ).toContain("identity_cohort_rehearsal");
    for (const value of [
      undefined,
      "postgres://localhost:5432/identity_cohort_rehearsal",
      "postgres://example.com:5432/identity_cohort_rehearsal",
      "postgres://127.0.0.1:5432/production",
      "postgres://127.0.0.1/identity_cohort_rehearsal",
    ])
      expect(() => disposableCohortDatabaseUrl(value)).toThrow("InvalidSnapshot");
  });
});
