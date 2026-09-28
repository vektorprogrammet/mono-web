import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import {
  Clock,
  Config,
  Console,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { Pool } from "pg";
import { IdempotencyKey } from "@vektorprogrammet/rpc/problem";
import { nativeScriptClient } from "@vektorprogrammet/rpc/script";
import {
  type DisposablePostgres,
  loopbackPortFree,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "@monoweb/postgres";
import { runCommand } from "../scripts/command.js";
import { indentedJsonText } from "../acceptance/acceptance-process.js";
import { jsonText, step, surfaceStepFailure } from "../acceptance/journey-step.js";

/** A bound of the proof that an observation or a process outlived. */
class RecoveryTimeout extends Data.TaggedError("RecoveryTimeout")<{ readonly message: string }> {}

/** A command of the proof that exited with a code other than 0. */
class RecoveryCommandFailed extends Data.TaggedError("RecoveryCommandFailed")<{
  readonly message: string;
}> {}

const DeliveryBody = Schema.fromJsonString(Schema.Struct({ deliveryId: Schema.String }));

type Environment = Readonly<Record<string, string | undefined>>;

interface NativeProcess {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly logs: string[];
  /** The exit code, or null for an exit on a signal. */
  readonly exited: Effect.Effect<number | null>;
}

/** Sends a signal to the process itself, as `ChildProcess.kill` of Node did. */
const signal = (owned: NativeProcess, name: NodeJS.Signals) =>
  Effect.sync(() => {
    process.kill(owned.child.pid, name);
  });

/** The exit code of the process within ten seconds, else the proof fails with `message`. */
const exitWithin = (owned: NativeProcess, message: string) =>
  owned.exited.pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new RecoveryTimeout({ message })),
    }),
  );

const proof = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const join = path.join;
  const root = new URL("../../", import.meta.url).pathname;

  const safeEnvironment: Record<string, string> = {};

  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH"]) {
    const value = yield* Config.option(Config.String(key));

    if (Option.isSome(value)) safeEnvironment[key] = value.value;
  }

  /** Runs a command with exactly `env`, for at most a minute, and answers its standard output. */
  const run = (command: string, args: ReadonlyArray<string>, env: Environment = safeEnvironment) =>
    runCommand(
      ChildProcess.make(command, args, {
        cwd: root,
        env: { ...env },
        extendEnv: false,
        stdin: "ignore",
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(new RecoveryTimeout({ message: `${command} timed out` })),
      }),
      Effect.flatMap((result) =>
        result.status === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new RecoveryCommandFailed({
                message: `${command} exited with ${result.status}: ${result.stderr}`,
              }),
            ),
      ),
    );

  assert.equal(
    (yield* run("git", ["status", "--porcelain"])).trim(),
    "",
    "requires committed source",
  );

  const revision = (yield* run("git", ["rev-parse", "HEAD"])).trim();

  const sourceTree = (yield* run("git", ["rev-parse", "HEAD^{tree}"])).trim();

  const artifacts = yield* fileSystem.makeTempDirectory({ prefix: "vektor-delivery-recovery-" });

  const privateRoot = join(artifacts, "private");

  yield* fileSystem.makeDirectory(privateRoot, { mode: 0o700 });

  yield* Console.log(`evidence: ${artifacts}`);

  const eventually = <E, R>(
    label: string,
    inspect: Effect.Effect<boolean, E, R>,
    timeout = 20_000,
  ) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + timeout;

      while ((yield* Clock.currentTimeMillis) < deadline) {
        if (yield* inspect) return;
        yield* Effect.sleep("50 millis");
      }

      return yield* new RecoveryTimeout({ message: `Observation timeout: ${label}` });
    });

  const processes: NativeProcess[] = [];

  const client = yield* HttpClient.HttpClient;

  const postJson = Effect.fnUntraced(function* (url: string, value: Schema.Json) {
    return yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("origin", dashboardOrigin),
        HttpClientRequest.bodyText(yield* jsonText(value), "application/json"),
      ),
    );
  });

  // The replacement main of the recovery binds the fourth port.
  const ownedPorts = [...(yield* step(() => reserveLoopbackPorts(4)))];

  const [pgPort, apiPort, dashboardPort, replacementPort] = ownedPorts;

  const pgDirectory = join(privateRoot, "postgres");

  const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;

  const origin = `http://127.0.0.1:${apiPort}`;

  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

  const providerToken = randomBytes(24).toString("hex");

  const secret = randomBytes(32).toString("hex");

  const password = randomBytes(24).toString("hex");

  const person = "delivery-recovery-person";

  const email = "delivery-recovery@example.invalid";

  const department = "delivery-recovery-department";

  type Mode = "failure" | "accept" | "hold";

  let resetMode: Mode = "failure";

  let receiptMode: Mode = "failure";

  const attempts: Array<{
    kind: "reset" | "receipt";
    id: string;
    hash: string;
    accepted: boolean;
  }> = [];

  const held: Array<Deferred.Deferred<void>> = [];

  const releaseHeld = Effect.suspend(() =>
    Effect.forEach(held.splice(0), (release) => Deferred.succeed(release, undefined)),
  );

  const poison = new Set<string>();

  const pool = new Pool({
    connectionString: postgresUrl,
    application_name: "delivery-recovery-observer",
  });

  const query = (text: string, values?: ReadonlyArray<unknown>) =>
    step(() => pool.query(text, values === undefined ? undefined : [...values]));

  const checks: string[] = [];

  let postgres: DisposablePostgres | undefined;

  let completed = false;

  let providerPort = 0;

  // A provider request that breaks an assertion answers 500; the proof fails on it at the end.
  const providerFailures: string[] = [];

  const provide = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    assert.equal(request.headers["authorization"], `Bearer ${providerToken}`);
    const payload = yield* request.text;
    const body = yield* Schema.decodeEffect(DeliveryBody)(payload);
    const kind = request.url === "/reset" ? "reset" : "receipt";

    const mode = poison.has(body.deliveryId)
      ? "failure"
      : kind === "reset"
        ? resetMode
        : receiptMode;

    assert.equal(request.headers["idempotency-key"], body.deliveryId);
    attempts.push({
      kind,
      id: body.deliveryId,
      hash: createHash("sha256").update(payload).digest("hex"),
      accepted: mode === "accept",
    });

    if (mode === "hold") {
      const pending = yield* Deferred.make<void>();
      held.push(pending);
      yield* Deferred.await(pending);
    }

    return HttpServerResponse.empty({ status: mode === "failure" ? 503 : 204 });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        providerFailures.push(String(cause));

        return HttpServerResponse.empty({ status: 500 });
      }),
    ),
  );

  let current: NativeProcess | undefined;

  let cookie = "";

  const inner = Effect.gen(function* () {
    yield* HttpServer.serveEffect(provide);

    const { address } = yield* HttpServer.HttpServer;

    if (Predicate.isTagged(address, "UnixPathAddress")) assert.fail("provider binds a TCP port");

    providerPort = address.port;

    const env = {
      ...safeEnvironment,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(apiPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: secret,
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([dashboardOrigin]),
      OAUTH_CANONICAL_ORIGIN: origin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      RECRUITMENT_NOTIFICATION_MODE: "disabled",
      SCHOOL_SERVICE_NOTIFICATION_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "http",
      PASSWORD_RESET_DELIVERY_POLL_MS: "2000",
      MAIL_SENDER: "recovery@example.invalid",
      MAIL_DELIVERY_URL: `http://127.0.0.1:${providerPort}/reset`,
      MAIL_DELIVERY_TOKEN: providerToken,
      MAIL_DELIVERY_TIMEOUT_MS: "30000",
      RECEIPT_DELIVERY_MODE: "http",
      RECEIPT_DELIVERY_POLL_MS: "10000",
      RECEIPT_DELIVERY_URL: `http://127.0.0.1:${providerPort}/receipt`,
      RECEIPT_DELIVERY_TOKEN: providerToken,
      RECEIPT_DELIVERY_TIMEOUT_MS: "30000",
      RECEIPT_DELIVERY_SENDER: "receipts@example.invalid",
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: yield* jsonText({
        [department]: "economy@example.invalid",
      }),
      RECEIPT_STAGING_ROOT: join(privateRoot, "staging"),
      RECEIPT_COMMITTED_ROOT: join(privateRoot, "committed"),
    } satisfies Environment;

    ownedPorts.push(providerPort);

    const start = Effect.fnUntraced(function* (childEnv: Environment) {
      const child = yield* ChildProcess.make(
        process.execPath,
        ["--no-env-file", "apps/backend/src/main.ts"],
        { cwd: root, env: { ...childEnv }, extendEnv: false, stdin: "ignore" },
      );

      const logs: string[] = [];

      yield* child.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.sync(() => logs.push(chunk))),
        Effect.ignore,
        Effect.forkScoped,
      );

      const exited = yield* child.exitCode.pipe(
        Effect.map((code): number | null => Number(code)),
        Effect.orElseSucceed(() => null),
        Effect.cached,
      );

      const owned: NativeProcess = { child, logs, exited };
      processes.push(owned);

      return owned;
    });

    const stop = Effect.fnUntraced(function* (
      owned: NativeProcess,
      name: NodeJS.Signals = "SIGTERM",
    ) {
      if (!(yield* owned.child.isRunning)) return;
      yield* signal(owned, name);

      const code = yield* exitWithin(owned, "Native shutdown timeout");

      if (name === "SIGTERM") assert.equal(code, 0, "graceful shutdown");
    });

    const boot = Effect.fnUntraced(function* (changes: Environment = {}) {
      const booted = yield* start({ ...env, ...changes });
      current = booted;
      yield* eventually(
        "native listener",
        Effect.gen(function* () {
          assert.ok(
            yield* booted.child.isRunning,
            booted.logs
              .join("")
              .replaceAll(secret, "[redacted]")
              .replaceAll(providerToken, "[redacted]")
              .replaceAll(password, "[redacted]")
              .replaceAll(email, "[redacted]"),
          );

          return yield* client.get(`${origin}/health`).pipe(
            Effect.map((response) =>
              changes["BACKEND_INGRESS"] === "internal"
                ? response.status === 404 &&
                  booted.logs.join("").includes("internal backend listening")
                : response.status >= 200 && response.status <= 299,
            ),
            Effect.orElseSucceed(() => false),
          );
        }),
      );

      return booted;
    });

    const resetRows = () =>
      query(
        "SELECT effect_id,verification_id,status,attempts,claim_id,payload_sha256,last_failure_code FROM auth.password_reset_email_outbox ORDER BY created_at,effect_id",
      ).pipe(Effect.map((result) => result.rows));

    const receiptRows = () =>
      query(
        "SELECT effect_id,receipt_id,status,attempts,claim_id,payload_json,delivery_envelope FROM economy_receipt_outbox ORDER BY receipt_id,ordinal",
      ).pipe(Effect.map((result) => result.rows));

    const resetRequest = Effect.fnUntraced(function* () {
      const response = yield* postJson(`${origin}/api/auth/request-password-reset`, {
        email,
        redirectTo: `${dashboardOrigin}/tilbakestill-passord`,
      });

      assert.equal(response.status, 200, "real reset request accepted");

      return (yield* resetRows()).at(-1)!;
    });

    const receiptRequest = () =>
      Effect.acquireUseRelease(
        Effect.sync(() => nativeScriptClient(origin)),
        (native) =>
          Effect.gen(function* () {
            const receiptDate = DateTime.formatIso(yield* DateTime.now).slice(0, 10);

            const result = yield* step(() =>
              native.call({ cookie, origin: dashboardOrigin }, (client) =>
                client["receipts.submitReceipt"]({
                  idempotencyKey: IdempotencyKey.make(randomUUID()),
                  departmentId: department,
                  request: {
                    description: "Disposable delivery recovery proof",
                    amountOre: 500,
                    receiptDate,
                    file: {
                      contentType: "application/pdf",
                      bytes: new TextEncoder().encode("%PDF-1.4\nDisposable receipt\n%%EOF"),
                    },
                  },
                }),
              ),
            );

            assert.ok(result.ok, "real receipt submission accepted");

            return result.value.receiptId;
          }),
        (native) => Effect.promise(() => native.dispose()),
      );

    const business = () =>
      query(`SELECT (SELECT count(*)::int FROM economy_receipts) AS receipts,
  (SELECT count(*)::int FROM economy_receipt_command_receipts) AS commands,
  (SELECT count(*)::int FROM economy_receipt_audit) AS audit,
  (SELECT count(*)::int FROM auth.identity_security_audit WHERE event_kind='password-reset-request-accepted') AS resets,
  (SELECT count(*)::int FROM auth.verification WHERE identifier LIKE 'reset-password:%') AS verifications`).pipe(
        Effect.map((result) => result.rows[0]),
      );

    const started = yield* step(() =>
      startDisposablePostgres({
        port: pgPort,
        directory: pgDirectory,
        environment: safeEnvironment,
      }),
    );

    postgres = started;
    assert.equal(started.url, postgresUrl, "owned PostgreSQL serves the configured URL");
    yield* run(
      process.execPath,
      ["--no-env-file", "packages/database/runtime/identity-seed-main.ts"],
      {
        ...env,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: yield* jsonText([
          { personId: person, firstName: "Recovery", lastName: "Proof", email, password },
        ]),
      },
    );
    // Prerequisites only: no receipt, reset verification, command receipt, or delivery outcome is seeded.
    yield* query(
      "INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES($1,'Recovery proof','RP','department@example.invalid','Trondheim')",
      [department],
    );
    yield* query(
      "INSERT INTO organization_teams(team_id,department_id,name) VALUES('delivery-recovery-team',$1,'Recovery proof')",
      [department],
    );
    yield* query(
      "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader) VALUES('delivery-recovery-membership',$1,'delivery-recovery-team',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '24 hours',false)",
      [person],
    );
    yield* query(
      "INSERT INTO person_contact_profiles(person_id,email,phone) VALUES($1,$2,'90000000')",
      [person, email],
    );
    yield* query(
      "INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES('delivery-recovery-payment',$1,$2,'synthetic:delivery-recovery',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '24 hours',0)",
      [person, department],
    );
    yield* boot();

    const login = yield* postJson(`${origin}/api/auth/sign-in/email`, { email, password });

    assert.equal(login.status, 200);
    cookie = Object.values(login.cookies.cookies)
      .map((value) => `${value.name}=${value.valueEncoded}`)
      .join("; ");
    const reset = yield* resetRequest();
    const receiptId = yield* receiptRequest();
    yield* eventually(
      "both durable failures",
      Effect.gen(function* () {
        return (
          (yield* resetRows()).some(
            (row) => row.effect_id === reset.effect_id && row.status === "Failed",
          ) &&
          (yield* receiptRows()).some(
            (row) => row.receipt_id === receiptId && row.status === "Failed",
          )
        );
      }),
    );
    yield* stop(current!);
    const before = yield* business();
    const failedReset = (yield* resetRows()).find((row) => row.effect_id === reset.effect_id)!;

    const failedReceipt = (yield* receiptRows()).find(
      (row) => row.receipt_id === receiptId && row.status === "Failed",
    )!;

    assert.equal(failedReset.attempts, 1);
    assert.equal(failedReceipt.attempts, 1);
    resetMode = "accept";
    receiptMode = "accept";
    yield* boot({
      PASSWORD_RESET_DELIVERY_POLL_MS: "100",
      RECEIPT_DELIVERY_POLL_MS: "100",
      RECEIPT_DELIVERY_SENDER: "changed@example.invalid",
    });
    yield* eventually(
      "unattended recovery",
      Effect.gen(function* () {
        return (
          (yield* resetRows()).find((row) => row.effect_id === reset.effect_id)?.status ===
            "Delivered" &&
          (yield* receiptRows())
            .filter((row) => row.receipt_id === receiptId)
            .every((row) => row.status === "Delivered")
        );
      }),
    );
    assert.deepEqual(yield* business(), before);

    for (const id of [reset.effect_id, failedReceipt.effect_id]) {
      const deliveries = attempts.filter((attempt) => attempt.id === id);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0]!.hash, deliveries[1]!.hash);
      assert.equal(deliveries[1]!.accepted, true);
    }

    assert.equal(
      (yield* resetRows()).find((row) => row.effect_id === reset.effect_id)!.attempts,
      2,
    );
    assert.equal(
      (yield* receiptRows()).find((row) => row.effect_id === failedReceipt.effect_id)!.attempts,
      2,
    );
    checks.push(
      "reset and receipt: real request -> durable failure -> stopped native process -> unattended restart success; stable effect/payload, attempts=2, unchanged business facts",
    );
    yield* stop(current!);

    receiptMode = "failure";
    yield* boot({ RECEIPT_DELIVERY_MODE: "disabled", PASSWORD_RESET_DELIVERY_MODE: "disabled" });
    const poisonedReceipt = yield* receiptRequest();
    const otherReceipt = yield* receiptRequest();

    const poisonedEffect = (yield* receiptRows()).find(
      (row) => row.receipt_id === poisonedReceipt && row.status === "Failed",
    )!;

    poison.add(poisonedEffect.effect_id);
    const beforeDisabled = yield* receiptRows();
    yield* Effect.sleep("300 millis");
    assert.deepEqual(yield* receiptRows(), beforeDisabled);
    yield* stop(current!);
    yield* boot({
      BACKEND_INGRESS: "internal",
      OAUTH_INTERNAL_SOURCE_NETWORKS: "127.0.0.1/32",
      PASSWORD_RESET_DELIVERY_POLL_MS: "100",
      RECEIPT_DELIVERY_POLL_MS: "100",
    });
    yield* Effect.sleep("300 millis");
    assert.deepEqual(yield* receiptRows(), beforeDisabled);
    yield* stop(current!);
    receiptMode = "accept";
    yield* boot({ RECEIPT_DELIVERY_POLL_MS: "100" });
    yield* eventually(
      "unrelated receipt progresses past poison",
      Effect.gen(function* () {
        return (yield* receiptRows())
          .filter((row) => row.receipt_id === otherReceipt)
          .every((row) => row.status === "Delivered");
      }),
    );
    assert.equal(
      (yield* receiptRows()).find((row) => row.effect_id === poisonedEffect.effect_id)!.status,
      "Failed",
    );
    poison.clear();
    yield* eventually(
      "poison recovery",
      Effect.gen(function* () {
        return (yield* receiptRows())
          .filter((row) => row.receipt_id === poisonedReceipt)
          .every((row) => row.status === "Delivered");
      }),
    );
    yield* stop(current!);
    checks.push(
      "disabled and internal workers do not claim; a failed receipt does not starve another receipt; predecessor order remains enforced",
    );

    // A changed reset payload must never reuse an idempotency key with a different body.
    resetMode = "failure";
    yield* boot();
    const drift = yield* resetRequest();
    yield* eventually(
      "reset drift baseline",
      Effect.gen(function* () {
        return (
          (yield* resetRows()).find((row) => row.effect_id === drift.effect_id)?.status === "Failed"
        );
      }),
    );
    yield* stop(current!);
    resetMode = "accept";
    yield* boot({ MAIL_SENDER: "changed@example.invalid", PASSWORD_RESET_DELIVERY_POLL_MS: "100" });
    yield* eventually(
      "reset drift quarantine",
      Effect.gen(function* () {
        return (
          (yield* resetRows()).find((row) => row.effect_id === drift.effect_id)?.status ===
          "Quarantined"
        );
      }),
    );
    assert.equal(attempts.filter((attempt) => attempt.id === drift.effect_id).length, 1);
    checks.push("reset payload drift quarantines without a second provider request");
    yield* stop(current!);

    resetMode = "hold";
    yield* boot({ PASSWORD_RESET_DELIVERY_POLL_MS: "100" });
    const interrupted = yield* resetRequest();
    yield* eventually(
      "reset in flight",
      Effect.sync(() => attempts.some((attempt) => attempt.id === interrupted.effect_id)),
    );
    yield* stop(current!);

    const interruptedRow = (yield* resetRows()).find(
      (row) => row.effect_id === interrupted.effect_id,
    )!;

    assert.equal(interruptedRow.status, "Quarantined");
    assert.equal(interruptedRow.claim_id, null);
    assert.equal(interruptedRow.last_failure_code, "delivery-timeout");
    yield* releaseHeld;
    checks.push(
      "SIGTERM aborts reset provider delivery, joins fenced quarantine, and releases the native pool",
    );

    // Freeze an actual native owner, let its lease become stale, and start a replacement owner.
    resetMode = "hold";
    receiptMode = "hold";
    yield* boot({ PASSWORD_RESET_DELIVERY_POLL_MS: "100", RECEIPT_DELIVERY_POLL_MS: "100" });
    const staleReset = yield* resetRequest();

    const staleReceiptRequest = yield* receiptRequest().pipe(
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );

    yield* eventually(
      "two held provider claims",
      Effect.gen(function* () {
        return (
          attempts.some((attempt) => attempt.id === staleReset.effect_id) &&
          (yield* receiptRows()).some(
            (row) => row.status === "Processing" && row.delivery_envelope !== null,
          )
        );
      }),
    );
    const oldReset = (yield* resetRows()).find((row) => row.effect_id === staleReset.effect_id)!;

    const oldReceipt = (yield* receiptRows()).find(
      (row) => row.status === "Processing" && row.delivery_envelope !== null,
    )!;

    const frozen = current!;
    yield* signal(frozen, "SIGSTOP");
    yield* Effect.sleep("61000 millis");
    resetMode = "accept";
    receiptMode = "accept";
    // A second main uses a separate listener, but the same durable queue and filesystem.
    current = yield* start({
      ...env,
      BACKEND_PORT: String(replacementPort),
      PASSWORD_RESET_DELIVERY_POLL_MS: "100",
      RECEIPT_DELIVERY_POLL_MS: "100",
    });
    yield* eventually(
      "stale recovery",
      Effect.gen(function* () {
        return (
          (yield* resetRows()).find((row) => row.effect_id === oldReset.effect_id)?.status ===
            "Quarantined" &&
          (yield* receiptRows()).find((row) => row.effect_id === oldReceipt.effect_id)?.status ===
            "Delivered"
        );
      }),
    );

    const replacementReceipt = (yield* receiptRows()).find(
      (row) => row.effect_id === oldReceipt.effect_id,
    )!;

    assert.equal(replacementReceipt.attempts, oldReceipt.attempts + 1);
    assert.deepEqual(replacementReceipt.delivery_envelope, oldReceipt.delivery_envelope);
    assert.equal(attempts.filter((attempt) => attempt.id === oldReset.effect_id).length, 1);
    const factsAfterRecovery = yield* business();
    yield* signal(frozen, "SIGCONT");
    yield* releaseHeld;
    yield* Effect.sleep("500 millis");
    yield* stop(frozen);
    yield* Fiber.join(staleReceiptRequest);
    assert.equal(
      (yield* resetRows()).find((row) => row.effect_id === oldReset.effect_id)!.status,
      "Quarantined",
    );
    assert.equal(
      (yield* receiptRows()).find((row) => row.effect_id === oldReceipt.effect_id)!.status,
      "Delivered",
    );
    assert.deepEqual(yield* business(), factsAfterRecovery);
    yield* stop(current!);
    checks.push(
      "stale reset owner cannot acknowledge quarantine; stale receipt owner cannot overwrite replacement delivery; receipt envelope and business facts remain unchanged",
    );

    // A real command creates pending notification work; only DDL injects the storage fault.
    yield* boot({
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_URL: undefined,
      RECEIPT_DELIVERY_TOKEN: undefined,
      RECEIPT_DELIVERY_TIMEOUT_MS: undefined,
      RECEIPT_DELIVERY_SENDER: undefined,
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: undefined,
    });
    const faultReceipt = yield* receiptRequest();
    yield* stop(current!);

    const faultEffect = (yield* receiptRows()).find(
      (row) => row.receipt_id === faultReceipt && row.status === "Failed",
    )!;

    assert.equal(faultEffect.delivery_envelope, null);
    yield* query(
      "CREATE FUNCTION delivery_recovery_envelope_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic envelope persistence fault'; END $$; CREATE TRIGGER delivery_recovery_envelope_fault BEFORE UPDATE OF delivery_envelope ON economy_receipt_outbox FOR EACH ROW EXECUTE FUNCTION delivery_recovery_envelope_fault()",
    );

    const interpreter = yield* start({
      ...env,
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_POLL_MS: "100",
    });

    current = interpreter;

    const interpreterCode = yield* exitWithin(
      interpreter,
      "Receipt interpreter SQL failure timeout",
    );

    assert.equal(interpreterCode, 1);
    assert.ok(interpreter.logs.join("").includes("receipt delivery worker failed"));
    assert.equal(attempts.filter((attempt) => attempt.id === faultEffect.effect_id).length, 0);
    assert.equal(
      (yield* receiptRows()).find((row) => row.effect_id === faultEffect.effect_id)!.status,
      "Processing",
    );
    yield* query(
      "DROP TRIGGER delivery_recovery_envelope_fault ON economy_receipt_outbox; DROP FUNCTION delivery_recovery_envelope_fault()",
    );
    checks.push(
      "receipt envelope persistence failure stops root without a provider request or retryable failure acknowledgment",
    );

    resetMode = "hold";
    yield* boot({ PASSWORD_RESET_DELIVERY_POLL_MS: "100", RECEIPT_DELIVERY_MODE: "disabled" });
    const shutdownFailure = yield* resetRequest();
    yield* eventually(
      "reset finalization fault prerequisite",
      Effect.sync(() => attempts.some((attempt) => attempt.id === shutdownFailure.effect_id)),
    );
    yield* query(
      "ALTER TABLE auth.password_reset_email_outbox RENAME TO password_reset_email_outbox_shutdown_fault",
    );
    yield* signal(current!, "SIGTERM");

    const shutdownCode = yield* exitWithin(current!, "Finalization failure shutdown timeout");

    assert.equal(shutdownCode, 1, "failed interruption finalization must not exit cleanly");
    yield* query(
      "ALTER TABLE auth.password_reset_email_outbox_shutdown_fault RENAME TO password_reset_email_outbox",
    );
    yield* releaseHeld;
    checks.push("reset interruption finalization SQL failure preserves nonzero root exit");

    // Fault injection affects availability, not durable business outcomes.
    for (const kind of ["reset", "receipt"] as const) {
      yield* boot({
        PASSWORD_RESET_DELIVERY_MODE: kind === "reset" ? "http" : "disabled",
        RECEIPT_DELIVERY_MODE: kind === "receipt" ? "http" : "disabled",
        PASSWORD_RESET_DELIVERY_POLL_MS: "100",
        RECEIPT_DELIVERY_POLL_MS: "100",
      });

      const table =
        kind === "reset" ? "auth.password_reset_email_outbox" : "economy_receipt_outbox";

      const renamed =
        kind === "reset" ? "password_reset_email_outbox_fault" : "economy_receipt_outbox_fault";

      yield* query(`ALTER TABLE ${table} RENAME TO ${renamed}`);

      const code: number | null = yield* exitWithin(current!, "Root worker failure timeout");

      assert.equal(code, 1);
      assert.ok(
        current!.logs
          .join("")
          .includes(
            kind === "reset"
              ? "password reset delivery worker failed"
              : "receipt delivery worker failed",
          ),
      );
      yield* query(
        `ALTER TABLE ${kind === "reset" ? "auth." : ""}${renamed} RENAME TO ${table.split(".").at(-1)}`,
      );
      checks.push(`${kind}: root SQL failure stops actual native main with exit 1`);
    }

    const sessions = yield* query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
    );

    assert.equal(sessions.rows[0].count, 0);
    checks.push("all native processes exited; no native PostgreSQL sessions remain");
    assert.equal(checks.length, 10);
    assert.deepEqual(providerFailures, [], "every provider request met its assertions");
    completed = true;
  });

  // Every owned native process exits before the pool, the provider, and the cluster close.
  const cleanup = Effect.gen(function* () {
    yield* releaseHeld;

    for (const owned of processes) {
      if (yield* owned.child.isRunning) {
        yield* signal(owned, "SIGCONT");
        yield* signal(owned, "SIGKILL");
        yield* owned.exited;
      }
    }

    yield* Effect.promise(() => pool.end());
  });

  const outcome = yield* Effect.exit(
    Effect.scoped(inner.pipe(Effect.ensuring(Effect.orDie(cleanup)))).pipe(
      Effect.provide(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
    ),
  );

  const stopped = postgres;

  if (stopped !== undefined) yield* Effect.promise(() => stopped.stop());
  yield* fileSystem.remove(privateRoot, { recursive: true, force: true });

  for (const expected of ownedPorts)
    assert.ok(yield* step(() => loopbackPortFree(expected)), `owned listener ${expected} released`);
  const postRunRevision = (yield* run("git", ["rev-parse", "HEAD"])).trim();
  const postRunTree = (yield* run("git", ["rev-parse", "HEAD^{tree}"])).trim();

  const sourceUnchanged =
    postRunRevision === revision &&
    postRunTree === sourceTree &&
    (yield* run("git", ["status", "--porcelain"])).trim() === "";

  yield* fileSystem.writeFileString(
    join(artifacts, "evidence.json"),
    (yield* indentedJsonText({
      revision,
      sourceTree,
      status: completed && sourceUnchanged ? "passed" : "failed",
      postRunRevision,
      postRunTree,
      sourceUnchanged,
      ownedPids: [...processes.map((owned) => owned.child.pid), stopped?.pid],
      ownedPorts,
      runtime: process.versions.bun,
      checks,
      cleanup: { privateResourcesRemoved: true, providersStopped: true, processesStopped: true },
      scope: "Synthetic local PostgreSQL and loopback provider only; no exactly-once claim",
    })) + "\n",
    { mode: 0o600 },
  );

  if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);

  assert.ok(completed && sourceUnchanged, "proof and source identity must pass");

  yield* Console.log(`PASS ${checks.length} recovery observations; sanitized evidence retained`);
});

BunRuntime.runMain(
  proof.pipe(
    surfaceStepFailure,
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
);
