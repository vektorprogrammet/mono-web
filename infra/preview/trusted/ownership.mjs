#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, assertNoForbiddenHost, assertResourceId, identityFromArgs, parseArgs, requireDigest, requireOption, requireSha, sha256 } from "./contracts.mjs";

const RESOURCE_TYPES = Object.freeze([
  "worker",
  "durable-object-namespace",
  "durable-object-migration",
  "container",
  "container-image",
  "homepage",
  "dashboard",
  "route",
  "dns-tls",
  "seed-artifact",
]);

function readJson(path, name) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${name} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createOwnershipManifest({ identity, sourceDigest, imageDigest, seedDigest, routeContractDigest, resources }) {
  requireSha(identity.headSha);
  const manifestResources = resources.map((resource) => {
    if (!RESOURCE_TYPES.includes(resource.type)) throw new Error(`resource type is not allow-listed: ${resource.type}`);
    const id = assertResourceId(resource.id, `${resource.type}.id`);
    const name = resource.name ?? id;
    if (resource.type === "container" && name !== identity.containerName) throw new Error("container name mismatch");
    if (resource.type !== "container" && !name.startsWith(identity.resourcePrefix)) {
      throw new Error(`${resource.type} name is outside resource prefix`);
    }
    return { type: resource.type, id, name, tags: { app: identity.app, stage: identity.stage, pr: String(identity.pullRequestNumber), target: identity.target } };
  });
  const typeCounts = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, manifestResources.filter((resource) => resource.type === type).length]));
  if (typeCounts.container !== 1) throw new Error("exactly one container resource is required");
  if (typeCounts.worker !== 1 || typeCounts["durable-object-namespace"] !== 1 || typeCounts["durable-object-migration"] !== 1) {
    throw new Error("worker and durable object resources must be singular");
  }
  const manifest = {
    schema: "preview-ownership/v1",
    repository: identity.repository,
    pullRequestNumber: identity.pullRequestNumber,
    app: identity.app,
    target: identity.target,
    stage: identity.stage,
    hostname: identity.hostname,
    resourcePrefix: identity.resourcePrefix,
    containerName: identity.containerName,
    remoteStateKey: identity.remoteStateKey,
    headSha: identity.headSha,
    sourceDigest: requireDigest(sourceDigest, "sourceDigest"),
    imageDigest: requireDigest(imageDigest, "imageDigest"),
    seedDigest: requireDigest(seedDigest, "seedDigest"),
    routeContractDigest: requireDigest(routeContractDigest, "routeContractDigest"),
    resources: manifestResources,
    allowList: RESOURCE_TYPES,
  };
  assertNoForbiddenHost(manifest, "ownership manifest");
  const digest = `sha256:${sha256(canonicalJson(manifest))}`;
  return Object.freeze({ ...manifest, manifestDigest: digest });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = identityFromArgs(args);
  const sourceDigest = requireOption(args, "source-digest");
  const imageDigest = requireOption(args, "image-digest");
  const seedDigest = requireOption(args, "seed-digest");
  const routeContractDigest = requireOption(args, "route-contract-digest");
  const resources = readJson(requireOption(args, "resources"), "resources");
  if (!Array.isArray(resources)) throw new Error("resources must be an array");
  const manifest = createOwnershipManifest({ identity, sourceDigest, imageDigest, seedDigest, routeContractDigest, resources });
  const output = args.output;
  if (!output) throw new Error("--output is required");
  writeFileSync(output, canonicalJson(manifest), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(canonicalJson({ manifestDigest: manifest.manifestDigest, resourceCount: manifest.resources.length, written: output }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`ownership manifest failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
