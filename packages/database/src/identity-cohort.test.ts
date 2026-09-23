import { describe, expect, it } from "vitest";
import { decodeIdentityCohort } from "./identity-cohort.js";
import {
  decodeSyntheticIdentityCohort,
  disposableCohortDatabaseUrl,
  summarizeIdentityCohort,
} from "./identity-cohort-cli.js";
describe("synthetic credential cohort boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0100",
    sourceKind: "Synthetic",
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
    expect(() => decodeIdentityCohort({ ...fixture, synthetic: true })).toThrow("InvalidSnapshot");
    expect(decodeIdentityCohort({ ...fixture, sourceKind: "LegacyBackup" }).sourceKind).toBe(
      "LegacyBackup",
    );
    expect(() => decodeSyntheticIdentityCohort({ ...fixture, sourceKind: "LegacyBackup" })).toThrow(
      "InvalidSnapshot",
    );
    expect(() => decodeIdentityCohort({ ...fixture, sourceKind: "Unknown" })).toThrow(
      "InvalidSnapshot",
    );
  });
  it("publishes aggregate dispositions without source identifiers", () => {
    const summary = summarizeIdentityCohort({
      snapshotKey: "opaque",
      input: 1,
      accepted: 0,
      quarantined: 1,
      occurrences: [
        {
          occurrenceId: "private-source-id",
          disposition: "Quarantined",
          reason: "UnsupportedHash",
        },
      ],
      aliases: "LegacyUsernameAndCompanyEmailUnsupported",
    });
    expect(summary.reasons.UnsupportedHash).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("private-source-id");
  });
  it("accepts the backup cohort limit, but refuses larger snapshots", () => {
    const occurrences = Array.from({ length: 10000 }, (_, i) => ({
      occurrenceId: `row-${i}`,
      row: {},
    }));
    expect(decodeIdentityCohort({ ...fixture, occurrences }).occurrences).toHaveLength(10000);
    expect(() =>
      decodeIdentityCohort({
        ...fixture,
        occurrences: [...occurrences, { occurrenceId: "overflow", row: {} }],
      }),
    ).toThrow("InvalidSnapshot");
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
