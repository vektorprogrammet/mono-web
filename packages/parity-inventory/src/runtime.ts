import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import { canonicalJson, compareByteOrder, sha256, stableId } from "./canonical.js";
import { assertSafeAcceptedIntentBytes } from "./coverage.js";
import { assertSafeRuntimeEvidenceBytes } from "./runtime-evidence.js";
import {
  createManifestContextFromSnapshots,
  effectiveIgnoreRule,
  isUnsafeSourcePath,
  matchesLiteralPattern,
  SOURCE_FAMILIES,
  sourceTextSafetyReason,
  unsafeSourceScalarReason,
  type RootScanSnapshot,
} from "./source-manifest.js";
import type { ManifestContext, ScanFile } from "./source-manifest.js";
import type { EvidenceAuthorityRecord, RuntimeEvidenceRegister } from "./types.js";

export class ParityRuntimeError extends Schema.TaggedError<ParityRuntimeError>()(
  "ParityRuntimeError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

const isMissingPath = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return true;
    throw cause;
  }
};

const assertNoSymlinkPath = (path: string): void => {
  let current = resolve(path);
  while (true) {
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink())
        throw new Error(`symbolic link is not an allowed path component: ${current}`);
    } catch (cause) {
      if (
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        const parent = dirname(current);
        if (parent === current) return;
        current = parent;
        continue;
      }
      throw cause;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
};

const assertWithinRoot = (root: string, target: string): void => {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`))
    throw new Error(`path escapes selected root: ${target}`);
};
const canonicalExistingPath = (path: string): string => {
  assertNoSymlinkPath(path);
  return realpathSync(path);
};
const pathContains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);
const sameFilesystemObject = (left: string, right: string): boolean => {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
};
export const assertAuthorityRootOwnership = (
  legacyRoot: string,
  monoRoot: string,
  authorityPath?: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const legacy = canonicalExistingPath(legacyRoot);
  const mono = canonicalExistingPath(monoRoot);
  const projection = resolve(join(mono, projectionDirectory));
  if (
    pathContains(legacy, mono) ||
    pathContains(mono, legacy) ||
    sameFilesystemObject(legacy, mono)
  )
    throw new Error("legacy and mono roots overlap or alias");
  if (
    pathContains(legacy, projection) ||
    pathContains(projection, legacy) ||
    pathContains(mono, projection) === false
  )
    throw new Error("projection directory is not owned by mono root");
  if (authorityPath !== undefined) {
    const authority = canonicalExistingPath(authorityPath);
    const authorityRoot = canonicalExistingPath(
      execFileSync("git", ["-C", dirname(authority), "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    );
    if (
      pathContains(legacy, authorityRoot) ||
      pathContains(authorityRoot, legacy) ||
      pathContains(mono, authorityRoot) ||
      pathContains(authorityRoot, mono) ||
      sameFilesystemObject(authorityRoot, legacy) ||
      sameFilesystemObject(authorityRoot, mono)
    )
      throw new Error("intent authority checkout overlaps or aliases selected roots");
    if (pathContains(projection, authority) || pathContains(authority, projection))
      throw new Error("intent authority overlaps projection directory");
  }
};

export interface PinnedIntentRegister {
  readonly authorityRoot: string;
  readonly relativePath: string;
  readonly revisionRefId: string;
  readonly revision: string;
  readonly blobOid: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

const readAuthorityBlob = (
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory: string,
): PinnedIntentRegister => {
  const absolutePath = canonicalExistingPath(path);
  const authorityRoot = canonicalExistingPath(
    execFileSync("git", ["-C", dirname(absolutePath), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  assertAuthorityRootOwnership(legacyRoot, monoRoot, absolutePath, projectionDirectory);
  const relativePath = relative(authorityRoot, absolutePath).split(sep).join("/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath === ".."
  )
    throw new Error("intent authority path escapes its checkout");
  const statusBefore = execFileSync(
    "git",
    ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  if (statusBefore.length > 0) throw new Error("intent authority checkout is dirty");
  const tracked = execFileSync(
    "git",
    ["-C", authorityRoot, "ls-files", "--stage", "--error-unmatch", "--", relativePath],
    { encoding: "utf8" },
  ).trim();
  if (!/^100644 [0-9a-f]{40} 0\t/.test(tracked))
    throw new Error("intent authority must be a tracked regular file");
  const revision = execFileSync("git", ["-C", authorityRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("intent authority revision is unavailable");
  const blobOid = execFileSync(
    "git",
    ["-C", authorityRoot, "rev-parse", `${revision}:${relativePath}`],
    { encoding: "utf8" },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(blobOid)) throw new Error("intent authority blob is unavailable");
  const bytes = execFileSync("git", ["-C", authorityRoot, "show", `${revision}:${relativePath}`], {
    maxBuffer: 16 * 1024 * 1024 + 1024,
  });
  assertSafeAcceptedIntentBytes(bytes);
  const statusAfter = execFileSync(
    "git",
    ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  const revisionAfter = execFileSync("git", ["-C", authorityRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (statusAfter !== statusBefore || revisionAfter !== revision)
    throw new Error("intent authority changed during pin");
  return {
    authorityRoot,
    relativePath,
    revisionRefId: `rev-intent-authority-${revision}`,
    revision,
    blobOid,
    bytes,
    digest: sha256(bytes),
  };
};

export const readPinnedIntentRegisterEffect = (
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<PinnedIntentRegister, ParityRuntimeError> =>
  Effect.try({
    try: () => readAuthorityBlob(path, legacyRoot, monoRoot, projectionDirectory),
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "intent_authority",
        path,
        message: cause instanceof Error ? cause.message : "intent authority is unavailable",
      }),
  });
export const recheckPinnedIntentRegister = (
  pinned: PinnedIntentRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const current = readAuthorityBlob(
    join(pinned.authorityRoot, pinned.relativePath),
    legacyRoot,
    monoRoot,
    projectionDirectory,
  );
  if (
    current.revision !== pinned.revision ||
    current.blobOid !== pinned.blobOid ||
    current.digest !== pinned.digest ||
    !Buffer.from(current.bytes).equals(Buffer.from(pinned.bytes))
  )
    throw new Error("intent authority changed before projection exchange");
};

export interface PinnedRuntimeEvidenceRegister {
  readonly authorityRoot: string
  readonly relativePath: string
  readonly revisionRefId: string
  readonly revision: string
  readonly blobOid: string
  readonly bytes: Uint8Array
  readonly digest: string
  readonly register: RuntimeEvidenceRegister
}

const readRuntimeEvidenceBlob = (
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory: string,
): PinnedRuntimeEvidenceRegister => {
  const absolutePath = canonicalExistingPath(path)
  const authorityRoot = canonicalExistingPath(
    execFileSync("git", ["-C", dirname(absolutePath), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  )
  assertAuthorityRootOwnership(legacyRoot, monoRoot, absolutePath, projectionDirectory)
  const relativePath = relative(authorityRoot, absolutePath).split(sep).join("/")
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath === ".."
  )
    throw new Error("runtime evidence authority path escapes its checkout")
  const statusBefore = execFileSync(
    "git",
    ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim()
  if (statusBefore.length > 0) throw new Error("runtime evidence authority checkout is dirty")
  const tracked = execFileSync(
    "git",
    ["-C", authorityRoot, "ls-files", "--stage", "--error-unmatch", "--", relativePath],
    { encoding: "utf8" },
  ).trim()
  if (!/^100644 [0-9a-f]{40} 0\t/.test(tracked))
    throw new Error("runtime evidence authority must be a tracked regular file")
  const revision = execFileSync("git", ["-C", authorityRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("runtime evidence authority revision is unavailable")
  const blobOid = execFileSync(
    "git",
    ["-C", authorityRoot, "rev-parse", `${revision}:${relativePath}`],
    { encoding: "utf8" },
  ).trim()
  if (!/^[0-9a-f]{40}$/.test(blobOid)) throw new Error("runtime evidence authority blob is unavailable")
  const bytes = execFileSync("git", ["-C", authorityRoot, "show", `${revision}:${relativePath}`], {
    maxBuffer: 16 * 1024 * 1024 + 1024,
  })
  const register = assertSafeRuntimeEvidenceBytes(bytes)
  const statusAfter = execFileSync(
    "git",
    ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim()
  const revisionAfter = execFileSync("git", ["-C", authorityRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  if (statusAfter !== statusBefore || revisionAfter !== revision)
    throw new Error("runtime evidence authority changed during pin")
  return {
    authorityRoot,
    relativePath,
    revisionRefId: `rev-runtime-evidence-authority-${revision}`,
    revision,
    blobOid,
    bytes,
    digest: sha256(bytes),
    register,
  }
}

export const readPinnedRuntimeEvidenceRegisterEffect = (
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<PinnedRuntimeEvidenceRegister, ParityRuntimeError> =>
  Effect.try({
    try: () => readRuntimeEvidenceBlob(path, legacyRoot, monoRoot, projectionDirectory),
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "runtime_evidence_authority",
        path,
        message: cause instanceof Error ? cause.message : "runtime evidence authority is unavailable",
      }),
  })

export const recheckPinnedRuntimeEvidenceRegister = (
  pinned: PinnedRuntimeEvidenceRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const current = readRuntimeEvidenceBlob(
    join(pinned.authorityRoot, pinned.relativePath),
    legacyRoot,
    monoRoot,
    projectionDirectory,
  )
  if (
    current.revision !== pinned.revision ||
    current.blobOid !== pinned.blobOid ||
    current.digest !== pinned.digest ||
    !Buffer.from(current.bytes).equals(Buffer.from(pinned.bytes))
  )
    throw new Error("runtime evidence authority changed before projection exchange")
}

export const registerRuntimeEvidenceAuthority = (
  context: ManifestContext,
  pinned: PinnedRuntimeEvidenceRegister,
): EvidenceAuthorityRecord => {
  const authorityPath = `authority://blob/${pinned.blobOid}`
  const revisionRefId = pinned.revisionRefId
  if (!context.revisions.some((revision) => revision.revision_ref_id === revisionRefId)) {
    context.revisions.push({
      revision_ref_id: revisionRefId,
      repository_ref: "external_runtime_evidence_authority",
      revision_kind: "git_commit",
      revision: pinned.revision,
      immutable: true,
    })
  }
  const sourceIdentity = {
    authority_line: "cross_line",
    authority_role: "external_runtime_evidence_authority",
    repository_ref: "external_runtime_evidence_authority",
    revision_ref_id: revisionRefId,
    path: authorityPath,
    line_start: null,
    line_end: null,
    symbol: null,
  }
  const sourceId = stableId("src", sourceIdentity)
  if (!context.sources.some((source) => source.source_id === sourceId)) {
    context.sources.push({
      source_id: sourceId,
      authority_role: "external_runtime_evidence_authority",
      authority_line: "cross_line",
      capture_mode: "runtime",
      repository_ref: "external_runtime_evidence_authority",
      revision_ref_id: revisionRefId,
      path: authorityPath,
      line_start: null,
      line_end: null,
      symbol: null,
      byte_length: pinned.bytes.byteLength,
      sha256: pinned.digest,
      availability: "available",
      classification_status: "classified",
    })
    context.sourcePathById.set(sourceId, { rootRef: "mono", path: authorityPath })
  }
  return {
    repository_ref: "external_runtime_evidence_authority",
    authority_path: authorityPath,
    revision_ref_id: revisionRefId,
    revision: pinned.revision,
    blob_oid: pinned.blobOid,
    digest: pinned.digest,
    source_ref_ids: [sourceId],
    immutable: true,
  }
}

const listRegularFiles = (rootPath: string, prefix = "", excludedPrefix?: string): string[] => {
  const absolute = prefix.length === 0 ? rootPath : join(rootPath, prefix);
  const entries = readdirSync(absolute, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (
      excludedPrefix !== undefined &&
      (child === excludedPrefix || child.startsWith(`${excludedPrefix}/`))
    )
      continue;
    if (entry.isDirectory()) paths.push(...listRegularFiles(rootPath, child, excludedPrefix));
    else if (entry.isFile()) paths.push(child.split(sep).join("/"));
    else if (entry.isSymbolicLink())
      throw new Error(`source file is a symbolic link: ${join(rootPath, child)}`);
  }
  return paths.sort(compareByteOrder);
};

interface GitState {
  readonly revision: string;
  readonly trackedPaths: ReadonlySet<string>;
}
const MAX_GIT_METADATA_BYTES = 64 * 1024 * 1024;
const MONO_PROJECTION_DIRECTORY = "evidence/functional-parity";
const isMonoProjectionMountPath = (rootRef: "legacy" | "mono", path: string): boolean =>
  rootRef === "mono" &&
  (path === MONO_PROJECTION_DIRECTORY || path.startsWith(`${MONO_PROJECTION_DIRECTORY}/`));
const porcelainPath = (entry: string): string => {
  const body = entry.length >= 3 ? entry.slice(3) : entry;
  const renameSeparator = body.lastIndexOf(" -> ");
  return (renameSeparator >= 0 ? body.slice(renameSeparator + 4) : body).trim();
};
const gitState = (rootPath: string, rootRef: "legacy" | "mono"): GitState | null => {
  let revision: string;
  try {
    revision = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_METADATA_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) return null;
  const dirtyEntries = execFileSync(
    "git",
    ["-C", rootPath, "status", "--porcelain=v1", "--untracked-files=all", "-z"],
    { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\0")
    .filter((entry) => entry.length > 0);
  const dirty = dirtyEntries.filter(
    (entry) => !isMonoProjectionMountPath(rootRef, porcelainPath(entry)),
  );
  if (dirty.length > 0) throw new Error(`selected source root is dirty: ${rootPath}`);
  const ignored = execFileSync(
    "git",
    ["-C", rootPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\0")
    .filter((path) => path.length > 0 && !isMonoProjectionMountPath(rootRef, path));
  const authorityPath = (path: string): boolean =>
    SOURCE_FAMILIES.some(
      (family) =>
        family.authority_line === rootRef &&
        family.patterns.some((pattern) => matchesLiteralPattern(path, pattern)),
    );
  const ignoredAuthority = ignored.filter(authorityPath);
  if (ignoredAuthority.length > 0)
    throw new Error(
      `selected source root contains ignored authority paths: ${ignoredAuthority.length}`,
    );
  const unsafeIgnored = ignored.filter(
    (path) => isUnsafeSourcePath(path) && effectiveIgnoreRule(rootRef, path) === null,
  );
  if (unsafeIgnored.length > 0)
    throw new Error(
      `selected source root contains ignored sensitive paths: ${unsafeIgnored.length}`,
    );
  const tracked = execFileSync(
    "git",
    ["-C", rootPath, "ls-tree", "-r", "--name-only", "-z", revision],
    { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\0")
    .filter((path) => path.length > 0 && !isMonoProjectionMountPath(rootRef, path));
  return { revision, trackedPaths: new Set(tracked) };
};

const MAX_GIT_BLOB_BYTES = 16 * 1024 * 1024;

const gitBlob = (rootPath: string, revision: string, path: string): Buffer => {
  const objectRef = `${revision}:${path}`;
  const sizeText = execFileSync("git", ["-C", rootPath, "cat-file", "-s", objectRef], {
    encoding: "utf8",
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GIT_BLOB_BYTES)
    throw new Error(`tracked source blob exceeds bounded read limit: ${path}`);
  return execFileSync("git", ["-C", rootPath, "show", objectRef], {
    maxBuffer: size + 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
};
const redactedSourcePath = (path: string): { readonly path: string; readonly unsafe: boolean } => {
  const unsafe = isUnsafeSourcePath(path) || unsafeSourceScalarReason(path, "source_path") !== null;
  return unsafe ? { path: "unsafe-source-redacted", unsafe: true } : { path, unsafe: false };
};

const scanRoot = (rootPath: string, rootRef: "legacy" | "mono"): RootScanSnapshot => {
  assertNoSymlinkPath(rootPath);
  const before = gitState(rootPath, rootRef);
  const paths =
    before === null
      ? listRegularFiles(rootPath, "", rootRef === "mono" ? MONO_PROJECTION_DIRECTORY : undefined)
      : [...before.trackedPaths].sort(compareByteOrder);
  if (
    paths.some(
      (path) => redactedSourcePath(path).unsafe && effectiveIgnoreRule(rootRef, path) === null,
    )
  )
    throw new Error("unsafe source metadata encountered before manifest construction");
  const files: ScanFile[] = paths.map((path) => {
    const absolutePath = join(rootPath, path);
    const ignore = effectiveIgnoreRule(rootRef, path);
    assertNoSymlinkPath(absolutePath);
    if (ignore !== null) {
      return {
        path,
        absolutePath,
        bytes: null,
        byteLength: null,
        digest: null,
        availability: "available",
        unsafe: false,
      };
    }
    const tracked = before?.trackedPaths.has(path) === true;
    let bytes: Buffer;
    try {
      bytes = tracked
        ? gitBlob(rootPath, before?.revision ?? "", path)
        : readFileSync(absolutePath);
    } catch {
      return {
        path,
        absolutePath,
        bytes: null,
        byteLength: null,
        digest: null,
        availability: "unavailable",
        unsafe: false,
      };
    }
    const safetyReason = sourceTextSafetyReason(path, bytes);
    if (safetyReason === "INVALID_UTF8")
      throw new Error("invalid UTF-8 source content encountered before manifest construction");
    if (safetyReason === "UNSAFE_SOURCE")
      throw new Error("unsafe source content encountered before manifest construction");
    return {
      path,
      absolutePath,
      bytes,
      byteLength: bytes.byteLength,
      digest: sha256(bytes),
      availability: "available",
      unsafe: false,
    };
  });
  const after = gitState(rootPath, rootRef);
  if (before !== null && (after === null || before.revision !== after.revision))
    throw new Error(`selected source root changed during scan: ${rootPath}`);
  const fileSetDigest = sha256(
    canonicalJson(files.map((file) => ({ path: file.path, sha256: file.digest }))),
  );
  const revision =
    rootRef === "mono" || before === null
      ? { revision_kind: "file_set_digest" as const, revision: fileSetDigest }
      : { revision_kind: "git_commit" as const, revision: before.revision };
  const revisionRefId = `rev-${rootRef}-${revision.revision}`;
  return {
    rootRef,
    authorityLine: rootRef,
    rootPath,
    files,
    revision: {
      revision_ref_id: revisionRefId,
      repository_ref: rootRef,
      ...revision,
      immutable: true,
    },
    revisionRefId,
  };
};

export const scanRootEffect = (
  rootPath: string,
  rootRef: "legacy" | "mono",
): Effect.Effect<RootScanSnapshot, ParityRuntimeError> =>
  Effect.try({
    try: () => scanRoot(rootPath, rootRef),
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "scan_root",
        path: rootPath,
        message: cause instanceof Error ? cause.message : "source root is unavailable",
      }),
  });

export const createManifestContextEffect = (
  legacyRoot: string,
  monoRoot: string,
): Effect.Effect<ManifestContext, ParityRuntimeError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => assertAuthorityRootOwnership(legacyRoot, monoRoot),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "root_ownership",
          path: monoRoot,
          message: cause instanceof Error ? cause.message : "source roots overlap",
        }),
    });
    const legacy = yield* scanRootEffect(legacyRoot, "legacy");
    const mono = yield* scanRootEffect(monoRoot, "mono");
    return createManifestContextFromSnapshots(legacy, mono);
  });

export const readProjectionEffect = (
  root: string,
  projectionDirectory: string,
  name: string,
): Effect.Effect<string | null, ParityRuntimeError> =>
  Effect.try({
    try: () => {
      const path = join(root, projectionDirectory, name);
      assertWithinRoot(root, path);
      assertNoSymlinkPath(path);
      return isMissingPath(path) ? null : readFileSync(path, "utf8");
    },
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "read_projection",
        path: join(root, projectionDirectory, name),
        message: cause instanceof Error ? cause.message : "projection is unavailable",
      }),
  });
export const readProjectionDirectoryEffect = (
  root: string,
  projectionDirectory: string,
): Effect.Effect<readonly string[], ParityRuntimeError> =>
  Effect.try({
    try: () => {
      const directory = join(root, projectionDirectory);
      assertWithinRoot(root, directory);
      if (isMissingPath(directory)) return [];
      assertNoSymlinkPath(directory);
      if (!lstatSync(directory).isDirectory())
        throw new Error(`projection target is not a directory: ${directory}`);
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = join(directory, entry.name);
        assertNoSymlinkPath(target);
        if (!entry.isFile()) throw new Error(`unsupported projection entry: ${target}`);
      }
      return entries.map((entry) => entry.name).sort(compareByteOrder);
    },
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "read_projection",
        path: join(root, projectionDirectory),
        message: cause instanceof Error ? cause.message : "projection directory is unavailable",
      }),
  });

const RENAME_EXCHANGE_SCRIPT = `import { dlopen, FFIType } from "bun:ffi"
const source = process.argv[1]
const target = process.argv[2]
if (source === undefined || target === undefined) process.exit(2)
const libc = dlopen("libc.so.6", { renameat2: { args: [FFIType.c_int, FFIType.cstring, FFIType.c_int, FFIType.cstring, FFIType.c_uint], returns: FFIType.c_int } })
const result = libc.symbols.renameat2(-100, Buffer.from(source + String.fromCharCode(0)), -100, Buffer.from(target + String.fromCharCode(0)), 2)
if (result !== 0) process.exit(1)`;

const exchangeDirectories = (staging: string, directory: string): void => {
  if (process.platform !== "linux")
    throw new Error("atomic projection exchange is unavailable on this platform");
  execFileSync(process.execPath, ["-e", RENAME_EXCHANGE_SCRIPT, staging, directory], {
    stdio: "ignore",
  });
};

const assertProjectionDirectoryEntries = (directory: string, names: readonly string[]): void => {
  const allowed = new Set(names);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    assertNoSymlinkPath(source);
    if (!entry.isFile()) throw new Error(`unsupported projection entry: ${source}`);
    if (!allowed.has(entry.name)) throw new Error(`unknown projection entry: ${source}`);
  }
};

export const writeProjectionSetEffect = (
  root: string,
  projectionDirectory: string,
  projections: Readonly<Record<string, string>>,
  names: readonly string[],
  intentAuthority: PinnedIntentRegister,
  legacyRoot: string,
  runtimeEvidenceAuthority?: PinnedRuntimeEvidenceRegister,
): Effect.Effect<void, ParityRuntimeError> =>
  Effect.try({
    try: () => {
      assertNoSymlinkPath(root);
      const directory = join(root, projectionDirectory);
      assertWithinRoot(root, directory);
      const parent = dirname(directory);
      assertWithinRoot(root, parent);
      assertNoSymlinkPath(parent);
      if (isMissingPath(parent)) mkdirSync(parent, { recursive: true });
      if (runtimeEvidenceAuthority !== undefined)
        recheckPinnedRuntimeEvidenceRegister(runtimeEvidenceAuthority, legacyRoot, root, projectionDirectory)
      recheckPinnedIntentRegister(intentAuthority, legacyRoot, root, projectionDirectory);
      const staging = mkdtempSync(join(root, ".functional-parity-staging-"));
      assertNoSymlinkPath(staging);
      try {
        if (!isMissingPath(directory)) {
          assertNoSymlinkPath(directory);
          if (!lstatSync(directory).isDirectory())
            throw new Error(`projection target is not a directory: ${directory}`);
          assertProjectionDirectoryEntries(directory, names);
        }
        for (const name of names) {
          const contents = projections[name];
          if (contents === undefined) throw new Error(`missing projection payload: ${name}`);
          const target = join(staging, name);
          assertWithinRoot(root, target);
          assertNoSymlinkPath(target);
          writeFileSync(target, contents, { encoding: "utf8", flag: "wx" });
        }
        recheckPinnedIntentRegister(intentAuthority, legacyRoot, root, projectionDirectory);
        if (runtimeEvidenceAuthority !== undefined)
          recheckPinnedRuntimeEvidenceRegister(runtimeEvidenceAuthority, legacyRoot, root, projectionDirectory)
        if (isMissingPath(directory)) {
          renameSync(staging, directory);
        } else {
          assertProjectionDirectoryEntries(directory, names);
          exchangeDirectories(staging, directory);
          rmSync(staging, { recursive: true, force: true });
        }
      } catch (cause) {
        if (!isMissingPath(staging)) rmSync(staging, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      new ParityRuntimeError({
        operation: "write_projection",
        path: join(root, projectionDirectory),
        message: cause instanceof Error ? cause.message : "projection write failed",
      }),
  });
