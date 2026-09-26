import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { heavyLockVariable } from "../heavy-lock.js";

// The tests run real measure-job and hook-slot processes against their own lock directory, so the
// machine's heavy lock is not involved. Each job's command holds the lock for a real number of
// seconds, because the waits under test are waits of other processes for flock(2). A command
// prints its start and end in epoch milliseconds.

const scripts = join(import.meta.dir, "..");

const runtime = mkdtempSync("/tmp/heavy-lock-test-");

// The tests may run inside a hook job, which holds the machine's lock and names itself here.
const env = Object.fromEntries(
  Object.entries({
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: runtime,
    VEKTORPROGRAMMET_HOOK_SLOTS: "2",
  }).filter(([name]) => name !== heavyLockVariable),
);

interface Job {
  readonly process: ChildProcess;
  readonly pid: number;
  /** Standard output and error so far. */
  readonly output: () => string;
  /** Resolves when the output contains the text. */
  readonly printed: (text: string) => Promise<void>;
  /** Resolves with the exit code when the job's output is closed. */
  readonly closed: Promise<number | null>;
}

const jobs: Array<Job> = [];

const run = (argv: ReadonlyArray<string>): Job => {
  // Its own process group, so the cleanup stops the whole tree of a job.
  const child = spawn(process.execPath, argv, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const waiters: Array<{ readonly text: string; readonly resolve: () => void }> = [];
  const closed = Promise.withResolvers<number | null>();
  let output = "";

  const append = (chunk: Buffer) => {
    output += chunk.toString();

    for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve();
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("close", closed.resolve);

  const job = {
    process: child,
    pid: child.pid ?? 0,
    output: () => output,
    printed: (text: string) => {
      const printed = Promise.withResolvers<void>();

      if (output.includes(text)) printed.resolve();
      else waiters.push({ text, resolve: printed.resolve });

      return printed.promise;
    },
    closed: closed.promise,
  };

  jobs.push(job);

  return job;
};

const recorded = (seconds: number) => [
  "sh",
  "-c",
  `echo "start $(date +%s%3N)"; sleep ${seconds}; echo "end $(date +%s%3N)"`,
];

const heavyJob = (seconds: number) =>
  run(["--no-env-file", join(scripts, "measure-job.ts"), "--class", "demo", "--", ...recorded(seconds)]);

const hookJob = (seconds: number) =>
  run(["--no-env-file", join(scripts, "hook-slot.ts"), "--class", "hook-demo", "--", ...recorded(seconds)]);

// NaN when the job did not print the event.
const instant = (job: Job, event: "start" | "end") =>
  Number(new RegExp(`^${event} (\\d+)$`, "m").exec(job.output())?.[1]);

afterEach(() => {
  for (const job of jobs.splice(0)) {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      // The job and its processes have exited.
    }
  }
});

afterAll(() => rmSync(runtime, { recursive: true, force: true }));

describe("the heavy lock", () => {
  test("serializes two heavy jobs that start together and shows the holder", async () => {
    const started = [heavyJob(2), heavyJob(2)];

    for (const job of started) expect(await job.closed).toBe(0);

    const [first, second] = started.sort((left, right) => instant(left, "start") - instant(right, "start"));

    expect(instant(first!, "end")).toBeLessThanOrEqual(instant(second!, "start"));
    expect(second!.output()).toContain(`waiting for the heavy job pid ${first!.pid}, demo, since `);
  }, 30_000);

  test("keeps a hook job waiting while a heavy job runs", async () => {
    const heavy = heavyJob(2);

    await heavy.printed("start ");

    const hook = hookJob(0);

    expect(await heavy.closed).toBe(0);
    expect(await hook.closed).toBe(0);
    expect(instant(hook, "start")).toBeGreaterThanOrEqual(instant(heavy, "end"));
    expect(hook.output()).toContain(`waiting for the heavy job pid ${heavy.pid}, demo, since `);
  }, 30_000);

  test("starts a heavy job after the running hook jobs and before hook jobs that arrive later", async () => {
    const running = hookJob(2);

    await running.printed("start ");

    const heavy = heavyJob(1);

    await heavy.printed("waiting for 1 running hook job:");

    const later = hookJob(0);

    for (const job of [running, heavy, later]) expect(await job.closed).toBe(0);

    expect(heavy.output()).toContain(`\n  pid ${running.pid}, hook-demo, since `);
    expect(instant(heavy, "start")).toBeGreaterThanOrEqual(instant(running, "end"));
    expect(later.output()).toContain(`waiting for the heavy job pid ${heavy.pid}, demo, since `);
    expect(instant(later, "start")).toBeGreaterThanOrEqual(instant(heavy, "end"));
  }, 30_000);

  test("lets a heavy job and a hook job inside a heavy job run without waiting for it", async () => {
    const outer = run([
      "--no-env-file",
      join(scripts, "measure-job.ts"),
      "--class",
      "outer",
      "--",
      process.execPath,
      "--no-env-file",
      join(scripts, "measure-job.ts"),
      "--class",
      "inner",
      "--",
      process.execPath,
      "--no-env-file",
      join(scripts, "hook-slot.ts"),
      "--class",
      "hook-inner",
      "--",
      ...recorded(0),
    ]);

    expect(await outer.closed).toBe(0);
    expect(instant(outer, "end")).toBeGreaterThan(0);
  }, 30_000);

  test("is released when its holder is killed, while the holder's job keeps running", async () => {
    const killed = heavyJob(60);

    await killed.printed("start ");
    killed.process.kill("SIGKILL");
    await once(killed.process, "exit");

    const next = heavyJob(0);

    expect(await next.closed).toBe(0);
    expect(instant(killed, "end")).toBeNaN();
  }, 30_000);
});
