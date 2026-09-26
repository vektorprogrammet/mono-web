import { spawn, spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { heavyLockVariable, takeHeavyLock } from "./heavy-lock.js";

const usage = `Usage:
  just hook-slot --class <job-class> -- <command...>

Runs the command through measure-job while this process holds the machine-wide
heavy lock shared and one of N machine-wide hook slots. The heavy lock is
  \${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/heavy.lock
While a heavy job holds it or waits for it (\`just measure\`), the command waits
and the holder is shown. Inside a job that holds the lock (${heavyLockVariable}
names a live holder), the command does not take it again. A slot is a flock(1)
lock on
  \${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/hook-slot-<1..N>
N is \${VEKTORPROGRAMMET_HOOK_SLOTS:-5}. If all slots are busy, the command
waits for one. The locks are released when this process exits, also on a signal.
The command runs with CPU affinity to 1/N of the allowed CPUs.
`;

// A function declaration lets calls narrow control flow as `never`.
function fail(message: string): never {
  process.stderr.write(`hook-slot: ${message}\n`);
  process.exit(2);
}

const clock = () => new Date().toTimeString().slice(0, 8);

const log = (message: string) => process.stderr.write(`hook-slot: ${clock()} ${message}\n`);

const argv = process.argv.slice(2);

const separator = argv.indexOf("--");

const options = separator === -1 ? argv : argv.slice(0, separator);

const command = separator === -1 ? [] : argv.slice(separator + 1);

let jobClass: string | undefined;

for (let index = 0; index < options.length; index += 1) {
  const option = options[index];

  if (option === "--help" || option === "-h") {
    process.stdout.write(usage);
    process.exit(0);
  } else if (option === "--class") jobClass = options[++index] ?? fail("--class needs a value.");
  else fail(`Unknown argument ${option}. Use --help.`);
}

if (jobClass === undefined) fail("Pass --class <job-class>. Use --help.");

if (command.length === 0) fail("Pass the command after --.");

// slots = min(memory bound 23.5 GiB / 2.4 GiB = 9, CPU bound 32 / 6 = 5) on
// the development machine. AGENTS.md shows how to derive it for another one.
const slotCount = Number(process.env.VEKTORPROGRAMMET_HOOK_SLOTS || "5");

if (!Number.isInteger(slotCount) || slotCount < 1)
  fail("VEKTORPROGRAMMET_HOOK_SLOTS must be a positive integer.");

// The heavy lock comes before the slot: a hook job that waits for a heavy job holds no slot, so
// hook jobs inside that heavy job, such as the hooks of its commits, still get one.
let jobEnv: NodeJS.ProcessEnv;

try {
  jobEnv = takeHeavyLock("shared", jobClass, command, log);
} catch (error) {
  fail(`The heavy lock failed: ${error instanceof Error ? error.message : String(error)}`);
}

const slotDirectory = join(process.env.XDG_RUNTIME_DIR || "/tmp", "vektorprogrammet");

mkdirSync(slotDirectory, { recursive: true });

const slotPath = (slot: number) => join(slotDirectory, `hook-slot-${slot}`);

// flock(1) locks the open file description of its standard input. This
// process keeps the descriptor open and does not pass it to the command, so
// the lock lasts exactly as long as this process.
const acquire = (slot: number, wait: boolean) => {
  const descriptor = openSync(slotPath(slot), "a");

  const { status } = spawnSync("flock", [...(wait ? [] : ["--nonblock"]), "0"], {
    stdio: [descriptor, "inherit", "inherit"],
  });

  if (status === 0) return descriptor;

  closeSync(descriptor);

  return status === 1 ? undefined : fail(`flock exited with ${status} on ${slotPath(slot)}.`);
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

  descriptor = acquire(slot, true) ?? fail(`flock could not wait for ${slotPath(slot)}.`);
}

ftruncateSync(descriptor, 0);

writeSync(descriptor, `pid ${process.pid}, ${jobClass}, since ${clock()}, ${process.cwd()}\n`);

// Each slot runs its job on an equal share of the allowed CPUs. Tools that
// size worker pools from the CPU count, such as Vitest, then start fewer
// workers. Explicit settings, such as `--no-file-parallelism`, still apply.
const allowedCpus = (
  /^Cpus_allowed_list:\s*(\S+)$/m.exec(readFileSync("/proc/self/status", "latin1"))?.[1] ??
  fail("/proc/self/status has no Cpus_allowed_list.")
)
  .split(",")
  .flatMap((range) => {
    const [first = 0, last = first] = range.split("-").map(Number);

    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });

const cpusPerSlot = Math.max(1, Math.floor(allowedCpus.length / slotCount));

const slotCpus = Array.from(
  { length: cpusPerSlot },
  (_, index) => allowedCpus[((slot - 1) * cpusPerSlot + index) % allowedCpus.length],
);

log(
  `got hook slot ${slot} of ${slotCount} after ${Math.round((performance.now() - waitStart) / 1000)}s; ` +
    `the job uses ${cpusPerSlot} of ${allowedCpus.length} CPUs`,
);

const child = spawn(
  "taskset",
  [
    "--cpu-list",
    slotCpus.join(","),
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "measure-job.ts"),
    "--class",
    jobClass,
    "--",
    ...command,
  ],
  { stdio: "inherit", env: jobEnv },
);

const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
  (signal) => [signal, () => child.kill(signal)] as const,
);

for (const [signal, handler] of signalHandlers) process.on(signal, handler);

child.once("error", (error) => fail(`taskset could not start: ${error.message}`));

child.once("exit", (exitCode, signal) => {
  for (const [name, handler] of signalHandlers) process.off(name, handler);

  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(exitCode ?? 1);
});
