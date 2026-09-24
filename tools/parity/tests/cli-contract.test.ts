import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDirectory = mkdtempSync(join(tmpdir(), "parity-cli-contract-"));

const directory = join(harnessDirectory, "work");

mkdirSync(directory);

const executable = fileURLToPath(new URL("../cli.ts", import.meta.url));

afterAll(() => rmSync(harnessDirectory, { recursive: true, force: true }));

const invoke = (args: readonly string[]) =>
  spawnSync(process.execPath, ["--no-env-file", executable, ...args], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: harnessDirectory,
      TMPDIR: harnessDirectory,
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });

const expectCommandError = (args: readonly string[]) => {
  const result = invoke(args);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(12);
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe("command_error");
  expect(report.exit_code).toBe(12);
  expect(report.projection_write).toEqual({ status: "blocked", target_ref: null });
  expect(report.failures.map((failure: { reason_code: string }) => failure.reason_code)).toEqual([
    "COMMAND_ARGUMENT_ERROR",
  ]);
  expect(result.stderr).toContain("--mode");
};

describe("RAT process contract", () => {
  test("help needs no roots or authorities and writes no artifacts", () => {
    for (const flag of ["--help", "-h"]) {
      const result = invoke(["--", flag]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--root");
      expect(result.stdout).toContain("fixture_injection");
      expect(result.stdout).toContain("F0_deterministic_replay");
    }

    expect(readdirSync(directory)).toEqual([]);
  });

  test("help cannot mask unknown flags, missing supplied values or invalid earlier enums", () => {
    expectCommandError(["--help", "--unknown-option"]);
    expectCommandError(["--help", "--root"]);
    expectCommandError(["--mode", "invalid", "--mode", "diff", "--help"]);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("mode boundaries fail before reading authorities or running collectors", () => {
    expectCommandError([]);
    const roots = ["--root", directory, "--legacy-root", directory];
    expectCommandError([...roots, "--mode", "diff"]);
    expectCommandError([...roots, "--mode", "write", "--intent-register", "missing-intent"]);
    expectCommandError([...roots, "--mode", "fixture_injection"]);
    expectCommandError([
      ...roots,
      "--mode",
      "fixture_injection",
      "--falsifier",
      "F0_deterministic_replay",
      "--evidence-register",
      "missing-evidence",
    ]);
    expectCommandError([
      ...roots,
      "--mode",
      "diff",
      "--intent-register",
      "missing-intent",
      "--evidence-register",
      "missing-evidence",
      "--falsifier",
      "F0_deterministic_replay",
    ]);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("last mode and falsifier win across separators in the actual synthetic runner", () => {
    const result = invoke([
      "--root",
      join(directory, "missing-root"),
      "--legacy-root",
      join(directory, "missing-legacy"),
      "--mode",
      "write",
      "--",
      "--mode",
      "fixture_injection",
      "--falsifier",
      "F0_deterministic_replay",
      "--falsifier",
      "F1_missing_required_source",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(13);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.exit_code).toBe(13);
    expect(report.status).toBe("falsifier_passed");
    expect(report.falsifier_id).toBe("F1_missing_required_source");
    expect(report.projection_write.status).toBe("blocked");
  }, 35_000);
});
