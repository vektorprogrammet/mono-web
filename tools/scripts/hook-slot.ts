import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Console, Data, Effect, FileSystem, Path } from "effect";
import { heavyLockVariable, localNow, takeHeavyLock, takeHookSlot } from "./heavy-lock.js";
import { jobDisposition, runJob } from "./job-process.js";

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

/** A usage error or a failed step; the program prints it and exits 2. */
class HookSlotFailure extends Data.TaggedError("HookSlotFailure")<{ readonly message: string }> {}

const fail = (message: string) => Effect.fail(new HookSlotFailure({ message }));

const log = (message: string) =>
  Effect.flatMap(localNow, ({ time }) => Console.error(`hook-slot: ${time} ${message}`));

const disposition = jobDisposition();

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let jobClass: string | undefined;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--help" || option === "-h") {
      yield* Console.log(usage.trimEnd());

      return 0;
    } else if (option === "--class") {
      index += 1;
      jobClass = options[index] ?? (yield* fail("--class needs a value."));
    } else return yield* fail(`Unknown argument ${option}. Use --help.`);
  }

  if (jobClass === undefined) return yield* fail("Pass --class <job-class>. Use --help.");

  if (command.length === 0) return yield* fail("Pass the command after --.");

  const slotClass = jobClass;

  // The heavy lock comes before the slot: a hook job that waits for a heavy job holds no slot, so
  // hook jobs inside that heavy job, such as the hooks of its commits, still get one.
  const { variables, slot, slotCount } = yield* Effect.gen(function* () {
    const taken = yield* takeHeavyLock({ mode: "shared", jobClass: slotClass, command, log });
    const held = yield* takeHookSlot({ jobClass: slotClass, log });

    return { variables: taken, ...held };
  }).pipe(
    Effect.catchTag("HeavyLockFailure", ({ message }) => fail(`The locks failed: ${message}`)),
  );

  // Each slot runs its job on an equal share of the allowed CPUs. Tools that size worker pools
  // from the CPU count, such as Oxfmt, Oxlint, and Vitest (vitest.shared.ts), then start fewer
  // workers. Explicit settings, such as `--no-file-parallelism`, still apply.
  const cpuList = /^Cpus_allowed_list:\s*(\S+)$/m.exec(
    yield* Effect.orDie(fileSystem.readFileString("/proc/self/status", "latin1")),
  )?.[1];

  if (cpuList === undefined) return yield* fail("/proc/self/status has no Cpus_allowed_list.");

  const allowedCpus = cpuList.split(",").flatMap((range) => {
    const [first = 0, last = first] = range.split("-").map(Number);

    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });

  const cpusPerSlot = Math.max(1, Math.floor(allowedCpus.length / slotCount));

  const slotCpus = Array.from(
    { length: cpusPerSlot },
    (_, index) => allowedCpus[((slot - 1) * cpusPerSlot + index) % allowedCpus.length],
  );

  yield* log(`the job uses ${cpusPerSlot} of ${allowedCpus.length} CPUs`);

  // From the start of the job to its end, a signal goes to the job and does not stop this program.
  const jobExit = yield* Effect.uninterruptible(
    runJob({
    command: "taskset",
    arguments: [
      "--cpu-list",
      slotCpus.join(","),
      process.execPath,
      "--no-env-file",
      path.join(import.meta.dir, "measure-job.ts"),
      "--class",
      slotClass,
      "--",
      ...command,
    ],
    variables,
    forwardedSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
  }).pipe(
    Effect.catchTag("JobStartFailure", ({ message }) => fail(`taskset could not start: ${message}`)),
    Effect.tap(disposition.record),
  ));

  return jobExit.exitCode ?? 1;
}).pipe(
  Effect.catchTag("HookSlotFailure", ({ message }) =>
    Console.error(`hook-slot: ${message}`).pipe(Effect.as(2)),
  ),
);

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)), {
  teardown: disposition.teardown,
});
