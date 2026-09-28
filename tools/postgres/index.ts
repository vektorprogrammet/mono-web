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
 * in-process exit hook would not cover that case. The sentinel runs in its own session and ignores
 * the termination signals, because the killers that end an owner also reach the owner's children:
 * a bash tool timeout and `hub stop` send SIGTERM to every descendant, also in other sessions.
 *
 * `reserveLoopbackPorts` is the one way to choose the loopback port of a server that a journey
 * starts, a cluster included. It reserves below the kernel's ephemeral range and never returns a
 * port twice in one process, so no other bind takes the port before its server binds it.
 *
 * The work is Effect programs over `FileSystem`, `Path`, and `ChildProcessSpawner`. Bun programs
 * and Node Vitest suites both import this module, so it keeps a Promise API and runs each program
 * in one module runtime of the shared Node implementations of those services. The postmaster and
 * the synchronous resolution of the manifest and the installation use Node directly (EX-0017).
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0017: the postmaster logs to a descriptor and gets signals alone, and the installation resolves synchronously
import { type ChildProcess as NodeChildProcess, spawn, spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0017: the postmaster's log is a descriptor, and the manifest and the installation resolve synchronously
import { accessSync, closeSync, constants, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  Cause,
  Clock,
  Config,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Predicate,
  Random,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { dual } from "effect/Function";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

/** A cluster, a pooler, or one of their programs that did not start or stop as it must. */
class DisposablePostgresFailure extends Data.TaggedError("DisposablePostgresFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A rejection of a caller's callback or the reason of an abandoned wait. The Promise API rejects
 * with it unchanged, so a caller sees the value that its own code rejected with.
 */
class CallerRejection extends Data.TaggedError("CallerRejection")<{
  readonly rejection: unknown;
}> {}

const callerPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (rejection) => new CallerRejection({ rejection }) });

/**
 * The services that the programs of this module run on: the shared Node implementations of
 * `ChildProcessSpawner`, `FileSystem`, and `Path`, which Bun and Node both run. Its test suites
 * take the same layer.
 */
export const PostgresPlatformLive = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

// The Promise API runs its programs here: the construct serves Bun programs and Node suites alike.
const runtime = ManagedRuntime.make(PostgresPlatformLive);

type PostgresPlatform = Layer.Success<typeof PostgresPlatformLive>;

/** Runs `program` for the Promise API, which rejects with a caller's rejection unchanged. */
const settle = <A, E>(program: Effect.Effect<A, E, PostgresPlatform>): Promise<A> =>
  runtime.runPromise(
    program.pipe(
      Effect.catchIf(
        (error): error is Extract<E, CallerRejection> => error instanceof CallerRejection,
        (error) => Effect.die(error.rejection),
      ),
    ),
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
export const selectPostgresMajor: {
  (requested: string | undefined): (supported: ReadonlyArray<number>) => number;
  (supported: ReadonlyArray<number>, requested: string | undefined): number;
} = dual(2, (supported: ReadonlyArray<number>, requested: string | undefined): number => {
  if (requested === undefined || requested === "") return Math.max(...supported);

  const major = supported.find((candidate) => String(candidate) === requested);

  if (major !== undefined) return major;

  throw new Error(
    `VEKTOR_POSTGRES_MAJOR=${requested} is not a supported PostgreSQL major. ` +
      `package.json engines.postgresql supports ${supported.join(separator)}.`,
  );
});

/** The PostgreSQL majors that the root manifest supports, ascending. */
export const supportedPostgresMajors = decodePostgresMajors(
  Schema.decodeSync(RootManifest)(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).engines.postgresql,
);

/** The highest supported major, which runs when `VEKTOR_POSTGRES_MAJOR` is unset. */
export const defaultPostgresMajor = selectPostgresMajor(supportedPostgresMajors, undefined);

const environmentValue = (name: string): string | undefined =>
  Option.getOrUndefined(runtime.runSync(Config.option(Config.String(name))));

/**
 * The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.
 */
export const selectedPostgresMajor = selectPostgresMajor(
  supportedPostgresMajors,
  environmentValue("VEKTOR_POSTGRES_MAJOR"),
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

const executable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);

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

/** The directory of the first `program` on `PATH`, if any. */
const onPath = (program: string) => {
  const path = runtime.runSync(Path.Path);
  const delimiter = path.sep === "\\" ? ";" : ":";

  const directory = (environmentValue("PATH") ?? "")
    .split(delimiter)
    .find((entry) => entry !== "" && executable(path.join(entry, program)));

  return directory === undefined ? undefined : { directory, file: path.join(directory, program) };
};

const resolveInstallation = (): Installation => {
  const found = onPath("postgres");
  const version = found === undefined ? undefined : versionOf(found.file);

  if (found !== undefined && version?.major === selectedPostgresMajor)
    return { directory: found.directory, version: version.line };

  throw new Error(
    `PostgreSQL ${selectedPostgresMajor} (selected by VEKTOR_POSTGRES_MAJOR from package.json ` +
      `engines.postgresql ${supportedPostgresMajors.join(separator)}) is required on PATH, which provides ` +
      `${found === undefined ? "no postgres" : `${found.file} (${version?.major ?? "unknown version"})`}. ` +
      "Run the command inside `devenv shell` with the same VEKTOR_POSTGRES_MAJOR, which provides it.",
  );
};

let installation: Installation | undefined;

const programPath = (program: PostgresProgram | ClusterProgram) =>
  runtime.runSync(Path.Path).join((installation ??= resolveInstallation()).directory, program);

/**
 * Absolute path of a client program of the selected PostgreSQL major.
 *
 * @remarks
 * The first `postgres` on `PATH` decides the installation, and it must be of the major that
 * `VEKTOR_POSTGRES_MAJOR` selects from `engines.postgresql` in the root manifest. The
 * installation is resolved once per process, and the path names `program` in its directory. The
 * cluster programs are not in `PostgresProgram`, because only `startDisposablePostgres` runs them.
 *
 * @throws An `Error` that names the selected major and what `PATH` provides, when the first
 * `postgres` on `PATH` is missing or of another major.
 *
 * @sideEffects Reads `PATH` and runs `postgres --version` at the first resolution of the process.
 *
 * @example
 * ```ts
 * await execFileAsync(postgresProgram("psql"), ["-h", "127.0.0.1", "-p", String(port), "-c", sql]);
 * ```
 *
 * @avoid Running `psql`, `pg_dump`, or `pg_restore` by bare name: `PATH` can hold a client of
 * another major than the cluster, whose dump or restore then fails or differs. Run the path that
 * this returns.
 *
 * @construct test-harness
 */
export const postgresProgram = (program: PostgresProgram): string => programPath(program);

/**
 * The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for
 * evidence that names the toolchain whether or not a cluster started.
 *
 * @remarks
 * It resolves the installation as `postgresProgram` does, once per process, and answers the
 * version line that the resolution read. It starts no server.
 *
 * @throws An `Error` when the first `postgres` on `PATH` is missing or of another major, as
 * `postgresProgram` throws.
 *
 * @sideEffects Reads `PATH` and runs `postgres --version` at the first resolution of the process.
 *
 * @example
 * ```ts
 * const toolchain = { bun: process.versions.bun, postgres: postgresVersion() };
 * ```
 *
 * @avoid Reading the version from a started cluster only: a run that fails before its cluster
 * starts then names no toolchain in its evidence. Record `postgresVersion()` instead.
 *
 * @construct test-harness
 */
export const postgresVersion = (): string => (installation ??= resolveInstallation()).version;

const loopback = "127.0.0.1";

// A cluster that does not accept connections within this time does not start.
const readinessTimeoutMs = 60_000;

// Fast shutdown ends the sessions; immediate shutdown and then SIGKILL follow when it hangs.
const fastShutdownMs = 30_000;

const immediateShutdownMs = 10_000;

// initdb that has not finished within this time fails the start.
const initdbTimeoutMs = 120_000;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The environment of the cluster programs: `base` in the C locale, without the libpq and server
 * variables (`PGHOST`, `PGPORT`, `PGDATA`, ...) that `devenv shell` sets for its own server.
 */
const programEnvironment = (base: Environment) => ({
  ...Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("PG"))),
  LC_ALL: "C",
});

const failure = (message: string, cause?: unknown) =>
  new DisposablePostgresFailure({ message, cause });

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream));

/** Runs `program` in this process group and fails with its standard error on a nonzero exit. */
const execute = (program: string, args: ReadonlyArray<string>, environment: Environment) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner.spawn(
        ChildProcess.make(program, args, {
          env: { ...environment },
          detached: false,
          stdin: "ignore",
        }),
      );

      const [, stderr, code] = yield* Effect.all(
        [text(handle.stdout), text(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );

      if (code !== 0)
        return yield* failure(`Command failed: ${[program, ...args].join(" ")}\n${stderr}`);
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(failure(`Command failed: ${program}: ${error.message}`, error)),
    ),
  );

// The kernel hands out port 0 binds and outgoing connections from its ephemeral range (Linux:
// 32768-60999; other systems use the IANA dynamic range, 49152-65535). A port below both is taken
// only by a process that names it.
const reservableFirst = 20_000;

const reservableEnd = 32_768;

// A reserved port is free until its server binds it, so no second reservation of this process may
// return it.
const reservedPorts = new Set<number>();

const portFree = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen({ host: loopback, port, exclusive: true }, () =>
      server.close(() => resume(Effect.succeed(true))),
    );
  });

/**
 * Whether a listener can bind `port` on loopback now.
 *
 * @remarks
 * It listens on `127.0.0.1:port` with an exclusive bind, closes again, and answers false when the
 * bind fails. A journey checks with it that a fixed port is free before its server binds it, and
 * that its reserved ports are free again after teardown. It reserves nothing: it answers for a
 * port that the caller names, and another process can bind the port after it answers.
 *
 * @sideEffects Binds `port` on loopback for the moment of the probe.
 *
 * @example
 * ```ts
 * if (!(await loopbackPortFree(port))) throw new Error(`port ${port} is still bound`);
 * ```
 *
 * @avoid Choosing the port of a server with it: another bind can take the port before the server
 * binds it. Reserve the ports of a journey with `reserveLoopbackPorts`.
 *
 * @construct test-harness
 */
export const loopbackPortFree = (port: number): Promise<boolean> => settle(portFree(port));

const reserveLoopbackPort = Effect.gen(function* () {
  for (let attempt = 0; attempt < reservableEnd - reservableFirst; attempt++) {
    const port = yield* Random.nextIntBetween(reservableFirst, reservableEnd, { halfOpen: true });

    if (!reservedPorts.has(port) && (yield* portFree(port))) {
      reservedPorts.add(port);

      return port;
    }
  }

  return yield* failure(`no free loopback port in ${reservableFirst}-${reservableEnd - 1}`);
});

/**
 * Reserves `count` distinct loopback ports for the servers that a journey starts: its backend,
 * dashboard, receivers, and clusters.
 *
 * @remarks
 * It draws each port at random from 20000 to 32767, below the kernel's ephemeral range, where
 * only a process that names a port binds it. A drawn port counts when `loopbackPortFree` answers
 * true and no earlier reservation of this process returned it. A probe that listens on port 0
 * learns a port in the ephemeral range instead, where the run's next probe, a child, or another
 * process can take it before its server binds it.
 *
 * @throws Rejects with an `Error` when no port of the range is free.
 *
 * @sideEffects Binds each drawn port on loopback for the moment of its probe, and keeps the
 * reserved ports in the process, so that no later reservation returns them.
 *
 * @example
 * ```ts
 * const [dashboardPort, backendPort, postgresPort] = await reserveLoopbackPorts(3);
 * ```
 *
 * @avoid Listening on port 0 and closing to learn a free port: another bind can take it before
 * the server does, and `anti-slop/no-port-probe` rejects such a probe in journey code.
 *
 * @construct test-harness
 */
export const reserveLoopbackPorts = (count: number): Promise<ReadonlyArray<number>> =>
  settle(Effect.replicateEffect(reserveLoopbackPort, count));

/** Where a client reaches a server: an address or a Unix socket directory, a port, and a role. */
export interface PostgresAddress {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

// pg_isready exits 0 when the server accepts connections, 1 when it rejects them (it starts up,
// shuts down, or recovers: SQLSTATE 57P03), 2 without a response, and 3 on invalid parameters.
const probe = (address: PostgresAddress, environment: Environment) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner.spawn(
        ChildProcess.make(
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
          { env: { ...environment }, detached: false, stdin: "ignore" },
        ),
      );

      const [report, code] = yield* Effect.all([text(handle.all), handle.exitCode], {
        concurrency: "unbounded",
      });

      return { code: Number(code), report: report.trim() };
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.succeed({ code: undefined, report: error.message }),
    ),
  );

/** Succeeds once the server at `address` accepts connections, as `pg_isready` reports. */
const awaitReady = (address: PostgresAddress, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    const environment = programEnvironment(process.env);

    for (;;) {
      const { code, report } = yield* probe(address, environment);

      if (code === 0) return;

      if (code === 3) return yield* failure(`pg_isready rejected its parameters: ${report}`);

      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* failure(
          `PostgreSQL at ${address.host}:${address.port} did not accept connections within ` +
            `${timeoutMs} ms. pg_isready last reported: ${report === "" ? `exit ${code ?? "without a code"}` : report}`,
        );

      yield* Effect.sleep(100);
    }
  });

/** Fails with the reason of `signal` once it aborts. */
const abandonment = (signal: AbortSignal): Effect.Effect<never, CallerRejection> =>
  Effect.callback<never, CallerRejection>((resume) => {
    const abandoned = () => resume(Effect.fail(new CallerRejection({ rejection: signal.reason })));

    if (signal.aborted) return abandoned();

    signal.addEventListener("abort", abandoned, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", abandoned));
  });

/**
 * Resolves once the server at `address` accepts connections, as `pg_isready` reports. An open
 * port is not enough: a server that starts up, shuts down, or recovers answers on its port and
 * rejects every session. Rejects after `timeoutMs`, or with the reason of `abandon` once it aborts.
 */
export const waitForPostgres: {
  (timeoutMs: number, abandon?: AbortSignal): (address: PostgresAddress) => Promise<void>;
  (address: PostgresAddress, timeoutMs: number, abandon?: AbortSignal): Promise<void>;
} = dual(
  (args) => Predicate.isObject(args[0]),
  (address: PostgresAddress, timeoutMs: number, abandon?: AbortSignal): Promise<void> =>
    settle(
      abandon === undefined
        ? awaitReady(address, timeoutMs)
        : Effect.raceFirst(awaitReady(address, timeoutMs), abandonment(abandon)),
    ),
);

// The owner holds the sentinel's standard input, so the sentinel reads end of file when the owner
// exits, however it exits. `stop` writes `released` instead, after it removed the cluster itself.
// A signal that ends the owner can reach the sentinel too, as a process-tree SIGTERM does, so the
// sentinel ignores HUP, INT, QUIT, and TERM; its own session keeps it out of process-group kills.
const sentinelScript = [
  "trap '' HUP INT QUIT TERM",
  'if read -r line && [ "$line" = released ]; then exit 0; fi',
  '"$1" stop --pgdata="$2" --mode=immediate --wait --timeout=30 >/dev/null 2>&1',
  'rm -rf -- "$3"',
].join("\n");

// The owner holds this sentinel's standard input too. When the owner exits without `stop`, the
// sentinel ends the pooler that its pid file names and removes the pooler's directory.
const poolerSentinelScript = [
  "trap '' HUP INT QUIT TERM",
  'if read -r line && [ "$line" = released ]; then exit 0; fi',
  'if [ -f "$1/pgbouncer.pid" ]; then kill -KILL "$(cat "$1/pgbouncer.pid")" 2>/dev/null; fi',
  'rm -rf -- "$1"',
].join("\n");

/**
 * Starts a sentinel shell in its own session whose standard input this process holds, and answers
 * the release, which tells the sentinel that `stop` removed what it watches and waits for its exit.
 * The sentinel's handle lives in a scope of its own that only the release closes, and it does not
 * keep this process alive: a pipe without pending writes holds no event loop.
 */
const sentinel = (
  script: string,
  name: string,
  args: ReadonlyArray<string>,
  environment: Environment | undefined,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();

    const handle = yield* spawner
      .spawn(
        ChildProcess.make("/bin/sh", ["-c", script, name, ...args], {
          env: environment === undefined ? undefined : { ...environment },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Scope.provide(scope));

    const reref = yield* handle.unref;

    const release = Effect.gen(function* () {
      yield* Effect.ignore(reref);
      yield* Effect.ignore(Stream.run(Stream.encodeText(Stream.make("released\n")), handle.stdin));
      yield* Effect.ignore(handle.exitCode);
      yield* Scope.close(scope, Exit.void);
    });

    return { release };
  });

/** Removes a directory tree, retrying as `rm` with `maxRetries: 3` did. */
const removeTree = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs
      .remove(root, { recursive: true, force: true })
      .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced(100) }));
  });

/** The last 4000 characters of a log, or `absent` when it cannot be read. */
const logTail = (file: string, absent: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(file).pipe(
      Effect.map((log) => log.slice(-4_000).trim()),
      Effect.orElseSucceed(() => absent),
    );
  });

/** The message of a failure cause, as an `Error` of it reads. */
const detailOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return { error, detail: error instanceof Error ? error.message : String(error) };
};

const waitsWithin = (exited: Deferred.Deferred<void>, milliseconds: number) =>
  Deferred.await(exited).pipe(Effect.timeoutOption(milliseconds), Effect.map(Option.isSome));

/** How `startDisposablePostgres` sets up a cluster. Every field is optional. */
export interface DisposablePostgresOptions {
  /** A database to create once the server accepts connections. `url` names it, or `postgres`. */
  readonly database?: string | undefined;
  /** The superuser that trust authentication admits without a password. Defaults to `postgres`. */
  readonly user?: string | undefined;
  /**
   * The port, which `reserveLoopbackPorts` reserved. Defaults to a port that it reserves. Without
   * TCP it only names the socket file.
   */
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
  readonly child: NodeChildProcess;
  readonly pid: number;
  /** Completes once the server exits. */
  readonly exited: Deferred.Deferred<void>;
  /** Fails once the server exits while nobody stops it. */
  readonly abandoned: Deferred.Deferred<never, DisposablePostgresFailure>;
  /** Whether `stop` or `outage` ends the server, so that its exit is no failure. */
  readonly state: { expected: boolean };
}

interface PostmasterSetup {
  readonly data: string;
  readonly port: number;
  readonly socketDirectory: string;
  readonly listen: "tcp" | "socket";
  readonly maxConnections: number | undefined;
  readonly logFile: string;
  readonly environment: Environment;
}

/**
 * Starts the postmaster in its own process group with the log file as its standard output and
 * error, and completes `ended` at its exit or failed start. The server must outlive a crash of
 * this process and get its signals alone, and its log must not pass through a pipe of this
 * process, which ChildProcess cannot express (EX-0017).
 */
const spawnPostmaster = (
  setup: PostmasterSetup,
  state: { expected: boolean },
  ended: Deferred.Deferred<{ readonly detail: string; readonly expected: boolean }>,
) =>
  Effect.try({
    try: () => {
      const log = openSync(setup.logFile, "a");
      let child: NodeChildProcess;

      try {
        child = spawn(
          programPath("postgres"),
          [
            "-D",
            setup.data,
            "-p",
            String(setup.port),
            "-k",
            setup.socketDirectory,
            "-c",
            `listen_addresses=${setup.listen === "tcp" ? loopback : ""}`,
            "-F",
            ...(setup.maxConnections === undefined
              ? []
              : ["-c", `max_connections=${setup.maxConnections}`]),
          ],
          { env: { ...setup.environment }, stdio: ["ignore", log, log], detached: true },
        );
      } finally {
        closeSync(log);
      }

      const end = (detail: string) =>
        Deferred.doneUnsafe(ended, Exit.succeed({ detail, expected: state.expected }));

      child.once("error", (cause) => end(`did not start: ${cause.message}`));
      child.once("exit", (code, signal) =>
        end(`exited with ${signal === null ? `code ${code}` : signal}`),
      );
      child.unref();

      return child;
    },
    catch: (cause) =>
      failure(`PostgreSQL did not start: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
  });

/** Sends `signal` to the postmaster alone, which relays the shutdown to its backends. */
const signalServer = (incarnation: Incarnation, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    incarnation.child.kill(signal);
  });

const startCluster = Effect.fnUntraced(function* (options: DisposablePostgresOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const user = options.user ?? "postgres";
  const listen = options.listen ?? "tcp";
  const environment = programEnvironment(options.environment ?? process.env);
  const version = postgresVersion();
  const port = options.port ?? (yield* reserveLoopbackPort);
  const root = options.directory ?? (yield* fs.makeTempDirectory({ prefix: "vektor-postgres-" }));

  if (options.directory !== undefined) yield* fs.makeDirectory(root, { mode: 0o700 });

  const data = path.join(root, "data");

  const { release } = yield* sentinel(
    sentinelScript,
    "vektor-postgres-sentinel",
    [programPath("pg_ctl"), data, root],
    environment,
  );

  const socketDirectory = path.join(root, "socket");
  const logFile = path.join(root, "postgres.log");
  const host = listen === "tcp" ? loopback : socketDirectory;
  const address = { host, port, user };
  const unexpected = Promise.withResolvers<Error>();
  let server: Incarnation | undefined;
  let stopping: Promise<void> | undefined;

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

  const launch = Effect.gen(function* () {
    const state = { expected: false };
    const ended = yield* Deferred.make<{ readonly detail: string; readonly expected: boolean }>();
    const exited = yield* Deferred.make<void>();
    const abandoned = yield* Deferred.make<never, DisposablePostgresFailure>();

    const child = yield* spawnPostmaster(
      {
        data,
        port,
        socketDirectory,
        listen,
        maxConnections: options.maxConnections,
        logFile,
        environment,
      },
      state,
      ended,
    );

    // The server's exit completes `exited`; an exit that nobody asked for also fails the start
    // that waits for it and settles `unexpectedExit`.
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        const { detail, expected } = yield* Deferred.await(ended);

        yield* Deferred.succeed(exited, undefined);

        if (expected) return;

        const exit = failure(
          `PostgreSQL ${detail}. Server log:\n${yield* logTail(logFile, "(no server log)")}`,
        );

        yield* Deferred.fail(abandoned, exit);
        unexpected.resolve(exit);
      }),
    );

    return { child, pid: child.pid ?? 0, exited, abandoned, state } satisfies Incarnation;
  });

  const run = Effect.gen(function* () {
    const incarnation = yield* launch;
    server = incarnation;

    yield* Effect.raceFirst(
      awaitReady(address, readinessTimeoutMs),
      Deferred.await(incarnation.abandoned),
    );
  });

  const halt = Effect.fnUntraced(function* (incarnation: Incarnation) {
    incarnation.state.expected = true;
    incarnation.child.ref();

    if (incarnation.child.exitCode !== null || incarnation.child.signalCode !== null) return;

    yield* signalServer(incarnation, "SIGINT");

    if (yield* waitsWithin(incarnation.exited, fastShutdownMs)) return;

    yield* signalServer(incarnation, "SIGQUIT");

    if (yield* waitsWithin(incarnation.exited, immediateShutdownMs)) return;

    yield* signalServer(incarnation, "SIGKILL");
    yield* Deferred.await(incarnation.exited);
  });

  const teardown = Effect.gen(function* () {
    if (server !== undefined) yield* halt(server);

    yield* removeTree(root);
  }).pipe(Effect.ensuring(release));

  const stop = () => (stopping ??= settle(teardown));

  const createDatabase = (database: string) =>
    execute(
      programPath("createdb"),
      ["--host", host, "--port", String(port), "--username", user, database],
      environment,
    ).pipe(Effect.as(urlOf(database)));

  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(socketDirectory, { mode: 0o700 });
    yield* execute(
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
      environment,
    ).pipe(
      Effect.timeoutOrElse({
        duration: initdbTimeoutMs,
        orElse: () => Effect.fail(failure(`initdb did not finish within ${initdbTimeoutMs} ms`)),
      }),
    );
    yield* run;

    if (options.database !== undefined) yield* createDatabase(options.database);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const { error, detail } = detailOf(cause);

        yield* Effect.exit(teardown);

        return yield* failure(`Disposable PostgreSQL did not start: ${detail}`, error);
      }),
    ),
  );

  const database = options.database ?? "postgres";

  const cluster: DisposablePostgres = {
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
    createDatabase: (name) => settle(createDatabase(name)),
    outage: (during) =>
      settle(
        Effect.gen(function* () {
          if (stopping !== undefined || server === undefined)
            return yield* failure("Disposable PostgreSQL is stopped");

          yield* halt(server);

          const result = yield* Effect.exit(callerPromise(during));

          yield* run;

          return yield* result;
        }),
      ),
    stop,
  };

  return cluster;
});

/**
 * Starts a fresh cluster of the selected major on a private port and socket directory with trust
 * authentication.
 *
 * @remarks
 * It runs `initdb` in a new directory and starts `postgres` on the port of `options.port`, or on
 * one that it reserves as `reserveLoopbackPorts` does. It resolves once `pg_isready` reports that
 * the server accepts connections, and `options.database` exists when it names one. The cluster
 * carries its address and `url`, `createDatabase`, `outage`, which stops and restarts the server
 * around a callback, and `unexpectedExit`. `stop` removes the cluster, and a sentinel in its own
 * session removes it when this process exits without `stop`, also on a signal or SIGKILL.
 *
 * @throws Rejects with an `Error` that carries the server log, when `initdb`, the server, or
 * `createdb` fails, or when the server accepts no connection within 60 seconds. It removes the
 * cluster first.
 *
 * @sideEffects Creates the cluster directory, starts the server and its sentinel, and binds a
 * loopback port and a Unix socket until `stop`.
 *
 * @example
 * ```ts
 * const postgres = await startDisposablePostgres({ port: postgresPort, database: "journey" });
 * ```
 *
 * @avoid Running `initdb`, `pg_ctl`, `postgres`, or `createdb` yourself, or taking an open port
 * for readiness: a server that starts up answers on its port and rejects every session.
 * `anti-slop/no-hand-rolled-postgres` rejects the cluster programs outside this construct.
 *
 * @construct test-harness
 */
export const startDisposablePostgres = (
  options: DisposablePostgresOptions = {},
): Promise<DisposablePostgres> => settle(startCluster(options));

/**
 * Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres`
 * starts, and removes the cluster when `use` settles, also when it fails.
 *
 * @remarks
 * `use` receives the connection URL of `database` as a `Redacted` value, so a log of it shows no
 * URL. The cluster stops after `use` settles, so the promise settles as `use` settled, after the
 * cluster is gone.
 *
 * @throws Rejects when the cluster does not start, as `startDisposablePostgres` rejects, and
 * with the failure of `use`.
 *
 * @sideEffects Starts and removes a disposable cluster, as `startDisposablePostgres` does.
 *
 * @example
 * ```ts
 * void withDisposablePostgres("rule_reconciliation_proof", (databaseUrl) => Effect.runPromise(program(databaseUrl)));
 * ```
 *
 * @avoid Starting a cluster without a `finally` that stops it: a failed assertion leaves the
 * cluster running until the process exits. Scope the cluster to `use`.
 *
 * @construct test-harness
 */
export const withDisposablePostgres: {
  <A>(
    use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>,
  ): (database: string) => Promise<A>;
  <A>(database: string, use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>): Promise<A>;
} = dual(
  2,
  <A>(database: string, use: (databaseUrl: Redacted.Redacted<string>) => Promise<A>): Promise<A> =>
    settle(
      Effect.gen(function* () {
        const cluster = yield* startCluster({ database });
        const result = yield* Effect.exit(callerPromise(() => use(Redacted.make(cluster.url))));

        yield* callerPromise(cluster.stop);

        return yield* result;
      }),
    ),
);

/** The PgBouncer program on `PATH`, which `devenv shell` provides. */
const pgbouncerProgram = Effect.suspend(() => {
  const found = onPath("pgbouncer");

  return found === undefined
    ? Effect.fail(failure("PgBouncer is required on PATH. Run the command inside `devenv shell`."))
    : Effect.succeed(found.file);
});

/** How `startDisposablePgBouncer` pools a cluster. Every field is optional. */
export interface DisposablePgBouncerOptions {
  /** `transaction` (the default), the mode of a managed transaction pooler, or `session`. */
  readonly poolMode?: "transaction" | "session" | undefined;
  /** Server connections per database and user. Defaults to 4. */
  readonly poolSize?: number | undefined;
  /** The loopback port, which `reserveLoopbackPorts` reserved. Defaults to a port that it reserves. */
  readonly port?: number | undefined;
}

/** A running PgBouncer that `startDisposablePgBouncer` owns. */
export interface DisposablePgBouncer {
  /** 127.0.0.1: the pooler listens on loopback TCP only. */
  readonly host: string;
  readonly port: number;
  /** The superuser of the cluster, which trust authentication admits. */
  readonly user: string;
  readonly poolMode: "transaction" | "session";
  /** The pooler log. `stop` removes it. */
  readonly logFile: string;
  /** The connection URL of a database of the cluster through the pooler. */
  readonly urlOf: (database: string) => string;
  /** Stops the pooler and removes its directory. Later calls return the first call's promise. */
  readonly stop: () => Promise<void>;
}

/** The pooler's process and the effect that lets it keep this process alive again. */
interface RunningPooler {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly reref: ChildProcessSpawner.Reref;
}

const startPooler = Effect.fnUntraced(function* (
  upstream: DisposablePostgres,
  options: DisposablePgBouncerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const poolMode = options.poolMode ?? "transaction";
  const port = options.port ?? (yield* reserveLoopbackPort);
  const root = yield* fs.makeTempDirectory({ prefix: "vektor-pgbouncer-" });

  const { release } = yield* sentinel(
    poolerSentinelScript,
    "vektor-pgbouncer-sentinel",
    [root],
    undefined,
  );

  const logFile = path.join(root, "pgbouncer.log");
  const configFile = path.join(root, "pgbouncer.ini");
  // The pooler outlives this program: its process lives in this scope until `stop` closes it.
  const scope = yield* Scope.make();
  let pooler: RunningPooler | undefined;
  let stopping: Promise<void> | undefined;

  const teardown = Effect.gen(function* () {
    if (pooler !== undefined && (yield* pooler.handle.isRunning)) {
      yield* pooler.reref;
      yield* Effect.ignore(
        pooler.handle.kill({ killSignal: "SIGQUIT", forceKillAfter: immediateShutdownMs }),
      );
    }

    yield* Scope.close(scope, Exit.void);
    yield* removeTree(root);
  }).pipe(Effect.ensuring(release));

  const stop = () => (stopping ??= settle(teardown));

  yield* Effect.gen(function* () {
    yield* fs.writeFileString(path.join(root, "users.txt"), `"${upstream.user}" ""\n`, {
      mode: 0o600,
    });
    yield* fs.writeFileString(
      configFile,
      [
        "[databases]",
        `* = host=${upstream.socketDirectory} port=${upstream.port} user=${upstream.user}`,
        "[pgbouncer]",
        `listen_addr = ${loopback}`,
        `listen_port = ${port}`,
        "unix_socket_dir =",
        "auth_type = trust",
        `auth_file = ${path.join(root, "users.txt")}`,
        `admin_users = ${upstream.user}`,
        `pool_mode = ${poolMode}`,
        `default_pool_size = ${options.poolSize ?? 4}`,
        "max_client_conn = 200",
        "track_extra_parameters = IntervalStyle, search_path",
        `logfile = ${logFile}`,
        `pidfile = ${path.join(root, "pgbouncer.pid")}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const handle = yield* spawner
      .spawn(
        ChildProcess.make(yield* pgbouncerProgram, [configFile], {
          env: programEnvironment(process.env),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError((error) => failure(`PgBouncer did not start: ${error.message}`, error)),
      );

    pooler = { handle, reref: yield* handle.unref };

    const exited = handle.exitCode.pipe(
      Effect.matchEffect({
        onSuccess: (code) => Effect.fail(failure(`PgBouncer exited with code ${code}`)),
        onFailure: (error) => Effect.fail(failure(`PgBouncer exited: ${error.message}`, error)),
      }),
    );

    yield* Effect.raceFirst(
      awaitReady({ host: loopback, port, user: upstream.user }, readinessTimeoutMs),
      exited,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const { error, detail } = detailOf(cause);
        const log = yield* logTail(logFile, "(no pooler log)");

        yield* Effect.exit(teardown);

        return yield* failure(
          `Disposable PgBouncer did not start: ${detail}. Pooler log:\n${log}`,
          error,
        );
      }),
    ),
  );

  const started: DisposablePgBouncer = {
    host: loopback,
    port,
    user: upstream.user,
    poolMode,
    logFile,
    urlOf: (database) =>
      `postgres://${encodeURIComponent(upstream.user)}@${loopback}:${port}/${encodeURIComponent(database)}`,
    stop,
  };

  return started;
});

/**
 * Starts PgBouncer on a private loopback port in front of `upstream`, with trust authentication
 * and every database of the cluster, in transaction pool mode unless `options` names another.
 * It resolves once the pooler accepts connections, as `pg_isready` reports.
 *
 * @remarks PgBouncer keeps `search_path` per client and restores it on a server connection only
 * where the server reports it, as PostgreSQL 18 does. On PostgreSQL 17 a client's startup
 * `search_path` does not reach the server, so a test names it on the database.
 * @sideEffects Writes a private directory with the configuration and log, starts the pooler in
 * its own process group, and starts a sentinel that ends it and removes the directory when this
 * process exits without `stop`.
 * @example
 * const pooler = await startDisposablePgBouncer(cluster, { poolSize: 4 });
 * const url = pooler.urlOf("pilot");
 * await pooler.stop();
 * @avoid Spawning `pgbouncer` elsewhere, and judging readiness by an open port.
 */
export const startDisposablePgBouncer: {
  (options?: DisposablePgBouncerOptions): (upstream: DisposablePostgres) => Promise<DisposablePgBouncer>;
  (upstream: DisposablePostgres, options?: DisposablePgBouncerOptions): Promise<DisposablePgBouncer>;
} = dual(
  (args) => Predicate.hasProperty(args[0], "socketDirectory"),
  (upstream: DisposablePostgres, options: DisposablePgBouncerOptions = {}): Promise<DisposablePgBouncer> =>
    settle(startPooler(upstream, options)),
);
