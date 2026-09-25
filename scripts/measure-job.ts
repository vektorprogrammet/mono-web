import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { availableParallelism, homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { Option, Schema } from "effect";

const usage = `Usage:
  bun run measure-job --class <job-class> [--ledger <path>] -- <command...>
  bun run measure-job --report [--ledger <path>]

Runs the command and samples its process tree every ${500} ms through /proc.
Appends one JSON line per run to the machine-local ledger:
  \${XDG_STATE_HOME:-~/.local/state}/vektorprogrammet/job-ledger.jsonl
The ledger is runtime evidence. Do not commit it.
`;

// A function declaration lets calls narrow control flow as `never`.
function fail(message: string): never {
  process.stderr.write(`measure-job: ${message}\n`);
  process.exit(2);
}

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

// Arguments

const argv = process.argv.slice(2);

const separator = argv.indexOf("--");

const options = separator === -1 ? argv : argv.slice(0, separator);

const command = separator === -1 ? [] : argv.slice(separator + 1);

let jobClass: string | undefined;

let ledgerPath = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "vektorprogrammet",
  "job-ledger.jsonl",
);

let report = false;

for (let index = 0; index < options.length; index += 1) {
  const option = options[index];

  if (option === "--help" || option === "-h") {
    process.stdout.write(usage);
    process.exit(0);
  } else if (option === "--report") report = true;
  else if (option === "--class") jobClass = options[++index] ?? fail("--class needs a value.");
  else if (option === "--ledger") ledgerPath = options[++index] ?? fail("--ledger needs a value.");
  else fail(`Unknown argument ${option}. Use --help.`);
}

if (!existsSync("/proc/self/stat")) fail("Linux /proc is required.");

const getconf = (name: string): number => {
  const value = Number(spawnSync("getconf", [name], { encoding: "utf8" }).stdout?.trim());

  return Number.isInteger(value) && value > 0 ? value : fail(`getconf ${name} failed.`);
};

const clockTicks = getconf("CLK_TCK");

const pageSize = getconf("PAGESIZE");

const logicalCpus = availableParallelism();

// System and process readings

const readMeminfo = () => {
  const fields = new Map<string, number>();

  for (const line of readFileSync("/proc/meminfo", "latin1").split("\n")) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line);

    if (match?.[1] !== undefined && match[2] !== undefined)
      fields.set(match[1], Number(match[2]) * 1024);
  }

  const field = (name: string) => fields.get(name) ?? fail(`/proc/meminfo has no ${name}.`);

  return {
    total: field("MemTotal"),
    available: field("MemAvailable"),
    swapUsed: field("SwapTotal") - field("SwapFree"),
  };
};

const readLoad1 = () => Number(readFileSync("/proc/loadavg", "latin1").split(" ")[0]);

type ProcessStat = {
  readonly parent: number;
  readonly start: string;
  // Own and reaped-descendant CPU time in clock ticks.
  readonly cpuTicks: number;
  readonly selfTicks: number;
  readonly childTicks: number;
  readonly rssPages: number;
};

const readStat = (pid: number | "self"): ProcessStat | undefined => {
  let text: string;

  try {
    text = readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch {
    return undefined;
  }

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

const readProcesses = () => {
  const pids = readdirSync("/proc")
    .map(Number)
    .filter(Number.isInteger)
    // Parents usually have lower pids. Reading them first means a child reaped
    // during the scan is missed once rather than counted twice.
    .sort((left, right) => left - right);

  const processes = new Map<number, ProcessStat>();

  for (const pid of pids) {
    const stat = readStat(pid);

    if (stat !== undefined) processes.set(pid, stat);
  }

  return processes;
};

// The tree is every descendant of this process. Known members stay tracked
// after they are reparented, identified by pid and start time.
let tracked = new Map<number, string>();

const sampleTree = () => {
  const processes = readProcesses();
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
};

const selfChildTicks = () => readStat("self")?.childTicks ?? fail("/proc/self/stat is unreadable.");

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

const printReport = () => {
  const rows: Array<LedgerRow> = [];
  const invalid: Array<number> = [];

  if (existsSync(ledgerPath)) {
    readFileSync(ledgerPath, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.trim() === "") return;
        const row = decodeLine(line);

        if (Option.isSome(row)) rows.push(row.value);
        else invalid.push(index + 1);
      });
  }

  const memory = readMeminfo();
  const load1 = readLoad1();
  process.stdout.write(
    `Ledger: ${ledgerPath}\n` +
      `Now: MemAvailable ${gib(memory.available)} of ${gib(memory.total)}, swap used ${gib(memory.swapUsed)}, ` +
      `load1 ${load1.toFixed(2)}, logical CPUs ${logicalCpus}\n` +
      `Admit if: MemAvailable - peak RSS >= ${gib(memory.total * 0.2)} and load1 + peak cores <= ${(logicalCpus * 0.8).toFixed(1)}\n\n`,
  );
  const classes = new Map<string, Array<LedgerRow>>();

  for (const row of rows) {
    const runs = classes.get(row.class);

    if (runs === undefined) classes.set(row.class, [row]);
    else runs.push(row);
  }

  const table = [
    ["class", "runs", "failed", "median wall", "max wall", "max peak RSS", "max peak cores"],
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
    ]);
  }

  const widths = table[0]!.map((_, column) =>
    Math.max(...table.map((cells) => cells[column]!.length)),
  );

  for (const cells of table) {
    process.stdout.write(
      `${cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ")}\n`,
    );
  }

  if (rows.length === 0) process.stdout.write("(no measured runs)\n");

  if (invalid.length > 0)
    process.stderr.write(`measure-job: ignored invalid ledger lines ${invalid.join(", ")}\n`);
};

if (report) {
  if (jobClass !== undefined || command.length > 0) fail("--report takes no class or command.");
  printReport();
  process.exit(0);
}

if (jobClass === undefined) fail("Pass --class <job-class> or --report. Use --help.");

if (!Schema.is(JobClass)(jobClass))
  fail("The job class must be lowercase words joined by hyphens.");

const [program, ...programArguments] = command;

if (program === undefined) fail("Pass the command after --.");

// Measurement

const git = (...gitArguments: Array<string>) => {
  const result = spawnSync("git", gitArguments, { encoding: "utf8" });

  return result.status === 0 ? result.stdout.trim() : null;
};

const revision = git("rev-parse", "HEAD");

const status = git("status", "--porcelain", "--untracked-files=normal");

const startMemory = readMeminfo();

const load1Start = readLoad1();

// Reaped descendants add their CPU time to this process's child ticks.
const childTicksStart = selfChildTicks();

const startedAt = new Date();

const startedMs = performance.now();

const child = spawn(program, programArguments, { stdio: "inherit" });

const rssSamples: Array<number> = [];

let peakCores = 0;

let peakProcesses = 0;

let minMemAvailable = startMemory.available;

let peakSwapUsed = startMemory.swapUsed;

let load1Peak = load1Start;

let cumulativeTicks = 0;

let previousMs = startedMs;

const sample = (running: boolean) => {
  const now = performance.now();
  const tree = sampleTree();
  const memory = readMeminfo();
  // Cumulative tree CPU never decreases. A scan that misses a just-reaped
  // process must not produce a false spike at the next sample.
  const ticks = Math.max(cumulativeTicks, selfChildTicks() - childTicksStart + tree.cpuTicks);
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
  load1Peak = Math.max(load1Peak, readLoad1());

  return { processes: tree.processes, swapUsed: memory.swapUsed };
};

const timer = setInterval(() => sample(true), sampleIntervalMs);

const signalHandlers = (["SIGINT", "SIGTERM"] as const).map(
  (signal) => [signal, () => child.kill(signal)] as const,
);

for (const [signal, handler] of signalHandlers) process.on(signal, handler);

child.once("error", (error) => {
  clearInterval(timer);
  fail(`${program} could not start: ${error.message}`);
});

child.once("exit", (exitCode, signal) => {
  clearInterval(timer);
  const wallMs = performance.now() - startedMs;
  const final = sample(false);
  const sortedRss = [...rssSamples].sort((left, right) => left - right);

  const row: LedgerRow = {
    version: 1,
    class: jobClass,
    command: [program, ...programArguments],
    cwd: process.cwd(),
    revision,
    dirty: status === null ? null : status !== "",
    host: hostname(),
    startedAt: startedAt.toISOString(),
    wallMs: Math.round(wallMs),
    exitCode,
    signal,
    samples: rssSamples.length,
    sampleIntervalMs,
    logicalCpus,
    memTotalBytes: startMemory.total,
    peakRssBytes: sortedRss.at(-1) ?? 0,
    p95RssBytes: sortedRss[Math.max(0, Math.ceil(sortedRss.length * 0.95) - 1)] ?? 0,
    peakCores: Number(peakCores.toFixed(2)),
    meanCores: Number(
      ((selfChildTicks() - childTicksStart) / clockTicks / (wallMs / 1000)).toFixed(2),
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

  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${encodeLine(row)}\n`);
  process.stderr.write(
    `measure-job: ${jobClass} ${signal ?? `exit ${exitCode}`} in ${duration(wallMs)}, ` +
      `peak RSS ${gib(row.peakRssBytes)}, peak cores ${row.peakCores}, mean cores ${row.meanCores}` +
      `${row.survivingProcesses > 0 ? `, ${row.survivingProcesses} processes still running` : ""}\n`,
  );

  for (const [name, handler] of signalHandlers) process.off(name, handler);

  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(exitCode ?? 1);
});
