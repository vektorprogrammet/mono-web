import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";
import { canonicalJson, sha256 } from "../src/canonical.js";
import {
  LegacyJourneyObservationArtifactSchema,
  type LegacyJourneyRunManifest,
} from "../src/legacy-journey-evidence.js";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const evidenceRoot = resolve(repositoryRoot, "evidence/capability-parity");

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

const decodeLegacyArtifact = (path: string) =>
  Schema.decodeUnknownSync(LegacyJourneyObservationArtifactSchema, {
    onExcessProperty: "error",
  })(readJson(path));

test("committed legacy run manifest pins canonical artifacts for all three tracer rows", () => {
  const manifestPath = resolve(evidenceRoot, "legacy-run-manifest.json");
  const manifestBytes = readFileSync(manifestPath, "utf8");
  const manifest = readJson(manifestPath) as LegacyJourneyRunManifest;

  expect(canonicalJson(manifest)).toBe(manifestBytes);
  expect(manifest.schema_version).toBe("claim-specific-legacy-journey-run/v1");
  expect(manifest.native_gate).toEqual({
    backend: "native_effect",
    reason: "NATIVE_EVIDENCE_COLLECTED_BY_SEPARATE_NATIVE_RUN",
    result: "ready",
  });
  expect(manifest.legacy).toHaveLength(3);
  expect(new Set(manifest.legacy.map((run) => run.journey)).size).toBe(3);
  for (const run of manifest.legacy) {
    expect(run.backend).toBe("legacy_symfony");
    expect(run.result).toBe("passed");
    expect(run.observations.length).toBeGreaterThan(0);
    expect(canonicalJson(run.observations)).toBe(
      canonicalJson(decodeLegacyArtifact(resolve(evidenceRoot, run.artifact_pointer)).observations),
    );
  }
});

test("legacy witness artifacts record observed legacy semantics without normalization", () => {
  for (const journey of [
    "applicant_admission",
    "interview_invitation",
    "owner_approval",
  ] as const) {
    const artifactPath = resolve(evidenceRoot, `artifacts/${journey}-legacy-symfony.json`);
    const artifactBytes = readFileSync(artifactPath, "utf8");
    const artifact = decodeLegacyArtifact(artifactPath);

    expect(canonicalJson(artifact)).toBe(artifactBytes);
    expect(artifact.artifact_schema_version).toBe("claim-specific-journey-observation/v1");
    expect(artifact.backend).toBe("legacy_symfony");
    expect(artifact.database_observation.method).toBe("fresh_sqlite_read_back");
    expect(artifact.environment).toEqual({
      api: "real_legacy_symfony_http_listener",
      database: "disposable_loopback_sqlite",
      network: "loopback_only",
      providers: "disabled",
    });
    const rowCounts = Object.values(artifact.database_observation.row_counts);
    expect(rowCounts.some((count) => count >= 1)).toBe(true);
    expect(rowCounts.every((count) => count >= 0)).toBe(true);

    const authorization = artifact.observations.find(
      (observation) => observation.observation_method === "authorization_rejection_without_session",
    );
    expect([401, 403]).toContain(authorization?.status);
    expect(
      artifact.observations.some(
        (observation) => observation.observation_method === "real_http_operation",
      ),
    ).toBe(true);
    expect(
      artifact.observations.some(
        (observation) => observation.observation_method === "fresh_http_read_after_write",
      ),
    ).toBe(true);
    // Lowercase legacy status enums stay as observed in response digests; the
    // runner records the raw bytes rather than mapping onto native labels.
    expect(artifactBytes).not.toMatch(/"status":"(Pending|Rejected|Accepted)"/u);
  }

  const receipt = decodeLegacyArtifact(
    resolve(evidenceRoot, "artifacts/owner_approval-legacy-symfony.json"),
  );
  // Legacy receipt status values are lowercase strings (pending/refunded).
  const statuses = readFileSync(
    resolve(evidenceRoot, "artifacts/owner_approval-legacy-symfony.json"),
    "utf8",
  );
  expect(statuses).toContain("fresh_sqlite_read_back");
  void receipt;

  // The duplicate-application rejection surfaces as an unhandled 500 on
  // legacy; the artifact must preserve it verbatim rather than normalize to
  // the native typed 409 conflict.
  const applicant = decodeLegacyArtifact(
    resolve(evidenceRoot, "artifacts/applicant_admission-legacy-symfony.json"),
  );
  const duplicate = applicant.observations.find(
    (observation) => observation.observation_method === "invalid_transition_rejection",
  );
  expect(duplicate?.status).toBe(500);
  expect(applicant.verified_semantics.rejection_ids).toEqual([]);
  expect(applicant.verified_semantics.assertion_ids).toEqual([
    "assertion-applicant-admission-submitted",
  ]);

  // Interview already-responded rejection is typed 422 on legacy (409+422 on
  // native), which still warrants the rejection claim.
  const interview = decodeLegacyArtifact(
    resolve(evidenceRoot, "artifacts/interview_invitation-legacy-symfony.json"),
  );
  const interviewRejection = interview.observations.find(
    (observation) => observation.observation_method === "invalid_transition_rejection",
  );
  expect(interviewRejection?.status).toBe(422);
  expect(interview.verified_semantics.rejection_ids).toEqual([
    "rejection-interview-invitation-already-responded",
  ]);
  expect(interview.verified_semantics.effect_ids).toEqual([
    "effect-interview-invitation-notification-requested",
  ]);
});

test("legacy artifact digests round-trip against manifest records", () => {
  const manifest = readJson(
    resolve(evidenceRoot, "legacy-run-manifest.json"),
  ) as LegacyJourneyRunManifest;
  for (const run of manifest.legacy) {
    const bytes = readFileSync(resolve(evidenceRoot, run.artifact_pointer), "utf8");
    expect(sha256(bytes)).toBe(run.artifact_digest);
    expect(run.database_digest.length).toBe("sha256:".length + 64);
    expect(run.runner_digest.length).toBe("sha256:".length + 64);
    expect(run.fixture_digest.length).toBe("sha256:".length + 64);
  }
});
