import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  assertNoForbiddenHost,
  assertResourceId,
  assertState,
  canonicalJson,
  ledgerKey,
  validateIdentity,
} from "./contracts.mjs";
import { assertTransition } from "./lifecycle.mjs";
import { buildAlchemyCommand } from "./alchemy.mjs";
import {
  assertTombstoneSurvives,
  incrementAttempt,
  initializeLedger,
  readLedger,
  transitionLedger,
  writeTombstone,
} from "./ledger.mjs";
import { createOwnershipManifest } from "./ownership.mjs";

const headSha = "a".repeat(40);
const digests = {
  sourceDigest: `sha256:${"1".repeat(64)}`,
  imageDigest: `sha256:${"2".repeat(64)}`,
  seedDigest: `sha256:${"3".repeat(64)}`,
  routeContractDigest: `sha256:${"4".repeat(64)}`,
};

function identity() {
  return validateIdentity({ pullRequestNumber: 21, headSha });
}

function resources() {
  return [
    { type: "worker", id: "vektor-p20-worker" },
    { type: "durable-object-namespace", id: "vektor-p20-preview-container-namespace" },
    { type: "durable-object-migration", id: "vektor-p20-preview-container-migration" },
    { type: "container", id: "vektor-p20-container" },
    { type: "container-image", id: "vektor-p20-container-image" },
    { type: "homepage", id: "vektor-p20-homepage" },
    { type: "dashboard", id: "vektor-p20-dashboard" },
    { type: "route", id: "vektor-p20-route" },
    { type: "dns-tls", id: "vektor-p20-dns-tls" },
    { type: "seed-artifact", id: "vektor-p20-seed-artifact" },
  ];
}

function ownershipManifest() {
  const currentIdentity = identity();
  return createOwnershipManifest({
    identity: currentIdentity,
    ...digests,
    resources: resources(),
  });
}

test("validates the frozen identity and rejects unsafe selectors", () => {
  const currentIdentity = identity();
  expect(currentIdentity).toMatchObject({
    repository: "vektorprogrammet/mono-web",
    app: "vektor",
    target: "p20",
    stage: "p20",
    pullRequestNumber: 21,
    headSha,
  });
  expect(ledgerKey(currentIdentity)).toBe("vektorprogrammet/mono-web#21#p20#p20");
  expect(() => assertState("Unknown")).toThrow("unknown preview state");
  expect(() => assertResourceId("../vektor-p20-worker")).toThrow("unsafe characters");
  expect(() => assertNoForbiddenHost({ target: "https://vektorprogrammet.no" })).toThrow(
    "forbidden production host",
  );
  assertTransition("Absent", "Requested");
  expect(() => assertTransition("Live", "Applying")).toThrow("illegal preview transition");
});

test("owns the exact allow-listed resource graph with immutable tags", () => {
  const manifest = ownershipManifest();
  expect(manifest.schema).toBe("preview-ownership/v1");
  expect(manifest.containerName).toBe("vektor-p20-container");
  expect(manifest.resources).toHaveLength(10);
  expect(manifest.resources.every((resource) => resource.name.startsWith("vektor-p20"))).toBe(true);
  expect(manifest.resources.find((resource) => resource.type === "container")).toMatchObject({
    id: "vektor-p20-container",
    name: "vektor-p20-container",
    tags: { app: "vektor", stage: "p20", pr: "21", target: "p20" },
  });
  expect(() => createOwnershipManifest({
    identity: identity(),
    ...digests,
    resources: [{ type: "unknown-resource", id: "vektor-p20-unknown" }, ...resources().slice(0, 4)],
  })).toThrow("not allow-listed");
});

test("keeps the attempt cap and tombstone across a third-attempt refusal", () => {
  const directory = mkdtempSync(join(tmpdir(), "preview-ledger-test-"));
  const store = join(directory, "ledger.json");
  const currentIdentity = identity();
  try {
    expect(initializeLedger(store, currentIdentity).attemptCount).toBe(0);
    const first = incrementAttempt(store, currentIdentity);
    expect(first.attemptCount).toBe(1);
    expect(incrementAttempt(store, currentIdentity).attemptCount).toBe(1);
    transitionLedger(store, currentIdentity, "Failed", { attemptStatus: "Failed" });
    const second = incrementAttempt(store, currentIdentity);
    expect(second.attemptCount).toBe(2);
    transitionLedger(store, currentIdentity, "Failed", { attemptStatus: "Failed" });
    const tombstone = writeTombstone(store, currentIdentity, {
      attemptCount: 2,
      terminalState: "Absent",
      generation: "generation-2",
    });
    expect(tombstone.attemptCount).toBe(2);
    expect(() => incrementAttempt(store, currentIdentity)).toThrow("AttemptLimitExceeded");
    expect(assertTombstoneSurvives(store, currentIdentity, 2)).toMatchObject({
      key: `tombstone:${ledgerKey(currentIdentity)}`,
      generation: "generation-2",
      terminalState: "Absent",
    });
    expect(readLedger(store, currentIdentity).attemptCount).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("constructs separated Alchemy argv and rejects shell injection", () => {
  const directory = mkdtempSync(join(tmpdir(), "preview-alchemy-test-"));
  const manifestPath = join(directory, "ownership.json");
  const manifest = ownershipManifest();
  writeFileSync(manifestPath, canonicalJson(manifest), "utf8");
  const currentIdentity = identity();
  const base = {
    action: "plan",
    identity: currentIdentity,
    manifestPath,
    ...digests,
    remoteState: "vektor/p20",
  };
  try {
    const command = buildAlchemyCommand(base);
    expect(command.command).toBe("bun");
    expect(command.args).toEqual(expect.arrayContaining(["alchemy", "plan", "--state", "vektor/p20"]));
    expect(command.args.join(" ")).not.toContain(";");
    expect(() => buildAlchemyCommand({ ...base, environment: "vektor-preview;touch /tmp/pwned" })).toThrow();
    expect(() => buildAlchemyCommand({ ...base, manifestPath: `${manifestPath};touch /tmp/pwned` })).toThrow();
    expect(() => buildAlchemyCommand({
      ...base,
      identity: { ...currentIdentity, stage: "p20;touch /tmp/pwned" },
    })).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
