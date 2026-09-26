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
  const holder = Number(process.env[heavyLockVariable]);

  if (Number.isInteger(holder) && holder > 0 && alive(holder)) return process.env;

  const directory = join(process.env.XDG_RUNTIME_DIR || "/tmp", "vektorprogrammet");
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
