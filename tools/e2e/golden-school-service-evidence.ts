import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Path, type PlatformError, Predicate, Schema } from "effect";
import { dual } from "effect/Function";
import { goldenSteps } from "./golden-school-service";

export const goldenArtifactName =
  /^(?:evidence\.json|failure\.log|browser-(?:evidence|network|trace-sanitized|cleanup|active|build)\.json|playwright-evidence\.json|dashboard-(?:runtime|command-[0-9]+)\.log)$/;

export const goldenRunnerPaths = [
  "tools/e2e/placement-check.ts",
  "tools/e2e/golden-school-service.ts",
  "apps/dashboard/e2e/run-real-native-placement.mjs",
  "apps/dashboard/e2e/native-placement.spec.ts",
  "tools/e2e/golden-school-service-evidence.ts",
  "tools/e2e/golden-school-service-evidence.mjs",
  "tools/e2e/golden-http-diagnostics.mjs",
];

// Receipts and diagnostics are untyped JSON documents; each check reads the fields it asserts.
// oxlint-disable-next-line typescript/no-explicit-any -- a parsed receipt is untyped JSON, as the reads did
type Document = any;

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const credentialField = /^(?:authorization|cookie|set-cookie)$/i;

/** Redacts the known secrets and every credential header value in one diagnostic text. */
export const redactDiagnostic: {
  (text: string): (secrets: ReadonlyArray<string>) => string;
  (secrets: ReadonlyArray<string>, text: string): string;
} = dual(2, (secrets: ReadonlyArray<string>, text: string): string =>
  secrets
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), text)
    .replace(/(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/gi, "$1$2[REDACTED]"),
);

/**
 * Serializes evidence with every string redacted and every credential field's value replaced.
 * Redacting the values, not the serialized text, keeps the file valid JSON.
 */
export const redactedEvidenceJson: {
  (evidence: Schema.Json): (secrets: ReadonlyArray<string>) => string;
  (secrets: ReadonlyArray<string>, evidence: Schema.Json): string;
} = dual(2, (secrets: ReadonlyArray<string>, evidence: Schema.Json): string =>
  JSON.stringify(
    evidence,
    (key: string, value: Document) => {
      if (credentialField.test(key) && value !== null) return "[REDACTED]";

      return Predicate.isString(value) ? redactDiagnostic(secrets, value) : value;
    },
    2,
  ),
);

/** Runs an evidence program for a Promise caller outside the Effect program (EX-0017). */
const runForPromiseCaller = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/** Fails when `path` names a symbolic link; `stat` follows links, so `readLink` detects one. */
const isSymbolicLink = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
  fs.readLink(path).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** Digests every file below the dashboard build, refusing symbolic links and non-files. */
export interface BuildFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export const readDashboardBuild = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<BuildFile> = [];

  const visit = (relative: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const file = path.join(root, "apps/dashboard/build", relative);
      const info = yield* fs.stat(file);
      assert.ok((yield* isSymbolicLink(fs, file)) !== true, "build must not contain symlinks");

      if (info.type === "Directory") {
        for (const name of (yield* fs.readDirectory(file)).sort())
          yield* visit(path.join(relative, name));
      } else {
        assert.ok(info.type === "File", "build contains a non-file");
        const bytes = yield* fs.readFile(file);
        files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
      }
    });

  yield* visit("");
  assert.ok(
    files.some(({ path }) => path === "server/index.js"),
    "server build absent",
  );
  assert.ok(
    files.some(({ path }) => path.startsWith("client/")),
    "client build absent",
  );

  return files;
});

/** The Promise form of `readDashboardBuild`, for the browser driver of the placement journey. */
export const dashboardBuildInventory = (root: string): Promise<Array<BuildFile>> =>
  runForPromiseCaller(readDashboardBuild(root));

const safeBytes = (bytes: Buffer) => {
  const text = bytes.toString("utf8");
  assert.ok(text.includes("\u0000") !== true, "binary diagnostic rejected");
  assert.ok(
    !/journey-secret-0123456789abcdef|synthetic-school-service-token/.test(text),
    "synthetic secret rejected",
  );
  assert.ok(
    !/"(?:authorization|set-cookie|cookie)"\s*:\s*"(?!\[REDACTED\])[^"\s]+|^(?:authorization|set-cookie|cookie):\s*(?!\[REDACTED\])\S+/im.test(
      text,
    ),
    "credential diagnostic rejected",
  );
  assert.ok(
    !/-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|access_token|refresh_token)"\s*:\s*"(?!\[REDACTED\])[^"\s]+/i.test(
      text,
    ),
    "private diagnostic rejected",
  );

  for (const match of text.matchAll(
    /(?:^|\s)(?:[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET)|AUTHORIZATION|COOKIE|SET-COOKIE)\s*[:=]\s*([^\r\n]*)/gim,
  ))
    assert.ok(match[1]?.trim() === "[REDACTED]", "credential diagnostic rejected");
};

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const safeJson = (value: Schema.Json): void => {
  if (Predicate.isString(value)) {
    safeBytes(Buffer.from(value));
  } else if (Array.isArray(value)) {
    for (const item of value) safeJson(item);
  } else if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:authorization|cookie|set-cookie)$|(?:password|token|secret)$/i.test(key))
        assert.ok(item === "[REDACTED]" || item === null, "credential diagnostic rejected");
      safeJson(item);
    }
  }
};

// Only receipt-bound, allowlisted regular files can enter the upload directory.
// Errors deliberately omit artifact contents and supplied values.
export interface GoldenEvidenceSource {
  /** The artifact directory that the runner reported. */
  readonly directory: string;
  /** The checkout whose runner sources and dashboard build the receipt binds. */
  readonly root: string;
  readonly revision: string;
  readonly sourceTree: string;
}

/** The inspected receipt, the bytes of every listed file, and the parsed JSON documents. */
export interface GoldenEvidence {
  readonly receipt: Document;
  readonly files: Map<string, Buffer>;
  readonly documents: Map<string, Document>;
}

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const parseDocument = (bytes: Buffer): Effect.Effect<Document, Schema.SchemaError> =>
  Schema.decodeEffect(UnknownJson)(bytes.toString("utf8"));

const documentText = (value: Schema.Json): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(UnknownJson)(value);

export const readGoldenEvidence = Effect.fnUntraced(function* ({
  directory,
  root,
  revision,
  sourceTree,
}: GoldenEvidenceSource) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  assert.ok((yield* fs.stat(directory)).type === "Directory", "evidence directory absent");
  assert.ok((yield* isSymbolicLink(fs, directory)) !== true, "evidence directory symlink rejected");

  const read = Effect.fnUntraced(function* (name: string) {
    const file = path.join(directory, name);
    const info = yield* fs.stat(file);
    assert.ok(
      info.type === "File" && (yield* isSymbolicLink(fs, file)) !== true,
      "diagnostic must be a regular file",
    );
    assert.ok(Number(info.size) <= 16 * 1024 * 1024, "diagnostic exceeds size limit");
    const bytes = Buffer.from(yield* fs.readFile(file));
    safeBytes(bytes);

    if (name.endsWith(".json") === true) safeJson(yield* parseDocument(bytes));

    return bytes;
  });

  const receiptBytes = yield* read("receipt.json");
  const receipt = yield* parseDocument(receiptBytes);
  assert.ok(
    receipt.schema_version === "native-functional-journey/v1",
    "unsupported receipt schema",
  );
  assert.ok(receipt.journey_ref_id === "intent://golden-school-service", "wrong journey");
  assert.ok(receipt.mono_revision_ref_id === "rev-" + revision, "wrong receipt revision");
  assert.ok(
    receipt.source_tree === sourceTree && receipt.clean_source === true,
    "wrong receipt source tree",
  );
  assert.ok(
    receipt.environment_kind === "local_disposable" && receipt.required_browser === true,
    "wrong execution environment",
  );
  assert.deepEqual(
    receipt.runner_sources.map(({ path }: { path: string }) => path),
    goldenRunnerPaths,
    "runner inventory differs",
  );

  for (const item of receipt.runner_sources)
    assert.ok(
      sha256(yield* fs.readFile(path.join(root, item.path))) === item.sha256,
      "runner digest differs",
    );
  assert.ok(
    receipt.fixture_digest === "sha256:" + receipt.runner_sources[0].sha256,
    "fixture digest differs",
  );
  assert.ok(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length <= 32,
    "invalid artifact inventory",
  );
  assert.ok(
    receipt.artifact_digest === "sha256:" + sha256(yield* documentText(receipt.artifacts)),
    "artifact inventory digest differs",
  );
  const files = new Map([["receipt.json", receiptBytes]]);
  const documents = new Map<string, Document>();

  for (const item of receipt.artifacts) {
    assert.ok(
      Predicate.isString(item.path) && goldenArtifactName.test(item.path),
      "artifact path outside allowlist",
    );
    assert.ok(!files.has(item.path), "duplicate artifact path");
    const bytes = yield* read(item.path);
    assert.ok(
      bytes.length === item.bytes && sha256(bytes) === item.sha256,
      "artifact bytes differ",
    );
    files.set(item.path, bytes);

    if (item.path.endsWith(".json") === true) documents.set(item.path, yield* parseDocument(bytes));
  }

  assert.deepEqual(
    (yield* fs.readDirectory(directory)).sort(),
    [...files.keys()].sort(),
    "unlisted runtime artifact remains",
  );
  const build = documents.get("browser-build.json");

  if (Predicate.isTruthy(build)) {
    assert.ok(build.revision === revision && build.sourceTree === sourceTree, "wrong build source");
    assert.ok(
      build.digest === "sha256:" + sha256(yield* documentText(build.files)),
      "build inventory digest differs",
    );
    assert.deepEqual(build.files, yield* readDashboardBuild(root), "built dashboard bytes differ");
  }

  return { receipt, files, documents } satisfies GoldenEvidence;
});

/** The Promise form of `readGoldenEvidence`, for the CI wrapper of the golden journey. */
export const inspectGoldenEvidence = (source: GoldenEvidenceSource): Promise<GoldenEvidence> =>
  runForPromiseCaller(readGoldenEvidence(source));

/** Writes each inspected file into the upload directory, refusing to replace an existing one. */
export const stageEvidence: {
  (
    destination: string,
  ): (
    evidence: GoldenEvidence,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;
  (
    evidence: GoldenEvidence,
    destination: string,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;
} = dual(2, (evidence: GoldenEvidence, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const [name, bytes] of evidence.files)
      yield* fs.writeFile(path.join(destination, name), bytes, { mode: 0o600, flag: "wx" });
  }),
);

/** The Promise form of `stageEvidence`, for the CI wrapper of the golden journey. */
export const stageGoldenEvidence: {
  (destination: string): (evidence: GoldenEvidence) => Promise<void>;
  (evidence: GoldenEvidence, destination: string): Promise<void>;
} = dual(2, (evidence: GoldenEvidence, destination: string) =>
  runForPromiseCaller(stageEvidence(evidence, destination)),
);

export const requireGoldenSuccess = ({ receipt, documents }: GoldenEvidence) => {
  assert.ok(
    receipt.result === "passed" && receipt.exit_code === 0 && receipt.termination_signal === null,
    "journey did not pass",
  );
  assert.deepEqual(receipt.step_ids, goldenSteps, "required steps missing or duplicated");

  for (const name of [
    "evidence.json",
    "browser-build.json",
    "browser-evidence.json",
    "browser-network.json",
    "browser-cleanup.json",
    "browser-active.json",
    "playwright-evidence.json",
  ])
    assert.ok(documents.has(name), "required artifact absent: " + name);
  const evidence = documents.get("evidence.json");
  assert.ok(
    evidence.passed === true && evidence.failure === null && evidence.fault === null,
    "parent did not pass",
  );
  assert.ok(
    evidence.revision === receipt.mono_revision_ref_id.slice(4) &&
      evidence.sourceTree === receipt.source_tree,
    "parent source differs",
  );
  assert.ok(
    evidence.mode === "--golden-school-service" && evidence.cleanSource === true,
    "wrong parent mode",
  );
  assert.deepEqual(
    evidence.observations.map(({ step }: { step: string }) => step),
    goldenSteps,
    "parent observations incomplete",
  );

  for (const key of [
    "processesExited",
    "portsReleased",
    "postgresRemoved",
    "credentialManifestRemoved",
    "receiverClosed",
  ])
    assert.ok(evidence.cleanup[key] === true, "parent cleanup incomplete: " + key);
  assert.deepEqual(evidence.cleanup.errors, [], "parent cleanup failed");
  assert.ok(
    evidence.cleanup.processes.every(({ exited }: { exited: boolean }) => exited === true),
    "parent process remains",
  );
  const cleanup = documents.get("browser-cleanup.json");
  assert.ok(
    cleanup.processesExited === true &&
      cleanup.privateTracesRemoved === true &&
      cleanup.privateResultsRemoved === true,
    "browser cleanup incomplete",
  );
  assert.deepEqual(cleanup.cleanupErrors, [], "browser cleanup failed");
  assert.ok(
    cleanup.failure === null &&
      cleanup.processes.every(({ exited }: { exited: boolean }) => exited === true),
    "browser process failed",
  );
  const browser = documents.get("browser-evidence.json");
  assert.ok(
    browser.passed === true && browser.revision === evidence.revision,
    "browser evidence failed or stale",
  );
  assert.deepEqual(browser.steps, goldenSteps.slice(1), "browser steps incomplete");
  const network = documents.get("browser-network.json");
  assert.ok(network.passed === true, "network evidence failed");
  assert.deepEqual(network.steps, goldenSteps.slice(1), "network steps incomplete");
  assert.deepEqual(
    documents.get("playwright-evidence.json"),
    {
      tests: [
        {
          title: "golden school-service continuous functional journey",
          ok: true,
          tests: [{ expectedStatus: "passed", resultStatuses: ["passed"] }],
        },
      ],
    },
    "exactly one first-attempt browser pass is required",
  );
};
