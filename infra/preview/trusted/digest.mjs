#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { canonicalJson, IDENTITY, parseArgs, requireOption, requireSha, sha256 } from "./contracts.mjs";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function repositoryName(remote) {
  return remote.replace(/^https?:\/\/[^/]+\//u, "").replace(/^git@[^:]+:/u, "").replace(/\.git$/u, "");
}

function archiveDigest(headSha) {
  const result = spawnSync("git", ["archive", "--format=tar", `--prefix=mono-web-${headSha}/`, headSha], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git archive failed: ${result.stderr?.toString().trim() || `exit ${result.status}`}`);
  }
  return `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`;
}

function trackedManifest(headSha) {
  const files = git(["ls-tree", "-r", "--name-only", headSha]).split("\n").filter(Boolean);
  const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/u;
  if (files.some((file) => forbidden.test(file))) {
    throw new Error("credential-shaped file is tracked by the source revision");
  }
  return files;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const headSha = requireSha(requireOption(args, "head-sha"));
  const expectedRepository = args.repository ?? IDENTITY.repository;
  const expectedRemote = args["expected-remote"] ?? expectedRepository;
  const observedHead = requireSha(git(["rev-parse", "HEAD"]), "observedHead");
  if (observedHead !== headSha) {
    throw new Error(`checked-out head mismatch: expected ${headSha}, observed ${observedHead}`);
  }
  const remote = git(["config", "--get", "remote.origin.url"]);
  const observedRepository = repositoryName(remote);
  if (observedRepository !== expectedRemote && observedRepository !== expectedRepository) {
    throw new Error(`repository mismatch: expected ${expectedRepository}, observed ${observedRepository}`);
  }
  const files = trackedManifest(headSha);
  const digest = archiveDigest(headSha);
  if (args["expected-digest"] !== undefined && args["expected-digest"] !== digest) {
    throw new Error(`source archive digest mismatch: expected ${args["expected-digest"]}, observed ${digest}`);
  }
  const result = {
    schema: "preview-source-digest/v1",
    repository: expectedRepository,
    observedRepository,
    headSha,
    archiveDigest: digest,
    trackedFileCount: files.length,
    fileManifestDigest: `sha256:${sha256(files.join("\n"))}`,
    credentialFree: true,
  };
  if (args.output) writeFileSync(args.output, canonicalJson(result), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(canonicalJson(result));
}

try {
  main();
} catch (error) {
  process.stderr.write(`preview digest failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
