import { afterAll, describe, expect, test } from "bun:test";
import process from "node:process";
import { Effect, Fiber, FileSystem, Path, Scope, Stream, SubscriptionRef } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { heavyLockVariable } from "../heavy-lock.js";
import { ScriptsPlatform } from "../measure-job.js";

// The tests run real measure-job and hook-slot processes against their own lock directory, so the
// machine's heavy lock is not involved. Each job's command holds the lock for a real number of
// seconds, because the waits under test are waits of other processes for flock(2). A command
// prints its start and end in epoch milliseconds. Each test's scope kills the process groups of
// its jobs when it closes.

const run = <A, E>(effect: Effect.Effect<A, E, ScriptsPlatform | Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(ScriptsPlatform)));

const { scripts, runtime } = await Effect.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return {
      scripts: path.join(import.meta.dir, ".."),
      runtime: yield* fileSystem.makeTempDirectory({
        directory: "/tmp",
        prefix: "heavy-lock-test-",
      }),
    };
  }).pipe(Effect.provide(ScriptsPlatform)),
);

// The tests may run inside a hook job, which holds the machine's lock and names itself in
// VEKTORPROGRAMMET_HEAVY_LOCK; an empty value names no holder.
const variables = {
  XDG_RUNTIME_DIR: runtime,
  XDG_STATE_HOME: runtime,
  VEKTORPROGRAMMET_HOOK_SLOTS: "2",
  [heavyLockVariable]: "",
};

interface Job {
  readonly pid: number;
  /** Standard output and error so far. */
  readonly output: Effect.Effect<string>;
  /** Succeeds when the output contains the text. */
  readonly printed: (text: string) => Effect.Effect<void>;
  /** Succeeds with the exit code when the job has exited and its output is closed. */
  readonly closed: Effect.Effect<number, PlatformError>;
  /** Succeeds when the job's own process has exited, however it ended. */
  readonly exited: Effect.Effect<void>;
}

const start = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Its own process group, so the cleanup stops the whole tree of a job.
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, argv, {
        env: variables,
        extendEnv: true,
        detached: true,
        stdin: "ignore",
      }),
    );

    const pid = Number(handle.pid);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The job and its processes have exited.
        }
      }),
    );

    const output = yield* SubscriptionRef.make("");

    const reader = yield* Effect.forkScoped(
      Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
        SubscriptionRef.update(output, (text) => text + chunk),
      ),
    );

    const job: Job = {
      pid,
      output: SubscriptionRef.get(output),
      printed: (text) =>
        Effect.asVoid(
          Stream.runHead(
            Stream.filter(SubscriptionRef.changes(output), (current) => current.includes(text)),
          ),
        ),
      closed: Effect.andThen(Effect.ignore(Fiber.join(reader)), handle.exitCode),
      exited: Effect.ignore(handle.exitCode),
    };

    return job;
  });

const recorded = (seconds: number) => [
  "sh",
  "-c",
  `echo "start $(date +%s%3N)"; sleep ${seconds}; echo "end $(date +%s%3N)"`,
];

const heavyJob = (seconds: number) =>
  start([
    "--no-env-file",
    `${scripts}/measure-job.ts`,
    "--class",
    "demo",
    "--",
    ...recorded(seconds),
  ]);

const hookJob = (seconds: number) =>
  start([
    "--no-env-file",
    `${scripts}/hook-slot.ts`,
    "--class",
    "hook-demo",
    "--",
    ...recorded(seconds),
  ]);

// NaN when the job did not print the event.
const instant = (output: string, event: "start" | "end") =>
  Number(new RegExp(`^${event} (\\d+)$`, "m").exec(output)?.[1]);

afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.remove(runtime, { recursive: true, force: true });
    }).pipe(Effect.provide(ScriptsPlatform)),
  ),
);

describe("the heavy lock", () => {
  test("serializes two heavy jobs that start together and shows the holder", () =>
    run(
      Effect.gen(function* () {
        const started = [yield* heavyJob(2), yield* heavyJob(2)];

        for (const job of started) expect(yield* job.closed).toBe(0);

        const outputs = yield* Effect.forEach(started, (job) =>
          Effect.map(job.output, (output) => ({ pid: job.pid, output })),
        );

        const [first, second] = outputs.sort(
          (left, right) => instant(left.output, "start") - instant(right.output, "start"),
        );

        expect(instant(first!.output, "end")).toBeLessThanOrEqual(
          instant(second!.output, "start"),
        );
        expect(second!.output).toContain(
          `waiting for the heavy job pid ${first!.pid}, demo, since `,
        );
      }),
    ), 30_000);

  test("keeps a hook job waiting while a heavy job runs", () =>
    run(
      Effect.gen(function* () {
        const heavy = yield* heavyJob(2);

        yield* heavy.printed("start ");

        const hook = yield* hookJob(0);

        expect(yield* heavy.closed).toBe(0);
        expect(yield* hook.closed).toBe(0);

        const heavyOutput = yield* heavy.output;
        const hookOutput = yield* hook.output;

        expect(instant(hookOutput, "start")).toBeGreaterThanOrEqual(instant(heavyOutput, "end"));
        expect(hookOutput).toContain(`waiting for the heavy job pid ${heavy.pid}, demo, since `);
      }),
    ), 30_000);

  test("starts a heavy job after the running hook jobs and before hook jobs that arrive later", () =>
    run(
      Effect.gen(function* () {
        const running = yield* hookJob(2);

        yield* running.printed("start ");

        const heavy = yield* heavyJob(1);

        yield* heavy.printed("waiting for 1 running hook job:");

        const later = yield* hookJob(0);

        for (const job of [running, heavy, later]) expect(yield* job.closed).toBe(0);

        const runningOutput = yield* running.output;
        const heavyOutput = yield* heavy.output;
        const laterOutput = yield* later.output;

        expect(heavyOutput).toContain(`\n  pid ${running.pid}, hook-demo, since `);
        expect(instant(heavyOutput, "start")).toBeGreaterThanOrEqual(
          instant(runningOutput, "end"),
        );
        expect(laterOutput).toContain(`waiting for the heavy job pid ${heavy.pid}, demo, since `);
        expect(instant(laterOutput, "start")).toBeGreaterThanOrEqual(instant(heavyOutput, "end"));
      }),
    ), 30_000);

  test("lets a heavy job and a hook job inside a heavy job run without waiting for it", () =>
    run(
      Effect.gen(function* () {
        const outer = yield* start([
          "--no-env-file",
          `${scripts}/measure-job.ts`,
          "--class",
          "outer",
          "--",
          process.execPath,
          "--no-env-file",
          `${scripts}/measure-job.ts`,
          "--class",
          "inner",
          "--",
          process.execPath,
          "--no-env-file",
          `${scripts}/hook-slot.ts`,
          "--class",
          "hook-inner",
          "--",
          ...recorded(0),
        ]);

        expect(yield* outer.closed).toBe(0);
        expect(instant(yield* outer.output, "end")).toBeGreaterThan(0);
      }),
    ), 30_000);

  test("is released when its holder is killed, while the holder's job keeps running", () =>
    run(
      Effect.gen(function* () {
        const killed = yield* heavyJob(60);

        yield* killed.printed("start ");
        process.kill(killed.pid, "SIGKILL");
        yield* killed.exited;

        const next = yield* heavyJob(0);

        expect(yield* next.closed).toBe(0);
        expect(instant(yield* killed.output, "end")).toBeNaN();
      }),
    ), 30_000);
});
