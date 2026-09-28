/**
 * Golden reimbursement journey: submission, private denials, restart custody, approval with a
 * failed notification delivery, settlement, unattended recovery, and intake bounds.
 *
 * Boots a private PostgreSQL cluster, a loopback notification provider, the native Bun backend,
 * and the built dashboard on private loopback ports, then drives one browser journey whose
 * checkpoints an independent REPEATABLE READ observer asserts. The runner writes the evidence,
 * source manifest, and `native-functional-journey/v1` receipt, and exits 0 when it passed and 1
 * otherwise, also after SIGINT, SIGTERM, or the 15-minute deadline.
 *
 * Usage: bun --no-env-file tools/e2e/golden-reimbursement.ts
 * Faults: GOLDEN_REIMBURSEMENT_FAULT=after-submitted|interrupt-after-submitted
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  type DisposablePostgres,
  loopbackPortFree,
  postgresVersion,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "@monoweb/postgres";
import { sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  Cause,
  Clock,
  Config,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schema,
  Scope,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { Pool } from "pg";
import {
  type ReimbursementBrowserEvidence,
  runReimbursementBrowser,
} from "../../apps/dashboard/e2e/golden-reimbursement-browser.mjs";
import {
  createReimbursementObserver,
  digestOutbox,
  digestText,
  fixture,
  jsonText,
  people,
  type Binding,
  type ReimbursementObserver,
  reimbursementSteps,
  seedReimbursement,
} from "./golden-reimbursement-evidence";
import {
  describeCause,
  eventually,
  failure,
  HarnessFailure,
  inspectSource,
  safeEnvironment,
  type SourceSnapshot,
  waitForHttp,
} from "./golden-harness";

const faults = ["after-submitted", "interrupt-after-submitted"];

const sourcePaths = [
  "apps/backend",
  "apps/dashboard",
  "packages/domain",
  "packages/database",
  "packages/rpc",
  "tools/e2e",
];

/** The indented JSON text of an artifact, as `JSON.stringify(value, null, 2)` writes it. */
const prettyJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const DeliveryEnvelope = Schema.fromJsonString(Schema.Struct({ deliveryId: Schema.String }));

type Environment = Readonly<Record<string, string>>;

type ProcessExit = { readonly code: number | null; readonly signal: string | null };

interface OwnedProcess {
  readonly label: string;
  readonly pid: number;
  readonly scope: Scope.Closeable;
  readonly exited: Deferred.Deferred<ProcessExit>;
  readonly isRunning: Effect.Effect<boolean>;
  readonly logTail: Effect.Effect<string>;
  log: string;
  exit: ProcessExit | undefined;
}

interface DeliveryAttempt {
  readonly deliveryId: string;
  readonly envelopeSha256: string;
  readonly startedAt: string;
  abortedAt: string | null;
  finishedAt: string | null;
  status: number | null;
  elapsedMs: number | null;
  failure?: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly rssKiB: number;
  readonly state: string | undefined;
  readonly name: string;
}

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

const signalOf = (exit: Exit.Exit<number, unknown>): ProcessExit => {
  if (Exit.isSuccess(exit)) return { code: exit.value, signal: null };

  const error = Cause.squash(exit.cause);
  const message = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";

  return { code: null, signal: /signal: '(\w+)'/u.exec(message)?.[1] ?? null };
};

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

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  assert.equal(
    process.argv.length,
    2,
    "Usage: bun --no-env-file tools/e2e/golden-reimbursement.ts",
  );

  const environment = yield* safeEnvironment;

  const fault = Option.getOrUndefined(
    yield* Config.option(Config.String("GOLDEN_REIMBURSEMENT_FAULT")),
  );

  assert.ok(fault === undefined || faults.includes(fault), "unknown journey fault");

  const command = (binary: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(binary, args, {
          cwd: root,
          env: environment,
          extendEnv: false,
          stdin: "ignore",
        });

        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        if (code !== 0)
          return yield* HarnessFailure.make({
            stage: binary,
            message: `${binary} exited with code ${code}: ${stderr}`,
          });

        return stdout;
      }),
    ).pipe(Effect.mapError(failure(binary)), Effect.timeout("60 seconds"));

  const source: SourceSnapshot = yield* inspectSource(root, sourcePaths);
  const { revision, tree: sourceTree } = source;
  const artifactRoot = yield* fs.makeTempDirectory({ prefix: "vektor-reimbursement-" });
  const privateRoot = path.join(artifactRoot, "private");

  yield* fs.makeDirectory(privateRoot, { mode: 0o700 });
  yield* Effect.sync(() =>
    process.stdout.write(`artifacts: ${artifactRoot}\nrunner-pid: ${process.pid}\n`),
  );

  const password = randomBytes(24).toString("hex");
  const token = randomBytes(24).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const persons = people(password);
  const secrets = [password, token, secret];

  const sanitize = (value: string) =>
    secrets
      .reduce((text, known) => text.replaceAll(known, "[REDACTED]"), value)
      .replace(/(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/giu, "$1$2[REDACTED]");

  const children: Array<OwnedProcess> = [];
  const ports: Array<number> = [];
  const resourceSnapshots: Array<unknown> = [];
  const providerAttempts: Array<DeliveryAttempt> = [];
  const interrupted = yield* Deferred.make<void>();
  let provider: Bun.Server<undefined> | undefined;
  let postgres: DisposablePostgres | undefined;
  let pool: Pool | undefined;
  let browser: { close: () => Promise<void> } | undefined;
  let observer: ReimbursementObserver | undefined;
  let browserEvidence: ReimbursementBrowserEvidence | undefined;
  let failureText: string | undefined;
  let interruption: string | undefined;
  let deliveryMode = "accept";
  let activeDeliveries = 0;
  let maxActiveDeliveries = 0;

  let build:
    | {
        readonly revision: string;
        readonly sourceTree: string;
        readonly digest: string;
        readonly files: ReadonlyArray<{ path: string; sha256: string; bytes: number }>;
      }
    | undefined;

  const onSignal = (signal: string) => {
    interruption ??= signal;
    failureText ??= `Interrupted: ${signal}`;
    Deferred.doneUnsafe(interrupted, Effect.void);
  };

  const start = (
    binary: string,
    args: ReadonlyArray<string>,
    env: Environment = environment,
    cwd = root,
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();

      const handle = yield* ChildProcess.make(binary, args, {
        cwd,
        env,
        extendEnv: false,
        detached: true,
        stdin: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: "5 seconds",
      }).pipe(Scope.provide(scope), Effect.mapError(failure(binary)));

      const exited = yield* Deferred.make<ProcessExit>();

      const owned: OwnedProcess = {
        label: args.includes("apps/backend/src/main.ts") ? "backend" : path.basename(binary),
        pid: handle.pid,
        scope,
        exited,
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        logTail: Effect.sync(() => owned.log),
        log: "",
        exit: undefined,
      };

      children.push(owned);

      yield* handle.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            owned.log = (owned.log + sanitize(chunk)).slice(-131_072);
          }),
        ),
        Effect.ignore,
        Effect.forkDetach,
      );
      yield* handle.exitCode.pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          owned.exit = signalOf(exit);

          return Deferred.succeed(exited, owned.exit);
        }),
        Effect.forkDetach,
      );

      return owned;
    });

  // Drain the owned group even when its leader exited, as the school-service CI wrapper does.
  const stop = (owned: OwnedProcess | undefined) =>
    owned === undefined
      ? Effect.void
      : Scope.close(owned.scope, Exit.void).pipe(
          Effect.andThen(
            eventually(
              "owned process group survived cleanup",
              Effect.map(groupAlive(owned.pid), (alive) => !alive),
              "5 seconds",
            ),
          ),
          Effect.mapError(() =>
            HarnessFailure.make({
              stage: owned.label,
              message: "owned process group survived cleanup",
            }),
          ),
        );

  const run = (
    binary: string,
    args: ReadonlyArray<string>,
    env: Environment = environment,
    cwd = root,
    timeout: Duration.Input = "120 seconds",
  ) =>
    Effect.gen(function* () {
      const owned = yield* start(binary, args, env, cwd);

      return yield* Deferred.await(owned.exited).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              HarnessFailure.make({ stage: binary, message: `${binary} deadline exceeded` }),
            ),
        }),
        Effect.flatMap((exit) =>
          exit.code === 0
            ? Effect.succeed(owned.log)
            : Effect.fail(
                HarnessFailure.make({
                  stage: binary,
                  message: `${binary} failed: ${owned.log.slice(-6000)}`,
                }),
              ),
        ),
        Effect.ensuring(Effect.ignore(stop(owned))),
      );
    });

  const sampleResources = (step: string) =>
    Effect.gen(function* () {
      const rows = (yield* command("ps", ["-eo", "pid=,ppid=,pgid=,rss=,stat=,comm="]))
        .trim()
        .split("\n")
        .map((line): ProcessRow => {
          const [pid, ppid, pgid, rssKiB, state, ...name] = line.trim().split(/\s+/u);

          return {
            pid: Number(pid),
            ppid: Number(ppid),
            pgid: Number(pgid),
            rssKiB: Number(rssKiB),
            state,
            name: name.join(" "),
          };
        });

      const ownedIds = new Set([process.pid]);

      for (let count = 0; count < 16; count++) {
        const before = ownedIds.size;

        for (const row of rows) if (ownedIds.has(row.ppid)) ownedIds.add(row.pid);

        if (before === ownedIds.size) break;
      }

      const processes = rows.filter((row) => ownedIds.has(row.pid) && row.name !== "ps");

      resourceSnapshots.push({
        step,
        observedAt: yield* isoNow,
        scope: "runner and live descendants; point-in-time RSS, not a peak",
        processes,
        processCount: processes.length,
        totalRssKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0),
      });
    });

  const waitHttp = (url: string, owned: OwnedProcess) =>
    waitForHttp({
      label: `HTTP ${new URL(url).pathname}`,
      url,
      process: owned,
      deadline: "60 seconds",
    });

  /** Digests every file below the dashboard build for `browser-build.json`. */
  const dashboardBuildInventory = Effect.gen(function* () {
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];

    const visit = (relative: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const file = path.join(root, "apps/dashboard/build", relative);
        const info = yield* fs.stat(file);

        assert.ok(info.type !== "SymbolicLink", "build must not contain symlinks");

        if (info.type === "Directory") {
          for (const name of (yield* fs.readDirectory(file)).sort())
            yield* visit(path.join(relative, name));
        } else {
          assert.ok(info.type === "File", "build contains a non-file");

          const bytes = yield* fs.readFile(file);

          files.push({ path: relative, sha256: sha256Hex(bytes), bytes: bytes.length });
        }
      });

    yield* visit("");

    return files;
  });

  const aborted = (signal: AbortSignal) =>
    Effect.callback<never, HarnessFailure>((resume) => {
      const listener = () =>
        resume(
          Effect.fail(HarnessFailure.make({ stage: "provider", message: String(signal.reason) })),
        );

      signal.addEventListener("abort", listener, { once: true });

      return Effect.sync(() => signal.removeEventListener("abort", listener));
    });

  const deliver = (request: Request) =>
    Effect.gen(function* () {
      activeDeliveries++;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);

      const startedAt = yield* Clock.currentTimeMillis;
      let attempt: DeliveryAttempt | undefined;

      return yield* Effect.gen(function* () {
        assert.equal(request.headers.get("authorization"), `Bearer ${token}`);

        const body = Buffer.from(yield* Effect.promise(() => request.arrayBuffer()));

        assert.ok(body.length <= 65_536, "bounded synthetic provider envelope");

        const envelope = yield* Schema.decodeEffect(DeliveryEnvelope)(body.toString("utf8"));

        assert.equal(request.headers.get("idempotency-key"), envelope.deliveryId);

        const current: DeliveryAttempt = {
          deliveryId: envelope.deliveryId,
          envelopeSha256: sha256Hex(body),
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
          abortedAt: null,
          finishedAt: null,
          status: null,
          elapsedMs: null,
        };

        attempt = current;
        providerAttempts.push(current);
        request.signal.addEventListener(
          "abort",
          () => {
            // The abort listener runs outside any fiber, so it reads the clock directly.
            if (current.status === null)
              current.abortedAt = DateTime.formatIso(DateTime.nowUnsafe());
          },
          { once: true },
        );

        if (deliveryMode === "timeout")
          yield* Effect.sleep("2 seconds").pipe(Effect.raceFirst(aborted(request.signal)));

        current.status = 204;

        return new Response(null, { status: 204 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause);

            if (attempt !== undefined)
              attempt.failure = sanitize(
                Schema.is(HarnessFailure)(error) ? error.message : String(error),
              );

            return new Response(null, { status: 503 });
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            if (attempt !== undefined) {
              attempt.elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
              attempt.finishedAt = yield* isoNow;
            }

            activeDeliveries--;
          }),
        ),
      );
    });

  const cleanup = Effect.gen(function* () {
    const errors: Array<string> = [];

    const attempt = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause);

            errors.push(sanitize(Schema.is(HarnessFailure)(error) ? error.message : String(error)));
          }),
        ),
      );

    const current = browser;

    if (current !== undefined) yield* attempt(Effect.tryPromise(() => current.close()));

    const server = provider;

    if (server !== undefined) yield* attempt(Effect.tryPromise(() => server.stop(true)));

    const observerPool = pool;

    if (observerPool !== undefined) yield* attempt(Effect.tryPromise(() => observerPool.end()));

    for (const owned of [...children].reverse()) yield* attempt(stop(owned));

    const cluster = postgres;

    if (cluster !== undefined) yield* attempt(Effect.tryPromise(() => cluster.stop()));

    for (const port of ports)
      if (!(yield* Effect.promise(() => loopbackPortFree(port))))
        errors.push(`owned listener ${port} remains`);

    const alive = yield* Effect.forEach(children, (owned) => groupAlive(owned.pid));
    const groupsDrained = alive.every((value) => !value);

    if (groupsDrained && errors.length === 0)
      yield* fs.remove(privateRoot, { recursive: true, force: true });
    yield* sampleResources("after-cleanup");

    return {
      groupsDrained,
      listenersReleased: errors.length === 0,
      privateResourcesRemoved: groupsDrained && errors.length === 0,
      ports: [...ports],
      processes: children.map(({ pid, label, exit }) => ({
        pid,
        label,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
      })),
      errors,
    };
  });

  const journey = Effect.gen(function* () {
    yield* sampleResources("baseline");

    const reserved = yield* Effect.tryPromise({
      try: () => reserveLoopbackPorts(4),
      catch: failure("ports"),
    });

    const [pgPort, apiPort, dashboardPort, providerPort] = reserved;

    assert.ok(
      pgPort !== undefined &&
        apiPort !== undefined &&
        dashboardPort !== undefined &&
        providerPort !== undefined,
    );
    ports.push(pgPort, apiPort, dashboardPort, providerPort);

    const origins = {
      backend: `http://127.0.0.1:${apiPort}`,
      dashboard: `http://127.0.0.1:${dashboardPort}`,
    };

    const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;

    postgres = yield* Effect.tryPromise({
      try: () => startDisposablePostgres({ port: pgPort, maxConnections: 16, environment }),
      catch: failure("postgres"),
    });

    const observerPool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      connectionTimeoutMillis: 1000,
      statement_timeout: 10_000,
      application_name: "reimbursement-independent-observer",
    });

    pool = observerPool;

    const runProvider = yield* FiberSet.makeRuntimePromise();

    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: providerPort,
      maxRequestBodySize: 65_536,
      fetch: (request) => runProvider(deliver(request)),
    });

    const backendEnvironment = {
      ...environment,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(apiPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: secret,
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: jsonText([origins.dashboard]),
      OAUTH_CANONICAL_ORIGIN: origins.backend,
      OAUTH_DASHBOARD_ORIGIN: origins.dashboard,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "http",
      RECEIPT_DELIVERY_POLL_MS: "250",
      RECEIPT_STAGING_ROOT: path.join(privateRoot, "staging"),
      RECEIPT_COMMITTED_ROOT: path.join(privateRoot, "committed"),
      RECEIPT_MAX_FILE_BYTES: "10485760",
      RECEIPT_DELIVERY_URL: `http://127.0.0.1:${providerPort}/receipt`,
      RECEIPT_DELIVERY_TOKEN: token,
      RECEIPT_DELIVERY_TIMEOUT_MS: "500",
      RECEIPT_DELIVERY_SENDER: "finance@example.invalid",
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: jsonText({
        [fixture.departmentId]: "finance@example.invalid",
      }),
    };

    yield* run("bun", ["--no-env-file", "run", "--cwd", "packages/database", "identity:seed"], {
      ...backendEnvironment,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: jsonText(Object.values(persons)),
    });
    yield* seedReimbursement({ pool: observerPool, persons });

    let backend: OwnedProcess | undefined;

    const boot = Effect.gen(function* () {
      const {
        RECEIPT_DELIVERY_URL: _url,
        RECEIPT_DELIVERY_TOKEN: _token,
        RECEIPT_DELIVERY_TIMEOUT_MS: _timeout,
        RECEIPT_DELIVERY_SENDER: _sender,
        RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: _recipients,
        ...withoutDelivery
      } = backendEnvironment;

      const bootEnvironment =
        backendEnvironment.RECEIPT_DELIVERY_MODE === "disabled"
          ? withoutDelivery
          : { ...backendEnvironment };

      const started = yield* start(
        "bun",
        ["--no-env-file", "apps/backend/src/main.ts"],
        bootEnvironment,
      );

      backend = started;
      yield* waitHttp(origins.backend + "/health", started);
    });

    yield* boot;

    const dashboardEnvironment = {
      ...environment,
      API_URL: origins.backend,
      VITE_API_URL: origins.dashboard,
      DASHBOARD_ORIGIN: origins.dashboard,
      DASHBOARD_MOUNT: "/dashboard/",
      HOST: "127.0.0.1",
      PORT: String(dashboardPort),
      NODE_ENV: "production",
      REAL_NATIVE_IDENTITY_E2E: "1",
    };

    const dashboardRoot = path.join(root, "apps/dashboard");

    yield* run(
      "bun",
      ["--no-env-file", "run", "build"],
      dashboardEnvironment,
      dashboardRoot,
      "300 seconds",
    );

    const files = yield* dashboardBuildInventory.pipe(Effect.mapError(failure("build")));

    build = { revision, sourceTree, digest: "sha256:" + digestText(jsonText(files)), files };

    const dashboard = yield* start(
      "bun",
      ["--no-env-file", "server.mjs"],
      dashboardEnvironment,
      dashboardRoot,
    );

    yield* waitHttp(origins.dashboard + "/dashboard/login", dashboard);

    const currentObserver = createReimbursementObserver({
      pool: observerPool,
      committedRoot: backendEnvironment.RECEIPT_COMMITTED_ROOT,
      persons,
    });

    observer = currentObserver;

    const checkpoint = (step: string, binding?: Binding) =>
      Effect.gen(function* () {
        const facts = yield* currentObserver.checkpoint(step, binding);

        yield* sampleResources(step);
        yield* Effect.sync(() => process.stdout.write(`checkpoint: ${step}\n`));

        return facts;
      });

    yield* checkpoint("initial");

    const runCallback = yield* FiberSet.makeRuntimePromise<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();

    const hooks = {
      origins,
      persons,
      artifacts: artifactRoot,
      checkpoint: (step: string, binding?: Binding) => runCallback(checkpoint(step, binding)),
      eventually: (label: string, inspect: () => Promise<boolean>, timeout = 30_000) =>
        runCallback(
          eventually(
            label,
            Effect.tryPromise({ try: inspect, catch: failure(label) }),
            Duration.millis(timeout),
          ),
        ),
      readFacts: () => runCallback(currentObserver.read),
      restart: (mode = "http") =>
        runCallback(
          Effect.gen(function* () {
            yield* stop(backend);
            backendEnvironment.RECEIPT_DELIVERY_MODE = mode;
            yield* boot;
            yield* sampleResources("native-restart");
          }),
        ),
      providerMode: (mode: string) => {
        deliveryMode = mode;
      },
      fault,
      browserReady: (value: { close: () => Promise<void> }) => {
        browser = value;
      },
    };

    // Interruption closes the browser, so the driver settles before cleanup verification.
    const evidence = yield* Effect.callback<ReimbursementBrowserEvidence, HarnessFailure>(
      (resume) => {
        const settled = runReimbursementBrowser(hooks).then(
          (value) => resume(Effect.succeed(value)),
          (cause: unknown) => resume(Effect.fail(failure("browser")(cause))),
        );

        return Effect.tryPromise({
          try: () => browser?.close() ?? Promise.resolve(),
          catch: failure("browser"),
        }).pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => settled)),
          Effect.timeout("30 seconds"),
          Effect.ignore,
        );
      },
    );

    browserEvidence = evidence;
    yield* currentObserver.finish;
    yield* sampleResources("bounds-complete");

    const postProbeFacts = yield* currentObserver.read;

    yield* fs.writeFileString(
      path.join(artifactRoot, "bounds-evidence.json"),
      prettyJsonText({
        checks: evidence.checks.filter(({ kind }) =>
          [
            "intake",
            "concurrent-disabled-worker",
            "bounded-collection",
            "disabled-worker-recovery",
            "pagination-ui",
          ].includes(kind),
        ),
        facts: { ...postProbeFacts, outbox: digestOutbox(postProbeFacts.outbox) },
      }),
      { mode: 0o600 },
    );
    assert.equal(maxActiveDeliveries, 1, "fixed active loopback request concurrency");

    const retried = providerAttempts.filter(({ status }) => status === null);

    assert.ok(retried.length > 0, "notification provider deadline observed");

    for (const retry of retried) {
      assert.notEqual(retry.abortedAt, null, "timed-out request cancelled the fixture transport");
      assert.ok(
        retry.elapsedMs !== null && retry.elapsedMs >= 250 && retry.elapsedMs < 2000,
        "bounded provider deadline interrupted the blocked transport",
      );
      assert.ok(
        providerAttempts.some(
          (candidate) =>
            candidate.deliveryId === retry.deliveryId &&
            candidate.envelopeSha256 === retry.envelopeSha256 &&
            candidate.status === 204,
        ),
        "failed immutable envelope recovered unattended",
      );
    }

    const after = yield* inspectSource(root, sourcePaths).pipe(
      Effect.mapError(() =>
        HarnessFailure.make({ stage: "source", message: "source changed during acceptance" }),
      ),
    );

    assert.equal(after.revision, revision);
    assert.equal(
      jsonText(after.files),
      jsonText(source.files),
      "source bytes changed during acceptance",
    );
  });

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          (["SIGINT", "SIGTERM"] as const).map((signal) => {
            const listener = () => onSignal(signal);

            process.on(signal, listener);

            return [signal, listener] as const;
          }),
        ),
        (listeners) =>
          Effect.sync(() => {
            for (const [signal, listener] of listeners) process.removeListener(signal, listener);
          }),
      );

      const deadline = Effect.sleep("15 minutes").pipe(
        Effect.andThen(Effect.sync(() => onSignal("15-minute journey deadline"))),
      );

      const outcome = yield* Effect.scoped(journey).pipe(
        Effect.raceFirst(Deferred.await(interrupted)),
        Effect.raceFirst(deadline),
        Effect.exit,
      );

      if (Exit.isFailure(outcome)) {
        const error = Cause.squash(outcome.cause);

        failureText ??= sanitize(
          Schema.is(HarnessFailure)(error) ? error.message : describeCause(error),
        );
      }
    }),
  );

  const cleaned = yield* cleanup;

  if (cleaned.errors.length > 0) failureText ??= "Resource cleanup failed";

  const currentObservations = observer?.observations ?? [];

  const evidence = {
    passed: failureText === undefined,
    revision,
    sourceTree,
    cleanSource: true,
    environment: "local_disposable",
    failure: failureText ?? null,
    interruption: interruption ?? null,
    fault: fault ?? null,
    observations: currentObservations,
    browser: browserEvidence ?? null,
    delivery: {
      scope:
        "Active loopback requests; this fixture cancels work on request abort. No remote execution bound is implied.",
      maxActive: maxActiveDeliveries,
      attempts: providerAttempts,
    },
    resources: resourceSnapshots,
    cleanup: cleaned,
  };

  const write = (name: string, text: string) =>
    fs.writeFileString(path.join(artifactRoot, name), text, { mode: 0o600 });

  yield* write("evidence.json", sanitize(prettyJsonText(evidence)));
  yield* write(
    "source-manifest.json",
    prettyJsonText({ revision, sourceTree, sources: source.files }),
  );

  if (build !== undefined) yield* write("browser-build.json", prettyJsonText(build));

  if (failureText !== undefined)
    yield* write(
      "failure.log",
      sanitize(children.map(({ label, log }) => `${label}\n${log}`).join("\n")),
    );

  const artifacts: Array<{ path: string; bytes: number; sha256: string }> = [];

  for (const name of (yield* fs.readDirectory(artifactRoot)).sort()) {
    if (name === "private") continue;

    const bytes = yield* fs.readFile(path.join(artifactRoot, name));

    artifacts.push({ path: name, bytes: bytes.length, sha256: sha256Hex(bytes) });
  }

  const passed = failureText === undefined;

  const receipt = {
    schema_version: "native-functional-journey/v1",
    journey_ref_id: "intent://golden-reimbursement",
    mono_revision_ref_id: "rev-" + revision,
    source_tree: sourceTree,
    clean_source: true,
    environment_kind: "local_disposable",
    result: passed ? "passed" : "failed",
    exit_code: passed ? 0 : 1,
    termination_signal: interruption ?? null,
    required_browser: true,
    step_ids: currentObservations.map(({ step }) => step),
    required_step_ids: reimbursementSteps,
    artifact_digest: "sha256:" + digestText(jsonText(artifacts)),
    artifacts,
    runtime: {
      bun: process.versions.bun,
      node: (yield* command("node", ["--version"])).trim(),
      postgres: postgresVersion(),
    },
  };

  yield* write("receipt.json", prettyJsonText(receipt));
  yield* Effect.sync(() =>
    process.stdout.write(
      `result: ${receipt.result}\nevidence: ${path.join(artifactRoot, "receipt.json")}\n`,
    ),
  );

  return receipt.exit_code;
});

Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
).then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    process.stderr.write(`${describeCause(cause)}\n`);
    process.exitCode = 1;
  },
);
