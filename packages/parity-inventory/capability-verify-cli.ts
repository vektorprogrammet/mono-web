#!/usr/bin/env bun

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "./src/canonical.js";
import { generateCapabilityArtifacts, type AuthorityPin } from "./src/capability-parity.js";
import { inspectJsonMembers, isJsonObject } from "./src/json-safety.js";

type Mode = "check" | "write";

interface Options {
  readonly legacyOpenapi: string;
  readonly nativeOpenapi: string;
  readonly intentRegister: string;
  readonly evidenceRegister: string;
  readonly output: string;
  readonly migrationCandidate: string | null;
  readonly mode: Mode;
}

const REQUIRED_OPTIONS = {
  "--legacy-openapi": true,
  "--native-openapi": true,
  "--intent-register": true,
  "--evidence-register": true,
  "--output": true,
  "--mode": true,
} as const;

const OPTIONAL_OPTIONS = { "--migration-candidate": true } as const;
const GENERATOR_PATHS = [
  "packages/parity-inventory/capability-verify-cli.ts",
  "packages/parity-inventory/legacy-openapi-cli.ts",
  "packages/parity-inventory/schemas",
  "packages/parity-inventory/src/capability-parity.ts",
  "packages/http-api/openapi.json",
  "packages/sdk/legacy-symfony-openapi.snapshot.json",
] as const;

export const parseCapabilityVerifyArgs = (rawArgs: readonly string[]): Options => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key) ||
      (!(key in REQUIRED_OPTIONS) && !(key in OPTIONAL_OPTIONS))
    )
      throw new Error("CAPABILITY_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  if (Object.keys(REQUIRED_OPTIONS).some((key) => !values.has(key)))
    throw new Error("CAPABILITY_ARGUMENTS_INVALID");
  const mode = values.get("--mode");
  if (mode !== "check" && mode !== "write") throw new Error("CAPABILITY_ARGUMENTS_INVALID");
  return {
    legacyOpenapi: resolve(values.get("--legacy-openapi") as string),
    nativeOpenapi: resolve(values.get("--native-openapi") as string),
    intentRegister: resolve(values.get("--intent-register") as string),
    evidenceRegister: resolve(values.get("--evidence-register") as string),
    output: resolve(values.get("--output") as string),
    migrationCandidate: values.has("--migration-candidate")
      ? resolve(values.get("--migration-candidate") as string)
      : null,
    mode,
  };
};

const gitOutput = async (cwd: string, args: readonly string[]): Promise<string> => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`AUTHORITY_GIT_FAILED:${stderr.trim() || args[0]}`);
  return stdout.trim();
};

const pinAuthority = async (path: string, parsed: unknown): Promise<AuthorityPin> => {
  const repositoryRoot = await gitOutput(dirname(path), ["rev-parse", "--show-toplevel"]);
  const relativePath = relative(repositoryRoot, path).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "")
    throw new Error("AUTHORITY_PATH_INVALID");
  if ((await gitOutput(repositoryRoot, ["status", "--porcelain"])) !== "")
    throw new Error("AUTHORITY_REPOSITORY_DIRTY");
  const [revision, blobOid, liveBlobOid] = await Promise.all([
    gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
    gitOutput(repositoryRoot, ["rev-parse", `HEAD:${relativePath}`]),
    gitOutput(repositoryRoot, ["hash-object", relativePath]),
  ]);
  if (blobOid !== liveBlobOid) throw new Error("AUTHORITY_BLOB_DRIFT");
  if (!isJsonObject(parsed) || typeof parsed.schema_version !== "string")
    throw new Error("AUTHORITY_SCHEMA_VERSION_MISSING");
  const bytes = await readFile(path, "utf8");
  return {
    repository_ref: `external:${basename(repositoryRoot)}`,
    authority_path: relativePath,
    revision,
    blob_oid: blobOid,
    digest: sha256(bytes),
    source_schema_version: parsed.schema_version,
  };
};

const readJson = async (
  path: string,
  requireCanonical: boolean,
): Promise<{ readonly bytes: string; readonly value: unknown }> => {
  const bytes = await readFile(path, "utf8");
  if (inspectJsonMembers(bytes) !== "valid") throw new Error(`JSON_INVALID:${basename(path)}`);
  const value = JSON.parse(bytes) as unknown;
  if (requireCanonical && canonicalJson(value) !== bytes)
    throw new Error(`JSON_NONCANONICAL:${basename(path)}`);
  return { bytes, value };
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
  const options = parseCapabilityVerifyArgs(process.argv.slice(2));
  const [legacyOpenapi, nativeOpenapi, intentAuthority, evidenceAuthority] = await Promise.all([
    readJson(options.legacyOpenapi, false),
    readJson(options.nativeOpenapi, false),
    readJson(options.intentRegister, true),
    readJson(options.evidenceRegister, true),
  ]);
  const [intentPin, evidencePin, sourceRevisionRef] = await Promise.all([
    pinAuthority(options.intentRegister, intentAuthority.value),
    pinAuthority(options.evidenceRegister, evidenceAuthority.value),
    gitOutput(process.cwd(), ["log", "-1", "--format=%H", "--", ...GENERATOR_PATHS]),
  ]);
  const generated = generateCapabilityArtifacts({
    legacyOpenApiBytes: legacyOpenapi.bytes,
    nativeOpenApiBytes: nativeOpenapi.bytes,
    intentAuthority: intentAuthority.value,
    intentPin,
    evidenceAuthority: evidenceAuthority.value,
    evidencePin,
    sourceRevisionRef,
  });
  const migrationBytes = canonicalJson(generated.migratedIntent);

  if (options.mode === "write") {
    await Promise.all(
      Object.entries(generated.bytes).map(([name, bytes]) =>
        writeAtomically(resolve(options.output, name), bytes),
      ),
    );
    if (options.migrationCandidate !== null)
      await writeAtomically(options.migrationCandidate, migrationBytes);
    process.stdout.write("capability_parity_written\n");
    return;
  }

  const stale: string[] = [];
  for (const [name, expected] of Object.entries(generated.bytes)) {
    const actual = await readFile(resolve(options.output, name), "utf8").catch(() => null);
    if (actual !== expected) stale.push(name);
  }
  if (options.migrationCandidate !== null) {
    const actual = await readFile(options.migrationCandidate, "utf8").catch(() => null);
    if (actual !== migrationBytes) stale.push("migration-candidate");
  }
  if (stale.length > 0) throw new Error(`CAPABILITY_PARITY_STALE:${stale.sort().join(",")}`);
  process.stdout.write("capability_parity_current\n");
};

await main();
