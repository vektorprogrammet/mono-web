import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Redacted } from "effect";
import { makeRuleReconciliationTracerProgram } from "../src/rule-reconciliation-postgres-tracer-main.js";

const execute = promisify(execFile);

const allocateLoopbackPort = (): Promise<number> => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("failed to allocate a disposable PostgreSQL port"));
      return;
    }
    server.close((cause) => {
      if (cause === undefined) resolve(address.port);
      else reject(cause);
    });
  });
  return promise;
};

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "vektor-rule-reconciliation-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  const log = join(root, "postgres.log");
  const port = await allocateLoopbackPort();
  let started = false;
  let completed = false;
  try {
    await mkdir(socket);
    await execute(
      "initdb",
      [
        "--pgdata",
        data,
        "--username",
        "postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { env: { ...process.env, LC_ALL: "C" } },
    );
    await execute("pg_ctl", [
      "--pgdata",
      data,
      "--wait",
      "--timeout",
      "30",
      "--log",
      log,
      "--options",
      `-h 127.0.0.1 -p ${port} -k ${socket} -F`,
      "start",
    ]);
    started = true;
    await execute("createdb", [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "postgres",
      "rule_reconciliation_proof",
    ]);
    const databaseUrl = Redacted.make(
      `postgres://postgres@127.0.0.1:${port}/rule_reconciliation_proof`,
    );
    await Effect.runPromise(
      Effect.scoped(makeRuleReconciliationTracerProgram(databaseUrl)).pipe(
        Effect.timeout("90 seconds"),
      ),
    );
    completed = true;
  } finally {
    try {
      if (started) {
        await execute("pg_ctl", [
          "--pgdata",
          data,
          "--mode",
          "immediate",
          "--wait",
          "--timeout",
          "30",
          "stop",
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
    if (completed) process.stderr.write("Disposable PostgreSQL topology cleaned.\n");
  }
};

void run().catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
