#!/usr/bin/env bun

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { API_METADATA_SCRIPT } from "./src/api.js";
import { canonicalJson } from "./src/canonical.js";
import { decodeLegacyMetadataRecords, enrichLegacyOpenApi } from "./src/capability-parity.js";
import { inspectJsonMembers } from "./src/json-safety.js";

type Mode = "check" | "write";

interface Options {
  readonly input: string;
  readonly output: string;
  readonly serverRoot: string;
  readonly php: string;
  readonly mode: Mode;
}

const parseArgs = (rawArgs: readonly string[]): Options => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key))
      throw new Error("LEGACY_OPENAPI_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  const allowed = new Set(["--input", "--output", "--server-root", "--php", "--mode"]);
  if ([...values.keys()].some((key) => !allowed.has(key)))
    throw new Error("LEGACY_OPENAPI_ARGUMENTS_INVALID");
  const input = values.get("--input");
  const output = values.get("--output");
  const serverRoot = values.get("--server-root");
  const php = values.get("--php");
  const mode = values.get("--mode");
  if (
    input === undefined ||
    output === undefined ||
    serverRoot === undefined ||
    php === undefined ||
    (mode !== "check" && mode !== "write")
  )
    throw new Error("LEGACY_OPENAPI_ARGUMENTS_INVALID");
  return {
    input: resolve(input),
    output: resolve(output),
    serverRoot: resolve(serverRoot),
    php,
    mode,
  };
};

const runMetadataCollector = async (options: Options): Promise<unknown> => {
  const child = Bun.spawn(
    [options.php, "-r", API_METADATA_SCRIPT, "--", "[]", options.serverRoot],
    {
      cwd: options.serverRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, APP_ENV: "test" },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`LEGACY_METADATA_COLLECTOR_FAILED:${stderr.trim() || exitCode}`);
  if (inspectJsonMembers(stdout) !== "valid") throw new Error("LEGACY_METADATA_JSON_INVALID");
  return JSON.parse(stdout) as unknown;
};

const writeAtomically = async (path: string, bytes: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const inputBytes = await readFile(options.input, "utf8");
  if (inspectJsonMembers(inputBytes) !== "valid") throw new Error("LEGACY_OPENAPI_JSON_INVALID");
  const openapi = JSON.parse(inputBytes) as unknown;
  const metadata = decodeLegacyMetadataRecords(await runMetadataCollector(options));
  const generated = canonicalJson(enrichLegacyOpenApi(openapi, metadata));
  if (options.mode === "write") {
    await writeAtomically(options.output, generated);
    process.stdout.write("legacy_openapi_written\n");
    return;
  }
  const committed = await readFile(options.output, "utf8").catch(() => null);
  if (committed !== generated) throw new Error("LEGACY_OPENAPI_STALE");
  process.stdout.write("legacy_openapi_current\n");
};

await main();
