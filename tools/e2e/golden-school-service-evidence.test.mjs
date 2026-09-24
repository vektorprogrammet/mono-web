import { expect, test } from "bun:test";
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
