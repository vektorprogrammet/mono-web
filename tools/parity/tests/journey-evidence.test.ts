import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";
import { canonicalJson, sha256 } from "../src/canonical.js";
import {
  JourneyObservationArtifactSchema,
  type NativeJourneyRunManifest,
} from "../src/journey-evidence.js";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const evidenceRoot = resolve(repositoryRoot, "evidence/capability-parity");

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

test("committed claim artifacts contain named real observations and current digests", () => {
  const manifestPath = resolve(evidenceRoot, "native-run-manifest.json");
  const manifestBytes = readFileSync(manifestPath, "utf8");
  const manifest = readJson(manifestPath) as NativeJourneyRunManifest;

  expect(canonicalJson(manifest)).toBe(manifestBytes);
  expect(manifest.legacy_gate).toEqual({
    backend: "legacy_symfony",
    reason: "LEGACY_COLLECTOR_EXECUTABLES_UNAVAILABLE:verified_php_and_bwrap_not_found",
    result: "observed_absent",
  });
  expect(manifest.native).toHaveLength(3);

  for (const run of manifest.native) {
    const artifactPath = resolve(evidenceRoot, run.artifact_pointer);
    const artifactBytes = readFileSync(artifactPath, "utf8");
    const artifact = Schema.decodeUnknownSync(JourneyObservationArtifactSchema, {
      onExcessProperty: "error",
    })(readJson(artifactPath));

    expect(canonicalJson(artifact)).toBe(artifactBytes);
    expect(sha256(artifactBytes)).toBe(run.artifact_digest);
    expect(artifact.database_observation.digest).toBe(run.database_digest);
    expect(artifact.database_observation.method).toBe("fresh_psql_read_back");
    expect(
      Object.values(artifact.database_observation.row_counts).every((count) => count >= 1),
    ).toBe(true);

    const authorization = artifact.observations.find(
      (observation) => observation.observation_method === "authorization_rejection_without_session",
    );
    const rejection = artifact.observations.find(
      (observation) => observation.observation_method === "invalid_transition_rejection",
    );
    const freshRead = artifact.observations.find(
      (observation) => observation.observation_method === "fresh_http_read_after_write",
    );
    expect([401, 403]).toContain(authorization?.status);
    expect(rejection?.status).toBeGreaterThanOrEqual(400);
    expect(freshRead?.status).toBe(200);
    expect(
      artifact.observations.some(
        (observation) => observation.observation_method === "real_http_operation",
      ),
    ).toBe(true);
    expect(artifactBytes).not.toMatch(
      /example\.invalid|session_token|responseCapability|claim-specific-0078-admission-leader-token/u,
    );
  }
});
