import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  goldenRunnerPaths,
  inspectGoldenEvidence,
  sha256,
  stageGoldenEvidence,
} from "./golden-school-service-evidence.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

// A partial failed-run receipt exercises diagnostic custody, not journey acceptance.
const diagnostic = async (directory, path, text) => {
  const bytes = Buffer.from(text);
  const sources = await Promise.all(
    goldenRunnerPaths.map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(root, path))),
    })),
  );
  const artifacts = [{ path, sha256: sha256(bytes), bytes: bytes.length }];
  await writeFile(join(directory, path), bytes);
  await writeFile(
    join(directory, "receipt.json"),
    JSON.stringify({
      schema_version: "native-functional-journey/v1",
      journey_ref_id: "intent://golden-school-service",
      mono_revision_ref_id: "rev-diagnostic-fixture",
      source_tree: "diagnostic-fixture",
      clean_source: true,
      environment_kind: "local_disposable",
      required_browser: true,
      result: "failed",
      exit_code: 1,
      runner_sources: sources,
      fixture_digest: "sha256:" + sources[0].sha256,
      artifacts,
      artifact_digest: "sha256:" + sha256(JSON.stringify(artifacts)),
    }),
  );
};

const stage = async (directory, destination) =>
  stageGoldenEvidence(
    await inspectGoldenEvidence({
      directory,
      root,
      revision: "diagnostic-fixture",
      sourceTree: "diagnostic-fixture",
    }),
    destination,
  );

test("diagnostic custody rejects encoded credentials before any upload file exists", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "golden-diagnostic-custody-"));
  try {
    const cases = [
      ["evidence.json", '{"authoriz\\u0061tion":"Bearer private-value"}'],
      ["evidence.json", '{"message":"synthetic-school-service-\\u0074oken"}'],
      ["failure.log", "Authorization: [REDACTED]Bearer private-value"],
      ["evidence.json", '{"cookie":" private-value"}'],
      ["failure.log", "DATABASE_PASSWORD=private-value"],
      ["private-trace-1.zip", "unlisted raw trace"],
    ];
    for (const [index, [path, text]] of cases.entries()) {
      const directory = join(temporary, String(index));
      const destination = join(temporary, String(index) + "-upload");
      await mkdir(directory);
      await mkdir(destination);
      await diagnostic(directory, path, text);
      await expect(stage(directory, destination)).rejects.toThrow();
      expect(await readdir(destination)).toEqual([]);
    }
    const directory = join(temporary, "safe");
    const destination = join(temporary, "safe-upload");
    await mkdir(directory);
    await mkdir(destination);
    const redacted = '{"authorization":"[REDACTED]"}';
    await diagnostic(directory, "evidence.json", redacted);
    await stage(directory, destination);
    expect(await readFile(join(destination, "evidence.json"), "utf8")).toBe(redacted);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a setup failure publishes only its failed summary for upload", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "golden-output-custody-"));
  try {
    const destination = join(temporary, "upload");
    const output = join(temporary, "github-output");
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", join(root, "tools/e2e/golden-school-service-ci.mjs"), destination],
      {
        env: {
          ...process.env,
          GOLDEN_EXPECTED_REVISION: "not-this-checkout",
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    const [header, ...lines] = (await readFile(output, "utf8")).trimEnd().split("\n");
    expect(header.startsWith("artifact_paths<<")).toBe(true);
    expect(lines.pop()).toBe(header.slice("artifact_paths<<".length));
    expect(lines).toEqual([join(destination, "ci-summary.json")]);
    expect(JSON.parse(await readFile(lines[0], "utf8")).passed).toBe(false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
