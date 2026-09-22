import { createHash } from "node:crypto";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { describe, expect, it } from "vitest";
import {
  disposableCurrentAssignmentDatabaseUrl,
  runCurrentAssignmentCohortCli,
} from "./current-assignment-cohort-cli.js";
import {
  currentAssignmentPlacementId,
  decodeCurrentAssignmentSnapshot,
} from "./current-assignment-cohort.js";

describe("synthetic current assignment boundary", () => {
  const fixtureBody = {
    sourceRepository: "synthetic",
    sourceRevision: "revision",
    snapshotId: "snapshot",
    sourceWatermark: "watermark",
    transformationRevision: "0109",
    synthetic: true,
    occurrences: [{ occurrenceId: "one", row: {} }],
    mappings: [],
  };
  const fixture = {
    ...fixtureBody,
    snapshotDigest: createHash("sha256").update(canonicalJson(fixtureBody)).digest("hex"),
  };

  it("retains invalid rows for quarantine but rejects invalid snapshot evidence", () => {
    expect(decodeCurrentAssignmentSnapshot(fixture).occurrences).toHaveLength(1);
    expect(() =>
      decodeCurrentAssignmentSnapshot({
        ...fixture,
        occurrences: [...fixture.occurrences, ...fixture.occurrences],
      }),
    ).toThrow("InvalidSnapshot");
    expect(() =>
      decodeCurrentAssignmentSnapshot({ ...fixture, snapshotDigest: "0".repeat(64) }),
    ).toThrow("InvalidSnapshot");
    expect(() => decodeCurrentAssignmentSnapshot({ ...fixture, synthetic: false })).toThrow(
      "InvalidSnapshot",
    );
  });

  it("uses one stable domain-separated placement identity for each source assignment", () => {
    expect(currentAssignmentPlacementId("synthetic", "assignment-a")).toMatch(
      /^placement-[a-f0-9]{64}$/,
    );
    expect(currentAssignmentPlacementId("synthetic", "assignment-a")).toBe(
      currentAssignmentPlacementId("synthetic", "assignment-a"),
    );
    expect(currentAssignmentPlacementId("synthetic", "assignment-a")).not.toBe(
      currentAssignmentPlacementId("synthetic", "assignment-b"),
    );
  });

  it("rejects ambient provider configuration before opening the synthetic CLI boundary", async () => {
    for (const [key, value] of [
      ["PUBLIC_APPLICATION_EFFECT_MODE", "disabled"],
      ["PUBLIC_APPLICATION_EFFECT_TOKEN", "synthetic-provider-configuration"],
      ["RECEIPT_DELIVERY_URL", "https://provider.example.invalid/delivery"],
      ["RECEIPT_DELIVERY_TOKEN", "synthetic-provider-configuration"],
    ] as const) {
      const previous = {
        mode: process.env.CURRENT_ASSIGNMENT_MODE,
        deployment: process.env.NATIVE_IDENTITY_DEPLOYMENT,
        provider: process.env[key],
      };
      process.env.CURRENT_ASSIGNMENT_MODE = "synthetic";
      process.env.NATIVE_IDENTITY_DEPLOYMENT = "local";
      process.env[key] = value;
      try {
        await expect(runCurrentAssignmentCohortCli()).rejects.toThrow("InvalidSnapshot");
      } finally {
        for (const [environmentKey, previousValue] of [
          ["CURRENT_ASSIGNMENT_MODE", previous.mode],
          ["NATIVE_IDENTITY_DEPLOYMENT", previous.deployment],
          [key, previous.provider],
        ] as const) {
          if (previousValue === undefined) delete process.env[environmentKey];
          else process.env[environmentKey] = previousValue;
        }
      }
    }
  });

  it("requires numeric loopback and the disposable current assignment namespace", () => {
    expect(
      disposableCurrentAssignmentDatabaseUrl(
        "postgres://postgres@127.0.0.1:49123/current_assignment_rehearsal",
      ),
    ).toContain("current_assignment_rehearsal");
    for (const value of [
      undefined,
      "postgres://localhost:5432/current_assignment_rehearsal",
      "postgres://example.com:5432/current_assignment_rehearsal",
      "postgres://127.0.0.1:5432/production",
      "postgres://127.0.0.1/current_assignment_rehearsal",
      "postgres://127.0.0.1:5432/historical_service_rehearsal",
      "postgres://127.0.0.1:5432/current_assignment_production",
      "postgres://127.0.0.1:5432/current_assignment_live",
      "postgres://127.0.0.1:5432/current_assignment_main",
    ])
      expect(() => disposableCurrentAssignmentDatabaseUrl(value)).toThrow("InvalidSnapshot");
  });
});
