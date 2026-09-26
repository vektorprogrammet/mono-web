/**
 * However its owner dies, a cluster leaves nothing behind: no server, no listener, no files, and
 * no sentinel. Each case starts a real cluster in a separate Bun owner, ends that owner as the named
 * killer does, and waits for the sentinel's teardown.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

const construct = JSON.stringify(new URL("./index.ts", import.meta.url).href);

const measureJob = fileURLToPath(new URL("../scripts/measure-job.ts", import.meta.url));

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

const signal = (target: number, name: NodeJS.Signals) => {
  try {
    process.kill(target, name);
  } catch {
    // The target is already gone.
  }
};

/** The process ids of `root` and its descendants, from the parent links in /proc. */
const treeOf = (root: number) => {
  const children = new Map<number, Array<number>>();

  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);

    if (!Number.isInteger(pid)) continue;

    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name may hold spaces and parentheses; the state and the parent follow it.
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const siblings = children.get(parent);

      if (siblings === undefined) children.set(parent, [pid]);
      else siblings.push(pid);
    } catch {
      // The process exited while the table was read.
    }
  }

  const tree: Array<number> = [];
  const pending = [root];

  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }

  return tree;
};

/** Live processes whose command line names `root`: the server and the sentinel of a cluster. */
const processesNaming = (root: string) =>
  readdirSync("/proc").flatMap((entry) => {
    const pid = Number(entry);

    if (!Number.isInteger(pid)) return [];

    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(root) ? [pid] : [];
    } catch {
      return [];
    }
  });

const refusesConnections = (port: number) => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host: "127.0.0.1", port });

  socket.once("connect", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(true));

  return promise;
};

const running = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves with the cluster that the owner reports. Rejects once the owner ends without one, or
 * after `within` milliseconds, so the case's `finally` still runs before the test times out.
 */
const reported = (launched: ChildProcess, within: number) => {
  const { promise, resolve, reject } = Promise.withResolvers<StartedCluster>();
  let output = "";

  const fail = (reason: string) => {
    clearTimeout(deadline);
    reject(new Error(`the owner ${reason}:\n${output}`));
  };

  const deadline = setTimeout(() => fail(`reported no cluster within ${within} ms`), within);

  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");

    const line = /^\{.*\}$/mu.exec(output)?.[0];

    if (line === undefined) return;

    clearTimeout(deadline);
    resolve(Schema.decodeSync(StartedCluster)(line));
  };

  launched.stdout?.on("data", collect);
  launched.stderr?.on("data", collect);
  launched.once("close", () => fail("ended without starting a cluster"));

  return promise;
};

const remains = async (cluster: StartedCluster, root: string) => ({
  directory: existsSync(root),
  server: running(cluster.pid),
  listener: !(await refusesConnections(cluster.port)),
  processes: processesNaming(root),
});

interface OwnerDeath {
  readonly name: string;
  /** The command that runs the owner, in its own process group. */
  readonly command: (ledger: string) => ReadonlyArray<string>;
  /** Ends the owner after it reported its cluster. `pid` leads the owner's process group. */
  readonly end: (pid: number) => Promise<void>;
}

const ownerDeaths: ReadonlyArray<OwnerDeath> = [
  // Bun exits on an uncaught failure without an `exit` event, so no handler of the owner runs.
  { name: "an uncaught failure", command: () => owner("fail"), end: async () => undefined },
  { name: "SIGKILL of the owner", command: () => owner("wait"), end: async (pid) => signal(pid, "SIGKILL") },
  {
    name: "SIGKILL of the owner's process group",
    command: () => owner("wait"),
    end: async (pid) => signal(-pid, "SIGKILL"),
  },
  {
    // `just measure` forwards SIGINT and SIGTERM to the command that it runs.
    name: "SIGTERM to `just measure`, which forwards it to the owner",
    command: (ledger) => [
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
    end: async (pid) => signal(pid, "SIGTERM"),
  },
  {
    // A bash tool timeout and `hub stop` send SIGTERM to every descendant, also to those in other
    // sessions, and then SIGKILL to the process group.
    name: "a tool timeout: SIGTERM to every descendant, then SIGKILL to the process group",
    command: () => owner("wait"),
    end: async (pid) => {
      for (const member of treeOf(pid)) signal(member, "SIGTERM");

      await sleep(1_000);
      signal(-pid, "SIGKILL");
    },
  },
];

describe("startDisposablePostgres teardown", () => {
  test.each(ownerDeaths)(
    "removes the cluster when its owner ends by $name",
    async ({ command, end }) => {
      const scratch = await mkdtemp(join(tmpdir(), "vektor-teardown-probe-"));
      const [program = "bun", ...args] = command(join(scratch, "ledger.jsonl"));
      const launched = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const leader = launched.pid;
      let root: string | undefined;

      try {
        if (leader === undefined) throw new Error(`${program} did not start`);

        const cluster = await reported(launched, 30_000);
        root = dirname(cluster.socketDirectory);
        await end(leader);

        const deadline = Date.now() + 20_000;
        let left = await remains(cluster, root);

        // The sentinel tears the cluster down in its own process after the owner is gone, so the
        // test polls for the result instead of awaiting an event of this process.
        while (
          Date.now() < deadline &&
          (left.directory || left.server || left.listener || left.processes.length > 0)
        ) {
          await sleep(100);
          left = await remains(cluster, root);
        }

        expect(left).toEqual({ directory: false, server: false, listener: false, processes: [] });
      } finally {
        // A failing case must not leak what the owner left: stop it and remove its files.
        if (leader !== undefined) signal(-leader, "SIGKILL");

        if (root !== undefined) {
          for (const pid of processesNaming(root)) signal(pid, "SIGKILL");

          await rm(root, { recursive: true, force: true });
        }

        await rm(scratch, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
