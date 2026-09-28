/**
 * However its owner dies, a cluster leaves nothing behind: no server, no listener, no files, and
 * no sentinel. Each case starts a real cluster in a separate Bun owner, ends that owner as the named
 * killer does, and waits for the sentinel's teardown.
 */
import { createConnection } from "node:net";
import { expect, layer } from "@effect/vitest";
import {
  Clock,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { PostgresPlatformLive } from "./index";

/** The owner ended, or ran out of time, before it reported its cluster. */
class OwnerReportMissing extends Data.TaggedError("OwnerReportMissing")<{
  readonly message: string;
}> {}

const construct = JSON.stringify(new URL("./index.ts", import.meta.url).href);

const StartedCluster = Schema.fromJsonString(
  Schema.Struct({ socketDirectory: Schema.String, port: Schema.Int, pid: Schema.Int }),
);

type StartedCluster = typeof StartedCluster.Type;

/** A Bun owner that starts a cluster, reports it on one line, and then fails or waits. */
const owner = (then: "fail" | "wait") => [
  "bun",
  "--no-env-file",
  "--eval",
  [
    `const { startDisposablePostgres } = await import(${construct});`,
    'const cluster = await startDisposablePostgres({ database: "teardown_probe" });',
    "const { socketDirectory, port, pid } = cluster;",
    'process.stdout.write(JSON.stringify({ socketDirectory, port, pid }) + "\\n");',
    then === "fail" ? 'throw new Error("owner failed");' : "setInterval(() => undefined, 1_000);",
  ].join("\n"),
];

const signal = (target: number, name: NodeJS.Signals) =>
  // The target may already be gone.
  Effect.ignore(Effect.try(() => process.kill(target, name)));

/** The process ids under /proc. */
const processIds = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return (yield* fs.readDirectory("/proc")).map(Number).filter((pid) => Number.isInteger(pid));
});

/** The text of a /proc file, or none when its process exited while the table was read. */
const procText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(file).pipe(Effect.option);
  });

/** The process ids of `root` and its descendants, from the parent links in /proc. */
const treeOf = (root: number) =>
  Effect.gen(function* () {
    const children = new Map<number, Array<number>>();

    for (const pid of yield* processIds) {
      const stat = yield* procText(`/proc/${pid}/stat`);

      if (Option.isNone(stat)) continue;

      // The command name may hold spaces and parentheses; the state and the parent follow it.
      const parent = Number(stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[1]);
      const siblings = children.get(parent);

      if (siblings === undefined) children.set(parent, [pid]);
      else siblings.push(pid);
    }

    const tree: Array<number> = [];
    const pending = [root];

    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      tree.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }

    return tree;
  });

/** Live processes whose command line names `root`: the server and the sentinel of a cluster. */
const processesNaming = (root: string) =>
  Effect.gen(function* () {
    const naming: Array<number> = [];

    for (const pid of yield* processIds) {
      const commandLine = yield* procText(`/proc/${pid}/cmdline`);

      if (Option.isSome(commandLine) && commandLine.value.includes(root)) naming.push(pid);
    }

    return naming;
  });

const refusesConnections = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = createConnection({ host: "127.0.0.1", port });

    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    socket.once("error", () => resume(Effect.succeed(true)));
  });

const running = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/**
 * The cluster that the owner reports on its output. Fails once the owner ends without one, or
 * after `within` milliseconds, so the case's cleanup still runs before the test times out.
 */
const reported = (launched: ChildProcessSpawner.ChildProcessHandle, within: number) =>
  Effect.gen(function* () {
    let output = "";

    const line = yield* Stream.decodeText(launched.all).pipe(
      Stream.map((chunk) => {
        output += chunk;

        return /^\{.*\}$/mu.exec(output)?.[0];
      }),
      Stream.filter(Predicate.isNotUndefined),
      Stream.runHead,
      Effect.timeoutOption(within),
    );

    if (Option.isNone(line))
      return yield* new OwnerReportMissing({
        message: `the owner reported no cluster within ${within} ms:\n${output}`,
      });

    if (Option.isNone(line.value))
      return yield* new OwnerReportMissing({
        message: `the owner ended without starting a cluster:\n${output}`,
      });

    return yield* Schema.decodeEffect(StartedCluster)(line.value.value);
  });

const remains = (cluster: StartedCluster, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return {
      directory: yield* fs.exists(root),
      server: yield* running(cluster.pid),
      listener: !(yield* refusesConnections(cluster.port)),
      processes: yield* processesNaming(root),
    };
  });

const lingers = (left: Effect.Success<ReturnType<typeof remains>>) =>
  left.directory || left.server || left.listener || left.processes.length > 0;

interface OwnerDeath {
  readonly name: string;
  /** The command that runs the owner, in its own process group. */
  readonly command: (paths: { readonly ledger: string; readonly measureJob: string }) => ReadonlyArray<string>;
  /** Ends the owner after it reported its cluster. `pid` leads the owner's process group. */
  readonly end: (
    pid: number,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

const ownerDeaths: ReadonlyArray<OwnerDeath> = [
  // Bun exits on an uncaught failure without an `exit` event, so no handler of the owner runs.
  { name: "an uncaught failure", command: () => owner("fail"), end: () => Effect.void },
  { name: "SIGKILL of the owner", command: () => owner("wait"), end: (pid) => signal(pid, "SIGKILL") },
  {
    name: "SIGKILL of the owner's process group",
    command: () => owner("wait"),
    end: (pid) => signal(-pid, "SIGKILL"),
  },
  {
    // `just measure` forwards SIGINT and SIGTERM to the command that it runs.
    name: "SIGTERM to `just measure`, which forwards it to the owner",
    command: ({ ledger, measureJob }) => [
      "bun",
      "--no-env-file",
      measureJob,
      "--class",
      "postgres-teardown-probe",
      "--ledger",
      ledger,
      "--",
      ...owner("wait"),
    ],
    end: (pid) => signal(pid, "SIGTERM"),
  },
  {
    // A bash tool timeout and `hub stop` send SIGTERM to every descendant, also to those in other
    // sessions, and then SIGKILL to the process group.
    name: "a tool timeout: SIGTERM to every descendant, then SIGKILL to the process group",
    command: () => owner("wait"),
    end: (pid) =>
      Effect.gen(function* () {
        for (const member of yield* treeOf(pid)) yield* signal(member, "SIGTERM");

        yield* Effect.sleep(1_000);
        yield* signal(-pid, "SIGKILL");
      }),
  },
];

layer(PostgresPlatformLive, { excludeTestServices: true })("startDisposablePostgres teardown", (it) => {
  it.effect.each(ownerDeaths)(
    "removes the cluster when its owner ends by $name",
    ({ command, end }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "vektor-teardown-probe-" });
        const measureJob = yield* path.fromFileUrl(new URL("../scripts/measure-job.ts", import.meta.url));
        const [program = "bun", ...args] = command({ ledger: path.join(scratch, "ledger.jsonl"), measureJob });

        // The owner leads its own process group, as the killers of the cases expect.
        const launched = yield* spawner.spawn(
          ChildProcess.make(program, args, { detached: true, stdin: "ignore" }),
        );

        let root: string | undefined;

        yield* Effect.gen(function* () {
          const cluster = yield* reported(launched, 30_000);
          root = path.dirname(cluster.socketDirectory);
          yield* end(Number(launched.pid));

          const deadline = (yield* Clock.currentTimeMillis) + 20_000;
          let left = yield* remains(cluster, root);

          // The sentinel tears the cluster down in its own process after the owner is gone, so the
          // test polls for the result instead of awaiting an event of this process.
          while ((yield* Clock.currentTimeMillis) < deadline && lingers(left)) {
            yield* Effect.sleep(100);
            left = yield* remains(cluster, root);
          }

          expect(left).toEqual({ directory: false, server: false, listener: false, processes: [] });
        }).pipe(
          // A failing case must not leak what the owner left: stop it and remove its files.
          Effect.ensuring(
            Effect.gen(function* () {
              yield* signal(-Number(launched.pid), "SIGKILL");

              if (root === undefined) return;

              for (const pid of yield* Effect.orDie(processesNaming(root)))
                yield* signal(pid, "SIGKILL");

              yield* Effect.ignore(fs.remove(root, { recursive: true, force: true }));
            }),
          ),
        );
      }),
    60_000,
  );
});
