#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { assertNoForbiddenHost, identityFromArgs, parseArgs, requireDigest, requireOption } from "./contracts.mjs";

const ALLOWED_ACTIONS = Object.freeze(["plan", "deploy", "destroy"]);
const SAFE_ENVIRONMENT = "vektor-preview";

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== "preview-ownership/v1") throw new Error("unsupported ownership manifest");
  return manifest;
}

export function buildAlchemyCommand({ action, identity, manifestPath, sourceDigest, imageDigest, seedDigest, routeContractDigest, remoteState, environment = SAFE_ENVIRONMENT }) {
  if (!ALLOWED_ACTIONS.includes(action)) throw new Error(`unsupported Alchemy action: ${action}`);
  if (environment !== SAFE_ENVIRONMENT) throw new Error(`unexpected deployment environment: ${environment}`);
  const manifest = readManifest(manifestPath);
  if (manifest.repository !== identity.repository || manifest.stage !== identity.stage || manifest.target !== identity.target) throw new Error("manifest identity mismatch");
  if (manifest.containerName !== identity.containerName) throw new Error("manifest container identity mismatch");
  if (manifest.sourceDigest !== sourceDigest) throw new Error("manifest source digest mismatch");
  if (manifest.imageDigest !== imageDigest) throw new Error("manifest image digest mismatch");
  if (manifest.seedDigest !== seedDigest) throw new Error("manifest seed digest mismatch");
  if (manifest.routeContractDigest !== routeContractDigest) throw new Error("manifest route contract digest mismatch");
  assertNoForbiddenHost(manifest, "ownership manifest");
  const args = ["alchemy", action, "--app", identity.app, "--stage", identity.stage, "--state", remoteState, "--environment", environment, "--source-sha", identity.headSha, "--source-digest", sourceDigest, "--image-digest", imageDigest, "--seed-digest", seedDigest, "--route-contract-digest", routeContractDigest, "--ownership-manifest", manifestPath];
  if (action === "destroy") args.push("--resource-prefix", identity.resourcePrefix, "--container-name", identity.containerName, "--exact-stage", identity.stage);
  return Object.freeze({ command: "bun", args, env: { ALCHEMY_APP: identity.app, ALCHEMY_STAGE: identity.stage, ALCHEMY_STATE_KEY: remoteState, PREVIEW_ENVIRONMENT: environment }, manifestDigest: manifest.manifestDigest });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0];
  if (!action) throw new Error("action is required");
  const identity = identityFromArgs(args);
  const sourceDigest = requireDigest(requireOption(args, "source-digest"), "sourceDigest");
  const imageDigest = requireDigest(requireOption(args, "image-digest"), "imageDigest");
  const seedDigest = requireDigest(requireOption(args, "seed-digest"), "seedDigest");
  const routeContractDigest = requireDigest(requireOption(args, "route-contract-digest"), "routeContractDigest");
  const command = buildAlchemyCommand({ action, identity, manifestPath: requireOption(args, "ownership-manifest"), sourceDigest, imageDigest, seedDigest, routeContractDigest, remoteState: requireOption(args, "remote-state") });
  process.stdout.write(`${JSON.stringify(command, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Alchemy command construction failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
