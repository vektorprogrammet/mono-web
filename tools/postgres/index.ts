/**
 * Disposable PostgreSQL clusters of the selected major, for tests, proofs, journeys, and CI.
 *
 * The root manifest declares the supported PostgreSQL majors once, as
 * `engines.postgresql` (for example `"17 || 18"`). The highest one is the default.
 * `VEKTOR_POSTGRES_MAJOR` selects another supported major; `devenv shell` reads the
 * same variable and puts the programs of the selected major on `PATH`.
 * Resolution uses the first `postgres` on `PATH` and rejects any other major.
 *
 * `startDisposablePostgres` is the one way to start a cluster. It owns `initdb`, the server,
 * `createdb`, and teardown, so no caller runs them. A cluster is ready when its server accepts
 * connections, as `pg_isready` reports: an open port is not readiness, because a server that
 * starts up, shuts down, or recovers answers on its port and rejects every session. A sentinel
 * process removes the cluster when its owner exits without `stop`: on an uncaught failure, on a
 * signal, and on SIGKILL. Bun exits on an uncaught failure without an `exit` event, so an
 * in-process exit hook would not cover that case.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Predicate, Redacted, Schema } from "effect";

const separator = " || ";

/** `engines.postgresql`: distinct majors joined by `" || "`, such as `"17 || 18"`. */
const PostgresMajorSet = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[1-9][0-9]*(?: \|\| [1-9][0-9]*)*$/u),
    Schema.makeFilter(
      (value) => new Set(value.split(separator)).size === value.split(separator).length,
      { message: "distinct PostgreSQL majors" },
    ),
  ),
);

const RootManifest = Schema.fromJsonString(
  Schema.Struct({ engines: Schema.Struct({ postgresql: PostgresMajorSet }) }),
);

/** Decodes an `engines.postgresql` value into its majors, ascending. Throws on a malformed value. */
export const decodePostgresMajors = (declared: string): ReadonlyArray<number> =>
  Schema.decodeSync(PostgresMajorSet)(declared)
    .split(separator)
    .map(Number)
    .toSorted((left, right) => left - right);

/**
 * The major that `requested` (the value of `VEKTOR_POSTGRES_MAJOR`) selects from `supported`.
 * No value, or an empty one, selects the highest. Throws on a major outside `supported`.
 */
export const selectPostgresMajor = (
  supported: ReadonlyArray<number>,
  requested: string | undefined,
): number => {
  if (requested === undefined || requested === "") return Math.max(...supported);

  const major = supported.find((candidate) => String(candidate) === requested);

  if (major !== undefined) return major;

  throw new Error(
    `VEKTOR_POSTGRES_MAJOR=${requested} is not a supported PostgreSQL major. ` +
      `package.json engines.postgresql supports ${supported.join(separator)}.`,
  );
};

/** The PostgreSQL majors that the root manifest supports, ascending. */
export const supportedPostgresMajors = decodePostgresMajors(
  Schema.decodeSync(RootManifest)(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).engines.postgresql,
);

/** The highest supported major, which runs when `VEKTOR_POSTGRES_MAJOR` is unset. */
export const defaultPostgresMajor = selectPostgresMajor(supportedPostgresMajors, undefined);

/**
 * The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.
 *
 * @construct test-harness
 */
export const selectedPostgresMajor = selectPostgresMajor(
  supportedPostgresMajors,
  process.env.VEKTOR_POSTGRES_MAJOR,
);

/**
 * Client programs of the selected major. The cluster programs (`initdb`, `postgres`, `pg_ctl`,
 * `createdb`) are not in this union: only `startDisposablePostgres` runs them.
 */
export type PostgresProgram = "pg_dump" | "pg_isready" | "pg_restore" | "psql";

type ClusterProgram = "createdb" | "initdb" | "pg_ctl" | "postgres";

interface Installation {
  /** The directory of the programs. */
  readonly directory: string;
  /** The `postgres --version` line, such as `postgres (PostgreSQL) 18.6`. */
  readonly version: string;
}

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const versionOf = (postgres: string) => {
  const result = spawnSync(postgres, ["--version"], { encoding: "utf8" });
  const line = result.error === undefined ? result.stdout.trim() : "";
  const major = /\(PostgreSQL\) (\d+)/u.exec(line)?.[1];

  return major === undefined ? undefined : { line, major: Number(major) };
};

const resolveInstallation = (): Installation => {
  const directory = (process.env.PATH ?? "")
    .split(delimiter)
    .find((entry) => entry !== "" && executable(join(entry, "postgres")));

  const version = directory === undefined ? undefined : versionOf(join(directory, "postgres"));

  if (directory !== undefined && version?.major === selectedPostgresMajor)
    return { directory, version: version.line };

  throw new Error(
    `PostgreSQL ${selectedPostgresMajor} (selected by VEKTOR_POSTGRES_MAJOR from package.json ` +
      `engines.postgresql ${supportedPostgresMajors.join(separator)}) is required on PATH, which provides ` +
      `${directory === undefined ? "no postgres" : `${directory}/postgres (${version?.major ?? "unknown version"})`}. ` +
      "Run the command inside `devenv shell` with the same VEKTOR_POSTGRES_MAJOR, which provides it.",
  );
};

let installation: Installation | undefined;

const programPath = (program: PostgresProgram | ClusterProgram) =>
  join((installation ??= resolveInstallation()).directory, program);

/**
 * Absolute path of a client program of the selected PostgreSQL major.
 *
 * @construct test-harness
 */
export const postgresProgram = (program: PostgresProgram): string => programPath(program);

/**
 * The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for
 * evidence that names the toolchain whether or not a cluster started.
 *
 * @construct test-harness
 */
export const postgresVersion = (): string => (installation ??= resolveInstallation()).version;

const execute = promisify(execFile);

const loopback = "127.0.0.1";

// A cluster that does not accept connections within this time does not start.
const readinessTimeoutMs = 60_000;

// Fast shutdown ends the sessions; immediate shutdown and then SIGKILL follow when it hangs.
const fastShutdownMs = 30_000;

const immediateShutdownMs = 10_000;

/**
 * The environment of the cluster programs: `base` in the C locale, without the libpq and server
 * variables (`PGHOST`, `PGPORT`, `PGDATA`, ...) that `devenv shell` sets for its own server.
 */
const programEnvironment = (
  base: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("PG"))),
  LC_ALL: "C",
});

const freeLoopbackPort = (): Promise<number> => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen({ host: loopback, port: 0, exclusive: true }, () => {
    const address = server.address();

    if (address === null || Predicate.isString(address)) {
      server.close();
      reject(new Error("failed to allocate a loopback port for PostgreSQL"));

      return;
    }

    server.close((cause) => {
      if (cause === undefined) resolve(address.port);
      else reject(cause);
    });
  });

  return promise;
};

/** Where a client reaches a server: an address or a Unix socket directory, a port, and a role. */
export interface PostgresAddress {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

// pg_isready exits 0 when the server accepts connections, 1 when it rejects them (it starts up,
// shuts down, or recovers: SQLSTATE 57P03), 2 without a response, and 3 on invalid parameters.
const probe = (address: PostgresAddress, environment: NodeJS.ProcessEnv) => {
  const { promise, resolve } = Promise.withResolvers<{
    readonly code: number | null;
    readonly report: string;
  }>();

  const child = spawn(
    postgresProgram("pg_isready"),
    [
      "--host",
      address.host,
      "--port",
      String(address.port),
      "--username",
      address.user,
      "--dbname",
      "postgres",
      "--timeout",
      "2",
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );

  let report = "";

  const collect = (chunk: Buffer) => {
    report += chunk.toString("utf8");
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", (cause) => resolve({ code: null, report: cause.message }));
  child.once("close", (code) => resolve({ code, report: report.trim() }));

  return promise;
};

/**
 * Resolves once the server at `address` accepts connections, as `pg_isready` reports. An open
 * port is not enough: a server that starts up, shuts down, or recovers answers on its port and
 * rejects every session. Rejects after `timeoutMs`, or with the reason of `abandon` once it aborts.
 */
export const waitForPostgres = async (
  address: PostgresAddress,
  timeoutMs: number,
  abandon?: AbortSignal,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const environment = programEnvironment(process.env);

  for (;;) {
    abandon?.throwIfAborted();

    const { code, report } = await probe(address, environment);

    if (code === 0) return;

    if (code === 3) throw new Error(`pg_isready rejected its parameters: ${report}`);

    abandon?.throwIfAborted();

    if (Date.now() >= deadline)
      throw new Error(
        `PostgreSQL at ${address.host}:${address.port} did not accept connections within ` +
          `${timeoutMs} ms. pg_isready last reported: ${report === "" ? `exit ${code}` : report}`,
      );

    await sleep(100, undefined, { signal: abandon }).catch(() => undefined);
  }
};

// The owner holds the sentinel's standard input, so the sentinel reads end of file when the owner
// exits, however it exits. `stop` writes `released` instead, after it removed the cluster itself.
const sentinelScript = [
  'if read -r line && [ "$line" = released ]; then exit 0; fi',
  '"$1" stop --pgdata="$2" --mode=immediate --wait --timeout=30 >/dev/null 2>&1',
  'rm -rf -- "$3"',
].join("\n");

const watch = (root: string, data: string, environment: NodeJS.ProcessEnv) => {
  const sentinel = spawn(
    "/bin/sh",
    ["-c", sentinelScript, "vektor-postgres-sentinel", programPath("pg_ctl"), data, root],
    { env: environment, stdio: ["pipe", "ignore", "ignore"], detached: true },
  );

  const exited = Promise.withResolvers<void>();
  sentinel.once("exit", () => exited.resolve());
  sentinel.once("error", () => exited.resolve());

  sentinel.stdin.on("error", () => undefined);
  sentinel.unref();

  return async () => {
    sentinel.ref();
    sentinel.stdin.end("released\n");
    await exited.promise;
  };
};

const settlesWithin = (settled: Promise<void>, milliseconds: number) =>
  Promise.race([settled.then(() => true), sleep(milliseconds, false)]);

/** How `startDisposablePostgres` sets up a cluster. Every field is optional. */
export interface DisposablePostgresOptions {
  /** A database to create once the server accepts connections. `url` names it, or `postgres`. */
  readonly database?: string | undefined;
  /** The superuser that trust authentication admits without a password. Defaults to `postgres`. */
  readonly user?: string | undefined;
  /** The port. Defaults to a free loopback port. Without TCP it only names the socket file. */
  readonly port?: number | undefined;
  /** `tcp` listens on 127.0.0.1 and the socket (the default); `socket` on the socket only. */
  readonly listen?: "tcp" | "socket" | undefined;
  /** A directory to create for the cluster. It must not exist yet. Defaults to a temporary one. */
  readonly directory?: string | undefined;
  /** The server's `max_connections`. Defaults to the server default. */
  readonly maxConnections?: number | undefined;
  /** The environment of the cluster programs, without its `PG*` variables. Defaults to this process's. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
}

/** A running cluster that `startDisposablePostgres` owns. */
export interface DisposablePostgres {
  /** The host of `url`: 127.0.0.1, or the socket directory when the cluster has no TCP listener. */
  readonly host: string;
  readonly port: number;
  /** The superuser that trust authentication admits without a password. */
  readonly user: string;
  /** The database that `url` names. */
  readonly database: string;
  /** The private directory of the Unix socket. */
  readonly socketDirectory: string;
  /** The connection URL of `database`. */
  readonly url: string;
  /** The `postgres --version` line of the server, such as `postgres (PostgreSQL) 18.6`. */
  readonly version: string;
  /** The process id of the running server. */
  readonly pid: number;
  /** The server log. `stop` removes it with the cluster. */
  readonly logFile: string;
  /** Settles with the failure once the server exits without `stop` or `outage`. */
  readonly unexpectedExit: Promise<Error>;
  /** The connection URL of another database of the cluster. */
  readonly urlOf: (database: string) => string;
  /** Creates a database and returns its connection URL. */
  readonly createDatabase: (database: string) => Promise<string>;
  /**
   * Stops the server with a fast shutdown and runs `during`. Then it starts the server again and
   * waits until it accepts connections, also when `during` fails.
   */
  readonly outage: <A>(during: () => Promise<A>) => Promise<A>;
  /** Stops the server and removes the cluster directory. Later calls return the first call's promise. */
  readonly stop: () => Promise<void>;
}

interface Incarnation {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<void>;
  readonly abandon: AbortController;
  expected: boolean;
}

/**
 * Starts a fresh cluster of the selected major on a private port and socket directory with trust
 * authentication. It resolves once the server accepts connections and `database` exists.
 * `stop` removes the cluster; a sentinel removes it when this process exits without `stop`.
 *
 * @construct test-harness
 */
export const startDisposablePostgres = async (
  options: DisposablePostgresOptions = {},
): Promise<DisposablePostgres> => {
  const user = options.user ?? "postgres";
  const listen = options.listen ?? "tcp";
  const environment = programEnvironment(options.environment ?? process.env);
  const version = postgresVersion();
  const port = options.port ?? (await freeLoopbackPort());
  const root = options.directory ?? (await mkdtemp(join(tmpdir(), "vektor-postgres-")));

  if (options.directory !== undefined) await mkdir(root, { mode: 0o700 });

  const data = join(root, "data");
  const release = watch(root, data, environment);
  const socketDirectory = join(root, "socket");
  const logFile = join(root, "postgres.log");
  const host = listen === "tcp" ? loopback : socketDirectory;
  const address = { host, port, user };
  const unexpected = Promise.withResolvers<Error>();
  let server: Incarnation | undefined;
  let stopping: Promise<void> | undefined;

  const logTail = () => {
    try {
      return readFileSync(logFile, "utf8").slice(-4_000).trim();
    } catch {
      return "(no server log)";
    }
  };

  const urlOf = (database: string) => {
    if (listen === "tcp")
      return `postgres://${encodeURIComponent(user)}@${loopback}:${port}/${encodeURIComponent(database)}`;

    const url = new URL(
      `postgresql://${encodeURIComponent(user)}@localhost/${encodeURIComponent(database)}`,
    );

    url.searchParams.set("host", socketDirectory);
    url.searchParams.set("port", String(port));

    return url.toString();
  };

  const launch = (): Incarnation => {
    const log = openSync(logFile, "a");
    let child: ChildProcess;

    try {
      child = spawn(
        programPath("postgres"),
        [
          "-D",
          data,
          "-p",
          String(port),
          "-k",
          socketDirectory,
          "-c",
          `listen_addresses=${listen === "tcp" ? loopback : ""}`,
          "-F",
          ...(options.maxConnections === undefined
            ? []
            : ["-c", `max_connections=${options.maxConnections}`]),
        ],
        { env: environment, stdio: ["ignore", log, log], detached: true },
      );
    } finally {
      closeSync(log);
    }

    const abandon = new AbortController();
    const exited = Promise.withResolvers<void>();

    const incarnation: Incarnation = {
      child,
      pid: child.pid ?? 0,
      exited: exited.promise,
      abandon,
      expected: false,
    };

    const ended = (detail: string) => {
      exited.resolve();

      if (incarnation.expected) return;

      const failure = new Error(`PostgreSQL ${detail}. Server log:\n${logTail()}`);
      abandon.abort(failure);
      unexpected.resolve(failure);
    };

    child.once("error", (cause) => ended(`did not start: ${cause.message}`));
    child.once("exit", (code, signal) =>
      ended(`exited with ${signal === null ? `code ${code}` : signal}`),
    );
    child.unref();

    return incarnation;
  };

  const run = async () => {
    server = launch();
    await waitForPostgres(address, readinessTimeoutMs, server.abandon.signal);
  };

  const halt = async (incarnation: Incarnation) => {
    incarnation.expected = true;
    incarnation.child.ref();

    if (incarnation.child.exitCode !== null || incarnation.child.signalCode !== null) return;

    incarnation.child.kill("SIGINT");

    if (await settlesWithin(incarnation.exited, fastShutdownMs)) return;

    incarnation.child.kill("SIGQUIT");

    if (await settlesWithin(incarnation.exited, immediateShutdownMs)) return;

    incarnation.child.kill("SIGKILL");
    await incarnation.exited;
  };

  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (server !== undefined) await halt(server);

        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      } finally {
        await release();
      }
    })());

  const createDatabase = async (database: string) => {
    await execute(
      programPath("createdb"),
      ["--host", host, "--port", String(port), "--username", user, database],
      { env: environment },
    );

    return urlOf(database);
  };

  try {
    await mkdir(socketDirectory, { mode: 0o700 });
    await execute(
      programPath("initdb"),
      [
        "--pgdata",
        data,
        "--username",
        user,
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--no-sync",
        "--no-instructions",
      ],
      { env: environment, timeout: 120_000 },
    );
    await run();

    if (options.database !== undefined) await createDatabase(options.database);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const failure = new Error(`Disposable PostgreSQL did not start: ${detail}`, { cause });
    await stop().catch(() => undefined);

    throw failure;
  }

  const database = options.database ?? "postgres";

  return {
    host,
    port,
    user,
    database,
    socketDirectory,
    url: urlOf(database),
    version,
    get pid() {
      return server?.pid ?? 0;
    },
    logFile,
    unexpectedExit: unexpected.promise,
    urlOf,
    createDatabase,
    outage: async (during) => {
      if (stopping !== undefined || server === undefined)
        throw new Error("Disposable PostgreSQL is stopped");

      await halt(server);

      try {
        return await during();
      } finally {
        await run();
      }
    },
    stop,
  };
};

/**
 * Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres`
 * starts, and removes the cluster when `use` settles, also when it fails.
 *
 * @construct test-harness
 */
export const withDisposablePostgres = async <A>(
  database: string,
  use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>,
): Promise<A> => {
  const cluster = await startDisposablePostgres({ database });

  try {
    return await use(Redacted.make(cluster.url));
  } finally {
    await cluster.stop();
  }
};
