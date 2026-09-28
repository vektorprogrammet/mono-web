import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { availableParallelism, homedir, hostname } from "node:os";
import process from "node:process";
import {
  Clock,
  Config,
  Console,
  Data,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { runCommand } from "./command.js";
import { heavyLockVariable, takeHeavyLock } from "./heavy-lock.js";
import { jobDisposition, runJob } from "./job-process.js";

const usage = `Usage:
  just measure --class <job-class> [--ledger <path>] -- <command...>
  just measure --report [--ledger <path>]

Takes the machine-wide heavy lock exclusively, then runs the command and samples
its process tree every ${500} ms through /proc. The lock is
  \${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/heavy.lock
While another heavy job or a hook job holds it, the command waits and the
holders are shown. Hook slots hold it shared. A command inside a job that holds
the lock (${heavyLockVariable} names a live holder) does not take it again.
Appends one JSON line per run to the machine-local ledger:
  \${XDG_STATE_HOME:-~/.local/state}/vektorprogrammet/job-ledger.jsonl
The ledger is runtime evidence. Do not commit it.
`;

/** A usage error or a failed step; the program prints it and exits 2. */
class MeasureFailure extends Data.TaggedError("MeasureFailure")<{ readonly message: string }> {}

const fail = (message: string) => Effect.fail(new MeasureFailure({ message }));

const sampleIntervalMs = 500;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const JobClass = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

const LedgerRow = Schema.Struct({
  version: Schema.Literal(1),
  class: JobClass,
  command: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.String,
  revision: Schema.NullOr(Schema.String),
  dirty: Schema.NullOr(Schema.Boolean),
  host: Schema.String,
  startedAt: Schema.String,
  wallMs: Count,
  exitCode: Schema.NullOr(Count),
  signal: Schema.NullOr(Schema.String),
  samples: Count,
  sampleIntervalMs: Count,
  logicalCpus: Count,
  memTotalBytes: Count,
  peakRssBytes: Count,
  p95RssBytes: Count,
  peakCores: Amount,
  meanCores: Amount,
  peakProcesses: Count,
  survivingProcesses: Count,
  memAvailableStartBytes: Count,
  minMemAvailableBytes: Count,
  swapDeltaBytes: Schema.Int,
  swapPeakIncreaseBytes: Count,
  load1Start: Amount,
  load1Peak: Amount,
});

type LedgerRow = typeof LedgerRow.Type;

const LedgerLine = Schema.fromJsonString(LedgerRow);

const encodeLine = Schema.encodeSync(LedgerLine);

const decodeLine = Schema.decodeUnknownOption(LedgerLine);

type ProcessStat = {
  readonly parent: number;
  readonly start: string;
  // Own and reaped-descendant CPU time in clock ticks.
  readonly cpuTicks: number;
  readonly selfTicks: number;
  readonly childTicks: number;
  readonly rssPages: number;
};

const parseStat = (text: string): ProcessStat => {
  // Fields after the parenthesized command name start at field 3 (state).
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const field = (number: number) => Number(fields[number - 3]);
  const selfTicks = field(14) + field(15);
  const childTicks = field(16) + field(17);

  return {
    parent: field(4),
    start: fields[22 - 3] ?? "",
    cpuTicks: selfTicks + childTicks,
    selfTicks,
    childTicks,
    rssPages: field(24),
  };
};

// Report

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

const duration = (milliseconds: number) => {
  const seconds = Math.round(milliseconds / 1000);

  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const disposition = jobDisposition();

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Arguments

  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let jobClass: string | undefined;

  // An empty XDG_STATE_HOME counts as unset.
  const stateHome = yield* Config.withDefault(Config.String("XDG_STATE_HOME"), "");

  let ledgerPath = path.join(
    stateHome === "" ? path.join(homedir(), ".local", "state") : stateHome,
    "vektorprogrammet",
    "job-ledger.jsonl",
  );

  let report = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--help" || option === "-h") {
      yield* Console.log(usage.trimEnd());

      return 0;
    } else if (option === "--report") report = true;
    else if (option === "--class") {
      index += 1;
      jobClass = options[index] ?? (yield* fail("--class needs a value."));
    } else if (option === "--ledger") {
      index += 1;
      ledgerPath = options[index] ?? (yield* fail("--ledger needs a value."));
    } else return yield* fail(`Unknown argument ${option}. Use --help.`);
  }

  if (!(yield* Effect.orElseSucceed(fileSystem.exists("/proc/self/stat"), () => false)))
    return yield* fail("Linux /proc is required.");

  const getconf = Effect.fnUntraced(function* (name: string) {
    const result = yield* Effect.option(runCommand(ChildProcess.make("getconf", [name])));
    const value = Option.isSome(result) ? Number(result.value.stdout.trim()) : Number.NaN;

    return Number.isInteger(value) && value > 0 ? value : yield* fail(`getconf ${name} failed.`);
  });

  const clockTicks = yield* getconf("CLK_TCK");
  const pageSize = yield* getconf("PAGESIZE");
  const logicalCpus = availableParallelism();

  // System and process readings

  const readProc = (file: string) => fileSystem.readFileString(file, "latin1");

  const readMeminfo = Effect.gen(function* () {
    const fields = new Map<string, number>();

    for (const line of (yield* Effect.orDie(readProc("/proc/meminfo"))).split("\n")) {
      const match = /^(\w+):\s+(\d+) kB$/.exec(line);

      if (match?.[1] !== undefined && match[2] !== undefined)
        fields.set(match[1], Number(match[2]) * 1024);
    }

    const field = (name: string) => {
      const value = fields.get(name);

      return value === undefined ? fail(`/proc/meminfo has no ${name}.`) : Effect.succeed(value);
    };

    return {
      total: yield* field("MemTotal"),
      available: yield* field("MemAvailable"),
      swapUsed: (yield* field("SwapTotal")) - (yield* field("SwapFree")),
    };
  });

  const readLoad1 = Effect.map(Effect.orDie(readProc("/proc/loadavg")), (text) =>
    Number(text.split(" ")[0]),
  );

  const readStat = (pid: number | "self") =>
    Effect.map(Effect.option(readProc(`/proc/${pid}/stat`)), Option.map(parseStat));

  const readProcesses = Effect.gen(function* () {
    const pids = (yield* Effect.orDie(fileSystem.readDirectory("/proc")))
      .map(Number)
      .filter(Number.isInteger)
      // Parents usually have lower pids. Reading them first means a child reaped
      // during the scan is missed once rather than counted twice.
      .sort((left, right) => left - right);

    const processes = new Map<number, ProcessStat>();

    for (const pid of pids) {
      const stat = yield* readStat(pid);

      if (Option.isSome(stat)) processes.set(pid, stat.value);
    }

    return processes;
  });

  // The tree is every descendant of this process. Known members stay tracked
  // after they are reparented, identified by pid and start time.
  let tracked = new Map<number, string>();

  const sampleTree = Effect.gen(function* () {
    const processes = yield* readProcesses;
    const children = new Map<number, Array<number>>();

    for (const [pid, stat] of processes) {
      const siblings = children.get(stat.parent);

      if (siblings === undefined) children.set(stat.parent, [pid]);
      else siblings.push(pid);
    }

    const pending = [...(children.get(process.pid) ?? [])];

    for (const [pid, start] of tracked) {
      if (processes.get(pid)?.start === start) pending.push(pid);
    }

    const members = new Map<number, string>();
    let rssBytes = 0;
    let cpuTicks = 0;

    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      const stat = processes.get(pid);

      if (stat === undefined || members.has(pid)) continue;
      members.set(pid, stat.start);
      rssBytes += stat.rssPages * pageSize;
      cpuTicks += stat.cpuTicks;
      pending.push(...(children.get(pid) ?? []));
    }

    tracked = members;

    return { rssBytes, cpuTicks, processes: members.size };
  });

  const selfChildTicks = Effect.flatMap(readStat("self"), (stat) =>
    Option.isSome(stat) ? Effect.succeed(stat.value.childTicks) : fail("/proc/self/stat is unreadable."),
  );

  const printReport = Effect.gen(function* () {
    const rows: Array<LedgerRow> = [];
    const invalid: Array<number> = [];

    if (yield* Effect.orElseSucceed(fileSystem.exists(ledgerPath), () => false)) {
      (yield* Effect.orDie(fileSystem.readFileString(ledgerPath)))
        .split("\n")
        .forEach((line, index) => {
          if (line.trim() === "") return;
          const row = decodeLine(line);

          if (Option.isSome(row)) rows.push(row.value);
          else invalid.push(index + 1);
        });
    }

    const memory = yield* readMeminfo;
    const load1 = yield* readLoad1;

    yield* Console.log(
      `Ledger: ${ledgerPath}\n` +
        `Now: MemAvailable ${gib(memory.available)} of ${gib(memory.total)}, swap used ${gib(memory.swapUsed)}, ` +
        `load1 ${load1.toFixed(2)}, logical CPUs ${logicalCpus}\n`,
    );

    const classes = new Map<string, Array<LedgerRow>>();

    for (const row of rows) {
      const runs = classes.get(row.class);

      if (runs === undefined) classes.set(row.class, [row]);
      else runs.push(row);
    }

    const table = [
      [
        "class",
        "runs",
        "failed",
        "median wall",
        "max wall",
        "max peak RSS",
        "max peak cores",
        "max mean cores",
      ],
    ];

    for (const [name, runs] of [...classes].sort(([left], [right]) => left.localeCompare(right))) {
      table.push([
        name,
        String(runs.length),
        String(runs.filter((run) => run.exitCode !== 0).length),
        duration(median(runs.map((run) => run.wallMs))),
        duration(Math.max(...runs.map((run) => run.wallMs))),
        gib(Math.max(...runs.map((run) => run.peakRssBytes))),
        Math.max(...runs.map((run) => run.peakCores)).toFixed(1),
        Math.max(...runs.map((run) => run.meanCores)).toFixed(1),
      ]);
    }

    const widths = table[0]!.map((_, column) =>
      Math.max(...table.map((cells) => cells[column]!.length)),
    );

    for (const cells of table) {
      yield* Console.log(
        cells
          .map((cell, column) =>
            column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
          )
          .join("  "),
      );
    }

    if (rows.length === 0) yield* Console.log("(no measured runs)");

    if (invalid.length > 0)
      yield* Console.error(`measure-job: ignored invalid ledger lines ${invalid.join(", ")}`);
  });

  if (report) {
    if (jobClass !== undefined || command.length > 0)
      return yield* fail("--report takes no class or command.");

    yield* printReport;

    return 0;
  }

  if (jobClass === undefined) return yield* fail("Pass --class <job-class> or --report. Use --help.");

  if (!Schema.is(JobClass)(jobClass))
    return yield* fail("The job class must be lowercase words joined by hyphens.");

  const [jobProgram, ...programArguments] = command;

  if (jobProgram === undefined) return yield* fail("Pass the command after --.");

  const measuredClass = jobClass;

  // The lock is taken before the readings, so the ledger measures the job, not the wait.
  const variables = yield* takeHeavyLock({
    mode: "exclusive",
    jobClass: measuredClass,
    command,
    log: (message) => Console.error(`measure-job: ${message}`),
  }).pipe(
    Effect.catchTag("HeavyLockFailure", ({ message }) => fail(`The heavy lock failed: ${message}`)),
  );

  // Measurement

  const git = Effect.fnUntraced(function* (...gitArguments: Array<string>) {
    const result = yield* Effect.option(runCommand(ChildProcess.make("git", gitArguments)));

    return Option.isSome(result) && result.value.status === 0 ? result.value.stdout.trim() : null;
  });

  const revision = yield* git("rev-parse", "HEAD");
  const status = yield* git("status", "--porcelain", "--untracked-files=normal");
  const startMemory = yield* readMeminfo;
  const load1Start = yield* readLoad1;

  // Reaped descendants add their CPU time to this process's child ticks.
  const childTicksStart = yield* selfChildTicks;
  const startedAt = yield* DateTime.now;
  const nowMs = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos) / 1e6);
  const startedMs = yield* nowMs;

  const rssSamples: Array<number> = [];
  let peakCores = 0;
  let peakProcesses = 0;
  let minMemAvailable = startMemory.available;
  let peakSwapUsed = startMemory.swapUsed;
  let load1Peak = load1Start;
  let cumulativeTicks = 0;
  let previousMs = startedMs;

  const sample = Effect.fnUntraced(function* (running: boolean) {
    const now = yield* nowMs;
    const tree = yield* sampleTree;
    const memory = yield* readMeminfo;

    // Cumulative tree CPU never decreases. A scan that misses a just-reaped
    // process must not produce a false spike at the next sample.
    const ticks = Math.max(
      cumulativeTicks,
      (yield* selfChildTicks) - childTicksStart + tree.cpuTicks,
    );

    const elapsedMs = now - previousMs;

    if (running || elapsedMs >= sampleIntervalMs / 2) {
      peakCores = Math.max(peakCores, (ticks - cumulativeTicks) / clockTicks / (elapsedMs / 1000));
    }

    cumulativeTicks = ticks;
    previousMs = now;

    if (running) {
      rssSamples.push(tree.rssBytes);
      peakProcesses = Math.max(peakProcesses, tree.processes);
    }

    minMemAvailable = Math.min(minMemAvailable, memory.available);
    peakSwapUsed = Math.max(peakSwapUsed, memory.swapUsed);
    load1Peak = Math.max(load1Peak, yield* readLoad1);

    return { processes: tree.processes, swapUsed: memory.swapUsed };
  });

  // From the start of the job to the ledger row, a signal goes to the job and does not stop this
  // program: the row records how the job ended.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const sampler = yield* Effect.forkChild(
        Effect.interruptible(
          Effect.schedule(sample(true), Schedule.fixed(Duration.millis(sampleIntervalMs))),
        ),
      );

      const jobExit = yield* runJob({
        command: jobProgram,
        arguments: programArguments,
        variables,
        forwardedSignals: ["SIGINT", "SIGTERM"],
      }).pipe(
        Effect.catchTag("JobStartFailure", ({ message }) =>
          Effect.andThen(Fiber.interrupt(sampler), fail(`${jobProgram} could not start: ${message}`)),
        ),
      );

      yield* Fiber.interrupt(sampler);

      const wallMs = (yield* nowMs) - startedMs;
      const final = yield* sample(false);
      const sortedRss = [...rssSamples].sort((left, right) => left - right);

      const row: LedgerRow = {
        version: 1,
        class: measuredClass,
        command: [jobProgram, ...programArguments],
        cwd: process.cwd(),
        revision,
        dirty: status === null ? null : status !== "",
        host: hostname(),
        startedAt: DateTime.formatIso(startedAt),
        wallMs: Math.round(wallMs),
        exitCode: jobExit.exitCode,
        signal: jobExit.signal,
        samples: rssSamples.length,
        sampleIntervalMs,
        logicalCpus,
        memTotalBytes: startMemory.total,
        peakRssBytes: sortedRss.at(-1) ?? 0,
        p95RssBytes: sortedRss[Math.max(0, Math.ceil(sortedRss.length * 0.95) - 1)] ?? 0,
        peakCores: Number(peakCores.toFixed(2)),
        meanCores: Number(
          (((yield* selfChildTicks) - childTicksStart) / clockTicks / (wallMs / 1000)).toFixed(2),
        ),
        peakProcesses,
        survivingProcesses: final.processes,
        memAvailableStartBytes: startMemory.available,
        minMemAvailableBytes: minMemAvailable,
        swapDeltaBytes: final.swapUsed - startMemory.swapUsed,
        swapPeakIncreaseBytes: peakSwapUsed - startMemory.swapUsed,
        load1Start,
        load1Peak,
      };

      yield* Effect.orDie(fileSystem.makeDirectory(path.dirname(ledgerPath), { recursive: true }));
      yield* Effect.orDie(
        fileSystem.writeFileString(ledgerPath, `${encodeLine(row)}\n`, { flag: "a" }),
      );

      yield* Console.error(
        `measure-job: ${measuredClass} ${jobExit.signal ?? `exit ${jobExit.exitCode}`} in ${duration(wallMs)}, ` +
          `peak RSS ${gib(row.peakRssBytes)}, peak cores ${row.peakCores}, mean cores ${row.meanCores}` +
          `${row.survivingProcesses > 0 ? `, ${row.survivingProcesses} processes still running` : ""}`,
      );

      yield* disposition.record(jobExit);

      return jobExit.exitCode ?? 1;
    }),
  );
}).pipe(
  Effect.catchTag("MeasureFailure", ({ message }) =>
    Console.error(`measure-job: ${message}`).pipe(Effect.as(2)),
  ),
);

/** The platform of the scripts, which their tests take too. */
export const ScriptsPlatform = BunServices.layer;

/** The services of `ScriptsPlatform`. */
export type ScriptsPlatform = BunServices.BunServices;

if (import.meta.main)
  BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(ScriptsPlatform)), {
    teardown: disposition.teardown,
  });
