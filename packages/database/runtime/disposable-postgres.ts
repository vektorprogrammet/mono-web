/**
 * A private PostgreSQL cluster of the selected major for one proof run, so a proof never reads
 * or resets a database that it did not create.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Predicate, Redacted } from "effect";
import { postgresProgram } from "@monoweb/postgres";

const execute = promisify(execFile);

const allocateLoopbackPort = (): Promise<number> => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    const address = server.address();

    if (address === null || Predicate.isString(address)) {
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

/**
 * Runs `use` against the one database `database` of a fresh cluster on a loopback port with
 * trust authentication. The cluster stops and its files are removed when `use` settles,
 * also when it fails.
 *
 * @construct test-harness
 */
export const withDisposablePostgres = async <A>(
  database: string,
  use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "vektor-disposable-postgres-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  const port = await allocateLoopbackPort();
  let started = false;

  try {
    await mkdir(socket);
    await execute(
      postgresProgram("initdb"),
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
    await execute(postgresProgram("pg_ctl"), [
      "--pgdata",
      data,
      "--wait",
      "--timeout",
      "30",
      "--log",
      join(root, "postgres.log"),
      "--options",
      `-h 127.0.0.1 -p ${port} -k ${socket} -F`,
      "start",
    ]);
    started = true;
    await execute(postgresProgram("createdb"), [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "postgres",
      database,
    ]);

    return await use(Redacted.make(`postgres://postgres@127.0.0.1:${port}/${database}`));
  } finally {
    try {
      if (started) {
        await execute(postgresProgram("pg_ctl"), [
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
  }
};
