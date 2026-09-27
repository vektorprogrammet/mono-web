import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heavyLockVariable, takeHeavyLock, takeHookSlot } from "./heavy-lock.js";

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

// The heavy lock comes before the slot: a hook job that waits for a heavy job holds no slot, so
// hook jobs inside that heavy job, such as the hooks of its commits, still get one.
let jobEnv: NodeJS.ProcessEnv;

let slot: number;

let slotCount: number;

try {
  jobEnv = takeHeavyLock("shared", jobClass, command, log);
  ({ slot, slotCount } = takeHookSlot(jobClass, log));
} catch (error) {
  fail(`The locks failed: ${error instanceof Error ? error.message : String(error)}`);
}

// Each slot runs its job on an equal share of the allowed CPUs. Tools that size worker pools
// from the CPU count, such as Oxfmt, Oxlint, and Vitest (vitest.shared.ts), then start fewer
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

log(`the job uses ${cpusPerSlot} of ${allowedCpus.length} CPUs`);

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
