import { describe, expect, it } from "vitest";
import { disposableHistoricalServiceDatabaseUrl } from "./historical-service-cohort-cli.js";
import { decodeHistoricalServiceSnapshot } from "./historical-service-cohort.js";

describe("synthetic historical service boundary", () => {
  const fixture = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    transformationRevision: "0108",
    synthetic: true,
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
    expect(() => decodeHistoricalServiceSnapshot({ ...fixture, synthetic: false })).toThrow(
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
});
