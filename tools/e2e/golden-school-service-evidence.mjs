import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { goldenSteps } from "./golden-school-service.mjs";

export const goldenArtifactName =
  /^(?:evidence\.json|failure\.log|browser-(?:evidence|network|trace-sanitized|cleanup|active|build)\.json|playwright-evidence\.json|dashboard-(?:runtime|command-[0-9]+)\.log)$/;
export const goldenRunnerPaths = [
  "tools/e2e/placement-check.ts",
  "tools/e2e/golden-school-service.mjs",
  "apps/dashboard/e2e/run-real-native-placement.mjs",
  "apps/dashboard/e2e/native-placement.spec.ts",
  "tools/e2e/golden-school-service-evidence.mjs",
];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const dashboardBuildInventory = async (root) => {
  const files = [];
  const visit = async (relative) => {
    const path = join(root, "apps/dashboard/build", relative);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "build must not contain symlinks");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    } else {
      assert.ok(info.isFile(), "build contains a non-file");
      const bytes = await readFile(path);
      files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
    }
  };
  await visit("");
  assert.ok(
    files.some(({ path }) => path === "server/index.js"),
    "server build absent",
  );
  assert.ok(
    files.some(({ path }) => path.startsWith("client/")),
    "client build absent",
  );
  return files;
};

const safeBytes = (bytes) => {
  const text = bytes.toString("utf8");
  assert.ok(!text.includes("\u0000"), "binary diagnostic rejected");
  assert.ok(
    !/journey-secret-0123456789abcdef|synthetic-school-service-(?:dispatch-)?token/.test(text),
    "synthetic secret rejected",
  );
  assert.ok(
    !/"(?:authorization|set-cookie|cookie)"\s*:\s*"(?!\[REDACTED\])[^"\s]+|^(?:authorization|set-cookie|cookie):\s*(?!\[REDACTED\])\S+/im.test(
      text,
    ),
    "credential diagnostic rejected",
  );
  assert.ok(
    !/-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|access_token|refresh_token)"\s*:\s*"(?!\[REDACTED\])[^"\s]+/i.test(
      text,
    ),
    "private diagnostic rejected",
  );
};

// Only receipt-bound, allowlisted regular files can enter the upload directory.
// Errors deliberately omit artifact contents and supplied values.
export const inspectGoldenEvidence = async ({ directory, root, revision, sourceTree }) => {
  assert.ok((await lstat(directory)).isDirectory(), "evidence directory absent");
  assert.ok(!(await lstat(directory)).isSymbolicLink(), "evidence directory symlink rejected");
  const read = async (name) => {
    const info = await lstat(join(directory, name));
    assert.ok(info.isFile() && !info.isSymbolicLink(), "diagnostic must be a regular file");
    assert.ok(info.size <= 16 * 1024 * 1024, "diagnostic exceeds size limit");
    const bytes = await readFile(join(directory, name));
    safeBytes(bytes);
    return bytes;
  };
  const receiptBytes = await read("receipt.json");
  const receipt = JSON.parse(receiptBytes);
  assert.ok(
    receipt.schema_version === "native-functional-journey/v1",
    "unsupported receipt schema",
  );
  assert.ok(receipt.journey_ref_id === "intent://golden-school-service", "wrong journey");
  assert.ok(receipt.mono_revision_ref_id === "rev-" + revision, "wrong receipt revision");
  assert.ok(
    receipt.source_tree === sourceTree && receipt.clean_source === true,
    "wrong receipt source tree",
  );
  assert.ok(
    receipt.environment_kind === "local_disposable" && receipt.required_browser === true,
    "wrong execution environment",
  );
  assert.deepEqual(
    receipt.runner_sources.map(({ path }) => path),
    goldenRunnerPaths,
    "runner inventory differs",
  );
  for (const item of receipt.runner_sources)
    assert.ok(
      sha256(await readFile(join(root, item.path))) === item.sha256,
      "runner digest differs",
    );
  assert.ok(
    receipt.fixture_digest === "sha256:" + receipt.runner_sources[0].sha256,
    "fixture digest differs",
  );
  assert.ok(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length <= 32,
    "invalid artifact inventory",
  );
  assert.ok(
    receipt.artifact_digest === "sha256:" + sha256(JSON.stringify(receipt.artifacts)),
    "artifact inventory digest differs",
  );
  const files = new Map([["receipt.json", receiptBytes]]);
  const documents = new Map();
  for (const item of receipt.artifacts) {
    assert.ok(
      typeof item.path === "string" && goldenArtifactName.test(item.path),
      "artifact path outside allowlist",
    );
    assert.ok(!files.has(item.path), "duplicate artifact path");
    const bytes = await read(item.path);
    assert.ok(
      bytes.length === item.bytes && sha256(bytes) === item.sha256,
      "artifact bytes differ",
    );
    files.set(item.path, bytes);
    if (item.path.endsWith(".json")) documents.set(item.path, JSON.parse(bytes));
  }
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [...files.keys()].sort(),
    "unlisted runtime artifact remains",
  );
  const build = documents.get("browser-build.json");
  if (build) {
    assert.ok(build.revision === revision && build.sourceTree === sourceTree, "wrong build source");
    assert.ok(
      build.digest === "sha256:" + sha256(JSON.stringify(build.files)),
      "build inventory digest differs",
    );
    assert.deepEqual(
      build.files,
      await dashboardBuildInventory(root),
      "built dashboard bytes differ",
    );
  }
  return { receipt, files, documents };
};

export const stageGoldenEvidence = async (evidence, destination) => {
  for (const [name, bytes] of evidence.files)
    await writeFile(join(destination, name), bytes, { mode: 0o600, flag: "wx" });
};

export const requireGoldenSuccess = ({ receipt, documents }) => {
  assert.ok(
    receipt.result === "passed" && receipt.exit_code === 0 && receipt.termination_signal === null,
    "journey did not pass",
  );
  assert.deepEqual(receipt.step_ids, goldenSteps, "required steps missing or duplicated");
  for (const name of [
    "evidence.json",
    "browser-build.json",
    "browser-evidence.json",
    "browser-network.json",
    "browser-cleanup.json",
    "browser-active.json",
    "playwright-evidence.json",
  ])
    assert.ok(documents.has(name), "required artifact absent: " + name);
  const evidence = documents.get("evidence.json");
  assert.ok(
    evidence.passed === true && evidence.failure === null && evidence.fault === null,
    "parent did not pass",
  );
  assert.ok(
    evidence.revision === receipt.mono_revision_ref_id.slice(4) &&
      evidence.sourceTree === receipt.source_tree,
    "parent source differs",
  );
  assert.ok(
    evidence.mode === "--golden-school-service" && evidence.cleanSource === true,
    "wrong parent mode",
  );
  assert.deepEqual(
    evidence.observations.map(({ step }) => step),
    goldenSteps,
    "parent observations incomplete",
  );
  for (const key of [
    "processesExited",
    "portsReleased",
    "postgresRemoved",
    "credentialManifestRemoved",
    "receiverClosed",
  ])
    assert.ok(evidence.cleanup[key] === true, "parent cleanup incomplete: " + key);
  assert.deepEqual(evidence.cleanup.errors, [], "parent cleanup failed");
  assert.ok(
    evidence.cleanup.processes.every(({ exited }) => exited === true),
    "parent process remains",
  );
  const cleanup = documents.get("browser-cleanup.json");
  assert.ok(
    cleanup.processesExited === true &&
      cleanup.privateTracesRemoved === true &&
      cleanup.privateResultsRemoved === true,
    "browser cleanup incomplete",
  );
  assert.deepEqual(cleanup.cleanupErrors, [], "browser cleanup failed");
  assert.ok(
    cleanup.failure === null && cleanup.processes.every(({ exited }) => exited === true),
    "browser process failed",
  );
  const browser = documents.get("browser-evidence.json");
  assert.ok(
    browser.passed === true && browser.revision === evidence.revision,
    "browser evidence failed or stale",
  );
  assert.deepEqual(browser.steps, goldenSteps.slice(1), "browser steps incomplete");
  const network = documents.get("browser-network.json");
  assert.ok(network.passed === true, "network evidence failed");
  assert.deepEqual(network.steps, goldenSteps.slice(1), "network steps incomplete");
  assert.deepEqual(
    documents.get("playwright-evidence.json"),
    {
      tests: [
        {
          title: "golden school-service continuous functional journey",
          ok: true,
          tests: [{ expectedStatus: "passed", resultStatuses: ["passed"] }],
        },
      ],
    },
    "exactly one first-attempt browser pass is required",
  );
};
