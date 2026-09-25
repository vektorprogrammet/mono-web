import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Predicate } from "effect";

const lockLibrary = dlopen("libc.so.6", {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

const LOCK_SHARED = 1;

const LOCK_EXCLUSIVE = 2;

const LOCK_RELEASE = 8;

const projectionLockQueues = new Map<string, Promise<void>>();

const acquireFileLock = (path: string, mode: "shared" | "exclusive"): (() => void) => {
  const descriptor = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
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

const projectionLockPath = (projectionDirectory: string): string =>
  join(
    tmpdir(),
    `monoweb-projection-${createHash("sha256").update(resolve(projectionDirectory)).digest("hex")}.lock`,
  );

/**
 * Runs `operation` while holding an advisory `flock` on a per-directory lock file.
 * Callers in one process queue in order; other processes serialize through the kernel lock.
 */
export const withProjectionFileLock = async <A>(
  projectionDirectory: string,
  mode: "shared" | "exclusive",
  operation: () => Promise<A>,
): Promise<A> => {
  const path = projectionLockPath(projectionDirectory);
  const previous = projectionLockQueues.get(path) ?? Promise.resolve();
  const { promise: turn, resolve: advanceQueue } = Promise.withResolvers<void>();

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

const noFollowReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const isErrorWithCode = (cause: unknown, code: string): boolean =>
  cause !== null && Predicate.isObjectOrArray(cause) && "code" in cause && cause.code === code;

/**
 * Opens `path` one component at a time through `/proc/self/fd`, refusing symlinks at every level.
 * With `create`, missing components become directories; a racing creator is tolerated.
 */
const openDirectoryPathNoFollow = (path: string, create = false): number => {
  let descriptor = openSync("/", noFollowReadFlags | constants.O_DIRECTORY);

  const components = resolve(path)
    .split("/")
    .filter((entry) => entry.length > 0);

  try {
    for (const component of components) {
      const childPath = `/proc/self/fd/${descriptor}/${component}`;
      let next: number;

      try {
        next = openSync(childPath, noFollowReadFlags | constants.O_DIRECTORY);
      } catch (cause) {
        if (!create || !isErrorWithCode(cause, "ENOENT")) throw cause;

        try {
          mkdirSync(childPath);
        } catch (mkdirCause) {
          if (!isErrorWithCode(mkdirCause, "EEXIST")) throw mkdirCause;
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

/**
 * Replaces the contents of `path` without following symlinks in any path component or the
 * final entry. Missing parent directories are created; hard-linked targets are refused.
 */
export const writeFilePathNoFollow = (path: string, contents: string | Uint8Array): void => {
  const parent = openDirectoryPathNoFollow(dirname(path), true);

  try {
    const descriptor = openSync(
      `/proc/self/fd/${parent}/${basename(path)}`,
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
  } finally {
    closeSync(parent);
  }
};
