/**
 * The machine-wide heavy lock: a readers-writer lock on
 *   ${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/heavy.lock
 * `just measure` holds it exclusively while its job runs. A hook slot holds it shared, so hook
 * jobs run together, a heavy job waits for running hook jobs, and hook jobs wait for a heavy job.
 * Every worktree and agent of the user on the machine shares the lock.
 *
 * An exclusive holder first takes the gate, heavy-gate.lock, and keeps it until it exits. A
 * shared holder passes the gate on its way in, so hook jobs that arrive while a heavy job waits
 * queue behind it and cannot keep it waiting forever. Each holder writes a line into the file it
 * holds, and a waiting process shows the lines of the live holders.
 *
 * The lock belongs to the process that takes it. flock(1) locks the open file description of its
 * standard input; this process keeps the descriptors open in the scope of its program and does
 * not pass them to its job, so the lock is released when this process exits, also on a signal.
 * The job's processes inherit `VEKTORPROGRAMMET_HEAVY_LOCK`, the holder's process id. A
 * `just measure` or hook slot started inside the job, such as the hooks of a commit, finds the
 * live holder and does not take the lock again, which would wait for itself.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0013: flock(1) locks the descriptor that it gets as standard input, which ChildProcess cannot pass
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0013: flock(1) needs the descriptor of a lock file, which a FileSystem File does not expose
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";
import process from "node:process";
import { Clock, Config, Data, DateTime, Effect, Exit, FileSystem, Path, Scope } from "effect";

export type HeavyLockMode = "exclusive" | "shared";

/** Names the process that holds the heavy lock for the job's processes. */
export const heavyLockVariable = "VEKTORPROGRAMMET_HEAVY_LOCK";

/** A lock file could not be opened, read, or written, or flock(1) failed. */
export class HeavyLockFailure extends Data.TaggedError("HeavyLockFailure")<{
  readonly message: string;
}> {}

const failure = (error: { readonly message: string }) =>
  new HeavyLockFailure({ message: error.message });

const two = (value: number) => String(value).padStart(2, "0");

/** The local date and time of now, as `YYYY-MM-DD` and `HH:MM:SS`. */
export const localNow: Effect.Effect<{ readonly date: string; readonly time: string }> =
  Effect.map(DateTime.now, (now) => {
    const parts = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));

    return {
      date: `${parts.year}-${two(parts.month)}-${two(parts.day)}`,
      time: `${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}`,
    };
  });

/** Whole seconds since a reading of `Clock.currentTimeNanos`. */
export const secondsSince = (startNanos: bigint): Effect.Effect<number> =>
  Effect.map(Clock.currentTimeNanos, (now) => Math.round(Number(now - startNanos) / 1e9));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const liveHolder = (line: string) => {
  const pid = Number(/^pid (\d+),/.exec(line)?.[1]);

  return Number.isInteger(pid) && alive(pid);
};

/**
 * Runs flock(1) on a descriptor of this process. It waits at most `timeoutSeconds` (0: tries
 * once), or without a limit when it is undefined, and succeeds with false when the time ran out.
 */
export const flockDescriptor = ({
  descriptor,
  arguments: flockArguments,
  timedOut,
}: {
  readonly descriptor: number;
  readonly arguments: ReadonlyArray<string>;
  /** Whether exit status 1 means that the time ran out rather than a failure. */
  readonly timedOut: boolean;
}): Effect.Effect<boolean, HeavyLockFailure> =>
  Effect.suspend(() => {
    const { status, signal } = spawnSync("flock", [...flockArguments, "0"], {
      stdio: [descriptor, "inherit", "inherit"],
    });

    if (status === 0) return Effect.succeed(true);

    if (status === 1 && timedOut) return Effect.succeed(false);

    return Effect.fail(new HeavyLockFailure({ message: `flock exited with ${status ?? signal}.` }));
  });

const flock = (descriptor: number, mode: HeavyLockMode, timeoutSeconds?: number) =>
  flockDescriptor({
    descriptor,
    arguments: [
      `--${mode}`,
      ...(timeoutSeconds === undefined ? [] : ["--timeout", String(timeoutSeconds)]),
    ],
    timedOut: timeoutSeconds !== undefined,
  });

/** Whether this process runs inside a job whose holder of the heavy lock is alive. */
export const insideHeavyLock: Effect.Effect<boolean, HeavyLockFailure> = Effect.map(
  Effect.mapError(Config.withDefault(Config.String(heavyLockVariable), ""), failure),
  (value) => {
    const holder = Number(value);

    return Number.isInteger(holder) && holder > 0 && alive(holder);
  },
);

/** `${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet`, where an empty XDG_RUNTIME_DIR counts as unset. */
export const lockDirectory: Effect.Effect<string, HeavyLockFailure, Path.Path> = Effect.gen(
  function* () {
    const path = yield* Path.Path;

    const runtime = yield* Effect.mapError(
      Config.withDefault(Config.String("XDG_RUNTIME_DIR"), ""),
      failure,
    );

    return path.join(runtime === "" ? "/tmp" : runtime, "vektorprogrammet");
  },
);

/** Opens a lock file for appending; the descriptor stays open until the scope closes. */
const openLockFile = (path: string): Effect.Effect<number, HeavyLockFailure, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => openSync(path, "a"),
      catch: (error) => new HeavyLockFailure({ message: String(error) }),
    }),
    (descriptor) => Effect.sync(() => closeSync(descriptor)),
  );

/** Replaces the content of a lock file that is open for appending. */
const replaceLockText = (descriptor: number, content: string): Effect.Effect<void, HeavyLockFailure> =>
  Effect.try({
    try: () => {
      ftruncateSync(descriptor, 0);
      writeSync(descriptor, content);
    },
    catch: (error) => new HeavyLockFailure({ message: String(error) }),
  });

const noVariables: Readonly<Record<string, string>> = {};

/** What `takeHeavyLock` takes the lock for. */
export interface HeavyLockRequest {
  readonly mode: HeavyLockMode;
  readonly jobClass: string;
  readonly command: ReadonlyArray<string>;
  readonly log: (message: string) => Effect.Effect<void>;
}

/**
 * Takes the heavy lock for this process, unless the process runs inside a job that holds it.
 * Shows the holders while it waits. Succeeds with the variables that the job's processes add to
 * their environment. The lock files stay open, and the lock held, until the scope closes.
 */
export const takeHeavyLock = ({
  mode,
  jobClass,
  command,
  log,
}: HeavyLockRequest): Effect.Effect<
  Readonly<Record<string, string>>,
  HeavyLockFailure,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    if (yield* insideHeavyLock) return noVariables;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const directory = yield* lockDirectory;
    const lockPath = path.join(directory, "heavy.lock");
    const gatePath = path.join(directory, "heavy-gate.lock");
    const waitStart = yield* Clock.currentTimeNanos;
    let waited = false;

    const holderLine = Effect.map(
      localNow,
      ({ date, time }) =>
        `pid ${process.pid}, ${jobClass}, since ${date} ${time}, ${process.cwd()}: ${command.join(" ")}`,
    );

    const readLockText = (file: string) => Effect.mapError(fileSystem.readFileString(file), failure);

    yield* Effect.mapError(fileSystem.makeDirectory(directory, { recursive: true }), failure);

    // A shared holder closes the gate as soon as it holds the lock, so the gate has its own scope.
    const gateScope = yield* Scope.fork(scope);
    const gate = yield* Scope.provide(openLockFile(gatePath), gateScope);
    const lock = yield* openLockFile(lockPath);

    // A shared holder passes the gate in milliseconds, and an exclusive holder writes the gate
    // file as soon as it takes the gate. A wait of more than a second is a wait for that heavy job.
    if (!(yield* flock(gate, "exclusive", 1))) {
      const heavyJob = (yield* readLockText(gatePath)).trim();

      yield* log(
        `waiting for the heavy job ${liveHolder(heavyJob) ? heavyJob : "of an unknown holder"}`,
      );
      waited = true;
      yield* flock(gate, "exclusive");
    }

    if (mode === "exclusive") {
      yield* replaceLockText(gate, `${yield* holderLine}\n`);

      if (!(yield* flock(lock, "exclusive", 0))) {
        const hookJobs = (yield* readLockText(lockPath)).split("\n").filter(liveHolder);

        yield* log(
          `waiting for ${hookJobs.length} running hook job${hookJobs.length === 1 ? "" : "s"}:` +
            hookJobs.map((hookJob) => `\n  ${hookJob}`).join(""),
        );
        waited = true;
        yield* flock(lock, "exclusive");
      }

      yield* replaceLockText(lock, `${yield* holderLine}\n`);
    } else {
      // No exclusive holder can hold the lock while this process holds the gate.
      yield* flock(lock, "shared");

      const hookJobs = (yield* readLockText(lockPath)).split("\n").filter(liveHolder);

      yield* replaceLockText(lock, `${[...hookJobs, yield* holderLine].join("\n")}\n`);
      yield* Scope.close(gateScope, Exit.void);
    }

    if (waited) yield* log(`got the heavy lock after ${yield* secondsSince(waitStart)}s`);

    return { [heavyLockVariable]: String(process.pid) };
  });

/** What `takeHookSlot` takes a slot for. */
export interface HookSlotRequest {
  readonly jobClass: string;
  readonly log: (message: string) => Effect.Effect<void>;
}

/**
 * Takes one of the N machine-wide hook slots for this process, a flock(1) lock on
 *   ${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/hook-slot-<1..N>
 * N is ${VEKTORPROGRAMMET_HOOK_SLOTS:-5}. If all slots are busy, it shows their holders and waits
 * for one. Like the heavy lock, the slot is held until the scope closes, and released when this
 * process exits, also on a signal. Take the heavy lock first: a job that waits for a heavy job
 * then holds no slot, so hook jobs inside that heavy job, such as the hooks of its commits, still
 * get one.
 */
export const takeHookSlot = ({
  jobClass,
  log,
}: HookSlotRequest): Effect.Effect<
  { readonly slot: number; readonly slotCount: number },
  HeavyLockFailure,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    // slots = min(memory bound 23.5 GiB / 3.2 GiB = 7, CPU bound 32 / 6 = 5) on
    // the development machine. AGENTS.md shows how to derive it for another one.
    const configured = yield* Effect.mapError(
      Config.withDefault(Config.String("VEKTORPROGRAMMET_HOOK_SLOTS"), ""),
      failure,
    );

    const slotCount = Number(configured === "" ? "5" : configured);

    if (!Number.isInteger(slotCount) || slotCount < 1)
      return yield* new HeavyLockFailure({
        message: "VEKTORPROGRAMMET_HOOK_SLOTS must be a positive integer.",
      });

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Scope.Scope;
    const directory = yield* lockDirectory;

    yield* Effect.mapError(fileSystem.makeDirectory(directory, { recursive: true }), failure);

    const slotPath = (slot: number) => path.join(directory, `hook-slot-${slot}`);

    // flock(1) locks the open file description of its standard input. This process keeps the
    // descriptor open and passes it to no child, so the lock lasts as long as the scope.
    const acquire = Effect.fnUntraced(function* (slot: number, wait: boolean) {
      const slotScope = yield* Scope.fork(scope);

      const file = yield* Scope.provide(openLockFile(slotPath(slot)), slotScope);

      const taken = yield* flockDescriptor({
        descriptor: file,
        arguments: wait ? [] : ["--nonblock"],
        timedOut: !wait,
      }).pipe(
        Effect.mapError(
          ({ message }) =>
            new HeavyLockFailure({ message: `${message.replace(/\.$/u, "")} on ${slotPath(slot)}.` }),
        ),
        Effect.onError(() => Scope.close(slotScope, Exit.void)),
      );

      if (taken) return file;

      yield* Scope.close(slotScope, Exit.void);

      return undefined;
    });

    let slot = 1;

    let file = yield* acquire(slot, false);

    while (file === undefined && slot < slotCount) {
      slot += 1;
      file = yield* acquire(slot, false);
    }

    const waitStart = yield* Clock.currentTimeNanos;

    if (file === undefined) {
      // Waiters spread over the slots. Each one waits for one holder to finish.
      slot = (process.pid % slotCount) + 1;

      const holders = yield* Effect.forEach(
        Array.from({ length: slotCount }, (_, index) => index + 1),
        (index) =>
          Effect.map(
            Effect.mapError(fileSystem.readFileString(slotPath(index)), failure),
            (holder) => `\n  slot ${index}: ${holder.trim() === "" ? "unknown holder" : holder.trim()}`,
          ),
      );

      yield* log(`waiting for a hook slot; ${slotCount} of ${slotCount} are busy:${holders.join("")}`);

      file = yield* acquire(slot, true);
    }

    if (file === undefined)
      return yield* new HeavyLockFailure({ message: `flock gave no hook slot ${slot}.` });

    const { time } = yield* localNow;

    yield* replaceLockText(file, `pid ${process.pid}, ${jobClass}, since ${time}, ${process.cwd()}\n`);

    yield* log(`got hook slot ${slot} of ${slotCount} after ${yield* secondsSince(waitStart)}s`);

    return { slot, slotCount };
  });
