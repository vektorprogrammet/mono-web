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
 * standard input; this process keeps the descriptors open and does not pass them to its job, so
 * the lock is released when this process exits, also on a signal. The job's processes inherit
 * `VEKTORPROGRAMMET_HEAVY_LOCK`, the holder's process id. A `just measure` or hook slot started
 * inside the job, such as the hooks of a commit, finds the live holder and does not take the lock
 * again, which would wait for itself.
 */
import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type HeavyLockMode = "exclusive" | "shared";

/** Names the process that holds the heavy lock for the job's processes. */
export const heavyLockVariable = "VEKTORPROGRAMMET_HEAVY_LOCK";

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

// Waits at most `timeoutSeconds` (0: tries once), or without a limit when it is undefined.
// Returns false when the time ran out.
const flock = (descriptor: number, mode: HeavyLockMode, timeoutSeconds?: number) => {
  const { status, signal } = spawnSync(
    "flock",
    [`--${mode}`, ...(timeoutSeconds === undefined ? [] : ["--timeout", String(timeoutSeconds)]), "0"],
    { stdio: [descriptor, "inherit", "inherit"] },
  );

  if (status === 0) return true;

  if (status === 1 && timeoutSeconds !== undefined) return false;

  throw new Error(`flock exited with ${status ?? signal}.`);
};

/** Whether this process runs inside a job whose holder of the heavy lock is alive. */
export const insideHeavyLock = () => {
  const holder = Number(process.env[heavyLockVariable]);

  return Number.isInteger(holder) && holder > 0 && alive(holder);
};

const lockDirectory = () => join(process.env.XDG_RUNTIME_DIR || "/tmp", "vektorprogrammet");

/**
 * Takes the heavy lock for this process, unless the process runs inside a job that holds it.
 * Shows the holders while it waits. Returns the environment for the job's processes.
 */
export const takeHeavyLock = (
  mode: HeavyLockMode,
  jobClass: string,
  command: ReadonlyArray<string>,
  log: (message: string) => void,
): NodeJS.ProcessEnv => {
  if (insideHeavyLock()) return process.env;

  const directory = lockDirectory();
  const lockPath = join(directory, "heavy.lock");
  const gatePath = join(directory, "heavy-gate.lock");
  const waitStart = performance.now();
  let waited = false;

  const holderLine = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    return `pid ${process.pid}, ${jobClass}, since ${date} ${now.toTimeString().slice(0, 8)}, ${process.cwd()}: ${command.join(" ")}`;
  };

  mkdirSync(directory, { recursive: true });

  const gate = openSync(gatePath, "a");
  const lock = openSync(lockPath, "a");

  // A shared holder passes the gate in milliseconds, and an exclusive holder writes the gate file
  // as soon as it takes the gate. A wait of more than a second is a wait for that heavy job.
  if (!flock(gate, "exclusive", 1)) {
    const heavyJob = readFileSync(gatePath, "utf8").trim();

    log(`waiting for the heavy job ${liveHolder(heavyJob) ? heavyJob : "of an unknown holder"}`);
    waited = true;
    flock(gate, "exclusive");
  }

  if (mode === "exclusive") {
    ftruncateSync(gate, 0);
    writeSync(gate, `${holderLine()}\n`);

    if (!flock(lock, "exclusive", 0)) {
      const hookJobs = readFileSync(lockPath, "utf8").split("\n").filter(liveHolder);

      log(
        `waiting for ${hookJobs.length} running hook job${hookJobs.length === 1 ? "" : "s"}:` +
          hookJobs.map((hookJob) => `\n  ${hookJob}`).join(""),
      );
      waited = true;
      flock(lock, "exclusive");
    }

    ftruncateSync(lock, 0);
    writeSync(lock, `${holderLine()}\n`);
  } else {
    // No exclusive holder can hold the lock while this process holds the gate.
    flock(lock, "shared");

    const hookJobs = readFileSync(lockPath, "utf8").split("\n").filter(liveHolder);

    ftruncateSync(lock, 0);
    writeSync(lock, `${[...hookJobs, holderLine()].join("\n")}\n`);
    closeSync(gate);
  }

  if (waited)
    log(`got the heavy lock after ${Math.round((performance.now() - waitStart) / 1000)}s`);

  return { ...process.env, [heavyLockVariable]: String(process.pid) };
};

/**
 * Takes one of the N machine-wide hook slots for this process, a flock(1) lock on
 *   ${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/hook-slot-<1..N>
 * N is ${VEKTORPROGRAMMET_HOOK_SLOTS:-5}. If all slots are busy, it shows their holders and waits
 * for one. Like the heavy lock, the slot is released when this process exits, also on a signal.
 * Take the heavy lock first: a job that waits for a heavy job then holds no slot, so hook jobs
 * inside that heavy job, such as the hooks of its commits, still get one.
 */
export const takeHookSlot = (jobClass: string, log: (message: string) => void) => {
  // slots = min(memory bound 23.5 GiB / 3.2 GiB = 7, CPU bound 32 / 6 = 5) on
  // the development machine. AGENTS.md shows how to derive it for another one.
  const slotCount = Number(process.env.VEKTORPROGRAMMET_HOOK_SLOTS || "5");

  if (!Number.isInteger(slotCount) || slotCount < 1)
    throw new Error("VEKTORPROGRAMMET_HOOK_SLOTS must be a positive integer.");

  const directory = lockDirectory();

  mkdirSync(directory, { recursive: true });

  const slotPath = (slot: number) => join(directory, `hook-slot-${slot}`);

  // flock(1) locks the open file description of its standard input. This process keeps the
  // descriptor open and passes it to no child, so the lock lasts exactly as long as this process.
  const acquire = (slot: number, wait: boolean) => {
    const descriptor = openSync(slotPath(slot), "a");

    const { status, signal } = spawnSync("flock", [...(wait ? [] : ["--nonblock"]), "0"], {
      stdio: [descriptor, "inherit", "inherit"],
    });

    if (status === 0) return descriptor;

    closeSync(descriptor);

    if (status === 1 && !wait) return undefined;

    throw new Error(`flock exited with ${status ?? signal} on ${slotPath(slot)}.`);
  };

  let slot = 1;

  let descriptor = acquire(slot, false);

  while (descriptor === undefined && slot < slotCount) descriptor = acquire(++slot, false);

  const waitStart = performance.now();

  if (descriptor === undefined) {
    // Waiters spread over the slots. Each one waits for one holder to finish.
    slot = (process.pid % slotCount) + 1;

    const holders = Array.from(
      { length: slotCount },
      (_, index) =>
        `\n  slot ${index + 1}: ${readFileSync(slotPath(index + 1), "utf8").trim() || "unknown holder"}`,
    );

    log(`waiting for a hook slot; ${slotCount} of ${slotCount} are busy:${holders.join("")}`);

    descriptor = acquire(slot, true);
  }

  ftruncateSync(descriptor, 0);

  writeSync(
    descriptor,
    `pid ${process.pid}, ${jobClass}, since ${new Date().toTimeString().slice(0, 8)}, ${process.cwd()}\n`,
  );

  log(
    `got hook slot ${slot} of ${slotCount} after ${Math.round((performance.now() - waitStart) / 1000)}s`,
  );

  return { slot, slotCount };
};
