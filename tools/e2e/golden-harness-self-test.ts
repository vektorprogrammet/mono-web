/**
 * Golden harness self-test.
 *
 * Without arguments this driver runs a probe journey in six child runners: pass,
 * injected failure, injected SIGTERM, external SIGINT, supervised crash, and an
 * unknown fault. Each probe boots PostgreSQL, the loopback provider, a readiness
 * server, and trivial process groups (one ignores SIGTERM, one owns a grandchild).
 * The driver then checks exit codes, receipts, and, independently of the probe's
 * own report, that every recorded process group is gone, every port rebinds, and
 * the private root is removed. It also exercises the clean-source guard in a
 * temporary repository.
 *
 * Usage: bun --no-env-file tools/e2e/golden-harness-self-test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The package index pulls Bun's global types into this program; the subpath does not.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { sha256Hex, canonicalJsonBytes } from "@vektorprogrammet/domain/evidence";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  eventually,
  HarnessFailure,
  inspectSource,
  readOnlySnapshot,
  runGoldenJourney,
  safeEnvironment,
  selectRows,
  waitForHttp,
  type GoldenJourney,
} from "./golden-harness";

const root = fileURLToPath(new URL("../../", import.meta.url));

const entry = fileURLToPath(import.meta.url);

const ProbeRow = Schema.Struct({ id: Schema.Int, label: Schema.String });

const deliveryStatus = (url: string, token: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "probe-delivery",
        },
        body: JSON.stringify({ deliveryId: "probe-delivery", recipient: "probe@example.invalid" }),
      }).then(async (response) => {
        await response.body?.cancel();

        return response.status;
      }),
    catch: (cause) => new HarnessFailure({ stage: "probe-delivery", message: String(cause) }),
  });

const probeJourney: GoldenJourney = {
  id: "golden-harness-probe",
  sourcePaths: ["tools/e2e"],
  steps: ["booted", "finished"],
  faultVariable: "GOLDEN_HARNESS_PROBE_FAULT",
  faultPoints: ["after-boot"],
  deadline: "2 minutes",
  requiredBrowser: false,
  body: (context) =>
    Effect.gen(function* () {
      const [postgresPort = 0, providerPort = 0, httpPort = 0] = yield* context.reservePorts(3);
      const token = yield* context.secret(24);
      const database = yield* context.postgres(postgresPort, "golden-harness-probe");

      yield* Effect.tryPromise({
        try: () =>
          database.pool.query(
            "CREATE TABLE probe_events(id integer PRIMARY KEY, label text NOT NULL); INSERT INTO probe_events VALUES (1, 'booted')",
          ),
        catch: (cause) => new HarnessFailure({ stage: "probe-sql", message: String(cause) }),
      });

      const provider = yield* context.provider({
        port: providerPort,
        path: "/deliveries",
        token,
        maxBodyBytes: 4_096,
      });

      const accepted = yield* deliveryStatus(provider.url, token);

      yield* provider.setMode("fail");

      const failed = yield* deliveryStatus(provider.url, token);
      const unauthorized = yield* deliveryStatus(provider.url, "wrong-token");

      assert.deepEqual([accepted, failed, unauthorized], [204, 503, 401]);

      const server = yield* context.spawn({
        label: "http-child",
        command: "bun",
        args: [
          "--no-env-file",
          "-e",
          `Bun.serve({ hostname: "127.0.0.1", port: ${httpPort}, fetch: () => new Response("ok") })`,
        ],
        cwd: context.root,
        env: context.environment,
        supervised: true,
      });

      yield* waitForHttp({
        label: "http-child",
        url: `http://127.0.0.1:${httpPort}/`,
        process: server,
        deadline: "20 seconds",
      });

      const stubborn = yield* context.spawn({
        label: "ignores-sigterm",
        command: "sh",
        args: ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"],
        cwd: context.root,
        env: context.environment,
        forceKillAfter: "1 second",
        supervised: true,
      });

      const family = yield* context.spawn({
        label: "with-grandchild",
        command: "sh",
        args: ["-c", "sleep 300 & echo ready; wait"],
        cwd: context.root,
        env: context.environment,
        supervised: true,
      });

      yield* eventually(
        "trivial children ready",
        Effect.all([stubborn.logTail, family.logTail]).pipe(
          Effect.map((logs) => logs.every((log) => log.includes("ready"))),
        ),
        "10 seconds",
      );

      if (process.env.GOLDEN_HARNESS_PROBE_CRASH === "1")
        yield* context.spawn({
          label: "crasher",
          command: "sh",
          args: ["-c", "sleep 0.5; exit 3"],
          cwd: context.root,
          env: context.environment,
          supervised: true,
        });

      const observe = Effect.gen(function* () {
        const rows = yield* readOnlySnapshot(database.pool, (client) =>
          selectRows(
            client,
            "probe-events",
            "SELECT id, label FROM probe_events ORDER BY id",
            [],
            ProbeRow,
          ),
        );

        const attempts = yield* provider.attempts;

        return {
          rows,
          attempts: attempts.map(({ status, rejection }) => ({ status, rejection })),
        };
      });

      yield* context.checkpoint("booted", observe);
      yield* context.faultPoint("after-boot");

      if (process.env.GOLDEN_HARNESS_PROBE_HOLD === "1") {
        yield* Effect.sync(() => process.stdout.write("probe: holding\n"));

        return yield* Effect.never;
      }

      if (process.env.GOLDEN_HARNESS_PROBE_CRASH === "1") yield* Effect.sleep("30 seconds");

      yield* context.checkpoint("finished", observe);
    }),
};

const Receipt = Schema.Struct({
  schema_version: Schema.Literal("native-functional-journey/v1"),
  journey_ref_id: Schema.String,
  mono_revision_ref_id: Schema.String,
  source_tree: Schema.String,
  result: Schema.Literals(["passed", "failed"]),
  exit_code: Schema.Int,
  termination_signal: Schema.NullOr(Schema.Literals(["SIGINT", "SIGTERM"])),
  required_browser: Schema.Boolean,
  step_ids: Schema.Array(Schema.String),
  required_step_ids: Schema.Array(Schema.String),
  artifact_digest: Schema.String,
  artifacts: Schema.Array(
    Schema.Struct({ bytes: Schema.Int, path: Schema.String, sha256: Schema.String }),
  ),
});

const Evidence = Schema.Struct({
  failure: Schema.NullOr(Schema.String),
  interruption: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, signals: Schema.Array(Schema.String) }),
  ),
  fault: Schema.NullOr(Schema.String),
  delivery: Schema.Array(
    Schema.Struct({
      attempts: Schema.Array(
        Schema.Struct({ status: Schema.Int, rejection: Schema.NullOr(Schema.String) }),
      ),
    }),
  ),
  cleanup: Schema.Struct({
    processesExited: Schema.Boolean,
    descendantsExited: Schema.Boolean,
    listenersReleased: Schema.Boolean,
    privateResourcesRemoved: Schema.Boolean,
    processes: Schema.Array(Schema.Struct({ label: Schema.String, pid: Schema.Int })),
    ports: Schema.Array(Schema.Struct({ port: Schema.Int })),
    privateRoot: Schema.String,
    errors: Schema.Array(Schema.String),
  }),
});

interface ProbeCase {
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exitCode: number;
  readonly signal?: "SIGINT" | undefined;
  readonly expect?:
    | {
        readonly result: "passed" | "failed";
        readonly terminationSignal: "SIGINT" | "SIGTERM" | null;
        readonly steps: ReadonlyArray<string>;
        readonly failure: RegExp | null;
      }
    | undefined;
}

const probeCases: ReadonlyArray<ProbeCase> = [
  {
    name: "pass",
    env: {},
    exitCode: 0,
    expect: {
      result: "passed",
      terminationSignal: null,
      steps: ["booted", "finished"],
      failure: null,
    },
  },
  {
    name: "injected-failure",
    env: { GOLDEN_HARNESS_PROBE_FAULT: "after-boot" },
    exitCode: 1,
    expect: {
      result: "failed",
      terminationSignal: null,
      steps: ["booted"],
      failure: /Injected journey failure after-boot/u,
    },
  },
  {
    name: "injected-sigterm",
    env: { GOLDEN_HARNESS_PROBE_FAULT: "interrupt-after-boot" },
    exitCode: 143,
    expect: {
      result: "failed",
      terminationSignal: "SIGTERM",
      steps: ["booted"],
      failure: /Interrupted: SIGTERM/u,
    },
  },
  {
    name: "external-sigint",
    env: { GOLDEN_HARNESS_PROBE_HOLD: "1" },
    exitCode: 130,
    signal: "SIGINT",
    expect: {
      result: "failed",
      terminationSignal: "SIGINT",
      steps: ["booted"],
      failure: /Interrupted: SIGINT/u,
    },
  },
  {
    name: "supervised-crash",
    env: { GOLDEN_HARNESS_PROBE_CRASH: "1" },
    exitCode: 1,
    expect: {
      result: "failed",
      terminationSignal: null,
      steps: ["booted"],
      failure: /crasher: exited unexpectedly \(code 3\)/u,
    },
  },
  { name: "unknown-fault", env: { GOLDEN_HARNESS_PROBE_FAULT: "unlisted" }, exitCode: 1 },
];

const portRebinds = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();

    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(true))));
  });

const groupGone = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, 0);

      return false;
    } catch (cause) {
      return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
    }
  });

const runProbe = (probe: ProbeCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lines: Array<string> = [];

      const handle = yield* ChildProcess.make("bun", ["--no-env-file", entry], {
        cwd: root,
        env: { ...safeEnvironment(), GOLDEN_HARNESS_PROBE: "1", ...probe.env },
        extendEnv: false,
        detached: true,
        stdin: "ignore",
        forceKillAfter: "30 seconds",
      });

      const [, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                lines.push(line);

                if (probe.signal !== undefined && line === "probe: holding")
                  process.kill(handle.pid, probe.signal);
              }),
            ),
          ),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("4 minutes"));

      return { pid: handle.pid, exitCode, stdout: lines, stderr };
    }),
  );

const verifyProbe = (probe: ProbeCase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const started = Date.now();
    const outcome = yield* runProbe(probe);
    const report = `${probe.name}\nstdout:\n${outcome.stdout.join("\n")}\nstderr:\n${outcome.stderr}`;

    assert.equal(outcome.exitCode, probe.exitCode, `exit code: ${report}`);
    assert.ok(yield* groupGone(outcome.pid), `probe runner group survived: ${report}`);

    const artifacts = outcome.stdout
      .find((line) => line.startsWith("artifacts: "))
      ?.slice("artifacts: ".length);

    if (probe.expect === undefined) {
      assert.equal(artifacts, undefined, `preflight rejection started resources: ${report}`);
      assert.match(outcome.stderr, /unknown journey fault/u);

      return `${probe.name}: ok (exit ${outcome.exitCode}, no resources started)`;
    }

    assert.ok(artifacts !== undefined, `artifact directory not reported: ${report}`);

    const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(
      yield* fs.readFileString(join(artifacts, "receipt.json")),
    );

    const evidence = yield* Schema.decodeEffect(Schema.fromJsonString(Evidence))(
      yield* fs.readFileString(join(artifacts, "evidence.json")),
    );

    assert.equal(receipt.journey_ref_id, "intent://golden-harness-probe");
    assert.equal(receipt.result, probe.expect.result, report);
    assert.equal(receipt.exit_code, probe.exitCode);
    assert.equal(receipt.termination_signal, probe.expect.terminationSignal);
    assert.equal(receipt.required_browser, false);
    assert.deepEqual(receipt.step_ids, probe.expect.steps);
    assert.deepEqual(receipt.required_step_ids, ["booted", "finished"]);
    assert.equal(
      receipt.artifact_digest,
      `sha256:${sha256Hex(canonicalJsonBytes(receipt.artifacts))}`,
    );

    const digests = yield* Effect.forEach(receipt.artifacts, (artifact) =>
      fs.readFile(join(artifacts, artifact.path)).pipe(
        Effect.map((bytes) => ({
          path: artifact.path,
          expected: artifact.sha256,
          observed: sha256Hex(bytes),
        })),
      ),
    );

    for (const { path, expected, observed } of digests)
      assert.equal(observed, expected, `artifact digest ${path}`);

    if (probe.expect.failure === null) assert.equal(evidence.failure, null, report);
    else assert.match(evidence.failure ?? "", probe.expect.failure, report);

    assert.equal(evidence.interruption?.reason ?? null, probe.expect.terminationSignal);
    assert.deepEqual(
      evidence.delivery[0]?.attempts.map(({ status }) => status),
      [204, 503, 401],
    );
    assert.deepEqual(evidence.cleanup.errors, [], report);
    assert.ok(
      evidence.cleanup.processesExited &&
        evidence.cleanup.descendantsExited &&
        evidence.cleanup.listenersReleased &&
        evidence.cleanup.privateResourcesRemoved,
      report,
    );

    const labels = new Set(evidence.cleanup.processes.map(({ label }) => label));

    for (const label of ["initdb", "postgres", "http-child", "ignores-sigterm", "with-grandchild"])
      assert.ok(labels.has(label), `${label} not recorded`);

    for (const { label, pid } of evidence.cleanup.processes)
      assert.ok(yield* groupGone(pid), `${label} group ${pid} survived`);

    assert.equal(evidence.cleanup.ports.length, 3);

    for (const { port } of evidence.cleanup.ports)
      assert.ok(yield* portRebinds(port), `port ${port} not released`);

    assert.equal(yield* fs.exists(evidence.cleanup.privateRoot), false, "private root remains");
    yield* fs.remove(artifacts, { recursive: true });

    return `${probe.name}: ok (exit ${outcome.exitCode}, ${evidence.cleanup.processes.length} groups gone, ${Date.now() - started} ms)`;
  });

// The guard must reject any uncommitted change and digest exactly the tracked bytes.
const verifySourceGuard = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = yield* fs.makeTempDirectoryScoped({ prefix: "golden-harness-guard-" });

    const git = (...args: ReadonlyArray<string>) =>
      ChildProcess.make(
        "git",
        [
          "-c",
          "user.name=Probe",
          "-c",
          "user.email=probe@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          cwd: repository,
          env: { ...safeEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          extendEnv: false,
        },
      ).pipe(
        Effect.flatMap((handle) => handle.exitCode),
        Effect.scoped,
      );

    assert.equal(yield* git("init", "--quiet"), 0);
    yield* fs.writeFileString(join(repository, "tracked.txt"), "tracked bytes\n");
    assert.equal(yield* git("add", "tracked.txt"), 0);
    assert.equal(yield* git("commit", "--quiet", "-m", "probe"), 0);

    const clean = yield* inspectSource(repository, ["."]);

    assert.deepEqual(clean.files, [
      { path: "tracked.txt", sha256: sha256Hex(new TextEncoder().encode("tracked bytes\n")) },
    ]);
    yield* fs.writeFileString(join(repository, "untracked.txt"), "dirty\n");

    const dirty = yield* Effect.flip(inspectSource(repository, ["."]));

    assert.equal(dirty.message, "requires committed clean source");

    return "clean-source guard: ok (clean tree digested, untracked file rejected)";
  }),
);

const selfTest = Effect.gen(function* () {
  const lines = [yield* verifySourceGuard];

  yield* Effect.sync(() => process.stdout.write(`${lines[0]}\n`));

  for (const probe of probeCases) {
    const line = yield* verifyProbe(probe);

    lines.push(line);
    yield* Effect.sync(() => process.stdout.write(`${line}\n`));
  }

  yield* Effect.sync(() => process.stdout.write(`self-test passed: ${lines.length} checks\n`));
});

if (process.env.GOLDEN_HARNESS_PROBE === "1") runGoldenJourney(probeJourney);
else BunRuntime.runMain(selfTest.pipe(Effect.provide(BunServices.layer)));
