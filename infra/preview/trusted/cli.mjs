#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildAlchemyCommand } from "./alchemy.mjs";
import { canonicalJson, IDENTITY, identityFromArgs, ledgerKey, parseArgs, requireDigest, requireOption, requireSha, serializeIdentity } from "./contracts.mjs";
import { createOwnershipManifest } from "./ownership.mjs";
import { absent, beginApply, buildPlan, live, planned, reconcile, request, retire, seedReady, seeded, validate } from "./lifecycle.mjs";
import { initializeLedger, readLedger } from "./ledger.mjs";

const ROOT = dirname(new URL(import.meta.url).pathname);
const DIGEST_TOOL = resolve(ROOT, "digest.mjs");
const VERIFY_TOOL = resolve(ROOT, "verify.mjs");

function runTool(tool, args) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${tool} exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function readResources(path) {
  const resources = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(resources)) throw new Error("resources must be an array");
  return resources;
}

function inputDigests(args) {
  return {
    sourceDigest: requireDigest(requireOption(args, "source-digest"), "sourceDigest"),
    imageDigest: requireDigest(requireOption(args, "image-digest"), "imageDigest"),
    seedDigest: requireDigest(requireOption(args, "seed-digest"), "seedDigest"),
    routeContractDigest: requireDigest(requireOption(args, "route-contract-digest"), "routeContractDigest"),
  };
}

export function validateInputs(args) {
  const identity = identityFromArgs(args);
  const result = {
    schema: "preview-trusted-inputs/v1",
    identity: serializeIdentity(identity),
    ledgerKey: ledgerKey(identity),
    environment: IDENTITY.environment,
    providerMutation: false,
    credentialBoundary: "provider credentials are unavailable to credential-free validation",
  };
  if (args["plan-only"] === false || args["plan-only"] === "false") result.providerMutation = true;
  return result;
}

export function packageSource(args) {
  const headSha = requireSha(requireOption(args, "head-sha"));
  const result = runTool(DIGEST_TOOL, ["--head-sha", headSha, "--repository", args.repository ?? IDENTITY.repository, ...(args.output ? ["--output", args.output] : [])]);
  return result;
}

export function verifySource(args) {
  const result = runTool(VERIFY_TOOL, ["--input", requireOption(args, "input"), "--head-sha", requireOption(args, "head-sha"), "--archive-digest", requireOption(args, "archive-digest"), "--repository", args.repository ?? IDENTITY.repository, ...(args.output ? ["--output", args.output] : [])]);
  return result;
}

export function packageOwnership(args) {
  const identity = identityFromArgs(args);
  const digests = inputDigests(args);
  const manifest = createOwnershipManifest({ identity, ...digests, resources: readResources(requireOption(args, "resources")) });
  const output = requireOption(args, "output");
  writeFileSync(output, canonicalJson(manifest), { encoding: "utf8", mode: 0o600 });
  return { manifestDigest: manifest.manifestDigest, resourceCount: manifest.resources.length, output };
}

function lifecycle(args, operation) {
  const store = requireOption(args, "store");
  const identity = identityFromArgs(args);
  if (operation === "plan" || operation === "deploy" || operation === "destroy") return buildPlan(args, operation);
  if (operation === "init") return initializeLedger(store, identity);
  if (operation === "read") return readLedger(store, identity);
  if (operation === "request") return request(store, identity);
  if (operation === "validate-state") return validate(store, identity);
  if (operation === "seed-ready") return seedReady(store, identity);
  if (operation === "planned") return planned(store, identity);
  if (operation === "begin-apply") return beginApply(store, identity, inputDigests(args));
  if (operation === "seeded") return seeded(store, identity);
  if (operation === "live") return live(store, identity);
  if (operation === "retire") return retire(store, identity);
  if (operation === "absent") return absent(store, identity, { manifestDigest: args["manifest-digest"] });
  if (operation === "reconcile") return reconcile(store, identity);
  throw new Error(`unknown trusted lifecycle operation: ${operation}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const operation = args._[0];
  if (!operation) throw new Error("command is required");
  let result;
  if (operation === "validate") result = validateInputs(args);
  else if (operation === "package") result = packageSource(args);
  else if (operation === "verify") result = verifySource(args);
  else if (operation === "ownership") result = packageOwnership(args);
  else result = lifecycle(args, operation);
  process.stdout.write(canonicalJson(result));
}

try {
  main();
} catch (error) {
  process.stderr.write(`trusted preview command failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
