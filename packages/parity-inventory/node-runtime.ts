import { dlopen, FFIType } from "bun:ffi";
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Layer } from "effect";
import { compareByteOrder, sha256 } from "./src/canonical.js";
import {
  ParityCommandExecutor,
  type ParityDirectoryInspection,
  type ParityCommandOptions,
  type ParityDirectoryTreeEntry,
  ParityExecutionEnvironment,
  ParityFileSystem,
  ParityTerminal,
} from "./src/services.js";

const commandOptions = (options: ParityCommandOptions | undefined): ExecFileSyncOptions => ({
  cwd: options?.cwd,
  env: options?.env === undefined ? undefined : { ...options.env },
  killSignal: options?.killSignal,
  maxBuffer: options?.maxBuffer,
  stdio: options?.stdio,
  timeout: options?.timeout,
});

const lockLibrary = dlopen("libc.so.6", {
  flock: {
    args: [FFIType.c_int, FFIType.c_int],
    returns: FFIType.c_int,
  },
  fchmod: {
    args: [FFIType.c_int, FFIType.c_uint],
    returns: FFIType.c_int,
  },
  unlinkat: {
    args: [FFIType.c_int, FFIType.cstring, FFIType.c_int],
    returns: FFIType.c_int,
  },
});
const LOCK_SHARED = 1;
const LOCK_EXCLUSIVE = 2;
const LOCK_RELEASE = 8;
const projectionLockQueues = new Map<string, Promise<void>>();
const fchmodDescriptor = (descriptor: number, mode: number): void => {
  if (lockLibrary.symbols.fchmod(descriptor, mode) !== 0)
    throw new Error(`cannot preserve projection evidence mode: ${mode.toString(8)}`);
};

const acquireFileLock = (path: string, mode: "shared" | "exclusive"): (() => void) => {
  const descriptor = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    0o600,
  );
  if (
    lockLibrary.symbols.flock(descriptor, mode === "shared" ? LOCK_SHARED : LOCK_EXCLUSIVE) !== 0
  ) {
    closeSync(descriptor);
    throw new Error(`cannot acquire projection lock: ${path}`);
  }
  return () => {
    const releaseFailed = lockLibrary.symbols.flock(descriptor, LOCK_RELEASE) !== 0;
    closeSync(descriptor);
    if (releaseFailed) throw new Error(`cannot release projection lock: ${path}`);
  };
};

const withFileLock = <A>(path: string, mode: "shared" | "exclusive", operation: () => A): A => {
  const release = acquireFileLock(path, mode);
  try {
    return operation();
  } finally {
    release();
  }
};

export const projectionLockPath = (projectionDirectory: string): string =>
  join(
    tmpdir(),
    `monoweb-functional-parity-${sha256(resolve(projectionDirectory)).slice("sha256:".length)}.lock`,
  );

export const withProjectionFileLock = async <A>(
  projectionDirectory: string,
  mode: "shared" | "exclusive",
  operation: () => Promise<A>,
): Promise<A> => {
  const path = projectionLockPath(projectionDirectory);
  const previous = projectionLockQueues.get(path) ?? Promise.resolve();
  let advanceQueue: () => void = () => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    advanceQueue = resolveTurn;
  });
  const queued = previous.then(() => turn);
  projectionLockQueues.set(path, queued);
  await previous;
  let release: (() => void) | null = null;
  try {
    release = acquireFileLock(path, mode);
    return await operation();
  } finally {
    try {
      release?.();
    } finally {
      advanceQueue();
      if (projectionLockQueues.get(path) === queued) projectionLockQueues.delete(path);
    }
  }
};
const RENAME_EXCHANGE_SCRIPT = `import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, fstatSync, openSync, renameSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY
const openDirectory = (path) => {
  const absolute = resolve(path)
  const pinned = /^(\\/proc\\/(?:self|\\d+)\\/fd\\/\\d+)(\\/.*)?$/.exec(absolute)
  let descriptor = pinned === null
    ? openSync("/", openFlags)
    : openSync(pinned[1], openFlags & ~constants.O_NOFOLLOW)
  const components = (pinned === null ? absolute : pinned[2] ?? "").split("/").filter((entry) => entry.length > 0)
  try {
    for (const component of components) {
      const next = openSync("/proc/self/fd/" + descriptor + "/" + component, openFlags)
      closeSync(descriptor)
      descriptor = next
    }
    return descriptor
  } catch (cause) {
    closeSync(descriptor)
    throw cause
  }
}
const source = process.argv[1]
const target = process.argv[2]
const flags = Number(process.argv[3])
if (source === undefined || target === undefined || !Number.isInteger(flags)) process.exit(2)
const sourceDescriptor = openDirectory(source)
const sourceMetadata = fstatSync(sourceDescriptor, { bigint: true })
const sourceParent = openDirectory(dirname(source))
const targetParent = openDirectory(dirname(target))
let targetMetadataBefore
let targetDescriptorBefore
if (flags === 2) {
  targetDescriptorBefore = openDirectory(target)
  targetMetadataBefore = fstatSync(targetDescriptorBefore, { bigint: true })
}
const replacement = process.argv[4]
const displaced = process.argv[5]
if ((replacement === undefined) !== (displaced === undefined)) {
  closeSync(targetDescriptorBefore)
  closeSync(sourceDescriptor)
  closeSync(sourceParent)
  closeSync(targetParent)
  process.exit(2)
}
if (replacement !== undefined) {
  renameSync(source, displaced)
  renameSync(replacement, source)
}
const sourceName = Buffer.from(basename(source) + String.fromCharCode(0))
const targetName = Buffer.from(basename(target) + String.fromCharCode(0))
const libc = dlopen("libc.so.6", { renameat2: { args: [FFIType.c_int, FFIType.cstring, FFIType.c_int, FFIType.cstring, FFIType.c_uint], returns: FFIType.c_int } })
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
const closeInputs = () => {
  if (targetDescriptorBefore !== undefined) closeSync(targetDescriptorBefore)
  closeSync(sourceDescriptor)
  closeSync(sourceParent)
  closeSync(targetParent)
}
const exchange = () => libc.symbols.renameat2(sourceParent, sourceName, targetParent, targetName, flags)
if (exchange() !== 0) {
  closeInputs()
  process.exit(1)
}
let committedIdentityMatches = false
try {
  const targetDescriptor = openDirectory(target)
  const targetMetadata = fstatSync(targetDescriptor, { bigint: true })
  closeSync(targetDescriptor)
  if (flags === 2) {
    const sourceDescriptorAfter = openDirectory(source)
    const sourceMetadataAfter = fstatSync(sourceDescriptorAfter, { bigint: true })
    closeSync(sourceDescriptorAfter)
    committedIdentityMatches =
      sameIdentity(sourceMetadata, targetMetadata) &&
      sameIdentity(targetMetadataBefore, sourceMetadataAfter)
  } else {
    committedIdentityMatches = sameIdentity(sourceMetadata, targetMetadata)
  }
} catch {
  committedIdentityMatches = false
}
if (!committedIdentityMatches) {
  const rollbackResult =
    flags === 2
      ? libc.symbols.renameat2(sourceParent, sourceName, targetParent, targetName, flags)
      : libc.symbols.renameat2(targetParent, targetName, sourceParent, sourceName, 1)
  let rollbackRestoredTarget = rollbackResult === 0
  if (rollbackRestoredTarget) {
    if (flags === 2) {
      try {
        const restoredTarget = openDirectory(target)
        rollbackRestoredTarget = sameIdentity(
          targetMetadataBefore,
          fstatSync(restoredTarget, { bigint: true }),
        )
        closeSync(restoredTarget)
      } catch {
        rollbackRestoredTarget = false
      }
    } else {
      try {
        const unexpectedTarget = openDirectory(target)
        closeSync(unexpectedTarget)
        rollbackRestoredTarget = false
      } catch (cause) {
        rollbackRestoredTarget =
          cause !== null &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "ENOENT"
      }
    }
  }
  closeInputs()
  process.exit(rollbackRestoredTarget ? 3 : 4)
}
closeInputs()`;

const childAccessiblePinnedPath = (path: string): string => {
  const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(path);
  if (match === null) return path;
  return `/proc/${process.pid}/fd/${match[1]}${match[2] ?? ""}`;
};

const renameDirectoriesNoFollow = (
  source: string,
  target: string,
  flags: 1 | 2,
  pinnedReplacement?: { readonly replacement: string; readonly displaced: string },
): void => {
  if (process.platform !== "linux")
    throw new Error("atomic projection rename is unavailable on this platform");
  execFileSync(
    process.execPath,
    [
      "-e",
      RENAME_EXCHANGE_SCRIPT,
      childAccessiblePinnedPath(source),
      childAccessiblePinnedPath(target),
      String(flags),
      ...(pinnedReplacement === undefined
        ? []
        : [
            childAccessiblePinnedPath(pinnedReplacement.replacement),
            childAccessiblePinnedPath(pinnedReplacement.displaced),
          ]),
    ],
    { stdio: "ignore" },
  );
};

export const exchangeDirectoriesAfterPinnedReplacementForTest = (
  source: string,
  target: string,
  replacement: string,
  displaced: string,
): void => renameDirectoriesNoFollow(source, target, 2, { replacement, displaced });
const noFollowReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const openDirectoryPathNoFollow = (path: string, create = false): number => {
  const absolute = resolve(path);
  const pinned = /^(\/proc\/(?:self|\d+)\/fd\/\d+)(\/.*)?$/.exec(absolute);
  let descriptor =
    pinned === null
      ? openSync("/", noFollowReadFlags | constants.O_DIRECTORY)
      : openSync(pinned[1], constants.O_RDONLY | constants.O_NONBLOCK | constants.O_DIRECTORY);
  const components = (pinned === null ? absolute : (pinned[2] ?? ""))
    .split("/")
    .filter((entry) => entry.length > 0);
  try {
    for (const component of components) {
      const childPath = `/proc/self/fd/${descriptor}/${component}`;
      let next: number;
      try {
        next = openSync(childPath, noFollowReadFlags | constants.O_DIRECTORY);
      } catch (cause) {
        if (
          !create ||
          cause === null ||
          typeof cause !== "object" ||
          !("code" in cause) ||
          cause.code !== "ENOENT"
        )
          throw cause;
        try {
          mkdirSync(childPath);
        } catch (mkdirCause) {
          if (
            mkdirCause === null ||
            typeof mkdirCause !== "object" ||
            !("code" in mkdirCause) ||
            mkdirCause.code !== "EEXIST"
          )
            throw mkdirCause;
        }
        next = openSync(childPath, noFollowReadFlags | constants.O_DIRECTORY);
      }
      closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (cause) {
    closeSync(descriptor);
    throw new Error(
      `cannot open projection directory without following links: ${path}: ${
        cause instanceof Error ? cause.message : "unknown filesystem error"
      }`,
      { cause },
    );
  }
};
const causedByCode = (cause: unknown, code: string): boolean => {
  if (cause === null || typeof cause !== "object") return false;
  if ("code" in cause && cause.code === code) return true;
  return "cause" in cause && causedByCode(cause.cause, code);
};

export const assertPathComponentsNoFollow = (path: string): void => {
  try {
    const descriptor = openDirectoryPathNoFollow(path);
    closeSync(descriptor);
  } catch (cause) {
    if (causedByCode(cause, "ENOENT")) return;
    throw new Error(`projection-adjacent output path is unsafe: ${path}`, { cause });
  }
};

const withDirectoryNoFollow = <A>(
  path: string,
  options: { readonly create: boolean },
  operation: (pinnedPath: string) => A,
): A => {
  const descriptor = openDirectoryPathNoFollow(path, options.create);
  try {
    return operation(`/proc/self/fd/${descriptor}`);
  } finally {
    closeSync(descriptor);
  }
};

const stableDescriptorBytes = (descriptor: number, path: string): Uint8Array => {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n)
    throw new Error(`unsupported or aliased projection evidence entry: ${path}`);
  const bytes = readFileSync(descriptor);
  const after = fstatSync(descriptor, { bigint: true });
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.nlink !== after.nlink ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error(`projection evidence changed while reading: ${path}`);
  return bytes;
};

const descriptorEntries = (descriptor: number): readonly string[] =>
  readdirSync(`/proc/self/fd/${descriptor}`).sort(compareByteOrder);

const inspectDirectoryTreeNoFollow = (
  path: string,
  fileNames: readonly string[],
): ParityDirectoryInspection => {
  if (process.platform !== "linux")
    throw new Error("secure projection evidence traversal is unavailable on this platform");
  const capturedNames = new Set(fileNames);
  const files: Record<string, Uint8Array> = {};
  const records: ParityDirectoryTreeEntry[] = [];
  const visit = (descriptor: number, relativePath: string): void => {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isDirectory())
      throw new Error(`projection evidence path is not a directory: ${path}`);
    records.push({
      kind: "directory",
      mode: Number(before.mode & 0o7777n),
      path: relativePath,
      sha256: null,
    });
    for (const name of descriptorEntries(descriptor)) {
      const childPath = `/proc/self/fd/${descriptor}/${name}`;
      const child = openSync(childPath, noFollowReadFlags);
      try {
        const childMetadata = fstatSync(child, { bigint: true });
        const childRelativePath = relativePath === "." ? name : `${relativePath}/${name}`;
        if (childMetadata.isDirectory()) {
          visit(child, childRelativePath);
          continue;
        }
        const bytes = stableDescriptorBytes(child, childPath);
        records.push({
          kind: "file",
          mode: Number(childMetadata.mode & 0o7777n),
          path: childRelativePath,
          sha256: sha256(bytes),
        });
        if (relativePath === "." && capturedNames.has(name)) files[name] = bytes;
      } finally {
        closeSync(child);
      }
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error(`projection evidence changed while reading: ${path}`);
  };
  const root = openDirectoryPathNoFollow(path);
  try {
    visit(root, ".");
    return { entries: records, files };
  } finally {
    closeSync(root);
  }
};

const readFileNoFollow = (path: string): Uint8Array => {
  const parent = openDirectoryPathNoFollow(dirname(path));
  try {
    const descriptor = openSync(`/proc/self/fd/${parent}/${basename(path)}`, noFollowReadFlags);
    try {
      return stableDescriptorBytes(descriptor, path);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    closeSync(parent);
  }
};

const writeFileInDirectoryNoFollow = (
  directory: string,
  name: string,
  contents: string | Uint8Array,
  mode?: number,
): void => {
  if (basename(name) !== name) throw new Error(`invalid projection file name: ${name}`);
  const parent = openDirectoryPathNoFollow(directory);
  try {
    const descriptor = openSync(
      `/proc/self/fd/${parent}/${name}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode ?? 0o666,
    );
    try {
      writeFileSync(descriptor, contents);
      if (mode !== undefined) fchmodDescriptor(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    closeSync(parent);
  }
};

export const readFilePathNoFollow = (path: string): Uint8Array =>
  withDirectoryNoFollow(dirname(path), { create: false }, (parent) =>
    readFileNoFollow(join(parent, basename(path))),
  );

export const writeFilePathNoFollow = (path: string, contents: string | Uint8Array): void =>
  withDirectoryNoFollow(dirname(path), { create: true }, (parent) => {
    const name = basename(path);
    if (basename(name) !== name) throw new Error(`invalid projection file name: ${name}`);
    const descriptor = openSync(
      join(parent, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error(`unsupported or aliased projection evidence entry: ${path}`);
      ftruncateSync(descriptor, 0);
      writeFileSync(descriptor, contents);
    } finally {
      closeSync(descriptor);
    }
  });

const copyDirectoryTreeNoFollow = (source: string, target: string): void => {
  if (process.platform !== "linux")
    throw new Error("secure projection evidence traversal is unavailable on this platform");
  const copyChildren = (sourceDescriptor: number, targetDescriptor: number): void => {
    for (const name of descriptorEntries(sourceDescriptor)) {
      const sourcePath = `/proc/self/fd/${sourceDescriptor}/${name}`;
      const sourceChild = openSync(sourcePath, noFollowReadFlags);
      try {
        const metadata = fstatSync(sourceChild, { bigint: true });
        const targetPath = `/proc/self/fd/${targetDescriptor}/${name}`;
        const mode = Number(metadata.mode & 0o7777n);
        if (metadata.isDirectory()) {
          const writableMode = mode | 0o700;
          mkdirSync(targetPath, { mode: writableMode });
          const targetChild = openSync(targetPath, noFollowReadFlags | constants.O_DIRECTORY);
          try {
            fchmodDescriptor(targetChild, writableMode);
            copyChildren(sourceChild, targetChild);
            fchmodDescriptor(targetChild, mode);
          } finally {
            closeSync(targetChild);
          }
          continue;
        }
        const bytes = stableDescriptorBytes(sourceChild, sourcePath);
        const targetChild = openSync(
          targetPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        try {
          writeFileSync(targetChild, bytes);
          fchmodDescriptor(targetChild, mode);
        } finally {
          closeSync(targetChild);
        }
      } finally {
        closeSync(sourceChild);
      }
    }
  };
  const sourceRoot = openDirectoryPathNoFollow(source);
  try {
    const targetParent = openDirectoryPathNoFollow(dirname(target));
    try {
      const metadata = fstatSync(sourceRoot, { bigint: true });
      const mode = Number(metadata.mode & 0o7777n);
      const writableMode = mode | 0o700;
      const targetPath = `/proc/self/fd/${targetParent}/${basename(target)}`;
      mkdirSync(targetPath, { mode: writableMode });
      const targetRoot = openSync(targetPath, noFollowReadFlags | constants.O_DIRECTORY);
      try {
        fchmodDescriptor(targetRoot, writableMode);
        copyChildren(sourceRoot, targetRoot);
        fchmodDescriptor(targetRoot, mode);
      } finally {
        closeSync(targetRoot);
      }
    } finally {
      closeSync(targetParent);
    }
  } finally {
    closeSync(sourceRoot);
  }
};

const removeDirectoryTreeNoFollow = (
  path: string,
  expected?: { readonly dev: number; readonly ino: number },
): void => {
  if (process.platform !== "linux")
    throw new Error("secure projection evidence removal is unavailable on this platform");
  const unlink = (parent: number, name: string, flags: 0 | 0x200): void => {
    if (lockLibrary.symbols.unlinkat(parent, Buffer.from(`${name}\0`), flags) !== 0)
      throw new Error(`cannot remove projection evidence entry: ${name}`);
  };
  const sameIdentity = (
    left: { readonly dev: number | bigint; readonly ino: number | bigint },
    right: { readonly dev: number | bigint; readonly ino: number | bigint },
  ): boolean => left.dev === right.dev && left.ino === right.ino;
  const assertCurrentDirectory = (
    parent: number,
    name: string,
    expectedDirectory: { readonly dev: number; readonly ino: number },
  ): void => {
    const current = openSync(
      `/proc/self/fd/${parent}/${name}`,
      noFollowReadFlags | constants.O_DIRECTORY,
    );
    try {
      if (!sameIdentity(fstatSync(current), expectedDirectory))
        throw new Error(`projection cleanup directory changed: ${name}`);
    } finally {
      closeSync(current);
    }
  };
  const visit = (descriptor: number): void => {
    fchmodDescriptor(descriptor, 0o700);
    for (const name of descriptorEntries(descriptor)) {
      const childPath = `/proc/self/fd/${descriptor}/${name}`;
      const childMetadata = lstatSync(childPath);
      if (childMetadata.isDirectory()) {
        const child = openSync(childPath, noFollowReadFlags | constants.O_DIRECTORY);
        const openedMetadata = fstatSync(child);
        if (!sameIdentity(childMetadata, openedMetadata)) {
          closeSync(child);
          throw new Error(`projection cleanup directory changed: ${name}`);
        }
        try {
          visit(child);
        } finally {
          closeSync(child);
        }
        assertCurrentDirectory(descriptor, name, openedMetadata);
        unlink(descriptor, name, 0x200);
      } else {
        const currentMetadata = lstatSync(childPath);
        if (!sameIdentity(childMetadata, currentMetadata))
          throw new Error(`projection cleanup entry changed: ${name}`);
        unlink(descriptor, name, 0);
      }
    }
  };
  const parent = openDirectoryPathNoFollow(dirname(path));
  try {
    const name = basename(path);
    const root = openSync(
      `/proc/self/fd/${parent}/${name}`,
      noFollowReadFlags | constants.O_DIRECTORY,
    );
    const rootMetadata = fstatSync(root);
    if (expected !== undefined && !sameIdentity(rootMetadata, expected)) {
      closeSync(root);
      throw new Error(`projection cleanup target changed: ${path}`);
    }
    try {
      visit(root);
    } finally {
      closeSync(root);
    }
    assertCurrentDirectory(parent, name, rootMetadata);
    unlink(parent, name, 0x200);
  } finally {
    closeSync(parent);
  }
};

const chmodDirectoryNoFollow = (path: string, mode: number): void => {
  const descriptor = openDirectoryPathNoFollow(path);
  try {
    fchmodDescriptor(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
};

export const NodeFileSystemLayer = Layer.succeed(ParityFileSystem, {
  chmodDirectoryNoFollow,
  copyDirectoryTreeNoFollow,
  removeDirectoryTreeNoFollow,
  chmod: chmodSync,
  exists: existsSync,
  inspectDirectoryTreeNoFollow,
  exchangeDirectoriesAtomically: (source, target) => renameDirectoriesNoFollow(source, target, 2),
  lstat: lstatSync,
  makeDirectory: (path, options) => {
    mkdirSync(path, options);
  },
  makeTempDirectory: mkdtempSync,
  readBytes: readFileSync,
  readFileNoFollow,
  readBytesPromise: readFile,
  readText: (path) => readFileSync(path, "utf8"),
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
  realpath: realpathSync,
  remove: (path, options) => {
    rmSync(path, options);
  },
  rename: renameSync,
  renameDirectoryNoFollow: (source, target) => renameDirectoriesNoFollow(source, target, 1),
  stat: statSync,
  writeFileInDirectoryNoFollow,
  temporaryDirectory: tmpdir,
  writeFile: writeFileSync,
  writeFileNoFollow: writeFilePathNoFollow,
  writeBytesPromise: writeFile,
  withFileLock,
  withDirectoryNoFollow,
});

export const NodeCommandExecutorLayer = Layer.succeed(ParityCommandExecutor, {
  executeBytes: (executable, arguments_, options) =>
    execFileSync(executable, [...arguments_], commandOptions(options)),
  executeText: (executable, arguments_, options) =>
    execFileSync(executable, [...arguments_], {
      ...commandOptions(options),
      encoding: "utf8",
    }),
  spawnText: (executable, arguments_, options) => {
    const result = spawnSync(executable, [...arguments_], {
      ...commandOptions(options),
      encoding: "utf8",
    } satisfies SpawnSyncOptionsWithStringEncoding);
    return {
      ...(result.error === undefined ? {} : { error: result.error }),
      signal: result.signal,
      status: result.status,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  },
});

const runnerDirectory = dirname(fileURLToPath(new URL("./src/runner.ts", import.meta.url)));
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

export const NodeExecutionEnvironmentLayer = Layer.succeed(ParityExecutionEnvironment, {
  get arguments() {
    return process.argv;
  },
  get environment() {
    return process.env;
  },
  get executablePath() {
    return process.execPath;
  },
  get platform() {
    return process.platform;
  },
  runnerDirectory,
  cliPath,
});

export const NodeTerminalLayer = Layer.succeed(ParityTerminal, {
  writeStandardError: (text) => {
    process.stderr.write(text);
  },
  writeStandardOutput: (text) => {
    process.stdout.write(text);
  },
});

export const NodeRuntimeLayer = Layer.mergeAll(
  NodeCommandExecutorLayer,
  NodeExecutionEnvironmentLayer,
  NodeFileSystemLayer,
  NodeTerminalLayer,
);
