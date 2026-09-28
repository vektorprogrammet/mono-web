/**
 * Placement journeys with an owned process lifecycle (0096/0110/0111): the broad placement API
 * (`--api-only`) and its browser acceptance (`--browser`), the golden school-service journey
 * (`--golden-school-service`), and the golden recruitment journey (`--golden-recruitment`).
 *
 * Boots a private PostgreSQL cluster, a loopback notification receiver and checkpoint observer,
 * and the native Bun backend on reserved loopback ports, drives the journey, and writes the
 * evidence and the `native-functional-journey/v1` receipt. It exits 0 when the journey passed,
 * 130 after SIGINT, 143 after SIGTERM, and 1 otherwise, also when cleanup fails.
 *
 * Usage: bun --no-env-file tools/e2e/placement-check.ts --browser | --api-only | --golden-school-service | --golden-recruitment
 * Faults: GOLDEN_SCHOOL_SERVICE_FAULT, which the browser driver of the golden journey reads.
 */
import assert from "node:assert/strict";
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
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementScope,
  SchoolServiceNotificationRequest,
} from "@vektorprogrammet/domain/placements";
import { IdempotencyKey, StrongETag } from "@vektorprogrammet/rpc/problem";
import { nativeScriptClient, type ScriptCallResult } from "@vektorprogrammet/rpc/script";
import {
  Config,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Record as Rec,
  Schema,
  Scope,
  Stream,
  Struct,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";
import { Pool } from "pg";
import { answersOk, indentedJsonText } from "../acceptance/acceptance-process";
import {
  committed,
  firstSetCookie,
  jsonText,
  type JourneyStepFailed,
  step,
  thrownBy,
} from "../acceptance/journey-step";
import { createGoldenObserver, goldenFaults, goldenSteps } from "./golden-school-service";
import {
  goldenArtifactName,
  goldenRunnerPaths,
  redactDiagnostic,
  redactedEvidenceJson,
  sha256,
} from "./golden-school-service-evidence";
import {
  createRecruitmentMailbox,
  createRecruitmentObserver,
  recruitmentFixture,
  recruitmentPeople,
  recruitmentRunnerPaths,
  recruitmentSteps,
  seedRecruitment,
} from "./golden-recruitment";
import { admissionJourneyClock } from "./journey-clock";

const modes = ["--browser", "--api-only", "--golden-school-service", "--golden-recruitment"];

/** The variables that the journey passes from the operator shell to its children. */
const safeEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "PLAYWRIGHT_NODE_EXECUTABLE",
  "PLAYWRIGHT_BROWSERS_PATH",
  "GOLDEN_PROCESS_GROUPS_PATH",
];

type Environment = Record<string, string>;

type NotificationCapture<Payload> = {
  authorization?: string;
  idempotencyKey?: string;
  readonly body: Payload;
};

/** A step of the journey that failed: a command, a child, or a readiness wait. */
class PlacementCheckFailure extends Data.TaggedError("PlacementCheckFailure")<{
  readonly message: string;
}> {}

/** One child process that the journey owns: its release stops it, escalating to SIGKILL. */
interface OwnedChild {
  readonly pid: number;
  readonly scope: Scope.Closeable;
  /** The exit code, or null when a signal ended the process. */
  readonly exit: Deferred.Deferred<number | null>;
}

const DiagnosticLine = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const BrowserEvidenceJson = Schema.fromJsonString(Schema.JsonObject);

/** The JSON text of a document; decoding it gives the plain JSON value that the text writes. */
const JsonDocument = Schema.fromJsonString(Schema.Json);

const NotificationRequestJson = Schema.fromJsonString(SchoolServiceNotificationRequest);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  // Claimed invitations expire after the run. Nothing reads the expiry of a claimed invitation,
  // but it must follow the issue instant.
  const claimExpiresAt = admissionJourneyClock().fromNow(120);

  const mode = process.argv[2] ?? "";

  assert.ok(
    process.argv.length === 3 && modes.includes(mode),
    "Usage: bun run tools/e2e/placement-check.ts --browser | --api-only | --golden-school-service | --golden-recruitment",
  );

  const recruitment = mode === "--golden-recruitment";

  const recruitmentMailbox = createRecruitmentMailbox();

  const children: Array<OwnedChild> = [];

  const outputs: Array<string> = [];

  /**
   * Runs one command to its end in the checkout and answers its standard output. Without `env`
   * the command inherits the environment of the runner.
   */
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    env?: Environment,
    timeout: `${number} seconds` = "60 seconds",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* env === undefined
          ? ChildProcess.make(command, args, { cwd: root, stdin: "ignore" })
          : ChildProcess.make(command, args, { cwd: root, env, extendEnv: false, stdin: "ignore" });

        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        if (code !== 0)
          return yield* new PlacementCheckFailure({
            message: `Command failed: ${[command, ...args].join(" ")}\n${stderr}`,
          });

        return stdout;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new PlacementCheckFailure({ message: `${command} timed out` })),
      }),
    );

  /** Starts one owned child in the checkout; its output joins the diagnostic outputs. */
  const start = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    env: Environment,
  ) {
    const scope = yield* Scope.make();

    const handle = yield* ChildProcess.make(command, args, {
      cwd: root,
      env,
      extendEnv: false,
      detached: false,
      stdin: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "5 seconds",
    }).pipe(Scope.provide(scope));

    const exit = yield* Deferred.make<number | null>();
    const child: OwnedChild = { pid: handle.pid, scope, exit };

    children.push(child);

    for (const stream of [handle.stdout, handle.stderr])
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.sync(() => outputs.push(chunk))),
        Effect.ignore,
        Effect.forkDetach,
      );

    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((result) =>
        Deferred.succeed(exit, Exit.isSuccess(result) ? result.value : null),
      ),
      Effect.forkDetach,
    );

    return child;
  });

  /** Sends SIGTERM, escalates to SIGKILL after five seconds, and ends on the observed exit. */
  const stopChild = (child: OwnedChild) => Scope.close(child.scope, Exit.void);

  const childExited = (child: OwnedChild) => Deferred.isDone(child.exit);

  /**
   * Runs one owned child to its end within `timeout`. It fails when the child exits with another
   * code than 0, and stops the child when the timeout passes.
   */
  const runChild = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    env: Environment,
    timeout: `${number} seconds`,
  ) {
    const child = yield* start(command, args, env);

    const code = yield* Deferred.await(child.exit).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          stopChild(child).pipe(
            Effect.andThen(
              Effect.fail(new PlacementCheckFailure({ message: command + " timed out" })),
            ),
          ),
      }),
    );

    if (code !== 0)
      return yield* new PlacementCheckFailure({ message: command + " exited " + String(code) });
  });

  const revision = (yield* run("git", ["rev-parse", "HEAD"])).trim();

  const sourceTree = (yield* run("git", ["rev-parse", "HEAD^{tree}"])).trim();

  assert.equal(
    (yield* run("git", ["status", "--porcelain"])).trim(),
    "",
    "requires committed clean artifact",
  );

  const artifacts = yield* fs.makeTempDirectory({ prefix: "vektor-placements-0096-" });

  yield* Effect.sync(() =>
    process.stdout.write("artifacts: " + artifacts + "\nrunner-pid: " + process.pid + "\n"),
  );

  const safeEnvironment: Environment = Object.fromEntries(
    yield* Effect.forEach(safeEnvironmentKeys, (key) =>
      Effect.map(Config.option(Config.String(key)), (value) =>
        Option.match(value, { onNone: () => [], onSome: (text) => [[key, text] as const] }),
      ),
    ).pipe(Effect.map((entries) => entries.flat())),
  );

  const fault = Option.getOrUndefined(
    yield* Config.option(Config.String("GOLDEN_SCHOOL_SERVICE_FAULT")),
  );

  assert.ok(fault === undefined || goldenFaults.includes(fault), "unknown test-driver fault");

  const secrets = [
    "synthetic-recruitment-provider",
    "journey-secret-0123456789abcdef",
    "synthetic-school-service-token",
  ];

  const sanitize = (value: string) => redactDiagnostic(secrets, value);

  let postgres: DisposablePostgres | undefined;

  let pool: Pool | undefined;

  /** What the journey recorded; each journey sets it only when it passed. */
  let evidence: object | undefined;

  let journeyPassed = false;

  let notificationServer: Bun.Server<undefined> | undefined;

  let receiverOpen = false;

  let checkpoint:
    | ((step: string) => Effect.Effect<unknown, JourneyStepFailed | Schema.SchemaError>)
    | undefined;

  let observations: Array<{ step: string }> = [];

  let ownedPorts: Array<number> = [];

  let failure: string | undefined;

  let interruptedSignal: "SIGINT" | "SIGTERM" | undefined;

  const interrupted = yield* Deferred.make<void>();

  /** Stops every owned resource, then writes the evidence and the receipt; answers the errors. */
  const cleanup = Effect.gen(function* () {
    const errors: Array<string> = [];

    const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            errors.push(sanitize(String(thrownBy(cause))));
          }),
        ),
      );

    for (const child of [...children].reverse()) yield* attempt(stopChild(child));

    const observerPool = pool;

    if (observerPool !== undefined) yield* attempt(step(() => observerPool.end()));

    const cluster = postgres;

    if (cluster !== undefined) yield* attempt(step(() => cluster.stop()));

    const server = notificationServer;

    if (server !== undefined && receiverOpen)
      yield* attempt(
        step(() => server.stop(true)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              receiverOpen = false;
            }),
          ),
        ),
      );

    const removed: Array<string> = [];

    for (const name of ["postgres", "manifest.json"])
      yield* attempt(
        fs
          .remove(path.join(artifacts, name), { recursive: true, force: true })
          .pipe(Effect.andThen(Effect.sync(() => removed.push(name)))),
      );

    for (const number of ownedPorts)
      if (!(yield* Effect.promise(() => loopbackPortFree(number))))
        errors.push("owned port remains occupied: " + number);

    if (errors.length > 0 && failure === undefined) failure = "Resource cleanup failed";

    const exited = yield* Effect.forEach(children, childExited);

    const result = Struct.assign(evidence ?? {}, {
      passed: journeyPassed && failure === undefined,
      revision,
      sourceTree,
      cleanSource: true,
      mode,
      fault: fault ?? null,
      failure: failure === undefined ? null : sanitize(String(failure)),
      observations,
      transport: outputs
        .join("")
        .split("\n")
        .flatMap((line) => {
          if (!line.startsWith('{"diagnostic":"golden-http"')) return [];

          return Option.match(Schema.decodeOption(DiagnosticLine)(line), {
            onNone: () => [],
            onSome: ({ pid, sequence, method, path, event, elapsed_ms, status }) =>
              status === undefined
                ? [{ pid, sequence, method, path, event, elapsed_ms }]
                : [{ pid, sequence, method, path, event, elapsed_ms, status }],
          });
        }),
      cleanup: {
        processes: children.map((child, index) => ({
          pid: child.pid,
          exited: exited[index] === true,
        })),
        processesExited: exited.every((done) => done),
        ports: ownedPorts,
        portsReleased: errors.length === 0,
        postgresRemoved: removed.includes("postgres"),
        credentialManifestRemoved: removed.includes("manifest.json"),
        receiverClosed: !receiverOpen,
        errors,
      },
    });

    yield* fs.writeFileString(
      path.join(artifacts, "evidence.json"),
      redactedEvidenceJson(
        secrets,
        yield* Schema.decodeEffect(JsonDocument)(yield* jsonText(result)),
      ),
      { mode: 0o600 },
    );

    if (failure !== undefined)
      yield* fs.writeFileString(
        path.join(artifacts, "failure.log"),
        sanitize(outputs.join("").slice(-24000)),
        { mode: 0o600 },
      );
    const retained = [];

    for (const name of (yield* fs.readDirectory(artifacts)).sort()) {
      if (goldenArtifactName.test(name) !== true) continue;
      const bytes = yield* fs.readFile(path.join(artifacts, name));
      retained.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
    }

    const runnerSources = yield* Effect.forEach(
      recruitment ? recruitmentRunnerPaths : goldenRunnerPaths,
      (source) =>
        Effect.map(fs.readFile(path.join(root, source)), (bytes) => ({
          path: source,
          sha256: sha256(bytes),
        })),
      { concurrency: "unbounded" },
    );

    const receipt = {
      schema_version: "native-functional-journey/v1",
      journey_ref_id: recruitment
        ? "intent://golden-recruitment-first-placement"
        : mode === "--golden-school-service"
          ? "intent://golden-school-service"
          : "intent://native-placement-broad",
      mono_revision_ref_id: "rev-" + revision,
      source_tree: sourceTree,
      clean_source: true,
      environment_kind: "local_disposable",
      result: result.passed ? "passed" : "failed",
      exit_code: result.passed
        ? 0
        : errors.length > 0
          ? 1
          : interruptedSignal === "SIGINT"
            ? 130
            : interruptedSignal === "SIGTERM"
              ? 143
              : 1,
      termination_signal: interruptedSignal ?? null,
      required_browser: mode !== "--api-only",
      step_ids: observations.map((item) => item.step),
      runner_sources: runnerSources,
      fixture_digest: "sha256:" + runnerSources[0]!.sha256,
      artifact_digest: "sha256:" + sha256(yield* jsonText(retained)),
      artifacts: retained,
      runtime: {
        bun: process.versions.bun,
        postgres: postgresVersion(),
      },
    };

    yield* fs.writeFileString(
      path.join(artifacts, "receipt.json"),
      yield* indentedJsonText(receipt),
      { mode: 0o600 },
    );
    yield* Effect.sync(() => process.stdout.write(artifacts + "/receipt.json\n"));

    return errors;
  });

  const notificationRequests: Array<NotificationCapture<SchoolServiceNotificationRequest>> = [];

  /** Answers one request of the loopback receiver: an observer checkpoint or a provider call. */
  const receive = (request: Request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const target = url.pathname + url.search;

      if (request.method === "POST" && target.startsWith("/observe/")) {
        return yield* Effect.gen(function* () {
          assert.ok(checkpoint, "observer not ready");
          const result = yield* checkpoint(target.slice("/observe/".length));

          return new Response(yield* jsonText(result), {
            headers: { "content-type": "application/json" },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(new Response(sanitize(String(thrownBy(cause))), { status: 500 })),
          ),
        );
      }

      if (recruitment) return yield* recruitmentMailbox.handle(request);

      const idempotencyKey = request.headers.get("idempotency-key");
      const authorization = request.headers.get("authorization");

      const observed: NotificationCapture<SchoolServiceNotificationRequest> = {
        body: yield* Schema.decodeEffect(NotificationRequestJson)(
          yield* step(() => request.text()),
        ),
      };

      if (authorization !== null) observed.authorization = authorization;

      if (idempotencyKey !== null) observed.idempotencyKey = idempotencyKey;
      notificationRequests.push(observed);

      return new Response(null, { status: 204 });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(new Response(sanitize(String(thrownBy(cause))), { status: 500 })),
      ),
    );

  const serveReceiver = yield* FiberSet.makeRuntimePromise();

  const journey = Effect.gen(function* () {
    ownedPorts = [...(yield* step(() => reserveLoopbackPorts(recruitment ? 5 : 4)))];
    const [pgPort, backendPort, dashboardPort, notificationPort, homepagePort] = ownedPorts;

    notificationServer = yield* Effect.try(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: notificationPort,
        fetch: (request) => serveReceiver(receive(request)),
      }),
    );
    receiverOpen = true;
    postgres = yield* step(() =>
      startDisposablePostgres({
        port: pgPort!,
        directory: path.join(artifacts, "postgres"),
      }),
    );
    const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
    const journeyPool = new Pool({ connectionString: postgresUrl });
    pool = journeyPool;

    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

    const environment = {
      ...safeEnvironment,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([dashboardOrigin]),
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      JOURNEY_SEED_PG_URL: postgresUrl,
      SCHOOL_SERVICE_NOTIFICATION_MODE: "http",
      SCHOOL_SERVICE_NOTIFICATION_URL: `http://127.0.0.1:${notificationPort}/school-service`,
      SCHOOL_SERVICE_NOTIFICATION_TOKEN: "synthetic-school-service-token",
      SCHOOL_SERVICE_NOTIFICATION_POLL_MS: "25",
      SCHOOL_SERVICE_NOTIFICATION_STALE_MS: "1000",
      SCHOOL_SERVICE_NOTIFICATION_TIMEOUT_MS: "2000",
    };

    if (recruitment)
      Object.assign(environment, {
        RECRUITMENT_NOTIFICATION_MODE: "http",
        RECRUITMENT_NOTIFICATION_URL: `http://127.0.0.1:${notificationPort}/recruitment`,
        RECRUITMENT_NOTIFICATION_TOKEN: "synthetic-recruitment-provider",
        RECRUITMENT_NOTIFICATION_POLL_MS: "25",
        RECRUITMENT_NOTIFICATION_STALE_MS: "5000",
        RECRUITMENT_NOTIFICATION_TIMEOUT_MS: "2000",
        ONBOARDING_DELIVERY_URL: `http://127.0.0.1:${notificationPort}/onboarding`,
        ONBOARDING_DELIVERY_TOKEN: "synthetic-recruitment-provider",
        ONBOARDING_DELIVERY_TIMEOUT_MS: "2000",
        ONBOARDING_DELIVERY_SENDER: "onboarding@example.invalid",
      });

    secrets.push(environment.BETTER_AUTH_SECRET);

    for (const key of Object.keys(environment))
      if (
        key.startsWith("CONTACT_") ||
        (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
      )
        Reflect.deleteProperty(environment, key);

    const substitute = {
      personId: "journey-coverage-substitute-0111",
      firstName: "Kari",
      lastName: "Kandidat",
      email: "kari.kandidat@example.invalid",
      password: "journey-secret-0123456789abcdef",
    };

    // Golden prerequisites only: a second applicant to name as cover, and a department member
    // who reads the on-call list. Neither has an admission outcome before the journey records one.
    const secondSubstitute = {
      personId: "journey-coverage-second-substitute-0111",
      firstName: "Vera",
      lastName: "Vikar",
      email: "vera.vikar@example.invalid",
      password: "journey-secret-0123456789abcdef",
    };

    const member = {
      personId: "journey-coverage-member-0111",
      firstName: "Mona",
      lastName: "Medlem",
      email: "mona.medlem@example.invalid",
      password: "journey-secret-0123456789abcdef",
    };

    const departmentId = "department-native-journey-0049";
    const semesterId = "semester-historical-0096";
    const secondSemesterId = "semester-native-journey-0049";
    const wrongDepartmentId = "department-wrong-0096";
    const leaderId = "journey-rec-leader-0049";
    const volunteerId = "journey-rec-interviewer-a-0049";
    const wrongId = "journey-rec-interviewer-b-0049";

    if (recruitment) {
      yield* run("bun", ["--no-env-file", "packages/database/runtime/identity-seed-main.ts"], {
        ...environment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: yield* jsonText([
          recruitmentPeople.leader,
          recruitmentPeople.wrongDepartment,
        ]),
      });
      yield* seedRecruitment(journeyPool);
    } else if (mode === "--golden-school-service") {
      yield* run("bun", ["--no-env-file", "packages/database/runtime/identity-seed-main.ts"], {
        ...environment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: yield* jsonText([
          substitute,
          secondSubstitute,
          member,
          {
            personId: leaderId,
            firstName: "Lina",
            lastName: "Lagleder",
            email: "lina.leader@example.invalid",
            password: "journey-secret-0123456789abcdef",
          },
          {
            personId: volunteerId,
            firstName: "Irene",
            lastName: "Intervjuer",
            email: "irene.intervjuer@example.invalid",
            password: "journey-secret-0123456789abcdef",
          },
          {
            personId: wrongId,
            firstName: "Ida",
            lastName: "Intervjuer",
            email: "ida.intervjuer@example.invalid",
            password: "journey-secret-0123456789abcdef",
          },
        ]),
      });
      yield* step(() =>
        journeyPool.query(`
      INSERT INTO admission_period_departments(department_id,name) VALUES ('${departmentId}','Trondheim'),('${wrongDepartmentId}','Annen');
      INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES ('${semesterId}','2024-01-01','2024-07-01');
      INSERT INTO organization_departments(department_id,name,short_name,email,city,active,independent,revision) VALUES
        ('${departmentId}','Vektorprogrammet Trondheim','Trondheim','trondheim@example.invalid','Trondheim',true,true,0),
        ('${wrongDepartmentId}','Annen avdeling','Annen','wrong@example.invalid','Annen',true,false,0);
      -- golden-team is the department's board (Styret) of an independent department, so its
      -- leader reaches the department (O8-11). The wrong-department leader leads an ordinary team.
      INSERT INTO organization_teams(team_id,department_id,name,kind,active,revision) VALUES
        ('golden-team','${departmentId}','Koordinator','DepartmentBoard',true,0),('golden-wrong-team','${wrongDepartmentId}','Annet team','Team',true,0);
      INSERT INTO organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES
        ('golden-leader','${leaderId}','golden-team',NULL,date_trunc('milliseconds',now(),'UTC')-interval '24 hours',NULL,'teamleader',true,false,0),
        ('golden-member','${member.personId}','golden-team',NULL,date_trunc('milliseconds',now(),'UTC')-interval '24 hours',NULL,'member',false,false,0),
        ('golden-wrong','${wrongId}','golden-wrong-team',NULL,date_trunc('milliseconds',now(),'UTC')-interval '24 hours',NULL,'teamleader',true,false,0);
      INSERT INTO person_contact_profiles(person_id,email,phone,revision) VALUES
        ('${leaderId}','lina.leader@example.invalid','+47 900 00 049',0),
        ('${volunteerId}','irene.intervjuer@example.invalid','+47 900 00 052',0),
        ('${wrongId}','ida.intervjuer@example.invalid','+47 900 00 053',0),
        ('${member.personId}','${member.email}','+47 900 00 054',0);
      INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES
        (962,'Skole Beta','Kontakt','beta@example.invalid','synthetic','Norwegian',true,0);
      INSERT INTO schools_directory_departments(school_id,department_id,revision) VALUES (962,'${departmentId}',0);
      INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('golden-field','${departmentId}','Matematikk');
      INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('golden-period','${departmentId}','${semesterId}','2024-01-01','2024-07-01','seed');
      INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES
        ('golden-applicant','${substitute.email}','${substitute.email}','Kari','Kandidat','90000111',0,'golden-field',3),
        ('golden-second-applicant','${secondSubstitute.email}','${secondSubstitute.email}','Vera','Vikar','90000222',0,'golden-field',2);
      INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES
        ('golden-application','golden-applicant','golden-period','${departmentId}','golden-field',3,'2024-02-01'),
        ('golden-second-application','golden-second-applicant','golden-period','${departmentId}','golden-field',2,'2024-02-02');
      INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES
        ('golden-invitation','golden-application','golden-applicant','${"c".repeat(64)}','${claimExpiresAt}','Claimed','${leaderId}','2024-02-01'),
        ('golden-second-invitation','golden-second-application','golden-second-applicant','${"d".repeat(64)}','${claimExpiresAt}','Claimed','${leaderId}','2024-02-02');
      INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES
        ('golden-applicant','${substitute.personId}','2024-02-01','golden-invitation'),
        ('golden-second-applicant','${secondSubstitute.personId}','2024-02-02','golden-second-invitation');
      INSERT INTO person_contact_profiles(person_id,email,phone) VALUES
        ('${substitute.personId}','${substitute.email}','90000111'),
        ('${secondSubstitute.personId}','${secondSubstitute.email}','90000222');
    `),
      );
    } else {
      yield* run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
      yield* run("bun", ["run", "--cwd", "packages/database", "identity:seed"], {
        ...environment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: yield* jsonText([substitute]),
      });
      yield* step(() =>
        journeyPool.query(`
    INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES ('${semesterId}','2024-01-01','2024-07-01');
    INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES
      ('admission-period-coverage-0111','${departmentId}','${semesterId}','2024-01-01','2024-07-01',0,'coverage-seed-0111');
    INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest) VALUES
      ('applicant-coverage-0111','${substitute.email}','${substitute.email}','${substitute.firstName}','${substitute.lastName}','90000111',0,'field-native-journey-0049',3,NULL);
    INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision) VALUES
      ('application-coverage-0111','applicant-coverage-0111','admission-period-coverage-0111','${departmentId}','field-native-journey-0049',3,'2024-02-01T10:00:00.000Z',0);
    INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES
      ('invitation-coverage-0111','application-coverage-0111','applicant-coverage-0111','${"c".repeat(64)}','${claimExpiresAt}','Claimed','${leaderId}','2024-02-01T10:00:00.000Z');
    INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES
      ('applicant-coverage-0111','${substitute.personId}','2024-02-01T10:00:00.000Z','invitation-coverage-0111');
    INSERT INTO person_contact_profiles(person_id,email,phone,revision) VALUES
      ('${substitute.personId}','${substitute.email}','+47 900 00 111',0);
    INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES ('${wrongDepartmentId}','Annen avdeling','Annen','wrong@example.invalid','Annen',true,0);
    INSERT INTO organization_teams(team_id,department_id,name,active,revision) VALUES ('team-wrong-0096','${wrongDepartmentId}','Annet team',true,0);
    UPDATE organization_memberships SET team_id='team-wrong-0096',is_team_leader=true WHERE person_id='${wrongId}';
    DELETE FROM organization_memberships WHERE person_id='${volunteerId}';
    DELETE FROM organization_global_administrator_grants;
    INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES
      (961,'Skole Alfa','Kontakt','alfa@example.invalid','synthetic','Norwegian',true,0),
      (962,'Skole Beta','Kontakt','beta@example.invalid','synthetic','Norwegian',true,0),
      (963,'Skole Feil avdeling','Kontakt','wrong@example.invalid','synthetic','Norwegian',true,0),
      (964,'Skole Inaktiv','Kontakt','inactive@example.invalid','synthetic','Norwegian',false,0);
    INSERT INTO schools_directory_departments(school_id,department_id,revision) VALUES (961,'${departmentId}',0),(962,'${departmentId}',0),(963,'${wrongDepartmentId}',0),(964,'${departmentId}',0);
  `),
      );
    }

    const credentialSnapshot = Effect.map(
      step(() =>
        journeyPool.query('SELECT id,"userId","providerId",password FROM auth.account ORDER BY id'),
      ),
      ({ rows }) => sha256(JSON.stringify(rows)),
    );

    const credentialsBefore = yield* credentialSnapshot;

    const peopleBefore = (yield* step(() =>
      journeyPool.query("SELECT * FROM person_profiles ORDER BY person_id"),
    )).rows;

    yield* start(
      "bun",
      [
        "--no-env-file",
        ...(mode === "--golden-school-service"
          ? ["--preload", "./tools/e2e/golden-http-diagnostics.mjs"]
          : []),
        "apps/backend/src/main.ts",
      ],
      environment,
    );

    for (let n = 0; ; n++) {
      if (yield* answersOk(`${backendOrigin}/health`)) break;

      if (n > 150) return yield* new PlacementCheckFailure({ message: "backend startup failed" });
      yield* Effect.sleep("200 millis");
    }

    const persons = {
      leader: { email: "lina.leader@example.invalid", password: "journey-secret-0123456789abcdef" },
      volunteer: {
        email: "irene.intervjuer@example.invalid",
        password: "journey-secret-0123456789abcdef",
      },
      wrongDepartment: {
        email: "ida.intervjuer@example.invalid",
        password: "journey-secret-0123456789abcdef",
      },
      candidate: { email: substitute.email, password: substitute.password },
    };

    if (recruitment) {
      const manifest = {
        ...recruitmentFixture,
        revision,
        backendOrigin,
        dashboardOrigin,
        artifacts,
        recruitment: true,
        homepageOrigin: `https://127.0.0.1:${homepagePort}`,
        observerOrigin: `http://127.0.0.1:${notificationPort}`,
      };

      const observer = createRecruitmentObserver({
        pool: journeyPool,
        mailbox: recruitmentMailbox,
      });

      observations = observer.observations;
      checkpoint = observer.observe;
      yield* observer.observe("initial");
      const manifestPath = path.join(artifacts, "manifest.json");
      yield* fs.writeFileString(manifestPath, yield* jsonText(manifest), { mode: 0o600 });
      yield* runChild(
        "bun",
        ["--no-env-file", "apps/dashboard/e2e/run-real-native-placement.mjs"],
        { ...safeEnvironment, PLACEMENT_JOURNEY_MANIFEST: manifestPath },
        "300 seconds",
      );

      const browserEvidence = yield* Schema.decodeEffect(BrowserEvidenceJson)(
        yield* fs.readFileString(path.join(artifacts, "browser-evidence.json")),
      );

      assert.equal(browserEvidence.passed, true);
      assert.equal(browserEvidence.revision, revision);
      assert.deepEqual(browserEvidence.steps, recruitmentSteps.slice(1));
      assert.equal((yield* run("git", ["rev-parse", "HEAD"])).trim(), revision);
      assert.equal(
        (yield* run("git", ["status", "--porcelain"])).trim(),
        "",
        "source changed during acceptance",
      );
      evidence = { passed: true, browser: browserEvidence, ...observer.finish() };
      journeyPassed = true;

      return;
    }

    if (mode === "--golden-school-service") {
      const manifest = {
        revision,
        backendOrigin,
        dashboardOrigin,
        artifacts,
        departmentId,
        semesterId,
        volunteerId,
        leaderId,
        schoolId: 962,
        persons: { ...persons, member: { email: member.email, password: member.password } },
        serviceDate: "2024-03-11",
        golden: true,
        candidateId: substitute.personId,
        applicationId: "golden-application",
        secondSubstituteId: secondSubstitute.personId,
        secondApplicationId: "golden-second-application",
        memberId: member.personId,
        substituteServiceDate: "2024-03-18",
        fault,
        observerOrigin: "http://127.0.0.1:" + notificationPort,
      };

      const observer = createGoldenObserver({
        pool: journeyPool,
        fixture: manifest,
        deliveries: notificationRequests,
      });

      observations = observer.observations;
      checkpoint = observer.observe;
      yield* observer.observe("initial");
      const manifestPath = path.join(artifacts, "manifest.json");
      yield* fs.writeFileString(manifestPath, yield* jsonText(manifest), { mode: 0o600 });

      const child = yield* start(
        "bun",
        ["--no-env-file", "apps/dashboard/e2e/run-real-native-placement.mjs"],
        { ...safeEnvironment, PLACEMENT_JOURNEY_MANIFEST: manifestPath },
      );

      const code = yield* Deferred.await(child.exit).pipe(
        Effect.timeoutOrElse({
          duration: "300 seconds",
          orElse: () =>
            Effect.fail(new PlacementCheckFailure({ message: "browser acceptance timed out" })),
        }),
      );

      if (code !== 0)
        return yield* new PlacementCheckFailure({
          message: "browser child exited " + String(code),
        });

      const browserEvidence = yield* Schema.decodeEffect(BrowserEvidenceJson)(
        yield* fs.readFileString(path.join(artifacts, "browser-evidence.json")),
      );

      assert.equal(browserEvidence.passed, true, "required browser evidence absent or failed");
      assert.equal(browserEvidence.revision, revision);
      assert.deepEqual(browserEvidence.steps, goldenSteps.slice(1));
      const facts = yield* observer.finish();
      assert.equal((yield* run("git", ["rev-parse", "HEAD"])).trim(), revision);
      assert.equal(
        (yield* run("git", ["status", "--porcelain"])).trim(),
        "",
        "source changed during acceptance",
      );
      evidence = { passed: true, browser: browserEvidence, ...facts };
      journeyPassed = true;

      return;
    }

    const login = Effect.fnUntraced(function* (person: { email: string; password: string }) {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${backendOrigin}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeader("origin", dashboardOrigin),
          HttpClientRequest.bodyJsonUnsafe(person),
        ),
      );

      assert.equal(response.status, 200);
      const cookie = firstSetCookie(response);
      assert.ok(cookie !== undefined);

      return cookie;
    });

    const leader = yield* login(persons.leader),
      volunteer = yield* login(persons.volunteer),
      wrong = yield* login(persons.wrongDepartment),
      candidate = yield* login(persons.candidate);

    // Placements are served as RPCs. Each call names the person whose session it forwards.
    const native = nativeScriptClient(backendOrigin);
    const session = (cookie: string) => ({ cookie, origin: dashboardOrigin });

    const valueOf = <A>(result: ScriptCallResult<A>): A =>
      result.ok ? result.value : assert.fail(JSON.stringify(result));

    const query = yield* Schema.decodeEffect(PlacementScope)({ departmentId, semesterId });
    // Each path names the RPC and scope of the HTTP route it replaced; `request` dispatches on it.
    const boardPath = `/api/placements?${new URLSearchParams(query).toString()}`;
    const ownPath = `/api/placements/affiliation?departmentId=${departmentId}`;
    const coverageBoardPath = `/api/placements/coverage?${new URLSearchParams(query).toString()}`;
    const ownCoveragePath = `/api/placements/coverage/own?${new URLSearchParams(query).toString()}`;

    const commandKeys = (etag: string | undefined, key: string) => ({
      idempotencyKey: Schema.decodeSync(IdempotencyKey)(key),
      ifMatch: Schema.decodeUnknownSync(StrongETag)(etag),
    });

    /**
     * Calls the placement RPC that replaced the route of `path`: its read without a body, its
     * command with one. The answer keeps the registry status of a problem.
     */
    const request = (
      path: string,
      cookie?: string,
      body?: Schema.Json,
      etag?: string,
      key = randomBytes(18).toString("base64url"),
    ): Effect.Effect<ScriptCallResult<unknown>, JourneyStepFailed> =>
      step((): Promise<ScriptCallResult<unknown>> => {
        const url = new URL(path, backendOrigin);
        const parameters = Object.fromEntries(url.searchParams);
        const headers = cookie === undefined ? { origin: dashboardOrigin } : session(cookie);

        if (url.pathname === "/api/placements/affiliation") {
          const scope = Schema.decodeUnknownSync(AffiliationScope)(parameters);

          return body === undefined
            ? native.call(headers, (client) => client["placements.readOwnAffiliation"](scope))
            : native.call(headers, (client) =>
                client["placements.commandOwnAffiliation"]({
                  ...scope,
                  ...commandKeys(etag, key),
                  request: Schema.decodeUnknownSync(OwnAffiliationCommand)(body),
                }),
              );
        }

        const scope = Schema.decodeUnknownSync(PlacementScope)(parameters);

        switch (url.pathname) {
          case "/api/placements":
            return body === undefined
              ? native.call(headers, (client) => client["placements.readBoard"](scope))
              : native.call(headers, (client) =>
                  client["placements.commandBoard"]({
                    ...scope,
                    ...commandKeys(etag, key),
                    request: Schema.decodeUnknownSync(PlacementCommand)(body),
                  }),
                );
          case "/api/placements/coverage":
            return body === undefined
              ? native.call(headers, (client) => client["placements.readCoverageBoard"](scope))
              : native.call(headers, (client) =>
                  client["placements.commandCoverageBoard"]({
                    ...scope,
                    ...commandKeys(etag, key),
                    request: Schema.decodeUnknownSync(CoverageCommand)(body),
                  }),
                );
          case "/api/placements/coverage/own":
            return body === undefined
              ? native.call(headers, (client) => client["placements.readOwnCoverage"](scope))
              : native.call(headers, (client) =>
                  client["placements.commandOwnCoverage"]({
                    ...scope,
                    ...commandKeys(etag, key),
                    request: Schema.decodeUnknownSync(OwnCoverageCommand)(body),
                  }),
                );
          default:
            return assert.fail(`no placement RPC replaces ${url.pathname}`);
        }
      });

    // The journey reads answers as the untyped JSON bodies it read over HTTP.
    const expectStatus = (
      response: ScriptCallResult<unknown>,
      status: number,
      code?: string,
    ): any => {
      assert.equal(response.status, status, JSON.stringify(response));

      if (code !== undefined) assert.equal(response.ok ? undefined : response.code, code);

      return response.ok ? response.value : "problem" in response ? response.problem : response;
    };

    const readBoard = Effect.fnUntraced(function* () {
      return valueOf(
        yield* step(() =>
          native.call(session(leader), (client) => client["placements.readBoard"](query)),
        ),
      );
    });

    const command = Effect.fnUntraced(function* (payload: Schema.Json) {
      const board = yield* readBoard();

      return valueOf(
        yield* step(() =>
          native.call(session(leader), (client) =>
            client["placements.commandBoard"]({
              ...query,
              ...commandKeys(board.etag, randomBytes(18).toString("base64url")),
              request: Schema.decodeUnknownSync(PlacementCommand)(payload),
            }),
          ),
        ),
      );
    });

    const readOwnCoverage = Effect.fnUntraced(function* (cookie: string) {
      return valueOf(
        yield* step(() =>
          native.call(session(cookie), (client) => client["placements.readOwnCoverage"](query)),
        ),
      );
    });

    const readCoverageBoard = Effect.fnUntraced(function* () {
      return valueOf(
        yield* step(() =>
          native.call(session(leader), (client) => client["placements.readCoverageBoard"](query)),
        ),
      );
    });

    const commandOwnCoverage = Effect.fnUntraced(function* (
      cookie: string,
      payload: Schema.Json,
      etag?: string,
      key = randomBytes(18).toString("base64url"),
    ) {
      const current = etag ?? (yield* readOwnCoverage(cookie)).etag;

      return valueOf(
        yield* step(() =>
          native.call(session(cookie), (client) =>
            client["placements.commandOwnCoverage"]({
              ...query,
              ...commandKeys(current, key),
              request: Schema.decodeUnknownSync(OwnCoverageCommand)(payload),
            }),
          ),
        ),
      );
    });

    const commandCoverage = Effect.fnUntraced(function* (
      payload: Schema.Json,
      etag?: string,
      key = randomBytes(18).toString("base64url"),
    ) {
      const current = etag ?? (yield* readCoverageBoard()).etag;

      return valueOf(
        yield* step(() =>
          native.call(session(leader), (client) =>
            client["placements.commandCoverageBoard"]({
              ...query,
              ...commandKeys(current, key),
              request: Schema.decodeUnknownSync(CoverageCommand)(payload),
            }),
          ),
        ),
      );
    });

    // An RPC answer carries no Cache-Control; the backend answers every RPC uncached.
    expectStatus(yield* request(boardPath, leader), 200);
    assert.deepEqual(
      (yield* readBoard()).schools.map((school) => school.schoolId),
      [961, 962],
    );
    assert.ok(
      valueOf(
        yield* step(() =>
          native.call(session(leader), (client) => client["placements.listScopes"]()),
        ),
      ).semesters.some((semester) => semester.semesterId === semesterId),
    );
    expectStatus(yield* request(boardPath), 401);
    expectStatus(yield* request(boardPath, volunteer), 403, "authority.denied");
    expectStatus(yield* request(boardPath, wrong), 403, "authority.denied");
    assert.equal(expectStatus(yield* request(ownPath, volunteer), 200).personId, volunteerId);
    assert.ok(
      !(yield* jsonText(expectStatus(yield* request(ownPath, volunteer), 200))).includes(leaderId),
    );
    // A real member still has no coordinator authority; the browser cohort has no team at all.
    yield* step(() =>
      journeyPool.query(
        "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,end_at,is_team_leader,is_suspended,revision) VALUES ('member-0096',$1,'team-native-journey-0049','2026-01-01',NULL,false,false,0)",
        [volunteerId],
      ),
    );
    expectStatus(yield* request(boardPath, volunteer), 403, "authority.denied");
    yield* step(() =>
      journeyPool.query("DELETE FROM organization_memberships WHERE membership_id='member-0096'"),
    );
    yield* step(() =>
      journeyPool.query(
        "UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1",
        [leaderId],
      ),
    );
    expectStatus(yield* request(boardPath, leader), 403, "authority.denied");
    yield* step(() =>
      journeyPool.query(
        "UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1",
        [leaderId],
      ),
    );
    yield* step(() =>
      journeyPool.query(
        "INSERT INTO organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-0096',$1,'2026-01-01',NULL,0)",
        [wrongId],
      ),
    );
    expectStatus(yield* request(boardPath, wrong), 200);
    yield* step(() =>
      journeyPool.query(
        "DELETE FROM organization_global_administrator_grants WHERE grant_id='admin-0096'",
      ),
    );

    // API cohort uses the coordinator's own Person; browser starts with an untouched no-team volunteer.
    let own = expectStatus(yield* request(ownPath, leader), 200);
    const ownKey = randomBytes(18).toString("base64url");

    const pending = expectStatus(
      yield* request(ownPath, leader, { action: "Request" }, own.etag, ownKey),
      200,
    );

    assert.equal(pending.status, "Pending");
    assert.deepEqual(
      expectStatus(yield* request(ownPath, leader, { action: "Request" }, own.etag, ownKey), 200),
      pending,
    );
    expectStatus(
      yield* request(ownPath, leader, { action: "Withdraw" }, own.etag, ownKey),
      409,
      "idempotency.digest-conflict",
    );
    expectStatus(yield* request(ownPath, leader, { action: "Withdraw" }, pending.etag), 200);
    own = expectStatus(yield* request(ownPath, leader), 200);
    expectStatus(yield* request(ownPath, leader, { action: "Request" }, own.etag), 200);
    yield* command({ action: "Affiliation", personId: leaderId, transition: "Establish" });

    const create = {
      action: "Create",
      personId: leaderId,
      schoolId: 961,
      day: "Monday",
      workdays: 4,
      block: "1",
    };

    let board = yield* readBoard();

    // The payload requires `ifMatch`, and the command schema rejects these before any call; the
    // RPC server decodes with the same schema and fails such a payload before the handler.
    for (const invalid of [
      { ...create, workdays: 0 },
      { ...create, workdays: 9 },
      { ...create, day: "Sunday" },
      { ...create, block: "3" },
    ])
      assert.ok(Option.isNone(Schema.decodeUnknownOption(PlacementCommand)(invalid)));

    for (const schoolId of [963, 964])
      expectStatus(
        yield* request(boardPath, leader, { ...create, schoolId }, board.etag),
        422,
        "scope.invalid",
      );
    expectStatus(
      yield* request(boardPath, leader, { ...create, personId: volunteerId }, board.etag),
      422,
      "affiliation.inactive",
    );
    const createKey = randomBytes(18).toString("base64url");
    const createEtag = board.etag;

    const created = expectStatus(
      yield* request(boardPath, leader, create, board.etag, createKey),
      200,
    );

    const placementId = created.placements.find(
      (p: { personId: string; block: string }) => p.personId === leaderId && p.block === "1",
    ).placementId;

    assert.deepEqual(
      expectStatus(yield* request(boardPath, leader, create, board.etag, createKey), 200),
      created,
    );
    expectStatus(
      yield* request(boardPath, leader, { ...create, workdays: 5 }, board.etag, createKey),
      409,
      "idempotency.digest-conflict",
    );
    expectStatus(
      yield* request(boardPath, leader, { ...create, block: "2" }, board.etag),
      412,
      "precondition.failed",
    );
    board = yield* readBoard();
    expectStatus(yield* request(boardPath, leader, create, board.etag), 409, "placement.overlap");
    yield* command({ ...create, block: "2" });
    yield* command({ ...create, block: "Both" });
    // Forging board scope never changes the persisted item's canonical semester.
    const otherPath = `/api/placements?${new URLSearchParams({ departmentId, semesterId: secondSemesterId }).toString()}`;
    const other = expectStatus(yield* request(otherPath, leader), 200);
    expectStatus(
      yield* request(otherPath, leader, { action: "Remove", placementId }, other.etag),
      404,
      "resource.not-found",
    );
    board = yield* readBoard();

    const edits = yield* Effect.all(
      [6, 7].map((workdays) =>
        request(
          boardPath,
          leader,
          { action: "Edit", placementId, schoolId: 961, day: "Tuesday", workdays, block: "1" },
          board.etag,
        ),
      ),
      { concurrency: "unbounded" },
    );

    assert.equal(edits.filter((r) => r.status === 200).length, 1);

    for (const response of edits.filter((r) => r.status !== 200))
      expectStatus(
        response,
        response.status === 409 ? 409 : 412,
        response.status === 409 ? "transaction.conflict" : "precondition.failed",
      );
    yield* command({ action: "Remove", placementId });

    const retained = yield* step(() =>
      journeyPool.query("SELECT active,revision FROM assistant_placements WHERE placement_id=$1", [
        placementId,
      ]),
    );

    assert.deepEqual(retained.rows, [{ active: false, revision: 3 }]);
    assert.deepEqual(
      (yield* step(() =>
        journeyPool.query(
          "SELECT action FROM assistant_placement_audit WHERE placement_id=$1 ORDER BY revision",
          [placementId],
        ),
      )).rows.map((r: { action: string }) => r.action),
      ["Create", "Edit", "Remove"],
    );
    board = yield* readBoard();

    const concurrentCreates = yield* Effect.all(
      [0, 1].map(() => request(boardPath, leader, create, board.etag)),
      { concurrency: "unbounded" },
    );

    assert.equal(concurrentCreates.filter((r) => r.status === 200).length, 1);

    for (const response of concurrentCreates.filter((r) => r.status !== 200))
      expectStatus(
        response,
        response.status === 409 ? 409 : 412,
        response.status === 409 ? "transaction.conflict" : "precondition.failed",
      );

    const replacement = (yield* readBoard()).placements.find(
      (p) => p.personId === leaderId && p.block === "1" && p.active,
    );

    assert.ok(replacement);
    yield* command({ action: "Remove", placementId: replacement.placementId });
    yield* command({ action: "Affiliation", personId: leaderId, transition: "Revoke" });
    board = yield* readBoard();
    assert.equal(
      board.placements.filter((p) => p.active).length,
      2,
      "affiliation revocation preserves historical placements",
    );
    expectStatus(
      yield* request(boardPath, leader, create, board.etag),
      422,
      "affiliation.inactive",
    );
    yield* step(() =>
      journeyPool.query(
        "UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1",
        [leaderId],
      ),
    );
    expectStatus(
      yield* request(boardPath, leader, create, createEtag, createKey),
      403,
      "authority.denied",
    );
    yield* step(() =>
      journeyPool.query(
        "UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1",
        [leaderId],
      ),
    );

    for (const placement of (yield* readBoard()).placements.filter(
      (candidate) => candidate.personId === leaderId && candidate.active,
    ))
      yield* command({ action: "Remove", placementId: placement.placementId });
    assert.equal(expectStatus(yield* request(otherPath, leader), 200).placements.length, 0);
    // The API cohort begins from a confirmed roster; the browser independently
    // confirms a two-person roster through the placement/service journey.
    // The substitute requests no affiliation: her admission outcome alone puts her on call.
    const wrongAffiliation = expectStatus(yield* request(ownPath, wrong), 200);
    assert.equal(wrongAffiliation.status, "Absent");
    assert.equal(
      expectStatus(
        yield* request(ownPath, wrong, { action: "Request" }, wrongAffiliation.etag),
        200,
      ).status,
      "Pending",
    );
    const leaderAffiliation = expectStatus(yield* request(ownPath, leader), 200);
    assert.equal(leaderAffiliation.status, "Inactive");
    assert.equal(
      expectStatus(
        yield* request(ownPath, leader, { action: "Request" }, leaderAffiliation.etag),
        200,
      ).status,
      "Pending",
    );
    yield* command({ action: "Affiliation", personId: wrongId, transition: "Establish" });
    yield* command({ action: "Affiliation", personId: leaderId, transition: "Establish" });
    const apiCoverageProposalId = `school-service-proposal-${"a".repeat(64)}`;
    yield* step(() =>
      journeyPool.query(
        `INSERT INTO school_service_proposals(
       proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,
       confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,
       reviewed_exception_ids
     ) VALUES($1,$2,$3,'Confirmed',2,'2024-02-01T10:00:00.000Z',$4,
       '2024-02-01T10:00:00.000Z',$4,$5::jsonb,$6::jsonb,'[]'::jsonb,'[]'::jsonb)`,
        [
          apiCoverageProposalId,
          departmentId,
          semesterId,
          leaderId,
          JSON.stringify([
            { schoolId: 961, day: "Monday", block: "1", requiredVolunteers: 1, revision: 1 },
            { schoolId: 961, day: "Monday", block: "2", requiredVolunteers: 1, revision: 1 },
            { schoolId: 961, day: "Tuesday", block: "1", requiredVolunteers: 1, revision: 1 },
            { schoolId: 961, day: "Wednesday", block: "1", requiredVolunteers: 2, revision: 1 },
            { schoolId: 961, day: "Thursday", block: "1", requiredVolunteers: 1, revision: 1 },
            { schoolId: 961, day: "Friday", block: "1", requiredVolunteers: 1, revision: 1 },
          ]),
          JSON.stringify([
            {
              placementId: `placement-${"b".repeat(64)}`,
              personId: volunteerId,
              firstName: "Irene",
              lastName: "Intervjuer",
              schoolId: 961,
              schoolName: "Skole Alfa",
              day: "Monday",
              block: "1",
            },
            {
              placementId: `placement-${"4".repeat(64)}`,
              personId: volunteerId,
              firstName: "Irene",
              lastName: "Intervjuer",
              schoolId: 961,
              schoolName: "Skole Alfa",
              day: "Monday",
              block: "2",
            },
            {
              placementId: `placement-${"d".repeat(64)}`,
              personId: leaderId,
              firstName: "Lina",
              lastName: "Lagleder",
              schoolId: 961,
              schoolName: "Skole Alfa",
              day: "Tuesday",
              block: "1",
            },
            ...[
              {
                day: "Wednesday",
                personId: leaderId,
                firstName: "Lina",
                lastName: "Lagleder",
                suffix: "e",
              },
              {
                day: "Wednesday",
                personId: volunteerId,
                firstName: "Irene",
                lastName: "Intervjuer",
                suffix: "f",
              },
              {
                day: "Thursday",
                personId: leaderId,
                firstName: "Lina",
                lastName: "Lagleder",
                suffix: "1",
              },
              {
                day: "Friday",
                personId: leaderId,
                firstName: "Lina",
                lastName: "Lagleder",
                suffix: "2",
              },
            ].map(({ day, personId, firstName, lastName, suffix }) => ({
              placementId: `placement-${suffix.repeat(64)}`,
              personId,
              firstName,
              lastName,
              schoolId: 961,
              schoolName: "Skole Alfa",
              day,
              block: "1",
            })),
          ]),
        ],
      ),
    );
    const historicalOccurrenceId = `school-service-occurrence-${"3".repeat(64)}`;
    // Simulate a pre-migration row in the disposable database. Product writes cannot bypass this guard.
    yield* Effect.acquireUseRelease(
      step(() => journeyPool.connect()),
      (fixtureClient) =>
        committed(
          fixtureClient,
          Effect.gen(function* () {
            yield* step(() =>
              fixtureClient.query(
                "ALTER TABLE school_service_occurrences DISABLE TRIGGER school_service_occurrence_insert_guard",
              ),
            );
            yield* step(() =>
              fixtureClient.query(
                `INSERT INTO school_service_occurrences(occurrence_id,proposal_id,department_id,semester_id,school_id,day,block,occurred_on,attended_person_ids,recorded_at,recorded_by_person_id)
        VALUES($1,$2,$3,$4,961,'Friday','1','2024-03-08',$5::jsonb,'2024-03-08T11:30:00.000Z',$6)`,
                [
                  historicalOccurrenceId,
                  apiCoverageProposalId,
                  departmentId,
                  semesterId,
                  JSON.stringify([leaderId]),
                  leaderId,
                ],
              ),
            );
            yield* step(() =>
              fixtureClient.query(
                "ALTER TABLE school_service_occurrences ENABLE TRIGGER school_service_occurrence_insert_guard",
              ),
            );
          }),
        ),
      (fixtureClient) => Effect.sync(() => fixtureClient.release()),
    );

    const schedule = (
      day: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday",
      serviceDate: string,
    ) => ({
      action: "ScheduleService" as const,
      proposalId: apiCoverageProposalId,
      schoolId: 961,
      day,
      block: "1" as const,
      serviceDate,
      startTime: "09:00",
      endTime: "11:00",
    });

    const serviceDates = {
      Monday: "2024-03-04",
      Tuesday: "2024-03-05",
      Wednesday: "2024-03-06",
      Thursday: "2024-03-07",
    } as const;

    const commitmentIds = new Map<keyof typeof serviceDates, string>();

    for (const day of Rec.keys(serviceDates)) {
      const serviceDate = serviceDates[day];
      const before = yield* readBoard();
      const result = yield* command(schedule(day, serviceDate));

      const commitment = result.commitments.find(
        (item) => item.schoolId === 961 && item.serviceDate === serviceDate && item.block === "1",
      );

      assert.ok(commitment);
      assert.equal(commitment.requiredVolunteers, day === "Wednesday" ? 2 : 1);
      assert.equal(commitment.decision, null);
      commitmentIds.set(day, commitment.commitmentId);

      if (day === "Monday") {
        expectStatus(
          yield* request(boardPath, leader, schedule(day, serviceDate), before.etag),
          412,
          "precondition.failed",
        );
        expectStatus(
          yield* request(boardPath, leader, schedule(day, serviceDate), result.etag),
          409,
        );
      }
    }

    const commitments = yield* Schema.decodeUnknownEffect(
      Schema.Struct(Rec.map(serviceDates, () => Schema.String)),
    )(Object.fromEntries(commitmentIds));

    assert.equal(
      (yield* readCoverageBoard()).commitments.filter(
        (item) => item.proposalId === apiCoverageProposalId,
      ).length,
      4,
    );
    assert.equal(
      (yield* readBoard()).commitments.filter((item) => item.proposalId === apiCoverageProposalId)
        .length,
      4,
    );
    expectStatus(
      yield* request(
        boardPath,
        volunteer,
        schedule("Monday", serviceDates.Monday),
        (yield* readBoard()).etag,
      ),
      403,
      "authority.denied",
    );
    expectStatus(
      yield* request(
        boardPath,
        leader,
        { ...schedule("Monday", serviceDates.Monday), serviceDate: "2024-03-05" },
        (yield* readBoard()).etag,
      ),
      422,
    );
    expectStatus(
      yield* request(
        boardPath,
        leader,
        { ...schedule("Monday", serviceDates.Monday), startTime: "11:00", endTime: "09:00" },
        (yield* readBoard()).etag,
      ),
      422,
    );
    expectStatus(
      yield* request(
        boardPath,
        leader,
        schedule("Friday", "2024-03-08"),
        (yield* readBoard()).etag,
      ),
      409,
    );
    assert.equal(
      (yield* step(() =>
        journeyPool.query(
          "SELECT commitment_id FROM school_service_occurrences WHERE occurrence_id=$1",
          [historicalOccurrenceId],
        ),
      )).rows[0].commitment_id,
      null,
    );
    const beforeOverlap = yield* readBoard();
    expectStatus(
      yield* request(
        boardPath,
        leader,
        {
          ...schedule("Monday", serviceDates.Monday),
          block: "2",
          startTime: "10:00",
          endTime: "12:00",
        },
        beforeOverlap.etag,
      ),
      409,
      "commitment.duplicate",
    );
    assert.equal(
      (yield* readBoard()).etag,
      beforeOverlap.etag,
      "overlapping person appointment has no write",
    );
    assert.equal((yield* request(ownCoveragePath)).status, 401);
    assert.equal((yield* request(coverageBoardPath)).status, 401);
    expectStatus(yield* request(coverageBoardPath, volunteer), 403, "authority.denied");
    expectStatus(yield* request(coverageBoardPath, wrong), 403, "authority.denied");
    expectStatus(
      yield* request(
        `/api/placements/coverage?${new URLSearchParams({
          departmentId: wrongDepartmentId,
          semesterId,
        }).toString()}`,
        leader,
      ),
      403,
      "authority.denied",
    );
    expectStatus(yield* request(ownCoveragePath, volunteer), 200);
    const initialOwnCoverage = yield* readOwnCoverage(volunteer);
    assert.deepEqual(
      initialOwnCoverage.commitments
        .filter((item) => item.proposalId === apiCoverageProposalId)
        .map((item) => item.commitmentId)
        .sort(),
      [commitments.Monday, commitments.Wednesday].sort(),
    );
    assert.deepEqual(
      (yield* readOwnCoverage(wrong)).commitments.filter(
        (item) => item.proposalId === apiCoverageProposalId,
      ),
      [],
    );
    assert.deepEqual(
      (yield* readOwnCoverage(candidate)).commitments.filter(
        (item) => item.proposalId === apiCoverageProposalId,
      ),
      [],
    );
    expectStatus(
      yield* request(
        ownCoveragePath,
        volunteer,
        { action: "ReportAbsence", commitmentId: commitments.Tuesday },
        initialOwnCoverage.etag,
      ),
      422,
    );
    const coveredAbsenceCommand = { action: "ReportAbsence", commitmentId: commitments.Monday };
    const reportAbsenceKey = randomBytes(18).toString("base64url");

    const reportedOwnCoverage = yield* commandOwnCoverage(
      volunteer,
      coveredAbsenceCommand,
      initialOwnCoverage.etag,
      reportAbsenceKey,
    );

    const coveredAbsence = reportedOwnCoverage.absences.find(
      (absence) =>
        absence.proposalId === apiCoverageProposalId &&
        absence.personId === volunteerId &&
        absence.serviceDate === "2024-03-04",
    );

    assert.ok(coveredAbsence);
    assert.deepEqual(
      expectStatus(
        yield* request(
          ownCoveragePath,
          volunteer,
          coveredAbsenceCommand,
          initialOwnCoverage.etag,
          reportAbsenceKey,
        ),
        200,
      ),
      reportedOwnCoverage,
    );
    expectStatus(
      yield* request(
        ownCoveragePath,
        volunteer,
        { ...coveredAbsenceCommand, commitmentId: commitments.Wednesday },
        initialOwnCoverage.etag,
        reportAbsenceKey,
      ),
      409,
      "idempotency.digest-conflict",
    );

    // A rejected coverage command keeps the board version and every coverage fact.
    const coverageFacts = Effect.fnUntraced(function* () {
      return (yield* step(() =>
        journeyPool.query(
          `SELECT
           (SELECT count(*)::integer FROM school_service_absences) AS absences,
           (SELECT count(*)::integer FROM school_service_coverage_records) AS records,
           (SELECT count(*)::integer FROM school_service_coverage_records
            WHERE withdrawn_at IS NOT NULL) AS withdrawn,
           (SELECT count(*)::integer FROM school_service_person_reservations) AS reservations,
           (SELECT count(*)::integer FROM school_service_decisions) AS decisions,
           (SELECT count(*)::integer FROM school_service_closures) AS closures,
           (SELECT count(*)::integer FROM school_service_coverage_audit) AS audit`,
        ),
      )).rows[0];
    });

    const rejectedCoverage = Effect.fnUntraced(function* (
      path: string,
      cookie: string,
      payload: Schema.Json,
      etag: string,
      status: number,
      code: string,
    ) {
      const before = { board: (yield* readCoverageBoard()).etag, facts: yield* coverageFacts() };
      expectStatus(yield* request(path, cookie, payload, etag), status, code);
      assert.deepEqual(
        { board: (yield* readCoverageBoard()).etag, facts: yield* coverageFacts() },
        before,
        `${code} must leave coverage unchanged`,
      );
    });

    const recordCoverage = (absenceId: string, coveringPersonId: string) => ({
      action: "RecordCoverage",
      absenceId,
      coveringPersonId,
    });

    const withdrawCoverage = (absenceId: string) => ({ action: "WithdrawCoverage", absenceId });

    const reservationsOf = Effect.fnUntraced(function* (commitmentId: string) {
      return (yield* step(() =>
        journeyPool.query(
          `SELECT source_kind AS "sourceKind",person_id AS "personId",coverage_id AS "coverageId"
         FROM school_service_person_reservations WHERE commitment_id=$1 ORDER BY source_kind,person_id`,
          [commitmentId],
        ),
      )).rows;
    });

    const audit = (action: string, actorPersonId: string) => ({ action, actorPersonId });

    // Before an admission outcome nobody can cover: not the applicant, not the absent volunteer,
    // and not a person with an active affiliation but no placement.
    let coverageBoard = yield* readCoverageBoard();
    assert.deepEqual(coverageBoard.coverers, []);
    assert.deepEqual((yield* readOwnCoverage(volunteer)).coverers, []);

    for (const personId of [substitute.personId, volunteerId, wrongId])
      yield* rejectedCoverage(
        coverageBoardPath,
        leader,
        recordCoverage(coveredAbsence.absenceId, personId),
        coverageBoard.etag,
        422,
        "coverage.coverer-ineligible",
      );

    // Admission management records the Substitute outcome; the applicant is then on call.
    const coverageApplicationId = "application-coverage-0111";

    // Admission outcomes are served as RPCs; the leader calls them with the leader's session.
    const outcomeClient = nativeScriptClient(backendOrigin);
    const leaderSession = { cookie: leader, origin: dashboardOrigin };
    const outcomeApplicationId = PublicApplicationIdSchema.make(coverageApplicationId);

    const outcomeAnswer = yield* step(() =>
      outcomeClient.call(leaderSession, (client) =>
        client["admissionOutcomes.readOutcome"]({ applicationId: outcomeApplicationId }),
      ),
    );

    assert.ok(outcomeAnswer.ok, yield* jsonText(outcomeAnswer));
    const outcomeEntry = outcomeAnswer.value;

    assert.deepEqual([outcomeEntry.outcome, outcomeEntry.revision], [null, 0]);

    const onCallAnswer = yield* step(() =>
      outcomeClient.call(leaderSession, (client) =>
        client["admissionOutcomes.recordOutcome"]({
          applicationId: outcomeApplicationId,
          idempotencyKey: IdempotencyKey.make(randomBytes(18).toString("base64url")),
          ifMatch: outcomeEntry.etag,
          request: { outcome: "Substitute" },
        }),
      ),
    );

    yield* step(() => outcomeClient.dispose());
    assert.ok(onCallAnswer.ok, yield* jsonText(onCallAnswer));
    const onCall = onCallAnswer.value;

    assert.deepEqual([onCall.outcome, onCall.revision], ["Substitute", 1]);

    const onCallCoverer = {
      personId: substitute.personId,
      firstName: substitute.firstName,
      lastName: substitute.lastName,
      kind: "Substitute",
    };

    coverageBoard = yield* readCoverageBoard();
    assert.deepEqual(coverageBoard.coverers, [onCallCoverer]);
    assert.deepEqual((yield* readOwnCoverage(volunteer)).coverers, [onCallCoverer]);
    assert.deepEqual(
      (yield* readOwnCoverage(candidate)).coverers,
      [],
      "only a person with an open absence sees the names of possible coverers",
    );

    // The own endpoint serves only the absent volunteer.
    for (const cookie of [candidate, wrong])
      for (const payload of [
        recordCoverage(coveredAbsence.absenceId, substitute.personId),
        withdrawCoverage(coveredAbsence.absenceId),
      ])
        yield* rejectedCoverage(
          ownCoveragePath,
          cookie,
          payload,
          (yield* readOwnCoverage(cookie)).etag,
          403,
          "coverage.owner-invalid",
        );

    // The absent volunteer records who agreed to cover; the record reserves that person.
    const ownBeforeRecord = yield* readOwnCoverage(volunteer);
    const recordKey = randomBytes(18).toString("base64url");

    const recordedOwn = yield* commandOwnCoverage(
      volunteer,
      recordCoverage(coveredAbsence.absenceId, substitute.personId),
      ownBeforeRecord.etag,
      recordKey,
    );

    const firstRecord = recordedOwn.coverage.find(
      (item) => item.absenceId === coveredAbsence.absenceId,
    );

    assert.ok(firstRecord);
    assert.deepEqual(
      [
        firstRecord.coveringPersonId,
        firstRecord.coveringFirstName,
        firstRecord.covererKind,
        firstRecord.recordedByPersonId,
      ],
      [substitute.personId, substitute.firstName, "Substitute", volunteerId],
    );
    assert.deepEqual(
      expectStatus(
        yield* request(
          ownCoveragePath,
          volunteer,
          recordCoverage(coveredAbsence.absenceId, substitute.personId),
          ownBeforeRecord.etag,
          recordKey,
        ),
        200,
      ),
      recordedOwn,
    );
    expectStatus(
      yield* request(
        ownCoveragePath,
        volunteer,
        withdrawCoverage(coveredAbsence.absenceId),
        ownBeforeRecord.etag,
        recordKey,
      ),
      409,
      "idempotency.digest-conflict",
    );
    expectStatus(
      yield* request(
        ownCoveragePath,
        volunteer,
        withdrawCoverage(coveredAbsence.absenceId),
        ownBeforeRecord.etag,
      ),
      412,
      "precondition.failed",
    );
    assert.deepEqual(yield* reservationsOf(commitments.Monday), [
      { sourceKind: "Coverage", personId: substitute.personId, coverageId: firstRecord.coverageId },
      { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
    ]);

    // An active placement makes the coordinator an assistant who can cover. Recording her
    // replaces the current record: withdrawal and new record share one transaction.
    const assistantBoard = yield* command({
      action: "Create",
      personId: leaderId,
      schoolId: 961,
      day: "Friday",
      workdays: 4,
      block: "2",
    });

    const assistantPlacement = assistantBoard.placements.find(
      (placement) =>
        placement.personId === leaderId &&
        placement.day === "Friday" &&
        placement.block === "2" &&
        placement.active,
    );

    assert.ok(assistantPlacement);
    assert.deepEqual(
      (yield* readCoverageBoard()).coverers.map((coverer) => [coverer.personId, coverer.kind]),
      [
        [substitute.personId, "Substitute"],
        [leaderId, "Assistant"],
      ],
    );

    const replacedBoard = yield* commandCoverage(
      recordCoverage(coveredAbsence.absenceId, leaderId),
    );

    const replacingRecord = replacedBoard.coverage.find(
      (item) => item.absenceId === coveredAbsence.absenceId,
    );

    assert.ok(replacingRecord);
    assert.deepEqual(
      [
        replacingRecord.coveringPersonId,
        replacingRecord.covererKind,
        replacingRecord.recordedByPersonId,
      ],
      [leaderId, "Assistant", leaderId],
    );
    assert.deepEqual(
      (yield* step(() =>
        journeyPool.query(
          `SELECT withdrawn_by_person_id AS "withdrawnBy",
           withdrawn_at=(SELECT recorded_at FROM school_service_coverage_records
             WHERE coverage_id=$2) AS "sameTransaction"
         FROM school_service_coverage_records WHERE coverage_id=$1`,
          [firstRecord.coverageId, replacingRecord.coverageId],
        ),
      )).rows,
      [{ withdrawnBy: leaderId, sameTransaction: true }],
    );
    assert.deepEqual(yield* reservationsOf(commitments.Monday), [
      { sourceKind: "Coverage", personId: leaderId, coverageId: replacingRecord.coverageId },
      { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
    ]);

    // Withdrawal leaves the absence uncovered and releases the covering person.
    const withdrawnBoard = yield* commandCoverage(withdrawCoverage(coveredAbsence.absenceId));
    assert.deepEqual(
      withdrawnBoard.coverage.filter((item) => item.absenceId === coveredAbsence.absenceId),
      [],
    );
    assert.deepEqual(yield* reservationsOf(commitments.Monday), [
      { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
    ]);
    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      withdrawCoverage(coveredAbsence.absenceId),
      withdrawnBoard.etag,
      409,
      "coverage.not-recorded",
    );

    // Attendance is derived: roster minus absences plus current coverage. Without coverage the
    // Monday service cannot be Completed; with it, it cannot be Unfulfilled.
    const completeCovered = {
      action: "CompleteService",
      commitmentId: commitments.Monday,
      evidenceSource: "Skole Alfa kontakt, telefon 2024-03-04",
    };

    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      completeCovered,
      withdrawnBoard.etag,
      422,
      "commitment.outcome-invalid",
    );

    let closeCoverageBoard = yield* commandCoverage(
      recordCoverage(coveredAbsence.absenceId, substitute.personId),
      withdrawnBoard.etag,
    );

    const coveringRecord = closeCoverageBoard.coverage.find(
      (item) => item.absenceId === coveredAbsence.absenceId,
    );

    assert.ok(coveringRecord);
    assert.deepEqual(
      [coveringRecord.coveringPersonId, coveringRecord.recordedByPersonId],
      [substitute.personId, leaderId],
    );
    assert.deepEqual(
      (yield* readOwnCoverage(candidate)).commitments
        .filter((item) => item.proposalId === apiCoverageProposalId)
        .map((item) => item.commitmentId),
      [commitments.Monday],
      "the covering person reads the service she covers",
    );
    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      {
        action: "MarkUnfulfilledService",
        commitmentId: commitments.Monday,
        reason: "Ingen møtte",
        evidenceSource: completeCovered.evidenceSource,
      },
      closeCoverageBoard.etag,
      422,
      "commitment.outcome-invalid",
    );
    const completeKey = randomBytes(18).toString("base64url");

    const coveredClosure = yield* commandCoverage(
      completeCovered,
      closeCoverageBoard.etag,
      completeKey,
    );

    const mondayDecision = coveredClosure.commitments.find(
      (item) => item.commitmentId === commitments.Monday,
    )?.decision;

    assert.deepEqual(
      [mondayDecision?.outcome, mondayDecision?.attendedPersonIds],
      ["Completed", [substitute.personId]],
    );
    assert.deepEqual(
      coveredClosure.closures
        .filter((closure) => closure.absenceId === coveredAbsence.absenceId)
        .map((closure) => ({
          outcome: closure.outcome,
          coverageId: closure.coverageId,
          coveringPersonId: closure.coveringPersonId,
          occurrenceId: closure.occurrenceId,
        })),
      [
        {
          outcome: "Covered",
          coverageId: coveringRecord.coverageId,
          coveringPersonId: substitute.personId,
          occurrenceId: mondayDecision?.occurrenceId,
        },
      ],
    );
    assert.deepEqual(
      expectStatus(
        yield* request(
          coverageBoardPath,
          leader,
          completeCovered,
          closeCoverageBoard.etag,
          completeKey,
        ),
        200,
      ),
      coveredClosure,
    );
    closeCoverageBoard = yield* readCoverageBoard();

    // A decided service accepts no second decision, absence or coverage change.
    for (const [path, cookie, payload, etag] of [
      [coverageBoardPath, leader, completeCovered, closeCoverageBoard.etag],
      [
        coverageBoardPath,
        leader,
        {
          action: "CancelService",
          commitmentId: commitments.Monday,
          reason: "Feilaktig konkurrerende avlysning",
          evidenceSource: "Skole Alfa kontakt, telefon",
        },
        closeCoverageBoard.etag,
      ],
      [
        coverageBoardPath,
        leader,
        withdrawCoverage(coveredAbsence.absenceId),
        closeCoverageBoard.etag,
      ],
      [
        coverageBoardPath,
        leader,
        recordCoverage(coveredAbsence.absenceId, leaderId),
        closeCoverageBoard.etag,
      ],
      [ownCoveragePath, volunteer, coveredAbsenceCommand, (yield* readOwnCoverage(volunteer)).etag],
    ] as const)
      expectStatus(yield* request(path, cookie, payload, etag), 409, "commitment.closed");
    assert.equal(
      (yield* readCoverageBoard()).etag,
      closeCoverageBoard.etag,
      "post-terminal commands write no second fact",
    );

    // Tuesday: the coordinator reports an absence nobody covers; zero attendance is Unfulfilled.
    const coordinatorAbsenceBoard = yield* commandCoverage(
      {
        action: "ReportAbsenceForVolunteer",
        personId: leaderId,
        commitmentId: commitments.Tuesday,
      },
      closeCoverageBoard.etag,
    );

    const uncoveredAbsence = coordinatorAbsenceBoard.absences.find(
      (absence) =>
        absence.proposalId === apiCoverageProposalId &&
        absence.personId === leaderId &&
        absence.serviceDate === "2024-03-05",
    );

    assert.ok(uncoveredAbsence);

    const zeroUnfulfilled = {
      action: "MarkUnfulfilledService",
      commitmentId: commitments.Tuesday,
      reason: "Ingen frivillige møtte",
      evidenceSource: "Skole Alfa kontakt, telefon 2024-03-05",
    };

    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      {
        action: "CompleteService",
        commitmentId: commitments.Tuesday,
        evidenceSource: zeroUnfulfilled.evidenceSource,
      },
      coordinatorAbsenceBoard.etag,
      422,
      "commitment.outcome-invalid",
    );
    const uncoveredClosure = yield* commandCoverage(zeroUnfulfilled, coordinatorAbsenceBoard.etag);

    const tuesdayDecision = uncoveredClosure.commitments.find(
      (item) => item.commitmentId === commitments.Tuesday,
    )?.decision;

    assert.deepEqual(
      [tuesdayDecision?.outcome, tuesdayDecision?.attendedPersonIds, tuesdayDecision?.occurrenceId],
      ["Unfulfilled", [], null],
    );
    assert.deepEqual(
      uncoveredClosure.closures
        .filter((closure) => closure.absenceId === uncoveredAbsence.absenceId)
        .map((closure) => [closure.outcome, closure.occurrenceId, closure.coverageId]),
      [["Uncovered", null, null]],
    );
    expectStatus(
      yield* request(
        coverageBoardPath,
        leader,
        recordCoverage(uncoveredAbsence.absenceId, substitute.personId),
        uncoveredClosure.etag,
      ),
      409,
      "commitment.closed",
    );

    // Wednesday needs two. A person scheduled on the service, or already covering another absence
    // in the same interval, is unavailable.
    const wednesdayOwn = yield* commandOwnCoverage(volunteer, {
      action: "ReportAbsence",
      commitmentId: commitments.Wednesday,
    });

    const volunteerWednesday = wednesdayOwn.absences.find(
      (absence) => absence.commitmentId === commitments.Wednesday,
    );

    assert.ok(volunteerWednesday);
    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      recordCoverage(volunteerWednesday.absenceId, leaderId),
      (yield* readCoverageBoard()).etag,
      409,
      "coverage.coverer-unavailable",
    );

    const wednesdayCovered = yield* commandCoverage(
      recordCoverage(volunteerWednesday.absenceId, substitute.personId),
    );

    const wednesdayRecord = wednesdayCovered.coverage.find(
      (item) => item.absenceId === volunteerWednesday.absenceId,
    );

    assert.ok(wednesdayRecord);

    const bothAbsent = yield* commandCoverage(
      {
        action: "ReportAbsenceForVolunteer",
        personId: leaderId,
        commitmentId: commitments.Wednesday,
      },
      wednesdayCovered.etag,
    );

    const leaderWednesday = bothAbsent.absences.find(
      (absence) => absence.commitmentId === commitments.Wednesday && absence.personId === leaderId,
    );

    assert.ok(leaderWednesday);
    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      recordCoverage(leaderWednesday.absenceId, substitute.personId),
      bothAbsent.etag,
      409,
      "coverage.coverer-unavailable",
    );

    const partialUnfulfilled = {
      action: "MarkUnfulfilledService",
      commitmentId: commitments.Wednesday,
      reason: "Én av to frivillige møtte",
      evidenceSource: "Skole Alfa kontakt, telefon 2024-03-06",
    };

    yield* rejectedCoverage(
      coverageBoardPath,
      leader,
      {
        action: "CompleteService",
        commitmentId: commitments.Wednesday,
        evidenceSource: partialUnfulfilled.evidenceSource,
      },
      bothAbsent.etag,
      422,
      "commitment.outcome-invalid",
    );

    const competingPartial = yield* Effect.all(
      [0, 1].map(() => request(coverageBoardPath, leader, partialUnfulfilled, bothAbsent.etag)),
      { concurrency: "unbounded" },
    );

    assert.equal(competingPartial.filter((response) => response.status === 200).length, 1);

    for (const response of competingPartial.filter((result) => result.status !== 200))
      assert.ok([409, 412].includes(response.status));

    const partialDecision = (yield* readCoverageBoard()).commitments.find(
      (item) => item.commitmentId === commitments.Wednesday,
    )?.decision;

    assert.equal(partialDecision?.outcome, "Unfulfilled");
    assert.deepEqual(partialDecision?.attendedPersonIds, [substitute.personId]);
    assert.ok(partialDecision?.occurrenceId);

    // Thursday: cancellation records no attendance or closure and releases every reservation.
    const thursdayAbsenceBoard = yield* commandCoverage({
      action: "ReportAbsenceForVolunteer",
      personId: leaderId,
      commitmentId: commitments.Thursday,
    });

    const cancelledAbsenceId = thursdayAbsenceBoard.absences.find(
      (item) => item.commitmentId === commitments.Thursday,
    )?.absenceId;

    assert.ok(cancelledAbsenceId);

    const thursdayCovered = yield* commandCoverage(
      recordCoverage(cancelledAbsenceId, substitute.personId),
      thursdayAbsenceBoard.etag,
    );

    const thursdayRecord = thursdayCovered.coverage.find(
      (item) => item.absenceId === cancelledAbsenceId,
    );

    assert.ok(thursdayRecord);
    assert.deepEqual(yield* reservationsOf(commitments.Thursday), [
      {
        sourceKind: "Coverage",
        personId: substitute.personId,
        coverageId: thursdayRecord.coverageId,
      },
      { sourceKind: "Scheduled", personId: leaderId, coverageId: null },
    ]);

    const cancel = {
      action: "CancelService",
      commitmentId: commitments.Thursday,
      reason: "Skolen avlyste undervisningen",
      evidenceSource: "Skole Alfa kontakt, telefon 2024-03-07",
    };

    const cancelled = yield* commandCoverage(cancel, thursdayCovered.etag);
    assert.equal(
      cancelled.commitments.find((item) => item.commitmentId === commitments.Thursday)?.decision
        ?.outcome,
      "Cancelled",
    );
    assert.equal(
      cancelled.commitments.find((item) => item.commitmentId === commitments.Thursday)?.decision
        ?.occurrenceId,
      null,
    );
    assert.equal(
      cancelled.occurrences.filter((item) => item.commitmentId === commitments.Thursday).length,
      0,
    );
    assert.equal(
      cancelled.closures.filter((item) => item.absenceId === cancelledAbsenceId).length,
      0,
    );
    assert.deepEqual(yield* reservationsOf(commitments.Thursday), []);

    for (const payload of [
      { ...partialUnfulfilled, commitmentId: commitments.Thursday },
      withdrawCoverage(cancelledAbsenceId),
    ])
      expectStatus(
        yield* request(coverageBoardPath, leader, payload, cancelled.etag),
        409,
        "commitment.closed",
      );
    // The assistant placement served only as a coverer; the browser roster must not include it.
    yield* command({ action: "Remove", placementId: assistantPlacement.placementId });
    const finalApiCoverage = yield* readCoverageBoard();
    assert.deepEqual(
      finalApiCoverage.commitments
        .filter((item) => item.proposalId === apiCoverageProposalId)
        .map((item) => item.decision?.outcome)
        .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
      ["Cancelled", "Completed", "Unfulfilled", "Unfulfilled"].sort(),
    );
    assert.equal(
      finalApiCoverage.occurrences.filter((item) =>
        Object.values(commitments).includes(item.commitmentId!),
      ).length,
      2,
    );

    const durableDecisions: Array<{
      commitmentId: string;
      serviceDate: string;
      requiredVolunteers: number;
      startTime: string;
      endTime: string;
      outcome: string;
      evidenceSource: string;
      reason: string | null;
      attendedPersonIds: string[];
      occurrenceId: string | null;
      decidedBy: string;
    }> = (yield* step(() =>
      journeyPool.query(
        `SELECT commitment.commitment_id AS "commitmentId",commitment.service_date::text AS "serviceDate",
       commitment.required_volunteers AS "requiredVolunteers",commitment.start_time::text AS "startTime",
       commitment.end_time::text AS "endTime",decision.outcome,decision.evidence_source AS "evidenceSource",
       decision.reason,decision.attended_person_ids AS "attendedPersonIds",
       decision.occurrence_id AS "occurrenceId",decision.decided_by_person_id AS "decidedBy"
     FROM school_service_commitments AS commitment
     JOIN school_service_decisions AS decision USING(commitment_id)
     WHERE commitment.proposal_id=$1 ORDER BY commitment.service_date`,
        [apiCoverageProposalId],
      ),
    )).rows;

    assert.deepEqual(
      durableDecisions.map((item) => [
        item.commitmentId,
        item.serviceDate,
        item.requiredVolunteers,
        item.outcome,
        item.attendedPersonIds,
        item.reason,
        item.decidedBy,
      ]),
      [
        [
          commitments.Monday,
          serviceDates.Monday,
          1,
          "Completed",
          [substitute.personId],
          null,
          leaderId,
        ],
        [
          commitments.Tuesday,
          serviceDates.Tuesday,
          1,
          "Unfulfilled",
          [],
          zeroUnfulfilled.reason,
          leaderId,
        ],
        [
          commitments.Wednesday,
          serviceDates.Wednesday,
          2,
          "Unfulfilled",
          [substitute.personId],
          partialUnfulfilled.reason,
          leaderId,
        ],
        [commitments.Thursday, serviceDates.Thursday, 1, "Cancelled", [], cancel.reason, leaderId],
      ],
    );
    assert.deepEqual(
      durableDecisions.map((item) => item.evidenceSource),
      [
        completeCovered.evidenceSource,
        zeroUnfulfilled.evidenceSource,
        partialUnfulfilled.evidenceSource,
        cancel.evidenceSource,
      ],
    );
    assert.deepEqual(
      durableDecisions.map((item) => [item.startTime, item.endTime]),
      Array.from({ length: 4 }, () => ["09:00:00", "11:00:00"]),
    );
    assert.ok(durableDecisions[0]?.occurrenceId);
    assert.equal(durableDecisions[1]?.occurrenceId, null);
    assert.ok(durableDecisions[2]?.occurrenceId);
    assert.equal(durableDecisions[3]?.occurrenceId, null);
    assert.deepEqual(
      (yield* step(() =>
        journeyPool.query(
          `SELECT commitment_id AS "commitmentId",attended_person_ids AS "attendedPersonIds"
    FROM school_service_occurrences WHERE commitment_id=ANY($1) ORDER BY occurred_on`,
          [Object.values(commitments)],
        ),
      )).rows,
      [
        { commitmentId: commitments.Monday, attendedPersonIds: [substitute.personId] },
        { commitmentId: commitments.Wednesday, attendedPersonIds: [substitute.personId] },
      ],
    );

    // Each absence of a decided, noncancelled service closes Covered by its current record or
    // Uncovered; the cancelled service closes none.
    assert.deepEqual(
      (yield* step(() =>
        journeyPool.query(
          `SELECT closure.absence_id AS "absenceId",closure.outcome,closure.coverage_id AS "coverageId",
           closure.covering_person_id AS "coveringPersonId",
           closure.scheduled_person_id AS "scheduledPersonId",closure.occurrence_id AS "occurrenceId"
         FROM school_service_closures AS closure
         JOIN school_service_absences AS absence USING(absence_id)
         WHERE absence.proposal_id=$1 ORDER BY absence.service_date,absence.person_id`,
          [apiCoverageProposalId],
        ),
      )).rows,
      [
        {
          absenceId: coveredAbsence.absenceId,
          outcome: "Covered",
          coverageId: coveringRecord.coverageId,
          coveringPersonId: substitute.personId,
          scheduledPersonId: volunteerId,
          occurrenceId: durableDecisions[0]?.occurrenceId,
        },
        {
          absenceId: uncoveredAbsence.absenceId,
          outcome: "Uncovered",
          coverageId: null,
          coveringPersonId: null,
          scheduledPersonId: leaderId,
          occurrenceId: null,
        },
        {
          absenceId: volunteerWednesday.absenceId,
          outcome: "Covered",
          coverageId: wednesdayRecord.coverageId,
          coveringPersonId: substitute.personId,
          scheduledPersonId: volunteerId,
          occurrenceId: durableDecisions[2]?.occurrenceId,
        },
        {
          absenceId: leaderWednesday.absenceId,
          outcome: "Uncovered",
          coverageId: null,
          coveringPersonId: null,
          scheduledPersonId: leaderId,
          occurrenceId: durableDecisions[2]?.occurrenceId,
        },
      ],
    );
    assert.deepEqual(
      (yield* step(() =>
        journeyPool.query(
          `SELECT coverage.absence_id AS "absenceId",coverage.covering_person_id AS "coveringPersonId",
           coverage.coverer_kind AS "covererKind",coverage.recorded_by_person_id AS "recordedBy",
           coverage.withdrawn_by_person_id AS "withdrawnBy"
         FROM school_service_coverage_records AS coverage
         JOIN school_service_absences AS absence USING(absence_id)
         WHERE absence.proposal_id=$1 ORDER BY coverage.recorded_at,coverage.coverage_id`,
          [apiCoverageProposalId],
        ),
      )).rows,
      [
        [coveredAbsence.absenceId, substitute.personId, "Substitute", volunteerId, leaderId],
        [coveredAbsence.absenceId, leaderId, "Assistant", leaderId, leaderId],
        [coveredAbsence.absenceId, substitute.personId, "Substitute", leaderId, null],
        [volunteerWednesday.absenceId, substitute.personId, "Substitute", leaderId, null],
        [cancelledAbsenceId, substitute.personId, "Substitute", leaderId, null],
      ].map(([absenceId, coveringPersonId, covererKind, recordedBy, withdrawnBy]) => ({
        absenceId,
        coveringPersonId,
        covererKind,
        recordedBy,
        withdrawnBy,
      })),
    );

    for (const [day, expected] of [
      [
        "Monday",
        [
          {
            sourceKind: "Coverage",
            personId: substitute.personId,
            coverageId: coveringRecord.coverageId,
          },
          { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
        ],
      ],
      ["Tuesday", [{ sourceKind: "Scheduled", personId: leaderId, coverageId: null }]],
      [
        "Wednesday",
        [
          {
            sourceKind: "Coverage",
            personId: substitute.personId,
            coverageId: wednesdayRecord.coverageId,
          },
          { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
          { sourceKind: "Scheduled", personId: leaderId, coverageId: null },
        ],
      ],
      ["Thursday", []],
    ] as const)
      assert.deepEqual(yield* reservationsOf(commitments[day]), expected, `${day} reservations`);

    const apiCoverageAudit = (yield* step(() =>
      journeyPool.query(
        `SELECT action,actor_person_id AS "actorPersonId"
       FROM school_service_coverage_audit ORDER BY audit_id`,
      ),
    )).rows;

    assert.deepEqual(apiCoverageAudit, [
      audit("ReportAbsence", volunteerId),
      audit("RecordCoverage", volunteerId),
      audit("RecordCoverage", leaderId),
      audit("WithdrawCoverage", leaderId),
      audit("RecordCoverage", leaderId),
      audit("CompleteService", leaderId),
      audit("ReportAbsence", leaderId),
      audit("MarkUnfulfilledService", leaderId),
      audit("ReportAbsence", volunteerId),
      audit("RecordCoverage", leaderId),
      audit("ReportAbsence", leaderId),
      audit("MarkUnfulfilledService", leaderId),
      audit("ReportAbsence", leaderId),
      audit("RecordCoverage", leaderId),
      audit("CancelService", leaderId),
    ]);
    const apiCoverageAuditCount = apiCoverageAudit.length;

    const apiCoverageEvidence = {
      proposalId: apiCoverageProposalId,
      admissionOutcome: { applicationId: coverageApplicationId, revision: onCall.revision },
      coveredAbsenceId: coveredAbsence.absenceId,
      uncoveredAbsenceId: uncoveredAbsence.absenceId,
      coverageId: coveringRecord.coverageId,
      replacedCoverageIds: [firstRecord.coverageId, replacingRecord.coverageId],
      auditActions: apiCoverageAudit.map((entry) => entry.action),
    };

    const browserLeaderBoard = yield* command({
      action: "Create",
      personId: leaderId,
      schoolId: 962,
      day: "Monday",
      workdays: 4,
      block: "2",
    });

    assert.ok(
      browserLeaderBoard.placements.some(
        (placement) =>
          placement.personId === leaderId &&
          placement.schoolId === 962 &&
          placement.day === "Monday" &&
          placement.block === "2" &&
          placement.active,
      ),
    );

    const apiHistoryBeforeBrowser = (yield* step(() =>
      journeyPool.query(
        "SELECT * FROM assistant_placements WHERE person_id=$1 ORDER BY placement_id",
        [leaderId],
      ),
    )).rows;

    const manifest = {
      revision,
      backendOrigin,
      dashboardOrigin,
      artifacts,
      departmentId,
      semesterId,
      secondSemesterId,
      wrongDepartmentId,
      volunteerId,
      schoolId: 962,
      persons,
      leaderId,
      coverage: {
        candidateId: substitute.personId,
        candidateFirstName: substitute.firstName,
        candidateLastName: substitute.lastName,
        serviceDate: "2024-03-11",
        secondServiceDate: "2024-03-18",
        cancelledServiceDate: "2024-03-25",
        api: apiCoverageEvidence,
      },
    };

    const manifestPath = path.join(artifacts, "manifest.json");
    yield* fs.writeFileString(manifestPath, yield* jsonText(manifest), { mode: 0o600 });
    let browserEvidence: Schema.JsonObject | null = null;

    if (mode === "--browser") {
      yield* runChild(
        "bun",
        ["apps/dashboard/e2e/run-real-native-placement.mjs"],
        { ...environment, PLACEMENT_JOURNEY_MANIFEST: manifestPath },
        "300 seconds",
      );
      browserEvidence = yield* Schema.decodeEffect(BrowserEvidenceJson)(
        yield* fs.readFileString(path.join(artifacts, "browser-evidence.json")),
      );
      assert.equal(browserEvidence?.passed, true);
      assert.equal(browserEvidence?.revision, revision);

      const browserCoverageExpected = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          absencePosts: Schema.Int,
          proposalId: Schema.String,
          completedCommitmentId: Schema.String,
          unfulfilledCommitmentId: Schema.String,
          cancelledCommitmentId: Schema.String,
          coveredAbsenceId: Schema.String,
          uncoveredAbsenceId: Schema.String,
          coverageId: Schema.String,
          withdrawnCoverageId: Schema.String,
          occurrenceId: Schema.String,
          uncoveredOccurrenceId: Schema.String,
        }),
      )(browserEvidence?.coverageExpected);

      assert.ok(browserCoverageExpected);
      assert.equal(browserCoverageExpected.absencePosts, 1);

      const actual = (yield* step(() =>
        journeyPool.query(
          'SELECT placement_id AS "placementId",person_id AS "personId",school_id::integer AS "schoolId",semester_id AS "semesterId",day,workdays,block,active,revision FROM assistant_placements WHERE person_id=$1 ORDER BY block,placement_id',
          [volunteerId],
        ),
      )).rows;

      assert.deepEqual(
        actual,
        browserEvidence?.finalExpected,
        "browser expectations independently read from PostgreSQL",
      );
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            "SELECT * FROM assistant_placements WHERE person_id=$1 ORDER BY placement_id",
            [leaderId],
          ),
        )).rows,
        apiHistoryBeforeBrowser,
      );
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            "SELECT action,actor_person_id FROM organization_volunteer_affiliation_audit WHERE person_id=$1 ORDER BY revision",
            [volunteerId],
          ),
        )).rows,
        [
          { action: "Request", actor_person_id: volunteerId },
          { action: "Establish", actor_person_id: leaderId },
          { action: "Revoke", actor_person_id: leaderId },
        ],
      );

      const serviceProposal = (yield* step(() =>
        journeyPool.query(
          `SELECT proposal_id AS "proposalId",status,revision,
           jsonb_array_length(exception_snapshot) AS "exceptionCount",
           jsonb_array_length(assignment_snapshot) AS "assignmentCount"
         FROM school_service_proposals
         WHERE department_id=$1 AND semester_id=$2
         ORDER BY created_at DESC LIMIT 1`,
          [departmentId, semesterId],
        ),
      )).rows[0];

      assert.deepEqual(serviceProposal, {
        proposalId: browserEvidence?.serviceProposalId,
        status: "Confirmed",
        revision: 2,
        exceptionCount: 1,
        assignmentCount: 2,
      });
      assert.equal(browserCoverageExpected.proposalId, serviceProposal.proposalId);
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            `SELECT required_volunteers AS "requiredVolunteers"
           FROM school_service_demand
           WHERE department_id=$1 AND semester_id=$2 AND school_id=$3
             AND day='Monday' AND block='2'`,
            [departmentId, semesterId, 962],
          ),
        )).rows,
        [{ requiredVolunteers: 2 }],
      );
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            `SELECT person_id AS "personId",status,attempts
           FROM school_service_notification_outbox
           WHERE proposal_id=$1 ORDER BY person_id`,
            [serviceProposal.proposalId],
          ),
        )).rows,
        [
          { personId: volunteerId, status: "Delivered", attempts: 1 },
          { personId: leaderId, status: "Delivered", attempts: 1 },
        ],
      );

      const browserDecisions: Array<{
        commitmentId: string;
        requiredVolunteers: number;
        serviceDate: string;
        outcome: string;
        attendedPersonIds: string[];
        reason: string | null;
        evidenceSource: string;
        occurrenceId: string | null;
      }> = (yield* step(() =>
        journeyPool.query(
          `SELECT commitment.commitment_id AS "commitmentId",commitment.required_volunteers AS "requiredVolunteers",
         commitment.service_date::text AS "serviceDate",decision.outcome,
         decision.attended_person_ids AS "attendedPersonIds",decision.reason,
         decision.evidence_source AS "evidenceSource",decision.occurrence_id AS "occurrenceId"
       FROM school_service_commitments AS commitment JOIN school_service_decisions AS decision USING(commitment_id)
       WHERE commitment.proposal_id=$1 ORDER BY commitment.service_date`,
          [browserCoverageExpected.proposalId],
        ),
      )).rows;

      assert.deepEqual(
        browserDecisions.map((item) => [
          item.commitmentId,
          item.requiredVolunteers,
          item.serviceDate,
          item.outcome,
          item.attendedPersonIds,
        ]),
        [
          [
            browserCoverageExpected.completedCommitmentId,
            2,
            manifest.coverage.serviceDate,
            "Completed",
            [leaderId, substitute.personId].sort(),
          ],
          [
            browserCoverageExpected.unfulfilledCommitmentId,
            2,
            manifest.coverage.secondServiceDate,
            "Unfulfilled",
            [volunteerId],
          ],
          [
            browserCoverageExpected.cancelledCommitmentId,
            2,
            manifest.coverage.cancelledServiceDate,
            "Cancelled",
            [],
          ],
        ],
      );
      assert.deepEqual(
        browserDecisions.map((item) => item.evidenceSource),
        [
          `Skole Beta kontakt, telefon ${manifest.coverage.serviceDate}`,
          `Skole Beta kontakt, telefon ${manifest.coverage.secondServiceDate}`,
          `Skole Beta kontakt, telefon ${manifest.coverage.cancelledServiceDate}`,
        ],
      );
      assert.deepEqual(
        browserDecisions.map((item) => item.reason),
        [null, "Bare én av to frivillige møtte", "Skolen avlyste tjenesten"],
      );
      assert.ok(browserDecisions[0]?.occurrenceId);
      assert.ok(browserDecisions[1]?.occurrenceId);
      assert.equal(browserDecisions[2]?.occurrenceId, null);

      const browserAbsences = (yield* step(() =>
        journeyPool.query(
          `SELECT absence_id AS "absenceId",person_id AS "personId",
           reporter_person_id AS "reporterPersonId",service_date::text AS "serviceDate"
         FROM school_service_absences
         WHERE proposal_id=$1 ORDER BY service_date,absence_id`,
          [browserCoverageExpected.proposalId],
        ),
      )).rows;

      assert.deepEqual(browserAbsences, [
        {
          absenceId: browserCoverageExpected.coveredAbsenceId,
          personId: volunteerId,
          reporterPersonId: volunteerId,
          serviceDate: manifest.coverage.serviceDate,
        },
        {
          absenceId: browserCoverageExpected.uncoveredAbsenceId,
          personId: leaderId,
          reporterPersonId: leaderId,
          serviceDate: manifest.coverage.secondServiceDate,
        },
      ]);

      // The volunteer's record covers the first service; the coordinator's record on the second
      // absence was withdrawn before the decision.
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            `SELECT coverage.coverage_id AS "coverageId",coverage.absence_id AS "absenceId",
             coverage.covering_person_id AS "coveringPersonId",coverage.coverer_kind AS "covererKind",
             coverage.recorded_by_person_id AS "recordedBy",
             coverage.withdrawn_by_person_id AS "withdrawnBy"
           FROM school_service_coverage_records AS coverage
           JOIN school_service_absences AS absence USING(absence_id)
           WHERE absence.proposal_id=$1 ORDER BY coverage.recorded_at,coverage.coverage_id`,
            [browserCoverageExpected.proposalId],
          ),
        )).rows,
        [
          {
            coverageId: browserCoverageExpected.coverageId,
            absenceId: browserCoverageExpected.coveredAbsenceId,
            coveringPersonId: substitute.personId,
            covererKind: "Substitute",
            recordedBy: volunteerId,
            withdrawnBy: null,
          },
          {
            coverageId: browserCoverageExpected.withdrawnCoverageId,
            absenceId: browserCoverageExpected.uncoveredAbsenceId,
            coveringPersonId: substitute.personId,
            covererKind: "Substitute",
            recordedBy: leaderId,
            withdrawnBy: leaderId,
          },
        ],
      );

      for (const [commitmentId, expected] of [
        [
          browserCoverageExpected.completedCommitmentId,
          [
            {
              sourceKind: "Coverage",
              personId: substitute.personId,
              coverageId: browserCoverageExpected.coverageId,
            },
            { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
            { sourceKind: "Scheduled", personId: leaderId, coverageId: null },
          ],
        ],
        [
          browserCoverageExpected.unfulfilledCommitmentId,
          [
            { sourceKind: "Scheduled", personId: volunteerId, coverageId: null },
            { sourceKind: "Scheduled", personId: leaderId, coverageId: null },
          ],
        ],
        [browserCoverageExpected.cancelledCommitmentId, []],
      ] as const)
        assert.deepEqual(yield* reservationsOf(commitmentId), expected);

      const browserOccurrences = (yield* step(() =>
        journeyPool.query(
          `SELECT occurrence_id AS "occurrenceId",occurred_on::text AS "occurredOn",
           attended_person_ids AS "attendedPersonIds",recorded_by_person_id AS "recordedByPersonId"
         FROM school_service_occurrences
         WHERE proposal_id=$1 ORDER BY occurred_on,occurrence_id`,
          [browserCoverageExpected.proposalId],
        ),
      )).rows;

      assert.deepEqual(
        browserOccurrences.map(
          (occurrence: {
            readonly occurrenceId: string;
            readonly occurredOn: string;
            readonly attendedPersonIds: ReadonlyArray<string>;
            readonly recordedByPersonId: string;
          }) => ({
            ...occurrence,
            attendedPersonIds: [...occurrence.attendedPersonIds].sort(),
          }),
        ),
        [
          {
            occurrenceId: browserCoverageExpected.occurrenceId,
            occurredOn: manifest.coverage.serviceDate,
            attendedPersonIds: [leaderId, substitute.personId].sort(),
            recordedByPersonId: leaderId,
          },
          {
            occurrenceId: browserCoverageExpected.uncoveredOccurrenceId,
            occurredOn: manifest.coverage.secondServiceDate,
            attendedPersonIds: [volunteerId],
            recordedByPersonId: leaderId,
          },
        ],
      );
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            `SELECT closure.absence_id AS "absenceId",closure.outcome,
             closure.coverage_id AS "coverageId",
             closure.covering_person_id AS "coveringPersonId",
             closure.scheduled_person_id AS "scheduledPersonId",
             closure.closed_by_person_id AS "closedByPersonId"
           FROM school_service_closures AS closure
           JOIN school_service_absences AS absence USING(absence_id)
           WHERE absence.proposal_id=$1 ORDER BY absence.service_date,closure.closure_id`,
            [browserCoverageExpected.proposalId],
          ),
        )).rows,
        [
          {
            absenceId: browserCoverageExpected.coveredAbsenceId,
            outcome: "Covered",
            coverageId: browserCoverageExpected.coverageId,
            coveringPersonId: substitute.personId,
            scheduledPersonId: volunteerId,
            closedByPersonId: leaderId,
          },
          {
            absenceId: browserCoverageExpected.uncoveredAbsenceId,
            outcome: "Uncovered",
            coverageId: null,
            coveringPersonId: null,
            scheduledPersonId: leaderId,
            closedByPersonId: leaderId,
          },
        ],
      );
      assert.deepEqual(
        (yield* step(() =>
          journeyPool.query(
            `SELECT action,actor_person_id AS "actorPersonId"
           FROM school_service_coverage_audit
           ORDER BY audit_id OFFSET $1`,
            [apiCoverageAuditCount],
          ),
        )).rows,
        [
          audit("ReportAbsence", volunteerId),
          audit("RecordCoverage", volunteerId),
          audit("CompleteService", leaderId),
          audit("ReportAbsence", leaderId),
          audit("RecordCoverage", leaderId),
          audit("WithdrawCoverage", leaderId),
          audit("MarkUnfulfilledService", leaderId),
          audit("CancelService", leaderId),
        ],
      );
      assert.equal(notificationRequests.length, 2);

      for (const delivered of notificationRequests) {
        assert.equal(delivered.authorization, "Bearer synthetic-school-service-token");
        assert.equal(delivered.idempotencyKey, delivered.body.effectId);
      }
    }

    assert.deepEqual(
      yield* credentialSnapshot,
      credentialsBefore,
      "placement does not mutate account credentials",
    );
    assert.deepEqual(
      (yield* step(() => journeyPool.query("SELECT * FROM person_profiles ORDER BY person_id")))
        .rows,
      peopleBefore,
      "canonical Person unchanged",
    );
    yield* step(() => native.dispose());
    const bunVersion = process.versions.bun;

    const postgresVersion = yield* Schema.decodeUnknownEffect(Schema.String)(
      (yield* step(() => journeyPool.query("SELECT version() AS version"))).rows[0].version,
    );

    const runtime: { readonly postgres: string; readonly bun?: string } =
      bunVersion === undefined
        ? { postgres: postgresVersion }
        : { bun: bunVersion, postgres: postgresVersion };

    evidence = {
      revision,
      apiPassed: true,
      browserEvidence,
      apiCoverage: apiCoverageEvidence,
      notificationRequests,
      runtime,
      implementation: {
        generatedCoverageOperations: [
          "placements.readOwnCoverage",
          "placements.commandOwnCoverage",
          "placements.readCoverageBoard",
          "placements.commandCoverageBoard",
          "admissionOutcomes.recordOutcome",
        ],
        coverageGates: [
          "anonymous, wrong-scope, owner, roster/date, coverer, ETag, and idempotency boundaries",
          "coverage record, atomic replacement, withdrawal, ineligible and unavailable coverers, exact decision replay and competing decision denial",
          "derived attendance, zero and partial unmet demand, cancellation without occurrence releasing reservations, old occurrence, closure and audit history",
        ],
      },
      localRuntime: {
        mode,
        postgres: "disposable loopback PostgreSQL",
        backend: backendOrigin,
        dashboard: mode === "--browser" ? dashboardOrigin : null,
        notificationProvider: "owned loopback HTTP provider for roster notifications",
      },
      productionBoundary:
        "No production data, provider, credentials, deployment, or cutover is contacted or changed.",
      apiGates: [
        "real RPC client read/write decoding",
        "private self discovery and no-team/regular-member privacy",
        "wrong-department/inactive/anonymous denies and global admin",
        "explicit historical scope and active associated schools",
        "self request/withdraw and coordinator establishment",
        "required ETag and invalid values",
        "exact and conflicting retries, stale/concurrent edits",
        "exact duplicate rejection and distinct blocks/Both",
        "persisted item scope defeats forged semester",
        "Create/Edit/Remove same row and audit retained",
        "inactive affiliation preserves history and rejects new placement",
        "fresh authority before exact replay",
        "dated commitment scope, old/duplicate occurrence, admission outcome, coverer eligibility and availability, coverage record, terminal evidence and closure gates",
        "canonical Person and account credentials unchanged",
      ],
    };

    journeyPassed = true;
  });

  // The listeners stay until the runner has written its receipt, so that a signal during cleanup
  // is recorded, not fatal.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      (["SIGTERM", "SIGINT"] as const).map((signal) => {
        const listener = () => {
          interruptedSignal ??= signal;
          failure ??= "Interrupted by " + signal;
          Deferred.doneUnsafe(interrupted, Exit.void);
        };

        process.once(signal, listener);

        return [signal, listener] as const;
      }),
    ),
    (listeners) =>
      Effect.sync(() => {
        for (const [signal, listener] of listeners) process.removeListener(signal, listener);
      }),
  );

  const outcome = yield* journey.pipe(Effect.raceFirst(Deferred.await(interrupted)), Effect.exit);

  if (Exit.isFailure(outcome)) {
    const error = sanitize(String(thrownBy(outcome.cause)));

    if (interruptedSignal === undefined) failure = error;

    yield* Effect.sync(() => process.stderr.write(error + "\n"));
  }

  const errors = yield* cleanup;

  if (errors.length > 0) {
    yield* Effect.sync(() => process.stderr.write(errors.join("; ") + "\n"));

    return 1;
  }

  return interruptedSignal === "SIGINT"
    ? 130
    : interruptedSignal === "SIGTERM"
      ? 143
      : failure === undefined
        ? 0
        : 1;
});

Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
).then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    process.stderr.write(String(cause) + "\n");
    process.exitCode = 1;
  },
);
