import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0018: O_NOFOLLOW opens, /proc/self/fd walks, fstat link counts, and flock need raw descriptors, which a FileSystem File does not expose
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0018: the descriptor walk resolves paths synchronously, where the Path service answers through an Effect
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Predicate, Semaphore } from "effect";
import { dual } from "effect/Function";

const lockLibrary = dlopen("libc.so.6", {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

const LOCK_SHARED = 1;

const LOCK_EXCLUSIVE = 2;

const LOCK_RELEASE = 8;

/** One in-process queue per lock file: callers of this process take the lock in turn. */
const projectionLockQueues = new Map<string, Semaphore.Semaphore>();

const projectionLockQueue = (path: string): Semaphore.Semaphore => {
  const known = projectionLockQueues.get(path);

  if (known !== undefined) return known;

  const created = Semaphore.makeUnsafe(1);

  projectionLockQueues.set(path, created);

  return created;
};

const acquireFileLock = (path: string, mode: "shared" | "exclusive"): (() => void) => {
  const descriptor = fs.openSync(
    path,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600,
  );

  if (
    lockLibrary.symbols.flock(descriptor, mode === "shared" ? LOCK_SHARED : LOCK_EXCLUSIVE) !== 0
  ) {
    fs.closeSync(descriptor);
    throw new Error(`cannot acquire projection lock: ${path}`);
  }

  return () => {
    const releaseFailed = lockLibrary.symbols.flock(descriptor, LOCK_RELEASE) !== 0;
    fs.closeSync(descriptor);

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
export const projectionFileLock: {
  <A, E, R>(
    mode: "shared" | "exclusive",
    operation: Effect.Effect<A, E, R>,
  ): (projectionDirectory: string) => Effect.Effect<A, E, R>;
  <A, E, R>(
    projectionDirectory: string,
    mode: "shared" | "exclusive",
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
} = dual(
  3,
  <A, E, R>(
    projectionDirectory: string,
    mode: "shared" | "exclusive",
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const path = projectionLockPath(projectionDirectory);

    return Effect.acquireUseRelease(
      Effect.sync(() => acquireFileLock(path, mode)),
      () => operation,
      (release) => Effect.sync(release),
    ).pipe(projectionLockQueue(path).withPermits(1));
  },
);

/**
 * The Promise form of `projectionFileLock`, for the browser drivers that are no Effect programs
 * yet (EX-0017).
 */
export const withProjectionFileLock: {
  <A>(
    mode: "shared" | "exclusive",
    operation: () => Promise<A>,
  ): (projectionDirectory: string) => Promise<A>;
  <A>(
    projectionDirectory: string,
    mode: "shared" | "exclusive",
    operation: () => Promise<A>,
  ): Promise<A>;
} = dual(
  3,
  <A>(
    projectionDirectory: string,
    mode: "shared" | "exclusive",
    operation: () => Promise<A>,
  ): Promise<A> =>
    Effect.runPromise(
      projectionFileLock(
        projectionDirectory,
        mode,
        // A rejection of the operation dies with its original error, which the Promise rejects with.
        Effect.promise(operation),
      ),
    ),
);

const noFollowReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const isErrorWithCode = (cause: unknown, code: string): boolean =>
  cause !== null && Predicate.isObjectOrArray(cause) && "code" in cause && cause.code === code;

/**
 * Opens `path` one component at a time through `/proc/self/fd`, refusing symlinks at every level.
 * With `create`, missing components become directories; a racing creator is tolerated.
 */
const openDirectoryPathNoFollow = (path: string, create = false): number => {
  let descriptor = fs.openSync("/", noFollowReadFlags | fs.constants.O_DIRECTORY);

  const components = resolve(path)
    .split("/")
    .filter((entry) => entry.length > 0);

  try {
    for (const component of components) {
      const childPath = `/proc/self/fd/${descriptor}/${component}`;
      let next: number;

      try {
        next = fs.openSync(childPath, noFollowReadFlags | fs.constants.O_DIRECTORY);
      } catch (cause) {
        if (!create || !isErrorWithCode(cause, "ENOENT")) throw cause;

        try {
          fs.mkdirSync(childPath);
        } catch (mkdirCause) {
          if (!isErrorWithCode(mkdirCause, "EEXIST")) throw mkdirCause;
        }

        next = fs.openSync(childPath, noFollowReadFlags | fs.constants.O_DIRECTORY);
      }

      fs.closeSync(descriptor);
      descriptor = next;
    }

    return descriptor;
  } catch (cause) {
    fs.closeSync(descriptor);
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
export const writeFilePathNoFollow: {
  (contents: string | Uint8Array): (path: string) => void;
  (path: string, contents: string | Uint8Array): void;
} = dual(2, (path: string, contents: string | Uint8Array): void => {
  const parent = openDirectoryPathNoFollow(dirname(path), true);

  try {
    const descriptor = fs.openSync(
      `/proc/self/fd/${parent}/${basename(path)}`,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600,
    );

    try {
      const metadata = fs.fstatSync(descriptor);

      if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error(`unsupported or aliased projection evidence entry: ${path}`);
      fs.ftruncateSync(descriptor, 0);
      fs.writeFileSync(descriptor, contents);
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.closeSync(parent);
  }
});
