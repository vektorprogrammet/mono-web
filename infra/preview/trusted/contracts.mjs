import { createHash } from "node:crypto";

export const IDENTITY = Object.freeze({
  repository: "vektorprogrammet/mono-web",
  app: "vektor",
  target: "p20",
  stage: "p20",
  hostname: "p20.vektor.phibkro.org",
  resourcePrefix: "vektor-p20",
  containerName: "vektor-p20-container",
  concurrency: "preview-vektor-p20",
  remoteStateKey: "vektor/p20",
  environment: "vektor-preview",
  productionHost: "vektorprogrammet.no",
});

export const STATES = Object.freeze([
  "Absent",
  "Requested",
  "Validating",
  "SeedReady",
  "Planned",
  "Applying",
  "Seeding",
  "Live",
  "Retiring",
  "NeedsOperator",
  "Failed",
]);

const HEX_SHA = /^[0-9a-f]{40}$/u;
const HEX_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SAFE_ID = /^[A-Za-z0-9._:/-]+$/u;

export function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function requireSha(value, name = "headSha") {
  const sha = requireString(value, name).toLowerCase();
  if (!HEX_SHA.test(sha)) {
    throw new Error(`${name} must be a 40-character lower-case commit SHA`);
  }
  return sha;
}

export function requireDigest(value, name) {
  const digest = requireString(value, name).toLowerCase();
  if (!HEX_DIGEST.test(digest)) {
    throw new Error(`${name} must be a sha256:<64 hex> digest`);
  }
  return digest;
}

export function requirePrNumber(value) {
  const text = String(value ?? "");
  if (!POSITIVE_INTEGER.test(text)) {
    throw new Error("pullRequestNumber must be a positive integer");
  }
  return Number(text);
}

export function requireSafeId(value, name) {
  const id = requireString(value, name);
  if (!SAFE_ID.test(id) || id.includes("..")) {
    throw new Error(`${name} contains unsafe characters`);
  }
  return id;
}

export function validateIdentity(input = {}) {
  const identity = {
    repository: input.repository ?? IDENTITY.repository,
    app: input.app ?? IDENTITY.app,
    target: input.target ?? IDENTITY.target,
    stage: input.stage ?? IDENTITY.stage,
    hostname: input.hostname ?? IDENTITY.hostname,
    resourcePrefix: input.resourcePrefix ?? IDENTITY.resourcePrefix,
    containerName: input.containerName ?? IDENTITY.containerName,
    concurrency: input.concurrency ?? IDENTITY.concurrency,
    remoteStateKey: input.remoteStateKey ?? IDENTITY.remoteStateKey,
    pullRequestNumber: requirePrNumber(input.pullRequestNumber),
    headSha: requireSha(input.headSha),
  };

  for (const [key, expected] of Object.entries(IDENTITY)) {
    if (key === "environment" || key === "productionHost") continue;
    if (identity[key] !== expected) {
      throw new Error(`identity mismatch for ${key}: expected ${expected}`);
    }
  }
  if (identity.hostname.includes(IDENTITY.productionHost)) {
    throw new Error("production host is forbidden");
  }
  return Object.freeze(identity);
}

export function validateMainDevIdentity(input = {}) {
  const identity = {
    repository: input.repository ?? IDENTITY.repository,
    app: input.app ?? IDENTITY.app,
    target: requireString(input.target ?? "main-dev", "target"),
    stage: requireString(input.stage ?? "main-dev", "stage"),
    hostname: requireString(input.hostname ?? "vektor.phibkro.org", "hostname"),
    resourcePrefix: requireString(input.resourcePrefix ?? "vektor-main-dev", "resourcePrefix"),
    containerName: requireString(input.containerName ?? "vektor-main-dev-container", "containerName"),
    concurrency: requireString(input.concurrency ?? "preview-vektor-main-dev", "concurrency"),
    remoteStateKey: requireString(input.remoteStateKey ?? "vektor/main-dev", "remoteStateKey"),
    pullRequestNumber: 0,
    headSha: requireSha(input.headSha),
  };
  if (identity.repository !== IDENTITY.repository || identity.app !== IDENTITY.app) {
    throw new Error("main-dev repository/app identity mismatch");
  }
  if (identity.hostname.includes(IDENTITY.productionHost)) {
    throw new Error("production host is forbidden");
  }
  return Object.freeze(identity);
}

export function ledgerKey(identity) {
  const pr = identity.pullRequestNumber;
  const target = requireString(identity.target, "target");
  const stage = requireString(identity.stage, "stage");
  return `${identity.repository}#${pr}#${target}#${stage}`;
}

export function tombstoneKey(identity) {
  return `tombstone:${ledgerKey(identity)}`;
}

export function mainDevLedgerKey(identity) {
  return `${identity.repository}#main-dev#${identity.target}#${identity.stage}`;
}

export function nowIso(clock = Date) {
  const value = new clock().toISOString();
  if (!value.endsWith("Z")) throw new Error("clock must produce UTC timestamps");
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function assertNoForbiddenHost(value, label = "value") {
  if (JSON.stringify(value).includes(IDENTITY.productionHost)) {
    throw new Error(`${label} contains forbidden production host`);
  }
}

export function assertState(value) {
  if (!STATES.includes(value)) throw new Error(`unknown preview state: ${value}`);
  return value;
}

export function assertResourceId(value, label = "resourceId") {
  const id = requireSafeId(value, label);
  if (id.startsWith("placeholder") || id === "unknown" || id === "pending") {
    throw new Error(`${label} must be an immutable provider identifier`);
  }
  return id;
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      result[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[name] = next;
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

export function requireOption(args, name) {
  return requireString(args[name], `--${name}`);
}

export function identityFromArgs(args) {
  return validateIdentity({
    repository: args.repository,
    app: args.app,
    target: args.target,
    stage: args.stage,
    hostname: args.hostname,
    resourcePrefix: args["resource-prefix"],
    containerName: args["container-name"],
    concurrency: args.concurrency,
    remoteStateKey: args["remote-state-key"],
    pullRequestNumber: args.pr,
    headSha: args["head-sha"],
  });
}

export function serializeIdentity(identity) {
  return {
    repository: identity.repository,
    pullRequestNumber: identity.pullRequestNumber,
    app: identity.app,
    target: identity.target,
    stage: identity.stage,
    hostname: identity.hostname,
    resourcePrefix: identity.resourcePrefix,
    containerName: identity.containerName,
    concurrency: identity.concurrency,
    remoteStateKey: identity.remoteStateKey,
    headSha: identity.headSha,
  };
}
