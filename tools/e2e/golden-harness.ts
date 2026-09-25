/**
 * Disposable local infrastructure for golden journeys.
 *
 * A journey receives a committed clean source snapshot, private loopback ports, a
 * private PostgreSQL cluster, a loopback notification provider, supervised process
 * groups, and an ordered checkpoint recorder. The harness owns interruption,
 * cleanup verification, and the `native-functional-journey/v1` receipt.
 *
 * Exit codes: 0 passed, 1 failed, 130 SIGINT, 143 SIGTERM. A signal interrupts the
 * journey fiber; its scope then releases processes, listeners, and pools before the
 * harness verifies that nothing it started survives.
 */
import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import { postgresProgram } from "@monoweb/postgres";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  Cause,
  DateTime,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Predicate,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { Pool, type PoolClient } from "pg";

export const receiptSchemaVersion = "native-functional-journey/v1";

const logTailCharacters = 131_072;

const failureLogCharacters = 6_000;

/** A harness or journey failure attributed to the stage that observed it. */
export class HarnessFailure extends Schema.TaggedError<HarnessFailure>()("HarnessFailure", {
  stage: Schema.String,
  message: Schema.String,
}) {}

class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {}) {}

const InterruptionReason = Schema.Literals(["SIGINT", "SIGTERM", "deadline"]);

type InterruptionReason = typeof InterruptionReason.Type;

class JourneyInterrupted extends Schema.TaggedError<JourneyInterrupted>()("JourneyInterrupted", {
  reason: InterruptionReason,
}) {}

export const describeCause = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

/** Maps an arbitrary rejection to a failure; an existing harness failure passes through. */
export const failure =
  (stage: string) =>
  (cause: unknown): HarnessFailure =>
    cause instanceof HarnessFailure
      ? cause
      : new HarnessFailure({ stage, message: describeCause(cause) });

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

const tail = (text: string, characters: number) => text.slice(-characters);

// Redaction runs on read, so a secret registered after a log line was captured still disappears.
class Redactor {
  private readonly secrets = new Set<string>();

  register(secret: string) {
    this.secrets.add(secret);
  }

  apply(text: string) {
    let redacted = text;

    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");

    return redacted.replace(
      /(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/giu,
      "$1$2[REDACTED]",
    );
  }

  leaks(text: string) {
    return [...this.secrets].some((secret) => text.includes(secret));
  }
}

class LogTail {
  private text = "";

  append(chunk: string) {
    this.text = tail(this.text + chunk, logTailCharacters);
  }

  read() {
    return this.text;
  }
}

/** One process group started by the harness. */
export interface ProcessSpec {
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Signal sent to the whole process group on release. Defaults to SIGTERM. */
  readonly killSignal?: ChildProcess.Signal | undefined;
  /** Grace before SIGKILL escalation. */
  readonly forceKillAfter?: Duration.Input | undefined;
  /** An exit before scope release fails the journey. */
  readonly supervised?: boolean | undefined;
}

export interface OwnedProcess {
  readonly label: string;
  readonly pid: number;
  readonly isRunning: Effect.Effect<boolean>;
  readonly logTail: Effect.Effect<string>;
}

interface LedgerProcess {
  readonly label: string;
  readonly pid: number;
  readonly log: LogTail;
  exit: string | null;
  stopping: boolean;
}

export type ProviderMode = "accept" | "fail";

export type ProviderAttempt = {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly mode: ProviderMode;
  readonly idempotencyKey: string | null;
  readonly status: number;
  readonly rejection: string | null;
  readonly bodySha256: string | null;
  readonly body: Schema.Json;
};

interface ProviderState {
  readonly url: string;
  mode: ProviderMode;
  active: number;
  maxActive: number;
  readonly attempts: Array<ProviderAttempt>;
}

interface Ledger {
  readonly processes: Array<LedgerProcess>;
  readonly ports: Array<number>;
  readonly providers: Array<ProviderState>;
  readonly supervision: Deferred.Deferred<HarnessFailure>;
  readonly redactor: Redactor;
}

/** Runs one command to completion and returns its standard output. */
type Run = (
  spec: ProcessSpec,
  deadline: Duration.Input,
) => Effect.Effect<string, HarnessFailure, BunServices.BunServices>;

/**
 * Starts one detached process group in the caller scope and records it for
 * cleanup verification. Release signals the whole group, then escalates to SIGKILL.
 */
const acquireProcess = Effect.fnUntraced(function* (
  ledger: Ledger,
  spec: ProcessSpec,
  forceKillAfter: Duration.Input,
) {
  const handle = yield* ChildProcess.make(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: false,
    detached: true,
    stdin: "ignore",
    killSignal: spec.killSignal ?? "SIGTERM",
    forceKillAfter,
  }).pipe(Effect.mapError(failure(spec.label)));

  const entry: LedgerProcess = {
    label: spec.label,
    pid: handle.pid,
    log: new LogTail(),
    exit: null,
    stopping: false,
  };

  ledger.processes.push(entry);

  return { handle, entry };
});

/**
 * Starts one long-running process group in the caller scope.
 *
 * Release order: mark the exit as expected, signal the group with escalation, then
 * drain the log collector for at most two seconds.
 */
const spawnOwned = (ledger: Ledger) =>
  Effect.fnUntraced(function* (spec: ProcessSpec) {
    let collector: Fiber.Fiber<void> | undefined;

    yield* Effect.addFinalizer(() =>
      collector === undefined
        ? Effect.void
        : Fiber.await(collector).pipe(
            Effect.timeout("2 seconds"),
            Effect.ignore,
            Effect.andThen(Fiber.interrupt(collector)),
          ),
    );

    const { handle, entry } = yield* acquireProcess(
      ledger,
      spec,
      spec.forceKillAfter ?? "5 seconds",
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        entry.stopping = true;
      }),
    );

    collector = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => entry.log.append(chunk))),
      Effect.ignore,
      Effect.forkDetach,
    );

    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const error = Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause);

          // The spawner wraps the signal report in a PlatformError cause.
          entry.exit = Exit.isSuccess(exit)
            ? `code ${exit.value}`
            : error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : String(error);

          if (spec.supervised === true && !entry.stopping)
            yield* Deferred.succeed(
              ledger.supervision,
              new HarnessFailure({
                stage: spec.label,
                message: `exited unexpectedly (${entry.exit}): ${ledger.redactor.apply(tail(entry.log.read(), failureLogCharacters))}`,
              }),
            );
        }),
      ),
      Effect.forkDetach,
    );

    return {
      label: spec.label,
      pid: handle.pid,
      isRunning: handle.isRunning.pipe(Effect.orElseSucceed(() => false)),
      logTail: Effect.sync(() => ledger.redactor.apply(entry.log.read())),
    } satisfies OwnedProcess;
  });

const runToCompletion =
  (ledger: Ledger): Run =>
  (spec, deadline) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handle, entry } = yield* acquireProcess(
          ledger,
          spec,
          spec.forceKillAfter ?? "2 seconds",
        );

        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(failure(spec.label)),
          Effect.timeoutOrElse({
            duration: deadline,
            orElse: () =>
              Effect.fail(new HarnessFailure({ stage: spec.label, message: "deadline exceeded" })),
          }),
        );

        entry.exit = `code ${code}`;

        if (code !== 0)
          return yield* new HarnessFailure({
            stage: spec.label,
            message: `exited with code ${code}: ${ledger.redactor.apply(tail(stdout + stderr, failureLogCharacters))}`,
          });

        return stdout;
      }),
    );

export interface SourceFile {
  readonly path: string;
  readonly sha256: string;
}

export interface SourceSnapshot {
  readonly revision: string;
  readonly tree: string;
  readonly files: ReadonlyArray<SourceFile>;
}

/** Requires a committed clean tree and digests every tracked file below the pathspecs. */
const captureSource = Effect.fnUntraced(function* (
  run: Run,
  root: string,
  environment: Readonly<Record<string, string>>,
  pathspecs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;

  const git = (args: ReadonlyArray<string>) =>
    run({ label: "git", command: "git", args, cwd: root, env: environment }, "60 seconds");

  if ((yield* git(["status", "--porcelain"])).trim() !== "")
    return yield* new HarnessFailure({
      stage: "source",
      message: "requires committed clean source",
    });

  const revision = (yield* git(["rev-parse", "HEAD"])).trim();
  const tree = (yield* git(["rev-parse", "HEAD^{tree}"])).trim();
  const paths = (yield* git(["ls-files", "-z", "--", ...pathspecs])).split("\0").filter(Boolean);

  const files = yield* Effect.forEach(
    paths,
    (path) =>
      fs.readFile(join(root, path)).pipe(
        Effect.map((bytes): SourceFile => ({ path, sha256: sha256Hex(bytes) })),
        Effect.mapError(failure("source")),
      ),
    { concurrency: 16 },
  );

  return { revision, tree, files } satisfies SourceSnapshot;
});

const verifySource = Effect.fnUntraced(function* (
  run: Run,
  root: string,
  environment: Readonly<Record<string, string>>,
  pathspecs: ReadonlyArray<string>,
  expected: SourceSnapshot,
) {
  const observed = yield* captureSource(run, root, environment, pathspecs);

  if (
    observed.revision !== expected.revision ||
    sha256Hex(canonicalJsonBytes(observed.files)) !== sha256Hex(canonicalJsonBytes(expected.files))
  )
    return yield* new HarnessFailure({
      stage: "source",
      message: "source changed during acceptance",
    });
});

/** Environment passed to children; nothing else from the operator shell leaks in. */
export const safeEnvironment = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TZ",
      "LD_LIBRARY_PATH",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
      "PLAYWRIGHT_NODE_EXECUTABLE",
      "PLAYWRIGHT_BROWSERS_PATH",
    ].flatMap((key) => {
      const value = process.env[key];

      return value === undefined ? [] : [[key, value]];
    }),
  );

const makeLedger = Effect.map(
  Deferred.make<HarnessFailure>(),
  (supervision): Ledger => ({
    processes: [],
    ports: [],
    providers: [],
    supervision,
    redactor: new Redactor(),
  }),
);

/** Clean-source guard and manifest for tools that do not run a journey. */
export const inspectSource = (root: string, pathspecs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ledger = yield* makeLedger;

    return yield* captureSource(runToCompletion(ledger), root, safeEnvironment(), pathspecs);
  });

const TcpAddress = Schema.Struct({ port: Schema.Int });

const bindLoopback = (port: number) =>
  Effect.callback<number, HarnessFailure>((resume) => {
    const server = createTcpServer();

    server.once("error", (cause) =>
      resume(
        Effect.fail(
          new HarnessFailure({ stage: "ports", message: `127.0.0.1:${port}: ${cause.message}` }),
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => {
      const bound = Schema.decodeUnknownSync(TcpAddress)(server.address()).port;

      server.close(() => resume(Effect.succeed(bound)));
    });
  });

/** Binds port 0 until it knows `count` distinct loopback ports that `taken` does not hold. */
const distinctLoopbackPorts = (count: number, taken: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const ports: Array<number> = [];

    while (ports.length < count) {
      const port = yield* bindLoopback(0);

      if (!ports.includes(port) && !taken.includes(port)) ports.push(port);
    }

    return ports;
  });

/** The golden journeys' port reservation for runners that do not run inside the harness. */
export const reserveLoopbackPorts = (count: number): Promise<ReadonlyArray<number>> =>
  Effect.runPromise(distinctLoopbackPorts(count, []));

/** Polls a condition until it holds; a typed failure from the check ends polling at once. */
export const eventually = <R>(
  label: string,
  check: Effect.Effect<boolean, HarnessFailure, R>,
  deadline: Duration.Input,
): Effect.Effect<void, HarnessFailure, R> =>
  check.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new NotReady()))),
    Effect.retry({
      while: (error) => Predicate.isTagged(error, "NotReady"),
      schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: deadline })),
    }),
    Effect.catchTag("NotReady", () =>
      Effect.fail(new HarnessFailure({ stage: label, message: `Timed out: ${label}` })),
    ),
  );

export interface HttpProbe {
  readonly label: string;
  readonly url: string;
  /** Host header override for virtual-host routing on a loopback listener. */
  readonly host?: string | undefined;
  /** Fails immediately when this process exits before readiness. */
  readonly process?: OwnedProcess | undefined;
  readonly deadline: Duration.Input;
}

/** Waits for a 2xx response over node:http, which honours an explicit Host header. */
export const waitForHttp = (probe: HttpProbe) =>
  eventually(
    probe.label,
    Effect.gen(function* () {
      if (probe.process !== undefined && !(yield* probe.process.isRunning))
        return yield* new HarnessFailure({
          stage: probe.label,
          message: `exited before ready: ${tail(yield* probe.process.logTail, failureLogCharacters)}`,
        });

      const url = new URL(probe.url);

      const status = yield* Effect.callback<number>((resume) => {
        const request = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: probe.host === undefined ? {} : { host: probe.host },
            timeout: 2_000,
          },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          },
        );

        request.once("timeout", () => request.destroy());
        request.once("error", () => resume(Effect.succeed(0)));
        request.end();

        return Effect.sync(() => request.destroy());
      });

      return status >= 200 && status <= 299;
    }),
    probe.deadline,
  );

export interface DisposablePostgres {
  readonly url: string;
  readonly port: number;
  /** Independent observer pool: two connections, released before the server stops. */
  readonly pool: Pool;
  readonly process: OwnedProcess;
}

type SqlValue = string | number | boolean | null;

const statement = (client: PoolClient, text: string) =>
  Effect.tryPromise({ try: () => client.query(text), catch: failure("snapshot") }).pipe(
    Effect.asVoid,
  );

/** Runs one read-only REPEATABLE READ transaction, so every read shares one snapshot. */
export const readOnlySnapshot = <A, R>(
  pool: Pool,
  read: (client: PoolClient) => Effect.Effect<A, HarnessFailure, R>,
): Effect.Effect<A, HarnessFailure, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => pool.connect(), catch: failure("snapshot") }),
    (client) =>
      statement(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").pipe(
        Effect.andThen(read(client)),
        Effect.tap(() => statement(client, "COMMIT")),
      ),
    (client, exit) =>
      (Exit.isSuccess(exit) ? Effect.void : Effect.ignore(statement(client, "ROLLBACK"))).pipe(
        Effect.ensuring(Effect.sync(() => client.release())),
      ),
  );

/** Queries one relation and decodes every row at the persistence boundary. */
export const selectRows = <Row>(
  client: PoolClient,
  label: string,
  text: string,
  values: ReadonlyArray<SqlValue>,
  row: Schema.Decoder<Row>,
) =>
  Effect.tryPromise({ try: () => client.query(text, [...values]), catch: failure(label) }).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(Schema.Array(row))(result.rows).pipe(
        Effect.mapError(failure(label)),
      ),
    ),
  );

export interface ProviderSpec {
  readonly port: number;
  readonly path: string;
  readonly token: string;
  readonly maxBodyBytes: number;
}

export interface LoopbackProvider {
  readonly url: string;
  readonly setMode: (mode: ProviderMode) => Effect.Effect<void>;
  readonly attempts: Effect.Effect<ReadonlyArray<ProviderAttempt>>;
}

const JsonBody = Schema.fromJsonString(Schema.Json);

const respond = (
  state: ProviderState,
  spec: ProviderSpec,
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
) => {
  const idempotencyKey = request.headers["idempotency-key"];

  const rejection =
    request.method !== "POST" || request.url !== spec.path
      ? { status: 404, reason: "route" }
      : request.headers.authorization !== `Bearer ${spec.token}`
        ? { status: 401, reason: "credential" }
        : !(request.headers["content-type"] ?? "").startsWith("application/json")
          ? { status: 415, reason: "media-type" }
          : bytes.length > spec.maxBodyBytes
            ? { status: 413, reason: "size" }
            : null;

  const body =
    rejection === null
      ? Schema.decodeOption(JsonBody)(bytes.toString("utf8"))
      : Option.none<Schema.Json>();

  const status =
    rejection !== null
      ? rejection.status
      : Option.isNone(body)
        ? 400
        : state.mode === "accept"
          ? 204
          : 503;

  state.attempts.push({
    sequence: state.attempts.length + 1,
    receivedAt: new Date().toISOString(),
    mode: state.mode,
    idempotencyKey: Array.isArray(idempotencyKey) ? null : (idempotencyKey ?? null),
    status,
    rejection: rejection?.reason ?? (status === 400 ? "json" : null),
    bodySha256: rejection === null ? sha256Hex(bytes) : null,
    body: Option.getOrNull(body),
  });
  response.writeHead(status).end();
};

/** Loopback notification receiver with accept and fail modes and attempt recording. */
const startProvider = (ledger: Ledger) => (spec: ProviderSpec) =>
  Effect.gen(function* () {
    const state: ProviderState = {
      url: `http://127.0.0.1:${spec.port}${spec.path}`,
      mode: "accept",
      active: 0,
      maxActive: 0,
      attempts: [],
    };

    const handle = (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Array<Buffer> = [];
      let size = 0;

      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      response.once("close", () => {
        state.active -= 1;
      });
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;

        if (size <= spec.maxBodyBytes + 1) chunks.push(chunk);
      });
      request.once("end", () => respond(state, spec, request, response, Buffer.concat(chunks)));
      request.once("error", () => response.destroy());
    };

    yield* Effect.acquireRelease(
      Effect.callback<Server, HarnessFailure>((resume) => {
        const server = createHttpServer(handle);

        server.once("error", (cause) => resume(Effect.fail(failure("provider")(cause))));
        server.listen(spec.port, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeAllConnections();
        }),
    );

    ledger.providers.push(state);

    return {
      url: state.url,
      setMode: (mode: ProviderMode) =>
        Effect.sync(() => {
          state.mode = mode;
        }),
      attempts: Effect.sync(() => [...state.attempts]),
    } satisfies LoopbackProvider;
  });

/** Starts a private cluster with trust authentication on one loopback port. */
const startPostgres =
  (
    ledger: Ledger,
    root: string,
    privateRoot: string,
    environment: Readonly<Record<string, string>>,
  ) =>
  (port: number, applicationName: string) =>
    Effect.gen(function* () {
      const data = join(privateRoot, "postgres");

      const programs = yield* Effect.try({
        try: () => ({ initdb: postgresProgram("initdb"), postgres: postgresProgram("postgres") }),
        catch: failure("postgres"),
      });

      yield* runToCompletion(ledger)(
        {
          label: "initdb",
          command: programs.initdb,
          args: ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
          cwd: root,
          env: environment,
        },
        "120 seconds",
      );

      const server = yield* spawnOwned(ledger)({
        label: "postgres",
        command: programs.postgres,
        args: [
          "-D",
          data,
          "-p",
          String(port),
          "-h",
          "127.0.0.1",
          "-k",
          privateRoot,
          "-c",
          "max_connections=40",
        ],
        cwd: root,
        env: environment,
        // Fast shutdown ends sessions; smart shutdown would wait for every client.
        killSignal: "SIGINT",
        forceKillAfter: "15 seconds",
        supervised: true,
      });

      const url = `postgres://postgres@127.0.0.1:${port}/postgres`;

      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const created = new Pool({
            connectionString: url,
            max: 2,
            connectionTimeoutMillis: 1_000,
            statement_timeout: 10_000,
            application_name: applicationName,
          });

          // Idle-client errors surface through supervision and the next query, not a crash.
          created.on("error", () => undefined);

          return created;
        }),
        (created) =>
          Effect.promise(() => created.end()).pipe(Effect.timeout("5 seconds"), Effect.ignore),
      );

      yield* eventually(
        "PostgreSQL ready",
        Effect.tryPromise({ try: () => pool.query("SELECT 1"), catch: failure("postgres") }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
        "30 seconds",
      );

      return { url, port, pool, process: server } satisfies DisposablePostgres;
    });

type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly rssKiB: number;
  readonly state: string;
  readonly name: string;
};

type ResourceSample = {
  readonly label: string;
  readonly observedAt: string;
  readonly scope: string;
  readonly processCount: number;
  readonly totalRssKiB: number;
  readonly processes: ReadonlyArray<ProcessRow>;
};

/** Live descendants of this runner, excluding the sampling `ps` and zombies. */
const descendants = (run: Run, root: string, environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const output = yield* run(
      {
        label: "ps",
        command: "ps",
        args: ["-eo", "pid=,ppid=,pgid=,rss=,stat=,comm="],
        cwd: root,
        env: environment,
      },
      "10 seconds",
    );

    const rows = output.split("\n").flatMap((line): Array<ProcessRow> => {
      const [pid, ppid, pgid, rss, state, ...name] = line.trim().split(/\s+/u);

      return pid === undefined || state === undefined
        ? []
        : [
            {
              pid: Number(pid),
              ppid: Number(ppid),
              pgid: Number(pgid),
              rssKiB: Number(rss),
              state,
              name: name.join(" "),
            },
          ];
    });

    const owned = new Set([process.pid]);

    for (let grew = true; grew;) {
      const before = owned.size;

      for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);

      grew = owned.size > before;
    }

    return rows.filter(
      (row) =>
        row.pid !== process.pid &&
        owned.has(row.pid) &&
        !row.state.startsWith("Z") &&
        !(row.ppid === process.pid && row.name === "ps"),
    );
  });

// Signal 0 probes the whole group; ESRCH is the only proof that no member remains.
const groupAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, 0);

      return true;
    } catch (cause) {
      return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
    }
  });

const kill = (target: number, signal: NodeJS.Signals) =>
  Effect.ignore(Effect.try({ try: () => process.kill(target, signal), catch: failure("cleanup") }));

const allGroupsGone = (ledger: Ledger) =>
  Effect.forEach(ledger.processes, (entry) => groupAlive(entry.pid)).pipe(
    Effect.map((alive) => alive.every((value) => !value)),
  );

type CleanupReport = {
  readonly processesExited: boolean;
  readonly descendantsExited: boolean;
  readonly listenersReleased: boolean;
  readonly privateResourcesRemoved: boolean;
  readonly processes: ReadonlyArray<{
    readonly label: string;
    readonly pid: number;
    readonly exit: string | null;
    readonly alive: boolean;
  }>;
  readonly ports: ReadonlyArray<{ readonly port: number; readonly released: boolean }>;
  readonly privateRoot: string;
  readonly survivors: ReadonlyArray<ProcessRow>;
  readonly errors: ReadonlyArray<string>;
};

/**
 * Proves release after the journey scope closed. A surviving owned group or
 * descendant is killed and reported; the private root is removed only after every
 * owned process group is gone.
 */
const verifyCleanup = (
  ledger: Ledger,
  run: Run,
  root: string,
  environment: Readonly<Record<string, string>>,
  privateRoot: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const errors: Array<string> = [];

    const processes = yield* Effect.forEach(ledger.processes, (entry) =>
      groupAlive(entry.pid).pipe(
        Effect.map((alive) => ({ label: entry.label, pid: entry.pid, exit: entry.exit, alive })),
      ),
    );

    for (const entry of processes.filter(({ alive }) => alive)) {
      errors.push(`${entry.label} process group ${entry.pid} survived release`);
      yield* kill(-entry.pid, "SIGKILL");
    }

    const survivors = yield* descendants(run, root, environment);

    for (const row of survivors) {
      errors.push(`descendant ${row.pid} (${row.name}) survived release`);
      yield* kill(row.pid, "SIGKILL");
    }

    yield* eventually("killed survivors exited", allGroupsGone(ledger), "10 seconds").pipe(
      Effect.catch((error) => Effect.sync(() => void errors.push(error.message))),
    );

    const ports = yield* Effect.forEach(ledger.ports, (port) =>
      bindLoopback(port).pipe(
        Effect.as({ port, released: true }),
        Effect.orElseSucceed(() => ({ port, released: false })),
      ),
    );

    for (const { port } of ports.filter(({ released }) => !released))
      errors.push(`owned listener ${port} remains`);

    if (yield* allGroupsGone(ledger))
      yield* fs
        .remove(privateRoot, { recursive: true, force: true })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => void errors.push(`private root removal: ${error.message}`)),
          ),
        );
    else errors.push("private root retained because an owned process survived");

    const removed = !(yield* fs.exists(privateRoot).pipe(Effect.orElseSucceed(() => true)));

    return {
      processesExited: processes.every(({ alive }) => !alive),
      descendantsExited: survivors.length === 0,
      listenersReleased: ports.every(({ released }) => released),
      privateResourcesRemoved: removed,
      processes,
      ports,
      privateRoot,
      survivors,
      errors,
    } satisfies CleanupReport;
  });

export interface GoldenContext {
  readonly root: string;
  /** Retained artifact directory; every file here enters the receipt inventory. */
  readonly artifacts: string;
  /** Mode 0700 directory removed during cleanup verification. */
  readonly privateRoot: string;
  readonly revision: string;
  readonly sourceTree: string;
  readonly fault: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
  /** Random hex credential registered for redaction in every artifact and log. */
  readonly secret: (bytes: number) => Effect.Effect<string>;
  readonly reservePorts: (count: number) => Effect.Effect<ReadonlyArray<number>, HarnessFailure>;
  readonly spawn: (
    spec: ProcessSpec,
  ) => Effect.Effect<
    OwnedProcess,
    HarnessFailure,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly run: Run;
  readonly postgres: (
    port: number,
    applicationName: string,
  ) => Effect.Effect<DisposablePostgres, HarnessFailure, Scope.Scope | BunServices.BunServices>;
  readonly provider: (
    spec: ProviderSpec,
  ) => Effect.Effect<LoopbackProvider, HarnessFailure, Scope.Scope>;
  /** Records one ordered checkpoint; `observe` asserts and returns the observed facts. */
  readonly checkpoint: <R>(
    step: string,
    observe: Effect.Effect<Schema.Json, HarnessFailure, R>,
  ) => Effect.Effect<void, HarnessFailure, R | BunServices.BunServices>;
  /** Fails, or signals this runner with SIGTERM, when the selected fault names this point. */
  readonly faultPoint: (point: string) => Effect.Effect<void, HarnessFailure>;
  /** Adds one JSON document to `evidence.json` under `journeyEvidence`. */
  readonly record: (key: string, value: Schema.Json) => Effect.Effect<void>;
  readonly sample: (label: string) => Effect.Effect<void, HarnessFailure, BunServices.BunServices>;
}

export interface GoldenJourney {
  /** Receipt journey reference `intent://<id>` and artifact directory prefix. */
  readonly id: string;
  /** Git pathspecs digested into the source manifest and re-verified at the end. */
  readonly sourcePaths: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
  readonly faultVariable: string;
  /** Allowed fault points; each also allows `interrupt-<point>`. */
  readonly faultPoints: ReadonlyArray<string>;
  readonly deadline: Duration.Input;
  readonly requiredBrowser: boolean;
  readonly body: (
    context: GoldenContext,
  ) => Effect.Effect<void, HarnessFailure, Scope.Scope | BunServices.BunServices>;
}

type Observation = {
  readonly step: string;
  readonly observedAt: string;
  readonly factsSha256: string;
  readonly facts: Schema.Json;
};

type Outcome =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly failure: string }
  | { readonly kind: "interrupted"; readonly reason: InterruptionReason };

const exitCodeFor = (reason: InterruptionReason | undefined, passed: boolean) =>
  reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : passed ? 0 : 1;

/** Installs SIGINT and SIGTERM listeners for the scope; the first signal is retained. */
const interceptSignals = (
  signals: Deferred.Deferred<InterruptionReason>,
  received: Array<string>,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      (["SIGINT", "SIGTERM"] as const).map((signal) => {
        const listener = () => {
          received.push(signal);
          Deferred.doneUnsafe(signals, Effect.succeed(signal));
        };

        process.on(signal, listener);

        return [signal, listener] as const;
      }),
    ),
    (listeners) =>
      Effect.sync(() => {
        for (const [signal, listener] of listeners) process.removeListener(signal, listener);
      }),
  );

const main = (journey: GoldenJourney, root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const environment = safeEnvironment();
    const fault = process.env[journey.faultVariable];

    if (
      fault !== undefined &&
      !journey.faultPoints.some((point) => fault === point || fault === `interrupt-${point}`)
    )
      return yield* new HarnessFailure({
        stage: "preflight",
        message: `unknown journey fault: ${fault}`,
      });

    const ledger = yield* makeLedger;
    const run = runToCompletion(ledger);
    const source = yield* captureSource(run, root, environment, journey.sourcePaths);

    const artifacts = yield* fs
      .makeTempDirectory({ prefix: `vektor-${journey.id}-` })
      .pipe(Effect.mapError(failure("artifacts")));

    const privateRoot = join(artifacts, "private");

    yield* fs
      .makeDirectory(privateRoot, { mode: 0o700 })
      .pipe(Effect.mapError(failure("artifacts")));
    yield* Effect.sync(() =>
      process.stdout.write(`artifacts: ${artifacts}\nrunner-pid: ${process.pid}\n`),
    );

    const signals = yield* Deferred.make<InterruptionReason>();
    const received: Array<string> = [];
    const observations: Array<Observation> = [];
    const samples: Array<ResourceSample> = [];
    const records = new Map<string, Schema.Json>();

    const sample = (label: string) =>
      Effect.gen(function* () {
        const processes = yield* descendants(run, root, environment);

        samples.push({
          label,
          observedAt: yield* isoNow,
          scope: "runner and live descendants; point-in-time RSS, not a peak",
          processCount: processes.length,
          totalRssKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0),
          processes,
        });
      });

    const context: GoldenContext = {
      root,
      artifacts,
      privateRoot,
      revision: source.revision,
      sourceTree: source.tree,
      fault,
      environment,
      secret: (bytes) =>
        Effect.sync(() => {
          const value = randomBytes(bytes).toString("hex");

          ledger.redactor.register(value);

          return value;
        }),
      reservePorts: (count) =>
        distinctLoopbackPorts(count, ledger.ports).pipe(
          Effect.tap((ports) => Effect.sync(() => ledger.ports.push(...ports))),
        ),
      spawn: spawnOwned(ledger),
      run,
      postgres: startPostgres(ledger, root, privateRoot, environment),
      provider: startProvider(ledger),
      checkpoint: (step, observe) =>
        Effect.gen(function* () {
          const expected = journey.steps[observations.length];

          if (step !== expected)
            return yield* new HarnessFailure({
              stage: "checkpoint",
              message: `checkpoint order: expected ${expected ?? "none"}, observed ${step}`,
            });

          const facts = yield* observe;

          observations.push({
            step,
            observedAt: yield* isoNow,
            factsSha256: sha256Hex(canonicalJsonBytes(facts)),
            facts,
          });
          yield* sample(step);
          yield* Effect.sync(() => process.stdout.write(`checkpoint: ${step}\n`));
        }),
      faultPoint: (point) =>
        fault === point
          ? Effect.fail(
              new HarnessFailure({ stage: "fault", message: `Injected journey failure ${point}` }),
            )
          : fault === `interrupt-${point}`
            ? Effect.sync(() => process.kill(process.pid, "SIGTERM")).pipe(
                Effect.andThen(Effect.never),
              )
            : Effect.void,
      record: (key, value) => Effect.sync(() => void records.set(key, value)),
      sample,
    };

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* interceptSignals(signals, received);
        yield* sample("baseline");

        const interruption = Effect.raceFirst(
          Deferred.await(signals),
          Effect.sleep(journey.deadline).pipe(Effect.as<InterruptionReason>("deadline")),
        ).pipe(Effect.flatMap((reason) => Effect.fail(new JourneyInterrupted({ reason }))));

        const supervision = Deferred.await(ledger.supervision).pipe(
          Effect.flatMap((error) => Effect.fail(error)),
        );

        const outcome = yield* Effect.scoped(journey.body(context)).pipe(
          Effect.andThen(() =>
            observations.length === journey.steps.length
              ? Effect.void
              : Effect.fail(
                  new HarnessFailure({
                    stage: "checkpoint",
                    message: `observed ${observations.length} of ${journey.steps.length} required steps`,
                  }),
                ),
          ),
          Effect.raceFirst(interruption),
          Effect.raceFirst(supervision),
          Effect.as<Outcome>({ kind: "passed" }),
          Effect.catchTag("JourneyInterrupted", (error) =>
            Effect.succeed<Outcome>({ kind: "interrupted", reason: error.reason }),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);

            return Effect.succeed<Outcome>({
              kind: "failed",
              failure:
                error instanceof HarnessFailure
                  ? `${error.stage}: ${error.message}`
                  : Cause.pretty(cause),
            });
          }),
        );

        const cleanup = yield* verifyCleanup(ledger, run, root, environment, privateRoot);

        yield* sample("after-cleanup");

        const sourceCheck = yield* verifySource(
          run,
          root,
          environment,
          journey.sourcePaths,
          source,
        ).pipe(
          Effect.as<string | null>(null),
          Effect.catch((error) => Effect.succeed<string | null>(error.message)),
        );

        const signal = (yield* Deferred.isDone(signals))
          ? yield* Deferred.await(signals)
          : undefined;

        const reason = outcome.kind === "interrupted" ? outcome.reason : signal;

        const primary =
          outcome.kind === "failed"
            ? outcome.failure
            : reason !== undefined
              ? `Interrupted: ${reason}`
              : cleanup.errors.length > 0
                ? `Resource cleanup failed: ${cleanup.errors.join("; ")}`
                : (sourceCheck ?? undefined);

        const logs = ledger.processes
          .flatMap((entry) =>
            entry.log.read() === ""
              ? []
              : [
                  `== ${entry.label} (${entry.pid}) ${entry.exit ?? "running"}\n${entry.log.read()}`,
                ],
          )
          .join("\n");

        const evidence = {
          passed: primary === undefined,
          journey: journey.id,
          revision: source.revision,
          sourceTree: source.tree,
          cleanSource: true,
          environment: "local_disposable",
          failure: primary ?? null,
          interruption: reason === undefined ? null : { reason, signals: received },
          fault: fault ?? null,
          observations,
          journeyEvidence: Object.fromEntries(records),
          delivery: ledger.providers.map((provider) => ({
            url: provider.url,
            scope: "Active loopback requests observed by the fixture receiver.",
            maxActive: provider.maxActive,
            attempts: provider.attempts,
          })),
          resources: samples,
          cleanup,
          sourceReverified: sourceCheck === null,
        };

        const write = (name: string, text: string) =>
          fs
            .writeFileString(join(artifacts, name), text, { mode: 0o600 })
            .pipe(Effect.mapError(failure("artifacts")));

        yield* write("evidence.json", ledger.redactor.apply(JSON.stringify(evidence, null, 2)));
        yield* write(
          "source-manifest.json",
          JSON.stringify(
            { revision: source.revision, sourceTree: source.tree, sources: source.files },
            null,
            2,
          ),
        );

        if (primary !== undefined) yield* write("failure.log", ledger.redactor.apply(logs));

        const names = yield* fs
          .readDirectory(artifacts, { recursive: true })
          .pipe(Effect.mapError(failure("artifacts")));

        const inventory = yield* Effect.forEach(
          names.sort().filter((name) => name !== "receipt.json" && !name.startsWith("private")),
          (name) =>
            Effect.gen(function* () {
              const path = join(artifacts, name);

              if ((yield* fs.stat(path)).type !== "File") return [];

              const bytes = yield* fs.readFile(path);

              return [
                {
                  bytes: bytes.length,
                  leaked: ledger.redactor.leaks(Buffer.from(bytes).toString("latin1")),
                  path: name,
                  sha256: sha256Hex(bytes),
                },
              ];
            }).pipe(Effect.mapError(failure("artifacts"))),
        ).pipe(Effect.map((items) => items.flat()));

        const leaked = inventory.flatMap((item) => (item.leaked ? [item.path] : []));
        const artifactList = inventory.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 }));
        const passed = primary === undefined && leaked.length === 0;
        const exitCode = exitCodeFor(reason, passed);

        const [node, postgres] = yield* Effect.forEach(
          [
            ["node", Effect.succeed("node")],
            [
              "postgres",
              Effect.try({ try: () => postgresProgram("postgres"), catch: failure("postgres") }),
            ],
          ] as const,
          ([label, command]) =>
            command.pipe(
              Effect.flatMap((resolved) =>
                run(
                  { label, command: resolved, args: ["--version"], cwd: root, env: environment },
                  "10 seconds",
                ),
              ),
              Effect.map((output) => output.trim()),
              Effect.orElseSucceed(() => "unavailable"),
            ),
        );

        const receipt = {
          schema_version: receiptSchemaVersion,
          journey_ref_id: `intent://${journey.id}`,
          mono_revision_ref_id: `rev-${source.revision}`,
          source_tree: source.tree,
          clean_source: true,
          environment_kind: "local_disposable",
          result: passed ? "passed" : "failed",
          exit_code: exitCode,
          termination_signal: reason === "SIGINT" || reason === "SIGTERM" ? reason : null,
          required_browser: journey.requiredBrowser,
          step_ids: observations.map(({ step }) => step),
          required_step_ids: journey.steps,
          artifact_digest: `sha256:${sha256Hex(canonicalJsonBytes(artifactList))}`,
          artifacts: artifactList,
          runtime: { bun: process.versions.bun ?? "unavailable", node, postgres },
        };

        if (leaked.length > 0) yield* write("credential-leak.txt", leaked.join("\n"));

        yield* write("receipt.json", JSON.stringify(receipt, null, 2));
        yield* Effect.sync(() =>
          process.stdout.write(
            `${passed ? "" : `failure: ${tail(ledger.redactor.apply(primary ?? `credential leaked into ${leaked.join(", ")}`), failureLogCharacters)}\n`}` +
              `result: ${receipt.result}\nevidence: ${join(artifacts, "receipt.json")}\n`,
          ),
        );

        return exitCode;
      }),
    );
  });

/**
 * Runs one journey as the process entry point and exits with its receipt code.
 * Preflight failures (unknown fault, dirty source) exit 1 before any resource starts.
 */
export const runGoldenJourney = (journey: GoldenJourney): void => {
  const root = fileURLToPath(new URL("../../", import.meta.url));

  Effect.runPromise(
    main(journey, root).pipe(
      Effect.catchTag("HarnessFailure", (error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.stage}: ${error.message}\n`);

          return 1;
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  ).then(
    (code) => process.stdout.write("", () => process.exit(code)),
    (cause: unknown) => {
      process.stderr.write(`harness defect: ${describeCause(cause)}\n`);
      process.exit(1);
    },
  );
};

/**
 * Runs promise-based driver code as an interruptible effect. Interruption aborts the
 * signal and waits (bounded) for the driver to settle, so cleanup verification never
 * races a browser that is still closing.
 */
export const fromAbortable = <A>(
  label: string,
  start: (signal: AbortSignal) => Promise<A>,
  grace: Duration.Input,
) =>
  Effect.callback<A, HarnessFailure>((resume) => {
    const controller = new AbortController();

    const settled = start(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(failure(label)(cause))),
    );

    return Effect.sync(() => controller.abort(new Error(`${label} interrupted`))).pipe(
      Effect.andThen(Effect.promise(() => settled)),
      Effect.timeout(grace),
      Effect.ignore,
    );
  });
