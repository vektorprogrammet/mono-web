import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  inspectGoldenEvidence,
  requireGoldenSuccess,
  stageGoldenEvidence,
} from "./golden-school-service-evidence.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const destination = process.argv[2];
assert.ok(
  process.argv.length === 3 && isAbsolute(destination),
  "Usage: bun --no-env-file tools/e2e/golden-school-service-ci.mjs /absolute/private/upload-directory",
);
assert.ok(
  relative(root, destination).startsWith("../"),
  "upload directory must be outside checkout",
);
await mkdir(destination, { mode: 0o700 });
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, "git identity unavailable");
  return result.stdout.trim();
};
const summary = {
  schema_version: "golden-school-service-ci/v1",
  passed: false,
  command: "bun run test:golden-school-service",
  command_exit_code: null,
  command_signal: null,
  interruption: null,
  acceptance_error: null,
};
let temporaryRoot;
let phase = "source and toolchain preflight";
try {
  summary.revision = git("rev-parse", "HEAD");
  summary.source_tree = git("rev-parse", "HEAD^{tree}");
  assert.equal(git("status", "--porcelain"), "", "requires clean committed checkout");
  if (process.env.GOLDEN_EXPECTED_REVISION)
    assert.ok(
      summary.revision === process.env.GOLDEN_EXPECTED_REVISION,
      "checkout differs from event revision",
    );
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(
    "bun@" + process.versions.bun === manifest.packageManager,
    "Bun differs from root packageManager",
  );
  const node = spawnSync(process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node", ["--version"], {
    encoding: "utf8",
  });
  assert.ok(node.status === 0 && /^v22\./.test(node.stdout.trim()), "Node 22 is required");
  summary.runtime = {
    bun: process.versions.bun,
    node: node.stdout.trim(),
    platform: process.platform,
    architecture: process.arch,
  };
  temporaryRoot = await mkdtemp(join(tmpdir(), "golden-ci-"));
  const environment = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TZ",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
      "PLAYWRIGHT_NODE_EXECUTABLE",
      "PLAYWRIGHT_BROWSERS_PATH",
      "GOLDEN_SCHOOL_SERVICE_FAULT",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  environment.TMPDIR = temporaryRoot;
  phase = "golden command";
  const child = spawn("bun", ["run", "test:golden-school-service"], {
    cwd: root,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runnerPid;
  let artifacts;
  let pending = "";
  let forceTimer;
  const stop = (signal, reason) => {
    summary.interruption ??= reason;
    try {
      process.kill(runnerPid ?? child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    forceTimer ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }, 60_000);
  };
  const interrupt = () => stop("SIGINT", "SIGINT");
  const terminate = () => stop("SIGTERM", "SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const timer = setTimeout(() => stop("SIGTERM", "15-minute command timeout"), 15 * 60_000);
  child.stdout.on("data", (chunk) => {
    pending += String(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (/^runner-pid: [0-9]+$/.test(line)) {
        runnerPid = Number(line.slice(12));
        process.stdout.write(line + "\n");
      }
      if (line.startsWith("artifacts: ")) {
        const candidate = line.slice(11);
        if (
          isAbsolute(candidate) &&
          relative(temporaryRoot, candidate).startsWith("vektor-placements-0096-") &&
          !relative(temporaryRoot, candidate).includes("/")
        ) {
          artifacts = candidate;
          process.stdout.write(line + "\n");
        }
      }
    }
    // No raw command log enters CI output or uploaded evidence.
    if (pending.length > 4096) pending = "";
  });
  child.stderr.resume();
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    summary.command_exit_code = outcome.code;
    summary.command_signal = outcome.signal;
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  phase = "receipt integrity and safe staging";
  assert.ok(artifacts, "runner did not report an evidence directory");
  assert.ok(
    git("rev-parse", "HEAD") === summary.revision && git("status", "--porcelain") === "",
    "source changed during command",
  );
  const evidence = await inspectGoldenEvidence({
    directory: artifacts,
    root,
    revision: summary.revision,
    sourceTree: summary.source_tree,
  });
  await stageGoldenEvidence(evidence, destination);
  phase = "required journey result";
  requireGoldenSuccess(evidence);
  assert.ok(
    summary.command_exit_code === 0 &&
      summary.command_signal === null &&
      summary.interruption === null,
    "first command attempt did not pass",
  );
  summary.passed = true;
} catch (error) {
  summary.acceptance_error = {
    phase,
    reason:
      error.code === "ERR_ASSERTION"
        ? String(error.message).split("\n")[0].slice(0, 180)
        : "Required evidence unavailable or malformed",
  };
} finally {
  if (temporaryRoot) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      summary.temporary_root_removed = true;
    } catch {
      summary.passed = false;
      summary.cleanup_error = "CI temporary root removal failed";
    }
  }
  await writeFile(join(destination, "ci-summary.json"), JSON.stringify(summary, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(JSON.stringify({ ...summary, evidence_directory: destination }) + "\n");
}
process.exitCode = summary.passed
  ? 0
  : summary.command_exit_code > 0
    ? summary.command_exit_code
    : 1;
