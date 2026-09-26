import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Predicate, Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { waitForPostgres } from "./index";

type Answer = "starting-up" | "accepting" | "hang-up";

const sslRequest = 80_877_103;

const gssEncryptionRequest = 80_877_104;

const message = (type: string, body: Buffer) => {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);

  return Buffer.concat([header, body]);
};

// What a starting server sends to every session: FATAL 57P03 (cannot_connect_now).
const startingUp = message(
  "E",
  Buffer.from("SFATAL\0VFATAL\0C57P03\0Mthe database system is starting up\0\0", "latin1"),
);

// AuthenticationOk, then ReadyForQuery in the idle state.
const accepting = Buffer.concat([
  message("R", Buffer.from([0, 0, 0, 0])),
  message("Z", Buffer.from("I", "latin1")),
]);

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());

      return promise;
    }),
  );
});

/**
 * A loopback endpoint that speaks the PostgreSQL startup protocol. It refuses encryption and
 * answers the startup message of connection `n` with `answer(n)`, which it records.
 */
const endpoint = async (answer: (attempt: number) => Answer) => {
  const answers: Array<Answer> = [];

  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);

    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 8 && pending.length >= pending.readInt32BE(0)) {
        const code = pending.readInt32BE(4);
        pending = pending.subarray(pending.readInt32BE(0));

        if (code === sslRequest || code === gssEncryptionRequest) {
          socket.write("N");
          continue;
        }

        const verdict = answer(answers.length);
        answers.push(verdict);

        if (verdict === "hang-up") socket.destroy();
        else socket.end(verdict === "accepting" ? accepting : startingUp);

        return;
      }
    });
  });

  servers.push(server);

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;

  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("no loopback port");

  return { address: { host: "127.0.0.1", port: address.port, user: "postgres" }, answers };
};

describe("waitForPostgres", () => {
  test("does not report a server that accepts TCP but still starts up as ready", async () => {
    const { address, answers } = await endpoint(() => "starting-up");

    await expect(waitForPostgres(address, 1_500)).rejects.toThrow(
      /did not accept connections within 1500 ms/u,
    );
    expect(answers.length).toBeGreaterThan(1);
  });

  test("does not report a server that closes the connection without an answer as ready", async () => {
    const { address, answers } = await endpoint(() => "hang-up");

    await expect(waitForPostgres(address, 1_000)).rejects.toThrow(/did not accept connections/u);
    expect(answers.length).toBeGreaterThan(1);
  });

  test("reports ready at the first session that the server accepts", async () => {
    const { address, answers } = await endpoint((attempt) =>
      attempt < 3 ? "starting-up" : "accepting",
    );

    await waitForPostgres(address, 30_000);

    expect(answers).toEqual(["starting-up", "starting-up", "starting-up", "accepting"]);
  });

  test("stops waiting with the reason of an abandoned start", async () => {
    const abandon = new AbortController();
    const reason = new Error("PostgreSQL exited with code 1");

    const { address } = await endpoint(() => {
      abandon.abort(reason);

      return "starting-up";
    });

    await expect(waitForPostgres(address, 30_000, abandon.signal)).rejects.toBe(reason);
  });
});

const StartedCluster = Schema.fromJsonString(
  Schema.Struct({ socketDirectory: Schema.String, port: Schema.Int, pid: Schema.Int }),
);

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

const processGone = (pid: number) => {
  try {
    process.kill(pid, 0);

    return false;
  } catch {
    return true;
  }
};

describe("startDisposablePostgres teardown", () => {
  // Bun exits on an uncaught failure without an `exit` event; SIGKILL runs no handler at all.
  test.each(["uncaught failure", "SIGKILL"] as const)(
    "removes the cluster of an owner that ends by %s",
    async (ending) => {
      // The owner is another Bun process, so its program imports this package at run time.
      const program = [
        `const { startDisposablePostgres } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});`,
        'const cluster = await startDisposablePostgres({ database: "teardown_probe" });',
        "const { socketDirectory, port, pid } = cluster;",
        'process.stdout.write(JSON.stringify({ socketDirectory, port, pid }) + "\\n");',
        ending === "SIGKILL"
          ? 'process.kill(process.pid, "SIGKILL");'
          : 'throw new Error("owner failed");',
      ].join("\n");

      const owner = spawn("bun", ["--no-env-file", "--eval", program], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      const collect = (chunk: Buffer) => {
        output += chunk.toString("utf8");
      };

      owner.stdout.on("data", collect);
      owner.stderr.on("data", collect);

      const ended = Promise.withResolvers<void>();
      owner.once("exit", () => ended.resolve());
      await ended.promise;

      const started = /^\{.*\}$/mu.exec(output)?.[0];

      if (started === undefined) throw new Error(`the owner did not start a cluster:\n${output}`);

      const cluster = Schema.decodeSync(StartedCluster)(started);
      const root = dirname(cluster.socketDirectory);
      const deadline = Date.now() + 30_000;

      // The sentinel removes the cluster in its own process after the owner is gone, so the test
      // polls for the result instead of awaiting an event of this process.
      while (
        Date.now() < deadline &&
        (existsSync(root) || !processGone(cluster.pid) || !(await refusesConnections(cluster.port)))
      )
        await sleep(100);

      expect(existsSync(root)).toBe(false);
      expect(processGone(cluster.pid)).toBe(true);
      expect(await refusesConnections(cluster.port)).toBe(true);
    },
    60_000,
  );
});
