#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, assertNoForbiddenHost, assertState, identityFromArgs, ledgerKey, nowIso, parseArgs, requireOption, serializeIdentity, sha256, tombstoneKey } from "./contracts.mjs";

const MAX_ATTEMPTS = 2;

function loadStore(path) {
  if (!existsSync(path)) return { schema: "preview-ledger/v1", ledgers: {}, tombstones: {} };
  const store = JSON.parse(readFileSync(path, "utf8"));
  if (store.schema !== "preview-ledger/v1") throw new Error("unsupported ledger schema");
  return store;
}

function saveStore(path, store) {
  assertNoForbiddenHost(store, "ledger");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, canonicalJson(store), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function initialLedger(identity, clock) {
  const timestamp = nowIso(clock);
  return {
    schema: "preview-ledger-row/v1",
    key: ledgerKey(identity),
    ...serializeIdentity(identity),
    attemptCount: 0,
    attemptStatus: "None",
    state: "Absent",
    generation: null,
    attemptId: null,
    sourceHeadSha: identity.headSha,
    imageDigest: null,
    seedDigest: null,
    operationIds: [],
    routeContractDigest: null,
    lease: null,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    terminalCleanupObservation: null,
  };
}

export function readLedger(path, identity, clock = Date) {
  const store = loadStore(path);
  const key = ledgerKey(identity);
  return store.ledgers[key] ?? initialLedger(identity, clock);
}

export function initializeLedger(path, identity, clock = Date) {
  const store = loadStore(path);
  const key = ledgerKey(identity);
  if (!store.ledgers[key]) {
    store.ledgers[key] = initialLedger(identity, clock);
    saveStore(path, store);
  }
  return store.ledgers[key];
}

export function transitionLedger(path, identity, nextState, patch = {}, clock = Date) {
  assertState(nextState);
  const store = loadStore(path);
  const key = ledgerKey(identity);
  const current = store.ledgers[key] ?? initialLedger(identity, clock);
  const updated = { ...current, ...patch, state: nextState, lastSeenAt: nowIso(clock) };
  if (updated.key !== key || updated.repository !== identity.repository || updated.stage !== identity.stage) throw new Error("ledger identity mismatch");
  if (updated.attemptCount < current.attemptCount) throw new Error("attempt count cannot decrease");
  if (updated.attemptCount > MAX_ATTEMPTS) throw new Error("attempt count exceeds maximum");
  store.ledgers[key] = updated;
  saveStore(path, store);
  return updated;
}

export function incrementAttempt(path, identity, patch = {}, clock = Date) {
  const store = loadStore(path);
  const key = ledgerKey(identity);
  const current = store.ledgers[key] ?? initialLedger(identity, clock);
  if (current.attemptStatus === "Applying" || current.attemptStatus === "Seeding") return current;
  if (current.attemptCount >= MAX_ATTEMPTS) {
    const refused = { ...current, state: "NeedsOperator", attemptStatus: "AttemptLimitExceeded", lastSeenAt: nowIso(clock) };
    store.ledgers[key] = refused;
    saveStore(path, store);
    throw new Error("AttemptLimitExceeded");
  }
  const attemptCount = current.attemptCount + 1;
  const attemptId = `${key}#attempt-${attemptCount}-${sha256(`${key}:${identity.headSha}:${attemptCount}`).slice(0, 16)}`;
  const updated = { ...current, ...patch, attemptCount, attemptId, attemptStatus: "Applying", state: "Applying", sourceHeadSha: identity.headSha, lastSeenAt: nowIso(clock) };
  store.ledgers[key] = updated;
  saveStore(path, store);
  return updated;
}

export function writeTombstone(path, identity, patch = {}, clock = Date) {
  const store = loadStore(path);
  const key = tombstoneKey(identity);
  const existing = store.tombstones[key];
  const tombstone = {
    schema: "preview-tombstone/v1",
    key,
    ...serializeIdentity(identity),
    generation: patch.generation ?? existing?.generation ?? null,
    terminalState: patch.terminalState ?? existing?.terminalState ?? "Absent",
    closedAt: patch.closedAt ?? existing?.closedAt ?? nowIso(clock),
    retainUntil: patch.retainUntil ?? existing?.retainUntil ?? new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    attemptCount: patch.attemptCount ?? existing?.attemptCount ?? 0,
    manifestDigest: patch.manifestDigest ?? existing?.manifestDigest ?? null,
  };
  if (existing && tombstone.attemptCount < existing.attemptCount) throw new Error("tombstone attempt count cannot decrease");
  assertNoForbiddenHost(tombstone, "tombstone");
  store.tombstones[key] = tombstone;
  saveStore(path, store);
  return tombstone;
}

export function assertTombstoneSurvives(path, identity, expectedAttemptCount) {
  const store = loadStore(path);
  const tombstone = store.tombstones[tombstoneKey(identity)];
  if (!tombstone) throw new Error("tombstone is missing");
  if (tombstone.attemptCount !== expectedAttemptCount) throw new Error("tombstone attempt count changed");
  return tombstone;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = requireOption(args, "store");
  const identity = identityFromArgs(args);
  const operation = args._[0];
  if (!operation) throw new Error("operation is required");
  let result;
  if (operation === "init") result = initializeLedger(path, identity);
  else if (operation === "read") result = readLedger(path, identity);
  else if (operation === "increment") result = incrementAttempt(path, identity, { imageDigest: args["image-digest"] ?? null, seedDigest: args["seed-digest"] ?? null, routeContractDigest: args["route-contract-digest"] ?? null });
  else if (operation === "transition") result = transitionLedger(path, identity, requireOption(args, "state"), { attemptStatus: args["attempt-status"] });
  else if (operation === "tombstone") result = writeTombstone(path, identity, { terminalState: args["terminal-state"] ?? "Absent", attemptCount: Number(args["attempt-count"] ?? 0), generation: args.generation ?? null, manifestDigest: args["manifest-digest"] ?? null });
  else throw new Error(`unknown ledger operation: ${operation}`);
  process.stdout.write(canonicalJson(result));
}

try {
  main();
} catch (error) {
  process.stderr.write(`preview ledger failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
