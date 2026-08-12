#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { buildAlchemyCommand } from "./alchemy.mjs";
import { assertNoForbiddenHost, assertState, identityFromArgs, isMainModule, ledgerKey, parseArgs, requireDigest, requireOption, serializeIdentity } from "./contracts.mjs";
import { incrementAttempt, readLedger, transitionLedger, writeTombstone } from "./ledger.mjs";

export const VALID_TRANSITIONS = Object.freeze({
  Absent: ["Requested", "NeedsOperator"],
  Requested: ["Validating", "NeedsOperator", "Failed"],
  Validating: ["SeedReady", "NeedsOperator", "Failed"],
  SeedReady: ["Planned", "NeedsOperator", "Failed"],
  Planned: ["Applying", "NeedsOperator", "Failed"],
  Applying: ["Seeding", "NeedsOperator", "Failed", "Retiring"],
  Seeding: ["Live", "NeedsOperator", "Failed", "Retiring"],
  Live: ["Retiring", "Failed"],
  Retiring: ["Absent", "NeedsOperator", "Failed"],
  NeedsOperator: ["Requested", "Planned", "Retiring", "Failed"],
  Failed: ["Requested", "Retiring"],
});

export function assertTransition(from, to) {
  assertState(from);
  assertState(to);
  if (!VALID_TRANSITIONS[from]?.includes(to)) throw new Error(`illegal preview transition: ${from} -> ${to}`);
}

export function readOwnership(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== "preview-ownership/v1") throw new Error("unsupported ownership manifest schema");
  assertNoForbiddenHost(manifest, "ownership manifest");
  return manifest;
}

function commonInputs(args) {
  const identity = identityFromArgs(args);
  const sourceDigest = requireDigest(requireOption(args, "source-digest"), "sourceDigest");
  const imageDigest = requireDigest(requireOption(args, "image-digest"), "imageDigest");
  const seedDigest = requireDigest(requireOption(args, "seed-digest"), "seedDigest");
  const routeContractDigest = requireDigest(requireOption(args, "route-contract-digest"), "routeContractDigest");
  const ownershipManifest = requireOption(args, "ownership-manifest");
  return { identity, sourceDigest, imageDigest, seedDigest, routeContractDigest, ownershipManifest };
}

export function buildPlan(args, action = "plan") {
  const inputs = commonInputs(args);
  const command = buildAlchemyCommand({
    action,
    identity: inputs.identity,
    manifestPath: inputs.ownershipManifest,
    sourceDigest: inputs.sourceDigest,
    imageDigest: inputs.imageDigest,
    seedDigest: inputs.seedDigest,
    routeContractDigest: inputs.routeContractDigest,
    remoteState: args["remote-state"] ?? "vektor/p20",
  });
  const plan = {
    schema: "preview-lifecycle-plan/v1",
    action,
    key: ledgerKey(inputs.identity),
    identity: serializeIdentity(inputs.identity),
    sourceDigest: inputs.sourceDigest,
    imageDigest: inputs.imageDigest,
    seedDigest: inputs.seedDigest,
    routeContractDigest: inputs.routeContractDigest,
    ownershipManifest: inputs.ownershipManifest,
    alchemy: command,
    providerMutation: action !== "plan",
    exactStage: inputs.identity.stage,
    exactContainer: inputs.identity.containerName,
    credentialBoundary: action === "plan" ? "none" : "trusted-environment-only",
  };
  assertNoForbiddenHost(plan, "lifecycle plan");
  return Object.freeze(plan);
}

export function request(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Requested");
  return transitionLedger(path, identity, "Requested", { ...patch, sourceHeadSha: identity.headSha });
}

export function validate(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Validating");
  return transitionLedger(path, identity, "Validating", { ...patch, sourceHeadSha: identity.headSha });
}

export function seedReady(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "SeedReady");
  return transitionLedger(path, identity, "SeedReady", patch);
}

export function planned(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Planned");
  return transitionLedger(path, identity, "Planned", patch);
}

export function beginApply(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Applying");
  return incrementAttempt(path, identity, patch);
}

export function seeded(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Seeding");
  return transitionLedger(path, identity, "Seeding", patch);
}

export function live(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Live");
  return transitionLedger(path, identity, "Live", { ...patch, attemptStatus: "Live" });
}

export function retire(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Retiring");
  return transitionLedger(path, identity, "Retiring", patch);
}

export function absent(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  assertTransition(current.state, "Absent");
  const next = transitionLedger(path, identity, "Absent", { ...patch, attemptStatus: current.attemptCount > 0 ? "Complete" : "None", terminalCleanupObservation: patch.terminalCleanupObservation ?? "required" });
  writeTombstone(path, identity, { generation: next.generation, terminalState: "Absent", attemptCount: next.attemptCount, manifestDigest: patch.manifestDigest });
  return next;
}

export function reconcile(path, identity, patch = {}) {
  const current = readLedger(path, identity);
  if (current.state === "Absent") return { mode: "plan-only", reason: "No active stage", ledger: current };
  if (current.state === "NeedsOperator" || current.state === "Failed") return { mode: "plan-only", reason: `Ledger state ${current.state} requires explicit operator action`, ledger: current };
  if (["Applying", "Seeding", "Live", "Retiring"].includes(current.state)) {
    const next = current.state === "Retiring" ? current : retire(path, identity, patch);
    return { mode: "teardown-required", ledger: next };
  }
  return { mode: "resume-required", ledger: current };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const operation = args._[0];
  if (!operation) throw new Error("lifecycle operation is required");
  const path = requireOption(args, "store");
  const identity = identityFromArgs(args);
  let result;
  if (operation === "plan") result = buildPlan(args, "plan");
  else if (operation === "deploy") result = buildPlan(args, "deploy");
  else if (operation === "destroy") result = buildPlan(args, "destroy");
  else if (operation === "request") result = request(path, identity);
  else if (operation === "validate") result = validate(path, identity);
  else if (operation === "seed-ready") result = seedReady(path, identity);
  else if (operation === "planned") result = planned(path, identity);
  else if (operation === "begin-apply") result = beginApply(path, identity);
  else if (operation === "seeded") result = seeded(path, identity);
  else if (operation === "live") result = live(path, identity);
  else if (operation === "retire") result = retire(path, identity);
  else if (operation === "absent") result = absent(path, identity, { manifestDigest: args["manifest-digest"] });
  else if (operation === "reconcile") result = reconcile(path, identity);
  else throw new Error(`unknown lifecycle operation: ${operation}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`preview lifecycle failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
