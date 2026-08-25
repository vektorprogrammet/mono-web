import { dirname, join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import { canonicalJson, compareByteOrder, sha256, stableId } from "./canonical.js";
import { assertSafeAcceptedIntentBytes } from "./coverage.js";
import { assertSafeRuntimeEvidenceBytes } from "./runtime-evidence.js";
import {
  ParityCommandExecutor,
  type ParityCommandExecutorShape,
  ParityFileSystem,
  type ParityFileSystemShape,
} from "./services.js";
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

const isMissingPath = (fileSystem: ParityFileSystemShape, path: string): boolean => {
  try {
    fileSystem.lstat(path);
    return false;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return true;
    throw cause;
  }
};

const assertNoSymlinkPath = (fileSystem: ParityFileSystemShape, path: string): void => {
  let current = resolve(path);
  while (true) {
    try {
      const stats = fileSystem.lstat(current);
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
const canonicalExistingPath = (fileSystem: ParityFileSystemShape, path: string): string => {
  assertNoSymlinkPath(fileSystem, path);
  return fileSystem.realpath(path);
};
const pathContains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);
const sameFilesystemObject = (
  fileSystem: ParityFileSystemShape,
  left: string,
  right: string,
): boolean => {
  const leftStat = fileSystem.stat(left);
  const rightStat = fileSystem.stat(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
};
const assertAuthorityRootOwnershipWithServices = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  legacyRoot: string,
  monoRoot: string,
  authorityPath?: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const legacy = canonicalExistingPath(fileSystem, legacyRoot);
  const mono = canonicalExistingPath(fileSystem, monoRoot);
  const projection = resolve(join(mono, projectionDirectory));
  if (
    pathContains(legacy, mono) ||
    pathContains(mono, legacy) ||
    sameFilesystemObject(fileSystem, legacy, mono)
  )
    throw new Error("legacy and mono roots overlap or alias");
  if (
    pathContains(legacy, projection) ||
    pathContains(projection, legacy) ||
    pathContains(mono, projection) === false
  )
    throw new Error("projection directory is not owned by mono root");
  if (authorityPath !== undefined) {
    const authority = canonicalExistingPath(fileSystem, authorityPath);
    const authorityRoot = canonicalExistingPath(
      fileSystem,
      commands
        .executeText("git", ["-C", dirname(authority), "rev-parse", "--show-toplevel"])
        .trim(),
    );
    if (
      pathContains(legacy, authorityRoot) ||
      pathContains(authorityRoot, legacy) ||
      pathContains(mono, authorityRoot) ||
      pathContains(authorityRoot, mono) ||
      sameFilesystemObject(fileSystem, authorityRoot, legacy) ||
      sameFilesystemObject(fileSystem, authorityRoot, mono)
    )
      throw new Error("intent authority checkout overlaps or aliases selected roots");
    if (pathContains(projection, authority) || pathContains(authority, projection))
      throw new Error("intent authority overlaps projection directory");
  }
};
export const assertAuthorityRootOwnership = (
  legacyRoot: string,
  monoRoot: string,
  authorityPath?: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<void, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    yield* Effect.try({
      try: () =>
        assertAuthorityRootOwnershipWithServices(
          fileSystem,
          commands,
          legacyRoot,
          monoRoot,
          authorityPath,
          projectionDirectory,
        ),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "root_ownership",
          path: monoRoot,
          message: cause instanceof Error ? cause.message : "source roots overlap",
        }),
    });
  });
const assertIndependentAuthorityRootsWithServices = (
  fileSystem: ParityFileSystemShape,
  intentAuthorityRoot: string,
  evidenceAuthorityRoot: string,
): void => {
  const intent = canonicalExistingPath(fileSystem, intentAuthorityRoot);
  const evidence = canonicalExistingPath(fileSystem, evidenceAuthorityRoot);
  if (
    pathContains(intent, evidence) ||
    pathContains(evidence, intent) ||
    sameFilesystemObject(fileSystem, intent, evidence)
  )
    throw new Error("intent and evidence authority checkouts overlap or alias");
};
export const assertIndependentAuthorityRoots = (
  intentAuthorityRoot: string,
  evidenceAuthorityRoot: string,
): Effect.Effect<void, ParityRuntimeError, ParityFileSystem> =>
  ParityFileSystem.use((fileSystem) =>
    Effect.try({
      try: () =>
        assertIndependentAuthorityRootsWithServices(
          fileSystem,
          intentAuthorityRoot,
          evidenceAuthorityRoot,
        ),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "authority_separation",
          path: evidenceAuthorityRoot,
          message:
            cause instanceof Error ? cause.message : "intent and evidence authorities overlap",
        }),
    }),
  );

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
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory: string,
): PinnedIntentRegister => {
  const absolutePath = canonicalExistingPath(fileSystem, path);
  const authorityRoot = canonicalExistingPath(
    fileSystem,
    commands
      .executeText("git", ["-C", dirname(absolutePath), "rev-parse", "--show-toplevel"])
      .trim(),
  );
  assertAuthorityRootOwnershipWithServices(
    fileSystem,
    commands,
    legacyRoot,
    monoRoot,
    absolutePath,
    projectionDirectory,
  );
  const relativePath = relative(authorityRoot, absolutePath).split(sep).join("/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath === ".."
  )
    throw new Error("intent authority path escapes its checkout");
  const statusBefore = commands
    .executeText("git", ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"])
    .trim();
  if (statusBefore.length > 0) throw new Error("intent authority checkout is dirty");
  const tracked = commands
    .executeText("git", [
      "-C",
      authorityRoot,
      "ls-files",
      "--stage",
      "--error-unmatch",
      "--",
      relativePath,
    ])
    .trim();
  if (!/^100644 [0-9a-f]{40} 0\t/.test(tracked))
    throw new Error("intent authority must be a tracked regular file");
  const revision = commands.executeText("git", ["-C", authorityRoot, "rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("intent authority revision is unavailable");
  const blobOid = commands
    .executeText("git", ["-C", authorityRoot, "rev-parse", `${revision}:${relativePath}`])
    .trim();
  if (!/^[0-9a-f]{40}$/.test(blobOid)) throw new Error("intent authority blob is unavailable");
  const bytes = commands.executeBytes(
    "git",
    ["-C", authorityRoot, "show", `${revision}:${relativePath}`],
    { maxBuffer: 16 * 1024 * 1024 + 1024 },
  );
  assertSafeAcceptedIntentBytes(bytes);
  const statusAfter = commands
    .executeText("git", ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"])
    .trim();
  const revisionAfter = commands
    .executeText("git", ["-C", authorityRoot, "rev-parse", "HEAD"])
    .trim();
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
): Effect.Effect<
  PinnedIntentRegister,
  ParityRuntimeError,
  ParityCommandExecutor | ParityFileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () =>
        readAuthorityBlob(fileSystem, commands, path, legacyRoot, monoRoot, projectionDirectory),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "intent_authority",
          path,
          message: cause instanceof Error ? cause.message : "intent authority is unavailable",
        }),
    });
  });
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const recheckPinnedIntentRegisterWithServices = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  pinned: PinnedIntentRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const current = readAuthorityBlob(
    fileSystem,
    commands,
    join(pinned.authorityRoot, pinned.relativePath),
    legacyRoot,
    monoRoot,
    projectionDirectory,
  );
  if (
    current.revision !== pinned.revision ||
    current.blobOid !== pinned.blobOid ||
    current.digest !== pinned.digest ||
    !bytesEqual(current.bytes, pinned.bytes)
  )
    throw new Error("intent authority changed before projection exchange");
};
export const recheckPinnedIntentRegister = (
  pinned: PinnedIntentRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<void, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () =>
        recheckPinnedIntentRegisterWithServices(
          fileSystem,
          commands,
          pinned,
          legacyRoot,
          monoRoot,
          projectionDirectory,
        ),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "intent_authority",
          path: join(pinned.authorityRoot, pinned.relativePath),
          message: cause instanceof Error ? cause.message : "intent authority changed",
        }),
    });
  });

export interface PinnedRuntimeEvidenceRegister {
  readonly authorityRoot: string;
  readonly relativePath: string;
  readonly revisionRefId: string;
  readonly revision: string;
  readonly blobOid: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly register: RuntimeEvidenceRegister;
}

const readRuntimeEvidenceBlob = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory: string,
): PinnedRuntimeEvidenceRegister => {
  const absolutePath = canonicalExistingPath(fileSystem, path);
  const authorityRoot = canonicalExistingPath(
    fileSystem,
    commands
      .executeText("git", ["-C", dirname(absolutePath), "rev-parse", "--show-toplevel"])
      .trim(),
  );
  assertAuthorityRootOwnershipWithServices(
    fileSystem,
    commands,
    legacyRoot,
    monoRoot,
    absolutePath,
    projectionDirectory,
  );
  const relativePath = relative(authorityRoot, absolutePath).split(sep).join("/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath === ".."
  )
    throw new Error("runtime evidence authority path escapes its checkout");
  const statusBefore = commands
    .executeText("git", ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"])
    .trim();
  if (statusBefore.length > 0) throw new Error("runtime evidence authority checkout is dirty");
  const tracked = commands
    .executeText("git", [
      "-C",
      authorityRoot,
      "ls-files",
      "--stage",
      "--error-unmatch",
      "--",
      relativePath,
    ])
    .trim();
  if (!/^100644 [0-9a-f]{40} 0\t/.test(tracked))
    throw new Error("runtime evidence authority must be a tracked regular file");
  const revision = commands.executeText("git", ["-C", authorityRoot, "rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("runtime evidence authority revision is unavailable");
  const blobOid = commands
    .executeText("git", ["-C", authorityRoot, "rev-parse", `${revision}:${relativePath}`])
    .trim();
  if (!/^[0-9a-f]{40}$/.test(blobOid))
    throw new Error("runtime evidence authority blob is unavailable");
  const bytes = commands.executeBytes(
    "git",
    ["-C", authorityRoot, "show", `${revision}:${relativePath}`],
    { maxBuffer: 16 * 1024 * 1024 + 1024 },
  );
  const register = assertSafeRuntimeEvidenceBytes(bytes);
  const statusAfter = commands
    .executeText("git", ["-C", authorityRoot, "status", "--porcelain=v1", "--untracked-files=all"])
    .trim();
  const revisionAfter = commands
    .executeText("git", ["-C", authorityRoot, "rev-parse", "HEAD"])
    .trim();
  if (statusAfter !== statusBefore || revisionAfter !== revision)
    throw new Error("runtime evidence authority changed during pin");
  return {
    authorityRoot,
    relativePath,
    revisionRefId: `rev-runtime-evidence-authority-${revision}`,
    revision,
    blobOid,
    bytes,
    digest: sha256(bytes),
    register,
  };
};

export const readPinnedRuntimeEvidenceRegisterEffect = (
  path: string,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<
  PinnedRuntimeEvidenceRegister,
  ParityRuntimeError,
  ParityCommandExecutor | ParityFileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () =>
        readRuntimeEvidenceBlob(
          fileSystem,
          commands,
          path,
          legacyRoot,
          monoRoot,
          projectionDirectory,
        ),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "runtime_evidence_authority",
          path,
          message:
            cause instanceof Error ? cause.message : "runtime evidence authority is unavailable",
        }),
    });
  });

const recheckPinnedRuntimeEvidenceRegisterWithServices = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  pinned: PinnedRuntimeEvidenceRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): void => {
  const current = readRuntimeEvidenceBlob(
    fileSystem,
    commands,
    join(pinned.authorityRoot, pinned.relativePath),
    legacyRoot,
    monoRoot,
    projectionDirectory,
  );
  if (
    current.revision !== pinned.revision ||
    current.blobOid !== pinned.blobOid ||
    current.digest !== pinned.digest ||
    !bytesEqual(current.bytes, pinned.bytes)
  )
    throw new Error("runtime evidence authority changed before projection exchange");
};
export const recheckPinnedRuntimeEvidenceRegister = (
  pinned: PinnedRuntimeEvidenceRegister,
  legacyRoot: string,
  monoRoot: string,
  projectionDirectory = "evidence/functional-parity",
): Effect.Effect<void, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () =>
        recheckPinnedRuntimeEvidenceRegisterWithServices(
          fileSystem,
          commands,
          pinned,
          legacyRoot,
          monoRoot,
          projectionDirectory,
        ),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "runtime_evidence_authority",
          path: join(pinned.authorityRoot, pinned.relativePath),
          message: cause instanceof Error ? cause.message : "runtime evidence authority changed",
        }),
    });
  });

export const registerRuntimeEvidenceAuthority = (
  context: ManifestContext,
  pinned: PinnedRuntimeEvidenceRegister,
): EvidenceAuthorityRecord => {
  const authorityPath = `authority://blob/${pinned.blobOid}`;
  const revisionRefId = pinned.revisionRefId;
  if (!context.revisions.some((revision) => revision.revision_ref_id === revisionRefId)) {
    context.revisions.push({
      revision_ref_id: revisionRefId,
      repository_ref: "external_runtime_evidence_authority",
      revision_kind: "git_commit",
      revision: pinned.revision,
      immutable: true,
    });
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
  };
  const sourceId = stableId("src", sourceIdentity);
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
    });
    context.sourcePathById.set(sourceId, { rootRef: "mono", path: authorityPath });
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
  };
};

const listRegularFiles = (
  fileSystem: ParityFileSystemShape,
  rootPath: string,
  prefix = "",
  excludedPrefix?: string,
): string[] => {
  const absolute = prefix.length === 0 ? rootPath : join(rootPath, prefix);
  const entries = fileSystem.readDirectory(absolute);
  const paths: string[] = [];
  for (const entry of entries) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (
      excludedPrefix !== undefined &&
      (child === excludedPrefix || child.startsWith(`${excludedPrefix}/`))
    )
      continue;
    if (entry.isDirectory())
      paths.push(...listRegularFiles(fileSystem, rootPath, child, excludedPrefix));
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
const gitState = (
  commands: ParityCommandExecutorShape,
  rootPath: string,
  rootRef: "legacy" | "mono",
): GitState | null => {
  let revision: string;
  try {
    revision = commands
      .executeText("git", ["-C", rootPath, "rev-parse", "HEAD"], {
        maxBuffer: MAX_GIT_METADATA_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) return null;
  const dirtyEntries = commands
    .executeText(
      "git",
      ["-C", rootPath, "status", "--porcelain=v1", "--untracked-files=all", "-z"],
      { maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] },
    )
    .split("\0")
    .filter((entry) => entry.length > 0);
  const dirty = dirtyEntries.filter(
    (entry) => !isMonoProjectionMountPath(rootRef, porcelainPath(entry)),
  );
  if (dirty.length > 0) throw new Error(`selected source root is dirty: ${rootPath}`);
  const ignored = commands
    .executeText(
      "git",
      ["-C", rootPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] },
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
  const tracked = commands
    .executeText("git", ["-C", rootPath, "ls-tree", "-r", "--name-only", "-z", revision], {
      maxBuffer: MAX_GIT_METADATA_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    })
    .split("\0")
    .filter((path) => path.length > 0 && !isMonoProjectionMountPath(rootRef, path));
  return { revision, trackedPaths: new Set(tracked) };
};

const MAX_GIT_BLOB_BYTES = 16 * 1024 * 1024;

const gitBlob = (
  commands: ParityCommandExecutorShape,
  rootPath: string,
  revision: string,
  path: string,
): Uint8Array => {
  const objectRef = `${revision}:${path}`;
  const sizeText = commands
    .executeText("git", ["-C", rootPath, "cat-file", "-s", objectRef], {
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    .trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GIT_BLOB_BYTES)
    throw new Error(`tracked source blob exceeds bounded read limit: ${path}`);
  return commands.executeBytes("git", ["-C", rootPath, "show", objectRef], {
    maxBuffer: size + 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
};
const redactedSourcePath = (path: string): { readonly path: string; readonly unsafe: boolean } => {
  const unsafe = isUnsafeSourcePath(path) || unsafeSourceScalarReason(path, "source_path") !== null;
  return unsafe ? { path: "unsafe-source-redacted", unsafe: true } : { path, unsafe: false };
};

const scanRoot = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  rootPath: string,
  rootRef: "legacy" | "mono",
): RootScanSnapshot => {
  assertNoSymlinkPath(fileSystem, rootPath);
  const before = gitState(commands, rootPath, rootRef);
  const paths =
    before === null
      ? listRegularFiles(
          fileSystem,
          rootPath,
          "",
          rootRef === "mono" ? MONO_PROJECTION_DIRECTORY : undefined,
        )
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
    assertNoSymlinkPath(fileSystem, absolutePath);
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
    let bytes: Uint8Array;
    try {
      bytes = tracked
        ? gitBlob(commands, rootPath, before?.revision ?? "", path)
        : fileSystem.readBytes(absolutePath);
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
  const after = gitState(commands, rootPath, rootRef);
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
): Effect.Effect<RootScanSnapshot, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () => scanRoot(fileSystem, commands, rootPath, rootRef),
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "scan_root",
          path: rootPath,
          message: cause instanceof Error ? cause.message : "source root is unavailable",
        }),
    });
  });

export const createManifestContextWithServices = (
  fileSystem: ParityFileSystemShape,
  commands: ParityCommandExecutorShape,
  legacyRoot: string,
  monoRoot: string,
): ManifestContext => {
  assertAuthorityRootOwnershipWithServices(fileSystem, commands, legacyRoot, monoRoot);
  const legacy = scanRoot(fileSystem, commands, legacyRoot, "legacy");
  const mono = scanRoot(fileSystem, commands, monoRoot, "mono");
  return createManifestContextFromSnapshots(legacy, mono);
};

export const createManifestContextEffect = (
  legacyRoot: string,
  monoRoot: string,
): Effect.Effect<ManifestContext, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    yield* assertAuthorityRootOwnership(legacyRoot, monoRoot);
    const legacy = yield* scanRootEffect(legacyRoot, "legacy");
    const mono = yield* scanRootEffect(monoRoot, "mono");
    return createManifestContextFromSnapshots(legacy, mono);
  });

export const readProjectionEffect = (
  root: string,
  projectionDirectory: string,
  name: string,
): Effect.Effect<string | null, ParityRuntimeError, ParityFileSystem> =>
  ParityFileSystem.use((fileSystem) =>
    Effect.try({
      try: () => {
        const path = join(root, projectionDirectory, name);
        assertWithinRoot(root, path);
        assertNoSymlinkPath(fileSystem, path);
        return isMissingPath(fileSystem, path) ? null : fileSystem.readText(path);
      },
      catch: (cause) =>
        new ParityRuntimeError({
          operation: "read_projection",
          path: join(root, projectionDirectory, name),
          message: cause instanceof Error ? cause.message : "projection is unavailable",
        }),
    }),
  );
export const readProjectionDirectoryEffect = (
  root: string,
  projectionDirectory: string,
): Effect.Effect<readonly string[], ParityRuntimeError, ParityFileSystem> =>
  ParityFileSystem.use((fileSystem) =>
    Effect.try({
      try: () => {
        const directory = join(root, projectionDirectory);
        assertWithinRoot(root, directory);
        if (isMissingPath(fileSystem, directory)) return [];
        assertNoSymlinkPath(fileSystem, directory);
        if (!fileSystem.lstat(directory).isDirectory())
          throw new Error(`projection target is not a directory: ${directory}`);
        const entries = fileSystem.readDirectory(directory);
        for (const entry of entries) {
          const target = join(directory, entry.name);
          assertNoSymlinkPath(fileSystem, target);
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
    }),
  );

const assertProjectionDirectoryEntries = (
  fileSystem: ParityFileSystemShape,
  directory: string,
  names: readonly string[],
): void => {
  const allowed = new Set(names);
  for (const entry of fileSystem.readDirectory(directory)) {
    const source = join(directory, entry.name);
    assertNoSymlinkPath(fileSystem, source);
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
): Effect.Effect<void, ParityRuntimeError, ParityCommandExecutor | ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const commands = yield* ParityCommandExecutor;
    return yield* Effect.try({
      try: () => {
        assertNoSymlinkPath(fileSystem, root);
        const directory = join(root, projectionDirectory);
        assertWithinRoot(root, directory);
        const parent = dirname(directory);
        assertWithinRoot(root, parent);
        assertNoSymlinkPath(fileSystem, parent);
        if (isMissingPath(fileSystem, parent))
          fileSystem.makeDirectory(parent, { recursive: true });
        if (runtimeEvidenceAuthority !== undefined)
          recheckPinnedRuntimeEvidenceRegisterWithServices(
            fileSystem,
            commands,
            runtimeEvidenceAuthority,
            legacyRoot,
            root,
            projectionDirectory,
          );
        recheckPinnedIntentRegisterWithServices(
          fileSystem,
          commands,
          intentAuthority,
          legacyRoot,
          root,
          projectionDirectory,
        );
        const staging = fileSystem.makeTempDirectory(join(root, ".functional-parity-staging-"));
        assertNoSymlinkPath(fileSystem, staging);
        try {
          if (!isMissingPath(fileSystem, directory)) {
            assertNoSymlinkPath(fileSystem, directory);
            if (!fileSystem.lstat(directory).isDirectory())
              throw new Error(`projection target is not a directory: ${directory}`);
            assertProjectionDirectoryEntries(fileSystem, directory, names);
          }
          for (const name of names) {
            const contents = projections[name];
            if (contents === undefined) throw new Error(`missing projection payload: ${name}`);
            const target = join(staging, name);
            assertWithinRoot(root, target);
            assertNoSymlinkPath(fileSystem, target);
            fileSystem.writeFile(target, contents, { encoding: "utf8", flag: "wx" });
          }
          recheckPinnedIntentRegisterWithServices(
            fileSystem,
            commands,
            intentAuthority,
            legacyRoot,
            root,
            projectionDirectory,
          );
          if (runtimeEvidenceAuthority !== undefined)
            recheckPinnedRuntimeEvidenceRegisterWithServices(
              fileSystem,
              commands,
              runtimeEvidenceAuthority,
              legacyRoot,
              root,
              projectionDirectory,
            );
          if (isMissingPath(fileSystem, directory)) {
            fileSystem.rename(staging, directory);
          } else {
            assertProjectionDirectoryEntries(fileSystem, directory, names);
            fileSystem.exchangeDirectoriesAtomically(staging, directory);
            fileSystem.remove(staging, { recursive: true, force: true });
          }
        } catch (cause) {
          if (!isMissingPath(fileSystem, staging))
            fileSystem.remove(staging, { recursive: true, force: true });
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
  });
