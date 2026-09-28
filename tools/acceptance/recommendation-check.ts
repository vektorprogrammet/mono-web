/**0101: previous-schema history -> actual migration -> production browser/API/PostgreSQL. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Array as Arr,
  type Cause,
  Config,
  Console,
  Data,
  DateTime,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Redacted,
  Runtime,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  observeInterviewReport,
  seedInterviewReportCoordinator,
  validateInterviewReportFixture,
} from "./interview-report-observation.js";
import {
  applicantProgressUnlinkedIdentity,
  runApplicantProgress0107,
  seedApplicantProgress0107,
} from "./applicant-progress-0107.ts";
import {
  loopbackPortFree,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "../postgres/index.ts";
import {
  type RunCommand,
  runReturningAssistantBrowserJourney,
  runReturningAssistantLoginProbe,
  seedReturningAssistant,
} from "./returning-assistant-journey.ts";
import {
  assertInterviewCorrectionPre0039Preserved,
  coInterviewerCorrection0106IdentitySeeds,
  seedCoInterviewerCorrection0106Fixture,
  seedInterviewCorrectionPre0039Fixture,
  type CoInterviewerCorrection0106Fixture,
  type InterviewCorrectionPre0039Fixture,
} from "./recommendation-preupgrade-fixture.ts";
import {
  assertInterviewCorrectionBoundaries,
  type InterviewCorrectionReplayRequest,
} from "./interview-correction-boundaries.ts";
import { assertInterviewCorrectionIntegrity } from "./interview-correction-integrity.ts";
import { runCoInterviewerCorrectionJourney } from "./co-interviewer-correction-0106.ts";
import {
  answersOk,
  commandOutput,
  indentedJsonText,
  type OwnedChild,
  ProbeFailure,
  startOwnedProcess,
} from "./acceptance-process.ts";
import { jsonText, step, thrownBy } from "./journey-step.ts";
import { DatabaseLive } from "../../packages/database/src/layers.js";
import { TestPlatform } from "../../packages/database/src/test-support/platform.js";
import { AdmissionsLive } from "../../packages/database/src/admissions/index.js";
import { OrganizationLive } from "../../packages/database/src/organization/index.js";
import { ProfileLive } from "../../packages/database/src/profile/index.js";
import { deliverNextRecruitmentInvitation } from "../../packages/database/src/recruitment/index.js";
import {
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidenceSchema,
} from "../../packages/domain/src/recruitment/index.js";
import { deliverJson } from "../../apps/backend/src/delivery/http.js";
import { NotificationGateway } from "../../packages/domain/src/notification/service.js";
import { PublicApplicationIdSchema } from "../../packages/domain/src/application/schema.js";
import { nativeScriptClient } from "../../packages/rpc/src/script-client.js";
import { replacedFetch } from "../../apps/dashboard/e2e/native-rpc-ledger.ts";

const root = new URL("../../", import.meta.url).pathname;

const dbRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));

const uiRequire = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));

const { Pool } = dbRequire("pg");

const fixtureKeys = {
  invalid0: "invalid-recommendation-0101-0",
  invalid1: "invalid-recommendation-0101-1",
  invalid2: "invalid-recommendation-0101-2",
  invalid3: "invalid-recommendation-0101-3",
  maybe: "recommendation-maybe-0101",
  raceA: "recommendation-no-a-0101",
  raceB: "recommendation-no-b-0101",
  no: "recommendation-no-0101",
  selfFinalize: "known-self-recommendation-0101",
  selfCancel: "self-cancel-recommendation-0101",
  linkRace: "identity-race-recommendation-0101",
} as const;

/**
 * How a run of the probe ended: the full journey passed, or a targeted mode finished with the
 * report that its result line carries after the revision, artifacts, and gates.
 */
interface Outcome {
  readonly result: string;
  readonly report?: { readonly probe: unknown } | { readonly journey: unknown };
}

/** The redacted failure of the probe, reported as its failure evidence before the exit. */
class RecommendationFailed extends Data.TaggedError("RecommendationFailed")<{
  readonly message: string;
}> {
  /** The failure evidence reports the failure already, so the runtime logs nothing more. */
  readonly [Runtime.errorReported] = false;
}

const assertNoRecommendation = (value: Schema.Json): void => {
  if (Arr.isArray<Schema.Json>(value)) for (const item of value) assertNoRecommendation(item);
  else if (
    value !== null &&
    !Predicate.isString(value) &&
    !Predicate.isNumber(value) &&
    !Predicate.isBoolean(value)
  )
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!["recommendation", "explanatoryPower", "roleModel", "suitability"].includes(key));
      assertNoRecommendation(item);
    }
};

type EffectReceiverCall = {
  readonly effectId: string;
  readonly commandId: string;
  readonly origin: string;
  readonly kind: string;
  readonly attempt: number;
  readonly status: number;
};

const stringField = (value: Schema.Json, key: string): string => {
  if (value === null || !(value === null || Predicate.isObjectOrArray(value)) || !(key in value))
    return "";
  const field = Schema.decodeUnknownSync(Schema.JsonObject)(value)[key];

  return Predicate.isString(field) ? field : "";
};

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The value of a JSON text, decoded through Schema. */
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The JSON value of a JSON text, decoded through Schema. */
const decodeJsonValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/** The current instant as an ISO 8601 string, as the delivery evidence records it. */
const isoNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const deliverRecruitmentInvitationOnce = ({
  pgUrl,
  endpoint,
  token,
  claimId,
}: {
  readonly pgUrl: string;
  readonly endpoint: URL;
  readonly token: string;
  readonly claimId: string;
}) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(pgUrl),
    applicationName: "native-returning-invitation-delivery",
    maxConnections: 1,
  }).pipe(Layer.provide(TestPlatform));

  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));

  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );

  const authorityLayers = Layer.mergeAll(
    databaseLayer,
    admissionsLayer,
    organizationLayer,
    profileLayer,
  );

  const transport = {
    endpoint,
    token,
    deliveryTimeoutMilliseconds: 2_000,
  };

  /** Delivers one request to the loopback receiver and answers its delivery evidence. */
  const deliverLoopback = <
    Request extends Schema.Json & {
      readonly effectId: (typeof RecruitmentNotificationEvidenceSchema.Type)["effectId"];
    },
  >(
    request: Request,
    message: string,
  ) =>
    deliverJson(request, transport, {
      "idempotency-key": request.effectId,
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.andThen(isoNow),
      Effect.map((deliveredAt) =>
        RecruitmentNotificationEvidenceSchema.make({
          effectId: request.effectId,
          deliveredAt,
          providerReference: `loopback:${request.effectId}`,
        }),
      ),
      Effect.mapError(() =>
        RecruitmentNotificationDeliveryError.make({ effectId: request.effectId, message }),
      ),
    );

  const gateway = Layer.succeed(
    NotificationGateway,
    NotificationGateway.of({
      deliverInterviewCompletionReceipt: (request) =>
        deliverLoopback(request, "loopback interview completion receipt delivery unavailable"),
      deliverInterviewInvitation: (request) =>
        deliverLoopback(request, "loopback recruitment invitation delivery unavailable"),
      deliverInterviewInvitationResponse: (request) =>
        deliverLoopback(request, "loopback recruitment invitation response delivery unavailable"),
    }),
  );

  return Effect.scoped(
    isoNow.pipe(
      Effect.flatMap((now) => deliverNextRecruitmentInvitation(claimId, now)),
      Effect.provide(Layer.merge(gateway, authorityLayers)),
    ),
  );
};

const program = Effect.gen(function* () {
  const coInterviewerMode = process.argv.includes("--co-interviewer-mode");
  const applicantProgressMode = process.argv.includes("--applicant-progress-mode");

  if (process.argv.includes("--report")) validateInterviewReportFixture();

  if (process.argv.includes("--validate-fixture")) {
    yield* Console.log("All recommendation fixture idempotency keys satisfy the canonical schema");

    return;
  }

  const { chromium } = uiRequire("@playwright/test");
  const AxeBuilder = uiRequire("@axe-core/playwright").default;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run: RunCommand = (command, args, env = {}, cwd = root) =>
    commandOutput({ command, args, cwd, env, deadline: "180 seconds", stderr: "pipe" });

  assert.equal(
    (yield* run("git", ["status", "--porcelain", "--", ".", ":(exclude).serena"])).trim(),
    "",
  );

  const revision = (yield* run("git", ["rev-parse", "HEAD"])).trim();
  const artifacts = yield* fs.makeTempDirectory({ prefix: "vektor-recommendation-0101-" });
  const logs: string[] = [];

  /** Starts an owned process whose output the probe keeps for its failure evidence. */
  const start = (
    command: string,
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
    cwd = root,
  ) => startOwnedProcess({ command, args, cwd, env, output: (text) => logs.push(text) });

  /** Polls the check every 100 ms, 150 times; a failed check counts as not ready. */
  const ready = <E, R>(check: Effect.Effect<boolean, E, R>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (yield* check.pipe(Effect.catchCause(() => Effect.succeed(false)))) return;

        yield* Effect.sleep("100 millis");
      }

      return yield* new ProbeFailure({ message: "Readiness failed" });
    });

  let pool: any, browser: any, page: any, heldIdentityClient: any;
  let backend: OwnedChild;
  let correctionPre0039Fixture: InterviewCorrectionPre0039Fixture | undefined;
  let acceptedCorrectionReplay: InterviewCorrectionReplayRequest | undefined;
  let coInterviewerFixture: CoInterviewerCorrection0106Fixture | undefined;
  let expectedHistoricalReportRecommendation: "Ja" | "Kanskje" | "Nei" | undefined;
  const effectCalls: EffectReceiverCall[] = [];
  const effectAttempts = new Map<string, number>();
  const invitationCapabilities = new Map<string, string>();
  let releaseEffectDelivery = false;
  const gates: string[] = [];
  const secrets: string[] = [];
  const accessibility: Array<{ state: string; violations: ReadonlyArray<unknown> }> = [];

  // The lines of standard output, in the order the journey and its callbacks report them.
  const lines = yield* Queue.unbounded<string, Cause.Done>();

  const printer = yield* Stream.fromQueue(lines).pipe(
    Stream.runForEach((line) => Console.log(line)),
    Effect.forkChild,
  );

  const say = (line: string) => {
    Queue.offerUnsafe(lines, line);
  };

  /** Ends standard output and waits until every reported line is written. */
  const flushOutput = Queue.end(lines).pipe(Effect.andThen(Fiber.join(printer)));

  const recordGate = (...observations: string[]) => {
    gates.push(...observations);
    say(JSON.stringify({ observed: observations }));
  };

  const auditPage = (auditedPage: any, state: string) =>
    Effect.gen(function* () {
      const analysis = yield* step(() => new AxeBuilder({ page: auditedPage }).analyze());

      const violations: ReadonlyArray<unknown> = analysis.violations.map((violation: any) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node: any) => ({
          target: node.target,
          checks: node.any.map((check: any) => ({ id: check.id, data: check.data })),
        })),
      }));

      accessibility.push({ state, violations });
      let evidence = yield* indentedJsonText(accessibility);

      for (const secret of secrets) evidence = evidence.replaceAll(secret, "[redacted]");
      yield* fs.writeFileString(path.join(artifacts, "accessibility.json"), evidence);

      return violations;
    });

  /** Fails when a retained artifact other than a screenshot contains a credential. */
  const assertArtifactsRedacted = Effect.gen(function* () {
    for (const name of yield* fs.readDirectory(artifacts)) {
      const file = path.join(artifacts, name);

      if ((yield* fs.stat(file)).type === "File" && !name.endsWith(".png")) {
        const text = yield* fs.readFileString(file);

        for (const secret of secrets)
          assert.ok(!text.includes(secret), `retained artifact ${name} contains a credential`);
      }
    }
  });

  /** The loopback receiver of the backend's effects, on its reserved port for the scope. */
  const startEffectReceiver = (
    token: string,
    portNumber: number,
    captureInvitationCapability: (interviewId: string, capability: string) => void,
  ) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: portNumber,
          fetch(request) {
            const url = new URL(request.url);

            if (request.method !== "POST" || `${url.pathname}${url.search}` !== "/effects")
              return new Response(null, { status: 404 });

            if (request.headers.get("authorization") !== `Bearer ${token}`)
              return new Response(null, { status: 401 });

            return request.text().then((text) => {
              const decoded = decodeJsonBody(text);

              if (Option.isNone(decoded)) return new Response(null, { status: 400 });

              const body = decoded.value;

              if (stringField(body, "_tag") === "SendInterviewInvitation") {
                const interviewId = stringField(body, "interviewId");
                const capability = stringField(body, "responseCapability");

                if (interviewId !== "" && capability !== "")
                  captureInvitationCapability(interviewId, capability);
              }

              const effectId = request.headers.get("idempotency-key") ?? "";
              const attempt = (effectAttempts.get(effectId) ?? 0) + 1;
              effectAttempts.set(effectId, attempt);
              const kind = stringField(body, "_tag");

              const status =
                releaseEffectDelivery || kind === "SendInterviewInvitation" ? 204 : 503;

              effectCalls.push({
                effectId,
                commandId: stringField(body, "commandId"),
                origin: stringField(body, "origin"),
                kind: stringField(body, "_tag"),
                attempt,
                status,
              });

              return new Response(null, { status });
            });
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

  // Runs journey programs for the callbacks of the promise-based helpers, in the probe's scope.
  const runCallback = yield* FiberSet.makeRuntimePromise();

  const recommendationJourney = Effect.gen(function* () {
    // The cluster reserves its own port through the same construct, so no port repeats.
    const [apiPort, effectPort] = yield* step(() => reserveLoopbackPorts(2)),
      uiPort = 5174;

    assert.ok(apiPort !== undefined && effectPort !== undefined);
    assert.ok(yield* step(() => loopbackPortFree(uiPort)), `loopback port ${uiPort} is in use`);

    const postgres = yield* Effect.acquireRelease(
      step(() => startDisposablePostgres()),
      (cluster) => step(() => cluster.stop()).pipe(Effect.orDie),
    );

    const pg = postgres.url,
      api = `http://127.0.0.1:${apiPort}`,
      ui = `http://127.0.0.1:${uiPort}`;

    const effectMode = process.argv.includes("--returning-mode") ? "http" : "disabled";
    const effectToken = randomBytes(32).toString("hex");

    const journeyPool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: pg })),
      (owned) => step(() => owned.end()).pipe(Effect.orDie),
    );

    pool = journeyPool;

    // A connection that holds an applicant lock rolls back and returns to the pool before it ends.
    yield* Effect.addFinalizer(() =>
      heldIdentityClient === undefined
        ? Effect.void
        : step(() => heldIdentityClient.query("ROLLBACK")).pipe(
            Effect.andThen(Effect.sync(() => heldIdentityClient.release())),
            Effect.orDie,
          ),
    );

    // Values over the inherited environment, which every command and process of the probe extends.
    const baseEnv = {
      JOURNEY_SEED_PG_URL: pg,
      BACKEND_PG_URL: pg,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(apiPort),
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([ui]),
      OAUTH_CANONICAL_ORIGIN: api,
      OAUTH_DASHBOARD_ORIGIN: ui,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: effectMode,
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",

      API_URL: api,
      VITE_API_URL: api,
      DASHBOARD_MOUNT: "/",
      HOST: "127.0.0.1",
      PORT: String(uiPort),
      NODE_ENV: "production",
    };

    const effectEnv = {
      PUBLIC_APPLICATION_EFFECT_ENDPOINT: `http://127.0.0.1:${effectPort}/effects`,
      PUBLIC_APPLICATION_EFFECT_TOKEN: effectToken,
      PUBLIC_APPLICATION_EFFECT_POLL_MS: "1000",
      PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: "2000",
    };

    const env = effectMode === "http" ? { ...baseEnv, ...effectEnv } : baseEnv;

    assert.ok(env.BETTER_AUTH_SECRET);
    secrets.push(env.BETTER_AUTH_SECRET);
    recordGate("disposable PostgreSQL is ready");
    yield* run("bun", ["tools/verification/recommendation-preupgrade-fixture.ts"], {
      ...env,
      RECOMMENDATION_PREUPGRADE_THROUGH_0038: "1",
    });

    const historicalBefore = (yield* step(() =>
      pool.query(
        `SELECT to_jsonb(c)-'recommendation' value FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
      ),
    )).rows[0].value;

    recordGate("previous-schema history fixture migrated");
    correctionPre0039Fixture = yield* seedInterviewCorrectionPre0039Fixture({ pool });
    recordGate("seeded 0105 pre-0039 correction rows from existing native base");
    yield* run(
      "bun",
      ["run", "identity:seed"],
      {
        ...env,
        IDENTITY_SEED_PG_URL: pg,
        IDENTITY_SEED_PERSONS: yield* jsonText([
          {
            personId: "journey-conduct-leader-0063",
            firstName: "Lina",
            lastName: "Lagleder",
            email: "lina.conduct@example.invalid",
            password: "journey-conduct-secret-0123456789",
          },
          ...(coInterviewerMode ? coInterviewerCorrection0106IdentitySeeds : []),
          ...(applicantProgressMode ? [applicantProgressUnlinkedIdentity] : []),
        ]),
      },
      path.join(root, "packages/database"),
    );

    if (coInterviewerMode) {
      coInterviewerFixture = yield* seedCoInterviewerCorrection0106Fixture({ pool });
      recordGate(
        "seeded synthetic 0106 co-interviewer designation after the canonical migration chain",
      );
    }

    yield* seedReturningAssistant({ pool, run, env, root });
    // Also classifies team-native-conduct-0063 as the board (Styret) of an independent department,
    // so promoting the conduct leader to its leader below grants department reach (O8-11).
    yield* seedInterviewReportCoordinator({ pool, secrets });

    if (effectMode === "http") {
      yield* startEffectReceiver(effectToken, effectPort, (interviewId, capability) => {
        invitationCapabilities.set(interviewId, capability);
        secrets.push(capability);
      });
      secrets.push(effectToken);
    }

    const effectSnapshot = Effect.fnUntraced(function* () {
      const tables = (yield* step(() =>
        pool.query(
          `SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') AND (tablename LIKE '%outbox%' OR tablename LIKE '%effect%') ORDER BY schemaname,tablename`,
        ),
      )).rows;

      return yield* Effect.forEach(
        tables,
        ({ schemaname, tablename }: any) =>
          step(() =>
            pool.query(
              `SELECT to_jsonb(t) value FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
            ),
          ).pipe(Effect.map(({ rows }: any) => ({ table: `${schemaname}.${tablename}`, rows }))),
        { concurrency: "unbounded" },
      );
    });

    const effectsBefore = yield* effectSnapshot();

    const link = Effect.fnUntraced(function* (suffix: string, personId: string, sql = pool) {
      const invitation = `identity-recommendation-${suffix}`;
      yield* step(() =>
        sql.query(
          `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Claimed','journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
          [
            invitation,
            `application-recommendation-${suffix}`,
            `applicant-recommendation-${suffix}`,
            createHash("sha256").update(invitation).digest("hex"),
          ],
        ),
      );
      yield* step(() =>
        sql.query(
          `INSERT INTO public.applicant_account_links VALUES($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$3)`,
          [`applicant-recommendation-${suffix}`, personId, invitation],
        ),
      );
    });

    yield* step(() =>
      pool.query(
        `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES('recommendation-other-0101','Other','Interviewer',0)`,
      ),
    );
    yield* link("self", "journey-conduct-leader-0063");
    yield* link("maybe", "recommendation-other-0101");

    if (applicantProgressMode) {
      yield* seedApplicantProgress0107(pool);
      recordGate("seeded synthetic current-semester applicant progress states");
      secrets.push(
        applicantProgressUnlinkedIdentity.email,
        applicantProgressUnlinkedIdentity.password,
      );
    }

    const invitationCapability = randomBytes(32).toString("base64url");
    secrets.push(invitationCapability);
    yield* step(() =>
      pool.query(
        `UPDATE public.recruitment_invitations SET capability_sha256=$1 WHERE invitation_id='invitation-recommendation-maybe'`,
        [createHash("sha256").update(invitationCapability).digest("hex")],
      ),
    );

    backend = yield* start("bun", ["apps/backend/src/main.ts"], env);
    yield* ready(answersOk(`${api}/health`));

    const historicalAfter = (yield* step(() =>
      pool.query(
        `SELECT to_jsonb(c)-'recommendation' value,recommendation FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
      ),
    )).rows[0];

    assert.deepEqual(historicalAfter.value, historicalBefore);
    assert.equal(historicalAfter.recommendation, null);
    recordGate(
      "immutable historical row survived actual0037 upgrade without invented recommendation",
    );
    assert.ok(correctionPre0039Fixture);
    yield* assertInterviewCorrectionPre0039Preserved({
      connection: pool,
      fixture: correctionPre0039Fixture,
    });
    recordGate(
      "0039/0040 upgrades preserved original interview/schedule/invitation/conduct/lifecycle rows",
    );
    yield* run("bun", ["run", "build"], env, path.join(root, "apps/dashboard"));
    yield* start("bun", ["server.mjs"], env, path.join(root, "apps/dashboard"));
    yield* ready(answersOk(`${ui}/login`));

    const password = "journey-conduct-secret-0123456789",
      email = "lina.conduct@example.invalid";

    secrets.push(password, email);

    const credentialCheck = yield* HttpClient.execute(
      HttpClientRequest.post(`${api}/api/auth/sign-in/email`).pipe(
        HttpClientRequest.setHeaders({ origin: ui }),
        HttpClientRequest.bodyText(yield* jsonText({ email, password }), "application/json"),
      ),
    );

    if (credentialCheck.status < 200 || credentialCheck.status > 299) {
      const failure = yield* credentialCheck.json;

      return yield* new ProbeFailure({
        message: `Native sign-in failed: ${credentialCheck.status} ${yield* jsonText(failure)}`,
      });
    }

    yield* credentialCheck.text;
    recordGate("seeded native credentials accepted by real identity engine");

    const executablePath = yield* Config.String("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH").pipe(
      Config.withDefault("/etc/profiles/per-user/nori/bin/chromium"),
    );

    browser = yield* Effect.acquireRelease(
      step(() => chromium.launch({ headless: true, executablePath })),
      (launched: any) => step(() => launched.close()).pipe(Effect.orDie),
    );
    const context = yield* step(() => browser.newContext());
    const errors: string[] = [];
    context.on("page", (p: any) => p.on("pageerror", () => errors.push("pageerror")));
    page = yield* step(() => context.newPage());
    yield* step(() => page.goto(`${ui}/login`));
    yield* step(() => page.getByLabel("E-post", { exact: true }).fill(email));
    yield* step(() => page.getByLabel("Passord", { exact: true }).fill(password));
    yield* step(() => page.getByRole("button", { name: "Logg inn", exact: true }).click());
    yield* step(() => page.waitForURL(/\/dashboard\/?$/));
    yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));

    if (process.argv.includes("--returning-login-probe")) {
      const probe = yield* runReturningAssistantLoginProbe({ browser, pool, ui, artifacts });

      return { result: "ReturningLoginProbe", report: { probe } } satisfies Outcome;
    }

    assert.equal(
      yield* step(() => page.getByRole("link", { name: "Søkerkontoer", exact: true }).count()),
      0,
    );
    const cookies = yield* step(() => context.cookies());
    const cookie = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    secrets.push(...cookies.map((c: any) => c.value));

    if (applicantProgressMode) {
      // Leadership of the department's board (classified by seedInterviewReportCoordinator).
      yield* step(() =>
        pool.query(
          `UPDATE public.organization_memberships
         SET is_team_leader=true, position_id='teamleader'
         WHERE membership_id='membership-native-conduct-leader-0063'`,
        ),
      );

      const journey = yield* runApplicantProgress0107({
        pool,
        page,
        cookie,
        api,
        ui,
        artifacts,
        errors,
        audit: (journeyPage) => runCallback(auditPage(journeyPage, "applicant-progress")),
      });

      recordGate("observed applicant-owned progress through the real browser/API/PostgreSQL path");

      yield* assertArtifactsRedacted;

      return { result: "ApplicantProgressTargeted", report: { journey } } satisfies Outcome;
    }

    if (coInterviewerMode) {
      if (coInterviewerFixture === undefined)
        return yield* new ProbeFailure({
          message: "co-interviewer targeted mode requires its synthetic designation fixture",
        });

      const journey = yield* runCoInterviewerCorrectionJourney({
        pool,
        browser,
        primaryCookie: cookie,
        api,
        ui,
        artifacts,
        revision,
        fixture: coInterviewerFixture,
        errors,
        secrets,
        effectsBefore,
        effectSnapshot,
        auditPage,
        recordGate,
      });

      yield* assertArtifactsRedacted;

      return { result: "CoInterviewerTargeted", report: { journey } } satisfies Outcome;
    }

    if (process.argv.includes("--returning-mode")) {
      let currentStage = "returning:startup";
      const returningStages: string[] = [];

      const stage = (name: string) => {
        currentStage = name;
        returningStages.push(name);
        say(JSON.stringify({ returningStage: name }));
      };

      /** The operation, or a failure that names the stage it reached, after `timeout`. */
      const bounded = <A, E, R>(
        label: string,
        operation: Effect.Effect<A, E, R>,
        timeout: Duration.Input = "90 seconds",
      ) =>
        operation.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new ProbeFailure({ message: `${label} timed out at ${currentStage}` })),
          }),
        );

      const returningResult = yield* bounded(
        "returning browser journey",
        runReturningAssistantBrowserJourney({
          browser,
          page,
          pool,
          api,
          ui,
          artifacts,
          auditPage,
          errors,
          stage,
          coordinatorEmail: "coordinator.report@example.invalid",
          coordinatorPassword: password,
          readInvitationCapability: (interviewId) => invitationCapabilities.get(interviewId),
          deliverRecruitmentInvitation: Effect.fnUntraced(function* (claimId: string) {
            const result = yield* deliverRecruitmentInvitationOnce({
              pgUrl: pg,
              endpoint: new URL(`${api.replace(/:\d+$/u, `:${effectPort}`)}/effects`),
              token: effectToken,
              claimId,
            });

            assert.equal(result._tag, "Delivered");

            const outbox = yield* step(() =>
              pool.query(
                "SELECT status,attempts FROM public.recruitment_invitation_outbox WHERE effect_id=$1",
                [result.claim.effectId],
              ),
            );

            assert.deepEqual(outbox.rows, [{ status: "Delivered", attempts: 1 }]);

            return result;
          }),
        }),
      );

      if (effectMode === "http") {
        const recruitmentInvitationCalls = effectCalls.filter(
          (call) => call.kind === "SendInterviewInvitation",
        );

        assert.equal(recruitmentInvitationCalls.length, 1);
        assert.deepEqual(
          recruitmentInvitationCalls.map((call) => call.status),
          [204],
        );
        recordGate(
          "manually drove existing recruitment invitation delivery helper through loopback ACK",
        );
      }

      if (effectMode === "http") {
        const ReturningOutboxRow = Schema.Struct({
          effect_id: Schema.String,
          command_id: Schema.String,
          effect_type: Schema.String,
          ordinal: Schema.Int,
          status: Schema.String,
          attempts: Schema.Int,
          claimed_at: Schema.NullOr(Schema.Union([Schema.String, Schema.Date])),
          last_failure_tag: Schema.NullOr(Schema.String),
          origin: Schema.String,
        });

        type ReturningOutboxRow = typeof ReturningOutboxRow.Type;

        const expectedEffectTypes = [
          "SendApplicantActivationOrConfirmation",
          "CreateAdmissionSubscription",
          "WriteApplicationAudit",
        ] as const;

        const acceptedReturningRegistrations = yield* step(() =>
          pool.query(
            "SELECT command_id,registration_id FROM public.admission_returning_command_receipts ORDER BY command_id",
          ),
        );

        assert.equal(acceptedReturningRegistrations.rows.length, 6);

        const expectedOutboxCount =
          acceptedReturningRegistrations.rows.length * expectedEffectTypes.length;

        const hasExactReturningEffects = (rows: ReadonlyArray<ReturningOutboxRow>) => {
          if (rows.length !== expectedOutboxCount) return false;

          if (rows.some((row) => row.origin !== "ReturningAssistant")) return false;

          return acceptedReturningRegistrations.rows.every(
            ({ command_id }: { command_id: string }) => {
              const commandRows = rows
                .filter((row) => row.command_id === command_id)
                .sort((left, right) => left.ordinal - right.ordinal);

              return (
                commandRows.length === expectedEffectTypes.length &&
                commandRows.map((row) => row.ordinal).join(",") === "0,1,2" &&
                commandRows.map((row) => row.effect_type).join(",") ===
                  expectedEffectTypes.join(",")
              );
            },
          );
        };

        const readReturningOutbox = Effect.fnUntraced(function* () {
          return yield* Schema.decodeUnknownEffect(Schema.Array(ReturningOutboxRow))(
            (yield* step(() =>
              pool.query(
                `SELECT effect_id,command_id,effect_type,ordinal,status,attempts,claimed_at,last_failure_tag,origin
             FROM public.admission_application_outbox
             WHERE origin='ReturningAssistant'
             ORDER BY effect_id`,
              ),
            )).rows,
          );
        });

        const waitForOutbox = Effect.fnUntraced(function* (
          predicate: (rows: ReadonlyArray<ReturningOutboxRow>) => boolean,
        ) {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const rows = yield* readReturningOutbox();

            if (predicate(rows)) return rows;
            yield* Effect.sleep("250 millis");
          }

          return yield* new ProbeFailure({
            message: "returning effect outbox did not reach expected state",
          });
        });

        const failedRows = yield* bounded(
          "returning effect first failure",
          waitForOutbox(
            (rows) =>
              hasExactReturningEffects(rows) &&
              rows.filter((row) => row.ordinal === 0).length ===
                acceptedReturningRegistrations.rows.length &&
              rows.filter((row) => row.ordinal !== 0).length ===
                acceptedReturningRegistrations.rows.length * 2 &&
              rows
                .filter((row) => row.ordinal === 0)
                .every(
                  (row) =>
                    row.status === "Failed" &&
                    row.attempts >= 1 &&
                    row.claimed_at === null &&
                    row.last_failure_tag === "PublicApplicationEffectDeliveryError",
                ) &&
              rows
                .filter((row) => row.ordinal !== 0)
                .every(
                  (row) =>
                    row.status === "Pending" &&
                    row.attempts === 0 &&
                    row.claimed_at === null &&
                    row.last_failure_tag === null,
                ),
          ),
          30_000,
        );

        assert.equal(failedRows.length, expectedOutboxCount);
        assert.ok(hasExactReturningEffects(failedRows));
        assert.equal(failedRows.filter((row) => row.ordinal === 0).length, 6);
        assert.equal(failedRows.filter((row) => row.ordinal !== 0).length, 12);
        assert.ok(
          failedRows.filter((row) => row.ordinal === 0).every((row) => row.status === "Failed"),
        );
        assert.ok(
          failedRows.filter((row) => row.ordinal !== 0).every((row) => row.status === "Pending"),
        );
        const heldFailedRows = yield* readReturningOutbox();
        assert.equal(heldFailedRows.length, expectedOutboxCount);
        assert.ok(hasExactReturningEffects(heldFailedRows));
        assert.ok(
          heldFailedRows
            .filter((row) => row.ordinal === 0)
            .every(
              (row) =>
                row.status === "Failed" &&
                row.attempts >= 1 &&
                row.claimed_at === null &&
                row.last_failure_tag === "PublicApplicationEffectDeliveryError",
            ),
        );
        assert.ok(
          heldFailedRows
            .filter((row) => row.ordinal !== 0)
            .every(
              (row) =>
                row.status === "Pending" &&
                row.attempts === 0 &&
                row.claimed_at === null &&
                row.last_failure_tag === null,
            ),
        );

        const preRestartEffectCalls = effectCalls.filter(
          (call) => call.origin === "ReturningAssistant",
        );

        assert.ok(preRestartEffectCalls.length >= 6);
        assert.ok(preRestartEffectCalls.every((call) => call.status === 503));
        assert.ok(
          preRestartEffectCalls.every(
            (call) => call.kind === "SendApplicantActivationOrConfirmation",
          ),
        );
        const preRestartEffectIds = new Set(preRestartEffectCalls.map((call) => call.effectId));
        assert.ok(
          heldFailedRows
            .filter((row) => row.ordinal === 0)
            .every((row) => preRestartEffectIds.has(row.effect_id)),
          "each failed returning activation effect reached the loopback receiver before restart",
        );
        recordGate(
          `returning notification/subscription/audit loopback failure held until deliberate restart (${acceptedReturningRegistrations.rows.length} registrations × ${expectedEffectTypes.length} effects)`,
        );
        yield* backend.stop;
        releaseEffectDelivery = true;
        backend = yield* start("bun", ["apps/backend/src/main.ts"], env);
        yield* ready(answersOk(`${api}/health`));

        const deliveredRows = yield* bounded(
          "returning effect restart delivery",
          waitForOutbox(
            (rows) =>
              hasExactReturningEffects(rows) && rows.every((row) => row.status === "Delivered"),
          ),
          90_000,
        );

        assert.equal(deliveredRows.length, expectedOutboxCount);
        assert.ok(hasExactReturningEffects(deliveredRows));
        assert.ok(deliveredRows.every((row) => row.status === "Delivered"));
        const expectedEffectsById = new Map(deliveredRows.map((row) => [row.effect_id, row]));

        const returningEffectCalls = effectCalls.filter(
          (call) => call.origin === "ReturningAssistant",
        );

        assert.ok(
          returningEffectCalls.every((call) => {
            const outboxRow = expectedEffectsById.get(call.effectId);

            return (
              outboxRow !== undefined &&
              call.commandId === outboxRow.command_id &&
              call.origin === outboxRow.origin &&
              call.kind === outboxRow.effect_type
            );
          }),
          "effect receiver observed only the immutable expected envelopes",
        );

        for (const outboxRow of deliveredRows) {
          const calls = effectCalls.filter((call) => call.effectId === outboxRow.effect_id);
          const acknowledgements = calls.filter((call) => call.status === 204);
          assert.equal(acknowledgements.length, 1);
          assert.equal(acknowledgements[0]?.commandId, outboxRow.command_id);
          assert.equal(acknowledgements[0]?.origin, outboxRow.origin);
          assert.equal(acknowledgements[0]?.kind, outboxRow.effect_type);

          if (outboxRow.ordinal === 0) {
            assert.ok(
              calls.some((call) => call.status === 503),
              `effect ${outboxRow.effect_id} had a pre-restart failure`,
            );
          }
        }

        yield* fs.writeFileString(
          path.join(artifacts, "returning-effect-evidence.json"),
          yield* indentedJsonText({
            outbox: deliveredRows,
            registrations: acceptedReturningRegistrations.rows,
            calls: effectCalls,
            preRestartCalls: preRestartEffectCalls,
            restart: true,
          }),
        );
        recordGate("returning effect worker restarted and acknowledged all loopback effects");
      }

      const reportEvidence = yield* bounded(
        "0103 report observer",
        observeInterviewReport({
          root,
          pool,
          browser,
          api,
          ui,
          artifacts,
          ordinaryCookie: cookie,
          password,
          secrets,
          correctionMode: false,
          returningPopulated: true,
          revision,
          auditPage,
          recordGate,
        }),
      );

      const observedReturningGates = new Set(
        returningResult.trace
          .values()
          .filter((entry) => entry.phase === "negative-gate")
          .map((entry) => Schema.decodeUnknownSync(Schema.String)(entry.gate))
          .toArray(),
      );

      const reportGates = Array.isArray(reportEvidence?.gates) ? reportEvidence.gates : [];

      const returningFalsifierManifest: Array<{
        falsifier: string;
        gate: string;
        status: "observed" | "missing";
      }> = (
        [
          ["anonymous", "anonymous-options"],
          ["no-history/team-only", "no-placement-despite-affiliation"],
          ["missing-linkedPerson", "missing-applicant-person-link"],
          ["multiple-linkedPerson", "multiple-applicant-person-links"],
          ["ambiguous-study-mapping", "ambiguous-study-mapping-structural-primary-key"],
          ["invalid/inactive-study-mapping", "inactive-study-mapping"],
          ["wrong-team", "cross-department-team"],
          ["closed-period", "closed-period"],
          [
            "retained inactive placement in different historical department/semester",
            "retained-inactive-cross-department-placement",
          ],
          [
            "original-app-receipt-activation-conduct",
            "preserved-original-receipt-activation-conduct",
          ],
          ["new-period-no-new-interview", "new-period-no-new-interview"],
        ] as const
      ).map(([falsifier, gate]) => ({
        falsifier,
        gate,
        status: observedReturningGates.has(gate) ? "observed" : "missing",
      }));

      returningFalsifierManifest.push(
        {
          falsifier: "report-self-privacy/read-only",
          gate: "0103 report observer",
          status: reportGates.some(
            (gate) => Predicate.isString(gate) && gate.includes("no report writes"),
          )
            ? "observed"
            : "missing",
        },
        {
          falsifier: "report-exact-period/classification/filter-reload",
          gate: "0103 report observer",
          status: reportGates.some((gate) => Predicate.isString(gate) && gate.includes("period"))
            ? "observed"
            : "missing",
        },
      );
      yield* fs.writeFileString(
        path.join(artifacts, "returning-targeted-evidence.json"),
        yield* indentedJsonText({
          revision,
          returningStages,
          returningResult,
          returningFalsifierManifest,
          reportEvidence,
        }),
      );
      assert.deepEqual(
        accessibility.filter((result) => result.violations.length > 0),
        [],
        "Returning registration and report accessibility violations retained in accessibility.json",
      );

      return {
        result: "ReturningTargeted",
        report: { journey: { returningStages, reportEvidence } },
      } satisfies Outcome;
    }

    // Each call is the RPC that replaced the route, answered as that route's HTTP response.
    const get = (id: string) =>
      replacedFetch({
        origin: api,
        tag: "recruitment.readInterviewConduct",
        payload: { interviewId: id },
        headers: { cookie, origin: ui },
      });

    const post = (id: string, body: Schema.Json, key: string, etag: string) =>
      replacedFetch({
        origin: api,
        tag: "recruitment.finalizeInterview",
        payload: { interviewId: id, idempotencyKey: key, ifMatch: etag, request: body },
        headers: { cookie, origin: ui },
      });

    const correctPost = (id: string, body: Schema.Json, key: string, etag: string) =>
      replacedFetch({
        origin: api,
        tag: "recruitment.correctInterviewAssessment",
        payload: { interviewId: id, idempotencyKey: key, ifMatch: etag, request: body },
        headers: { cookie, origin: ui },
      });

    const open = Effect.fnUntraced(function* (p: any, name: string) {
      yield* step(() =>
        p
          .getByRole("article")
          .filter({ hasText: name })
          .getByRole("button", { name: "Åpne intervju" })
          .click(),
      );
      yield* step(() => p.getByRole("heading", { name: `Intervju med ${name}` }).waitFor());
    });

    const waitForRecruitmentOperation = (p: any, operation: string) =>
      p.waitForResponse((response: any) => {
        if (
          response.request().method() !== "POST" ||
          new URL(response.url()).pathname !== "/recruitment"
        )
          return false;

        try {
          const payload: unknown = response.request().postDataJSON();

          return (
            (payload === null || Predicate.isObjectOrArray(payload)) &&
            payload !== null &&
            "operation" in payload &&
            payload.operation === operation
          );
        } catch {
          return false;
        }
      });

    const fill = Effect.fnUntraced(function* (p: any) {
      yield* step(() =>
        p
          .locator("#question-interview-schema-native-conduct-0063-q0")
          .fill("Jeg vil forklare matematikk tydelig."),
      );
      yield* step(() => p.locator("#question-interview-schema-native-conduct-0063-q1-1").check());
      yield* step(() => p.locator("#question-interview-schema-native-conduct-0063-q2-0").check());
      yield* step(() => p.locator("#question-interview-schema-native-conduct-0063-q3-0").check());

      for (const axis of ["explanatoryPower", "roleModel", "suitability"])
        yield* step(() => p.locator(`#score-${axis}`).selectOption("8"));
    });

    if (process.argv.includes("--correction-mode")) {
      const correctionId = "interview-recommendation-history";
      const correctionName = "history Recommendation";
      const correctionStages: string[] = [];
      const stage = (name: string) => correctionStages.push(name);

      const operationFor = (request: any): string | undefined => {
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment")
          return undefined;

        try {
          const payload: unknown = request.postDataJSON();

          return (payload === null || Predicate.isObjectOrArray(payload)) &&
            payload !== null &&
            "operation" in payload &&
            Predicate.isString(payload.operation)
            ? payload.operation
            : undefined;
        } catch {
          return undefined;
        }
      };

      const responseFor = (operation: string) =>
        page.waitForResponse((response: any) => operationFor(response.request()) === operation);

      const correctionPageOpen = Effect.fnUntraced(function* () {
        yield* step(() =>
          page
            .getByRole("article")
            .filter({ hasText: correctionName })
            .getByRole("button", { name: "Åpne intervju", exact: true })
            .click(),
        );
        yield* step(() =>
          page.getByRole("heading", { name: `Intervju med ${correctionName}` }).waitFor(),
        );
      });

      const saveCorrection = Effect.fnUntraced(function* (
        recommendation: "Ja" | "Kanskje" | "Nei",
      ) {
        yield* fill(page);
        yield* step(() => page.locator("#interviewer-recommendation").selectOption(recommendation));
        yield* step(() => page.locator("#score-explanatoryPower").selectOption("4"));
        yield* step(() => page.locator("#score-roleModel").selectOption("5"));
        yield* step(() => page.locator("#score-suitability").selectOption("6"));
        yield* step(() => page.getByRole("button", { name: "Rett intervju", exact: true }).click());
        yield* step(() => page.getByRole("dialog").waitFor({ state: "visible" }));
        const responsePromise = responseFor("correctInterviewAssessment");
        yield* step(() =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Rett intervju", exact: true })
            .press("Enter"),
        );
        const response = yield* step(() => responsePromise);

        if (response.ok() !== true)
          throw new Error(
            `correction response ${response.status()}: ${yield* step(() => response.text())}`,
          );
        yield* step(() =>
          page.locator("#interviewer-recommendation").waitFor({ state: "visible" }),
        );
        assert.equal(
          yield* step(() => page.locator("#interviewer-recommendation").inputValue()),
          recommendation,
        );
      });

      const before = yield* step(() => get(correctionId));
      assert.equal(before.status, 200);
      const beforeBody = yield* step(() => before.json());

      const originalConductSql = (yield* step(() =>
        pool.query(
          `SELECT to_jsonb(c) AS value
           FROM public.recruitment_interview_conducts c
           WHERE interview_id=$1`,
          [correctionId],
        ),
      )).rows[0].value;

      assert.equal(beforeBody.completionState, "Completed");
      assert.equal(beforeBody.history[0]?._tag, "Original");
      assert.equal(beforeBody.history[0]?.recommendation, null);
      stage("historical-null completed detail opens");
      yield* correctionPageOpen();
      yield* saveCorrection("Ja");
      stage("browser keyboard correction saves and refreshes detail");
      const afterFirst = yield* step(() => get(correctionId).then((response) => response.json()));
      assert.equal(afterFirst.recommendation, "Ja");
      assert.deepEqual(afterFirst.answers, [
        {
          questionId: "interview-schema-native-conduct-0063-q0",
          answer: "Jeg vil forklare matematikk tydelig.",
        },
        { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
        { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
        {
          questionId: "interview-schema-native-conduct-0063-q3",
          answer: ["Samarbeid"],
        },
      ]);
      assert.deepEqual(afterFirst.score, {
        explanatoryPower: 4,
        roleModel: 5,
        suitability: 6,
      });
      assert.equal(afterFirst.finalizedByPersonId, beforeBody.finalizedByPersonId);
      assert.equal(afterFirst.finalizedAt, beforeBody.finalizedAt);
      assert.deepEqual(afterFirst.history[0], beforeBody.history[0]);
      yield* step(() => page.reload());
      yield* correctionPageOpen();
      assert.equal(
        yield* step(() => page.locator("#interviewer-recommendation").inputValue()),
        "Ja",
      );
      const staleCorrectionEtag = (yield* step(() => get(correctionId))).headers.get("etag")!;

      const staleStorageState = yield* step(() => context.storageState());

      const staleCorrectionContext = yield* step(() =>
        browser.newContext({
          storageState: staleStorageState,
        }),
      );

      const staleCorrection = yield* step(() => staleCorrectionContext.newPage());
      staleCorrection.on("pageerror", () => errors.push("stale-correction-pageerror"));
      yield* step(() => staleCorrection.goto(`${ui}/dashboard/intervjuer`));
      yield* step(() =>
        staleCorrection
          .getByRole("article")
          .filter({ hasText: correctionName })
          .getByRole("button", { name: "Åpne intervju", exact: true })
          .click(),
      );
      yield* step(() =>
        staleCorrection.getByRole("heading", { name: `Intervju med ${correctionName}` }).waitFor(),
      );
      yield* step(() =>
        staleCorrection
          .locator("#question-interview-schema-native-conduct-0063-q0")
          .fill("Stale correction draft."),
      );
      yield* step(() =>
        staleCorrection.locator("#interviewer-recommendation").selectOption("Kanskje"),
      );
      yield* step(() => staleCorrection.locator("#score-explanatoryPower").selectOption("7"));
      yield* step(() =>
        page
          .locator("#question-interview-schema-native-conduct-0063-q0")
          .fill("Et nytt tydelig svar."),
      );
      yield* step(() => page.locator("#score-explanatoryPower").selectOption("9"));
      yield* step(() => page.locator("#interviewer-recommendation").selectOption("Nei"));

      type CorrectionAttempt = {
        readonly phase: "failed-save" | "retry";
        readonly payload: unknown;
        readonly ifMatch: string | undefined;
        readonly idempotencyKey: string | undefined;
        readonly fetchedStatus: number;
      };

      const correctionAttempts: CorrectionAttempt[] = [];
      // The route handler below settles these; the journey awaits them as steps.
      const failedSaveSettled = Promise.withResolvers<void>();
      const correctionRetrySettled = Promise.withResolvers<void>();

      const correctionRoute = (route: any): Promise<void> => {
        const request = route.request();

        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment")
          return route.continue();

        let payload: unknown;

        try {
          payload = request.postDataJSON();
        } catch {
          return route.continue();
        }

        if (
          payload === null ||
          !(payload === null || Predicate.isObjectOrArray(payload)) ||
          !("operation" in payload) ||
          payload.operation !== "correctInterviewAssessment"
        )
          return route.continue();

        const headersValue = "headers" in payload ? payload.headers : undefined;

        const operationHeaders =
          (headersValue === null || Predicate.isObjectOrArray(headersValue)) &&
          headersValue !== null
            ? headersValue
            : {};

        const ifMatch =
          "if-match" in operationHeaders && Predicate.isString(operationHeaders["if-match"])
            ? operationHeaders["if-match"]
            : undefined;

        const idempotencyKey =
          "idempotency-key" in operationHeaders &&
          Predicate.isString(operationHeaders["idempotency-key"])
            ? operationHeaders["idempotency-key"]
            : undefined;

        const phase: CorrectionAttempt["phase"] =
          correctionAttempts.length === 0 ? "failed-save" : "retry";

        return route
          .fetch({ timeout: 30_000 })
          .then((response: any) => {
            correctionAttempts.push({
              phase,
              payload,
              ifMatch,
              idempotencyKey,
              fetchedStatus: response.status(),
            });

            if (phase === "failed-save")
              return response
                .body()
                .then(() => route.abort("failed"))
                .then(() => failedSaveSettled.resolve());

            return route.fulfill({ response }).then(() => correctionRetrySettled.resolve());
          })
          .catch((cause: unknown) =>
            (phase === "failed-save" ? failedSaveSettled : correctionRetrySettled).reject(cause),
          );
      };

      const rowsBeforeFailedSave = (yield* step(() =>
        pool.query(
          `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      assert.deepEqual(
        rowsBeforeFailedSave.map((row: any) => row.resulting_revision),
        [2],
      );
      yield* step(() => page.route("**/recruitment", correctionRoute));
      yield* step(() =>
        page.getByRole("button", { name: "Rett intervju", exact: true }).last().click(),
      );
      yield* step(() => page.getByRole("dialog").waitFor({ state: "visible" }));
      yield* step(() =>
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Rett intervju", exact: true })
          .press("Enter"),
      );
      yield* step(() => failedSaveSettled.promise);
      yield* step(() => page.locator("#interviewer-recommendation").waitFor({ state: "visible" }));
      assert.equal(
        yield* step(() => page.locator("#interviewer-recommendation").inputValue()),
        "Nei",
      );
      assert.equal(yield* step(() => page.locator("#score-explanatoryPower").inputValue()), "9");

      const rowsBeforeRetry = (yield* step(() =>
        pool.query(
          `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      assert.deepEqual(
        rowsBeforeRetry.map((row: any) => row.resulting_revision),
        [...rowsBeforeFailedSave.map((row: any) => row.resulting_revision), 3],
      );
      yield* step(() =>
        page.getByRole("button", { name: "Rett intervju", exact: true }).last().click(),
      );
      yield* step(() => page.getByRole("dialog").waitFor({ state: "visible" }));
      yield* step(() =>
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Rett intervju", exact: true })
          .press("Enter"),
      );
      yield* step(() => correctionRetrySettled.promise);
      assert.equal(correctionAttempts.length, 2);
      assert.deepEqual(correctionAttempts[1], {
        ...correctionAttempts[0],
        phase: "retry",
      });
      assert.equal(correctionAttempts[0]!.fetchedStatus, 200);
      yield* step(() => page.locator("#interviewer-recommendation").waitFor({ state: "visible" }));
      yield* step(() => page.unroute("**/recruitment", correctionRoute));
      yield* step(() => page.reload());
      yield* correctionPageOpen();
      assert.equal(
        yield* step(() => page.locator("#interviewer-recommendation").inputValue()),
        "Nei",
      );

      const browserHistory: any[] = (yield* step(() =>
        get(correctionId).then((response) => response.json()),
      )).history;

      assert.deepEqual(
        browserHistory.map((entry) => [entry._tag, entry.revision]),
        [
          ["Original", 1],
          ["Correction", 2],
          ["Correction", 3],
        ],
      );

      const formatUiInstant = (instant: string): string =>
        new Intl.DateTimeFormat("nb-NO", { dateStyle: "long", timeStyle: "short" }).format(
          DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
        );

      const historyView = page.locator(".fs-history");
      yield* step(() => historyView.waitFor());
      const historyText = () => historyView.textContent();
      assert.match((yield* step(() => historyText())) ?? "", /Original vurdering, versjon 1/u);
      assert.match((yield* step(() => historyText())) ?? "", /Korrigering, versjon 2/u);
      assert.match((yield* step(() => historyText())) ?? "", /Korrigering, versjon 3/u);
      assert.match((yield* step(() => historyText())) ?? "", /journey-conduct-leader-0063/u);

      const completionText =
        (yield* step(() => page.locator(".fs-conduct__completion").textContent())) ?? "";

      assert.match(completionText, /Fullført/u);
      assert.match(completionText, /journey-conduct-leader-0063/u);
      assert.match(completionText, new RegExp(formatUiInstant(beforeBody.finalizedAt), "u"));
      assert.match((yield* step(() => historyText())) ?? "", /Svar/u);
      assert.match((yield* step(() => historyText())) ?? "", /Et nytt tydelig svar/u);
      assert.match((yield* step(() => historyText())) ?? "", /Forklaringskraft7/u);
      assert.match((yield* step(() => historyText())) ?? "", /Rollemodell8/u);
      assert.match((yield* step(() => historyText())) ?? "", /Egnethet9/u);
      assert.match((yield* step(() => historyText())) ?? "", /Ja/u);
      assert.match((yield* step(() => historyText())) ?? "", /Nei/u);
      assert.match(
        (yield* step(() => historyText())) ?? "",
        new RegExp(formatUiInstant(browserHistory[0].finalizedAt), "u"),
      );
      assert.match(
        (yield* step(() => historyText())) ?? "",
        new RegExp(formatUiInstant(browserHistory[1].correctedAt), "u"),
      );
      assert.match(
        (yield* step(() => historyText())) ?? "",
        new RegExp(formatUiInstant(browserHistory[2].correctedAt), "u"),
      );
      const originalEntry = browserHistory[0];
      assert.deepEqual(originalEntry, beforeBody.history[0]);
      const originalView = historyView.locator(".fs-history__entry").nth(0);
      const originalText = (yield* step(() => originalView.textContent())) ?? "";
      assert.match(originalText, /Original vurdering, versjon 1/u);
      assert.match(originalText, new RegExp(formatUiInstant(originalEntry.finalizedAt), "u"));
      assert.match(originalText, new RegExp(originalEntry.finalizedByPersonId, "u"));

      for (const [label, value] of [
        ["Forklaringskraft", originalEntry.score.explanatoryPower],
        ["Rollemodell", originalEntry.score.roleModel],
        ["Egnethet", originalEntry.score.suitability],
      ] as const) {
        assert.match(originalText, new RegExp(`${label}${value}`, "u"));
      }

      assert.match(originalText, /AnbefalingIkke registrert/u);
      const originalAnswerNodes = originalView.locator(".fs-history__answer");
      assert.equal(
        yield* step(() => originalAnswerNodes.count()),
        Math.max(1, originalEntry.answers.length),
      );

      if (originalEntry.answers.length === 0) {
        assert.match(originalText, /Ingen svar registrert/u);
      } else {
        for (const answer of originalEntry.answers) {
          const question = beforeBody.questions.find(
            (candidate: any) => candidate.questionId === answer.questionId,
          );

          const renderedAnswer = Array.isArray(answer.answer)
            ? answer.answer.join(", ")
            : answer.answer;

          assert.match(
            originalText,
            new RegExp(`${question?.prompt ?? answer.questionId}: ${renderedAnswer}`, "u"),
          );
        }
      }

      assert.equal(
        yield* step(() => historyView.locator("input,textarea,select,button").count()),
        0,
      );
      yield* step(() => page.locator("#interviewer-recommendation").focus());
      assert.equal(
        yield* step(() =>
          page
            .locator("#interviewer-recommendation")
            .evaluate(
              (element: HTMLSelectElement) => element.ownerDocument.activeElement === element,
            ),
        ),
        true,
      );
      yield* step(() =>
        page
          .locator(".fs-conduct")
          .screenshot({ path: path.join(artifacts, "correction-history-desktop.png") }),
      );
      yield* auditPage(page, "correction-history-desktop");
      yield* step(() => page.setViewportSize({ width: 390, height: 844 }));
      assert.ok(
        (yield* step(() =>
          page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth),
        )) <= 390,
      );
      yield* step(() =>
        page
          .locator(".fs-conduct")
          .screenshot({ path: path.join(artifacts, "correction-history-mobile.png") }),
      );
      yield* auditPage(page, "correction-history-mobile");
      yield* step(() => page.setViewportSize({ width: 1280, height: 900 }));
      stage(
        "browser ordered original and correction history shows completion metadata after reload with keyboard/mobile/Axe evidence",
      );

      const staleCorrectionResponsePromise = staleCorrection.waitForResponse(
        (response: any) => operationFor(response.request()) === "correctInterviewAssessment",
      );

      yield* step(() =>
        staleCorrection.getByRole("button", { name: "Rett intervju", exact: true }).click(),
      );
      yield* step(() => staleCorrection.getByRole("dialog").waitFor({ state: "visible" }));
      yield* step(() =>
        staleCorrection
          .getByRole("dialog")
          .getByRole("button", { name: "Rett intervju", exact: true })
          .press("Enter"),
      );
      const staleCorrectionResponse = yield* step(() => staleCorrectionResponsePromise);
      assert.equal(staleCorrectionResponse.status(), 409);
      const staleCorrectionRequest = staleCorrectionResponse.request();
      assert.equal(new URL(staleCorrectionRequest.url()).pathname, "/recruitment");
      const staleCorrectionRequestBody = staleCorrectionRequest.postDataJSON();
      assert.equal(staleCorrectionRequestBody.operation, "correctInterviewAssessment");
      assert.equal(staleCorrectionRequestBody.payload.expectedRevision, 2);
      assert.equal(staleCorrectionRequestBody.headers["if-match"], staleCorrectionEtag);
      assert.match(staleCorrectionRequestBody.headers["idempotency-key"] ?? "", /^[a-z0-9-]+$/);
      yield* step(() =>
        staleCorrection
          .getByText(
            "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
            { exact: true },
          )
          .waitFor(),
      );
      assert.equal(
        yield* step(() =>
          staleCorrection.locator("#question-interview-schema-native-conduct-0063-q0").inputValue(),
        ),
        "Stale correction draft.",
      );
      assert.equal(
        yield* step(() => staleCorrection.locator("#interviewer-recommendation").inputValue()),
        "Kanskje",
      );

      const staleRowsAfterConflict = (yield* step(() =>
        pool.query(
          `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      assert.deepEqual(
        staleRowsAfterConflict.map((row: any) => row.resulting_revision),
        [2, 3],
      );
      yield* step(() => staleCorrection.close());
      yield* step(() => staleCorrectionContext.close());
      stage("stale correction rejects old base and preserves visible draft without persistence");
      stage(
        "lost correction response retries identical payload, base and idempotency key without duplicate persistence",
      );
      stage("second correction and reload preserve ordered history");
      const afterSecond = yield* step(() => get(correctionId).then((response) => response.json()));
      assert.ok(
        afterSecond.history.filter((entry: any) => Predicate.isTagged(entry, "Correction"))
          .length >= 2,
      );
      const afterSecondEtag = (yield* step(() => get(correctionId))).headers.get("etag");
      assert.deepEqual(afterSecond.answers, [
        { questionId: "interview-schema-native-conduct-0063-q0", answer: "Et nytt tydelig svar." },
        { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
        { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
        {
          questionId: "interview-schema-native-conduct-0063-q3",
          answer: ["Samarbeid"],
        },
      ]);
      assert.deepEqual(afterSecond.score, { explanatoryPower: 9, roleModel: 5, suitability: 6 });

      const secondCorrections = afterSecond.history.filter((entry: any) =>
        Predicate.isTagged(entry, "Correction"),
      );

      assert.equal(secondCorrections.length, 2);
      assert.deepEqual(
        secondCorrections.map((entry: any) => [entry.predecessorRevision, entry.revision]),
        [
          [1, 2],
          [2, 3],
        ],
      );
      assert.ok(
        secondCorrections.every(
          (entry: any) =>
            entry.correctedByPersonId === "journey-conduct-leader-0063" &&
            Predicate.isString(entry.correctedAt) &&
            Predicate.isString(entry.commandId),
        ),
      );

      const originalConductAfterSql = (yield* step(() =>
        pool.query(
          `SELECT to_jsonb(c) AS value
           FROM public.recruitment_interview_conducts c
           WHERE interview_id=$1`,
          [correctionId],
        ),
      )).rows[0].value;

      assert.deepEqual(originalConductAfterSql, originalConductSql);

      const correctionRows = (yield* step(() =>
        pool.query(
          `SELECT predecessor_revision AS "predecessorRevision",
                  resulting_revision AS "resultingRevision",
                  answers, explanatory_power AS "explanatoryPower",
                  role_model AS "roleModel", suitability, recommendation,
                  corrected_by_person_id AS "correctedByPersonId",
                  command_id AS "commandId"
           FROM public.recruitment_interview_correction_assessments
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      assert.equal(correctionRows.length, 2);
      assert.deepEqual(
        correctionRows.map((row: any) => [row.predecessorRevision, row.resultingRevision]),
        [
          [1, 2],
          [2, 3],
        ],
      );
      assert.ok(
        correctionRows.every(
          (row: any) =>
            row.correctedByPersonId === "journey-conduct-leader-0063" &&
            Predicate.isString(row.commandId),
        ),
      );

      const receiptRows = (yield* step(() =>
        pool.query(
          `SELECT command_id AS "commandId", predecessor_revision AS "predecessorRevision",
                  resulting_revision AS "resultingRevision", command_json AS "commandJson",
                  observation_json AS "observationJson"
           FROM public.recruitment_interview_correction_command_receipts
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      const auditRows = (yield* step(() =>
        pool.query(
          `SELECT command_id AS "commandId", actor_person_id AS "actorPersonId",
                  predecessor_revision AS "predecessorRevision",
                  resulting_revision AS "resultingRevision"
           FROM public.recruitment_interview_correction_audit
           WHERE interview_id=$1 ORDER BY resulting_revision`,
          [correctionId],
        ),
      )).rows;

      assert.equal(receiptRows.length, 2);
      assert.equal(auditRows.length, 2);
      assert.deepEqual(
        receiptRows.map((row: any) => [
          row.commandId,
          row.predecessorRevision,
          row.resultingRevision,
        ]),
        correctionRows.map((row: any) => [
          row.commandId,
          row.predecessorRevision,
          row.resultingRevision,
        ]),
      );
      assert.ok(
        receiptRows.every(
          (row: any) =>
            (row.commandJson === null || Predicate.isObjectOrArray(row.commandJson)) &&
            row.commandJson !== null &&
            (row.observationJson === null || Predicate.isObjectOrArray(row.observationJson)) &&
            row.observationJson !== null,
        ),
      );
      assert.deepEqual(
        auditRows.map((row: any) => [
          row.commandId,
          row.actorPersonId,
          row.predecessorRevision,
          row.resultingRevision,
        ]),
        correctionRows.map((row: any) => [
          row.commandId,
          "journey-conduct-leader-0063",
          row.predecessorRevision,
          row.resultingRevision,
        ]),
      );
      stage("SQL original conduct immutability and correction chain receipt audit linkage");
      assert.ok(afterSecondEtag);

      const writeCount = Effect.fnUntraced(function* () {
        return (yield* step(() =>
          pool.query(
            `SELECT
               (SELECT count(*) FROM public.recruitment_interview_correction_assessments WHERE interview_id=$1) AS assessments,
               (SELECT count(*) FROM public.recruitment_interview_correction_command_receipts WHERE interview_id=$1) AS receipts,
               (SELECT count(*) FROM public.recruitment_interview_correction_audit WHERE interview_id=$1) AS audit,
               (SELECT revision FROM public.recruitment_interviews WHERE interview_id=$1) AS revision`,
            [correctionId],
          ),
        )).rows[0];
      });

      const beforeMismatch = yield* writeCount();

      const mismatched = yield* step(() =>
        correctPost(
          correctionId,
          {
            expectedRevision: afterFirst.revision,
            answers: afterFirst.answers,
            score: afterFirst.score,
            recommendation: afterFirst.recommendation,
          },
          "correction-old-body-new-header-0105",
          afterSecondEtag!,
        ),
      );

      assert.equal(mismatched.status, 412);
      assert.deepEqual(yield* writeCount(), beforeMismatch);
      stage(
        "old displayed body with newer opaque ETag rejects at correction boundary without writes",
      );

      const correctionPayload = (detail: any, recommendation: "Ja" | "Kanskje" | "Nei") => ({
        expectedRevision: detail.revision,
        answers: [
          {
            questionId: "interview-schema-native-conduct-0063-q0",
            answer: "API correction answer",
          },
          { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
          { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
          { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
        ],
        score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
        recommendation,
      });

      const firstDirectDetail = yield* step(() =>
        get(correctionId).then((response) => response.json()),
      );

      const firstDirectEtag = (yield* step(() => get(correctionId))).headers.get("etag")!;
      const firstDirectPayload = correctionPayload(firstDirectDetail, "Kanskje");

      const firstDirect = yield* step(() =>
        correctPost(correctionId, firstDirectPayload, "correction-replay-0105-a", firstDirectEtag),
      );

      if (firstDirect.status !== 200) {
        throw new Error(
          `first direct correction ${firstDirect.status}: ${yield* step(() => firstDirect.text())}`,
        );
      }

      const acceptedCorrectionRequest = {
        rawKey: "correction-replay-0105-a",
        originalIfMatch: firstDirectEtag,
        exactFourFieldPayload: firstDirectPayload,
      };

      acceptedCorrectionReplay = {
        key: acceptedCorrectionRequest.rawKey,
        etag: acceptedCorrectionRequest.originalIfMatch,
        payload: acceptedCorrectionRequest.exactFourFieldPayload,
      };
      const firstBytes = yield* step(() => firstDirect.text());

      const secondDirectDetail = yield* step(() =>
        get(correctionId).then((response) => response.json()),
      );

      const secondDirectEtag = (yield* step(() => get(correctionId))).headers.get("etag")!;

      const secondDirect = yield* step(() =>
        correctPost(
          correctionId,
          correctionPayload(secondDirectDetail, "Nei"),
          "correction-replay-0105-b",
          secondDirectEtag,
        ),
      );

      assert.equal(secondDirect.status, 200);

      const replay = yield* step(() =>
        correctPost(
          correctionId,
          acceptedCorrectionRequest.exactFourFieldPayload,
          acceptedCorrectionRequest.rawKey,
          acceptedCorrectionRequest.originalIfMatch,
        ),
      );

      assert.equal(replay.status, 200);
      assert.equal(yield* step(() => replay.text()), firstBytes);
      stage("exact correction replay remains byte-stable after later correction");
      const raceDetail = yield* step(() => get(correctionId).then((response) => response.json()));
      const raceEtag = (yield* step(() => get(correctionId))).headers.get("etag")!;
      const beforeRaceWrites = yield* writeCount();

      const race = yield* step(() =>
        Promise.all(
          ["correction-race-0105-a", "correction-race-0105-b"].map((key, index) =>
            correctPost(
              correctionId,
              correctionPayload(raceDetail, index === 0 ? "Ja" : "Kanskje"),
              key,
              raceEtag,
            ),
          ),
        ),
      );

      assert.equal(race.filter((response) => response.status === 200).length, 1);
      assert.equal(race.filter((response) => response.status !== 200).length, 1);
      assert.ok(race.every((response) => [200, 409, 412].includes(response.status)));
      const winningRaceIndex = race.findIndex((response) => response.status === 200);
      expectedHistoricalReportRecommendation = winningRaceIndex === 0 ? "Ja" : "Kanskje";
      const afterRaceWrites = yield* writeCount();
      assert.equal(Number(afterRaceWrites.assessments), Number(beforeRaceWrites.assessments) + 1);
      assert.equal(Number(afterRaceWrites.receipts), Number(beforeRaceWrites.receipts) + 1);
      assert.equal(Number(afterRaceWrites.audit), Number(beforeRaceWrites.audit) + 1);
      assert.equal(Number(afterRaceWrites.revision), Number(beforeRaceWrites.revision) + 1);
      stage("same-revision concurrent corrections have one winner and one no-write loser");
      const finalDetail = yield* step(() => get(correctionId).then((response) => response.json()));
      assert.equal(finalDetail.history[0]?.recommendation, null);
      assert.equal(finalDetail.finalizedByPersonId, beforeBody.finalizedByPersonId);
      assert.equal(finalDetail.finalizedAt, beforeBody.finalizedAt);
      assert.equal(finalDetail.effectiveRevision, 6);
      assert.equal(finalDetail.revision, 6);
      assert.equal(
        finalDetail.history.filter((entry: any) => Predicate.isTagged(entry, "Correction")).length,
        5,
      );
      assert.ok(finalDetail.canFinalize === false && finalDetail.canCancel === false);
      assert.deepEqual(yield* effectSnapshot(), effectsBefore);
      stage("corrections create no notification or application effects");
      yield* step(() =>
        pool.query(
          `UPDATE public.organization_memberships SET is_suspended=true WHERE membership_id='membership-native-conduct-leader-0063'`,
        ),
      );
      assert.equal((yield* step(() => get(correctionId))).status, 403);
      assert.equal(
        (yield* step(() =>
          correctPost(
            correctionId,
            acceptedCorrectionRequest.exactFourFieldPayload,
            acceptedCorrectionRequest.rawKey,
            acceptedCorrectionRequest.originalIfMatch,
          ),
        )).status,
        403,
      );
      yield* step(() =>
        pool.query(
          `UPDATE public.organization_memberships SET is_suspended=false WHERE membership_id='membership-native-conduct-leader-0063'`,
        ),
      );
      yield* step(() =>
        pool.query(
          `UPDATE public.recruitment_interviews SET interviewer_person_id='recommendation-other-0101' WHERE interview_id=$1`,
          [correctionId],
        ),
      );
      assert.equal((yield* step(() => get(correctionId))).status, 403);
      assert.equal(
        (yield* step(() =>
          correctPost(
            correctionId,
            acceptedCorrectionRequest.exactFourFieldPayload,
            acceptedCorrectionRequest.rawKey,
            acceptedCorrectionRequest.originalIfMatch,
          ),
        )).status,
        403,
      );
      yield* step(() =>
        pool.query(
          `UPDATE public.recruitment_interviews SET interviewer_person_id='journey-conduct-leader-0063' WHERE interview_id=$1`,
          [correctionId],
        ),
      );
      stage("authority revocation denies correction detail and replay before receipt reuse");
      yield* step(() =>
        pool.query(
          `UPDATE public.organization_memberships SET end_at=date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC') - interval '24 hours' WHERE membership_id='membership-native-conduct-leader-0063'`,
        ),
      );
      assert.equal((yield* step(() => get(correctionId))).status, 403);
      assert.equal(
        (yield* step(() =>
          correctPost(
            correctionId,
            acceptedCorrectionRequest.exactFourFieldPayload,
            acceptedCorrectionRequest.rawKey,
            acceptedCorrectionRequest.originalIfMatch,
          ),
        )).status,
        403,
      );
      yield* step(() =>
        pool.query(
          `UPDATE public.organization_memberships SET end_at=NULL WHERE membership_id='membership-native-conduct-leader-0063'`,
        ),
      );
      stage("ended membership denies correction detail and replay");
      const rollbackBefore = yield* writeCount();
      yield* step(() =>
        pool.query(`
        CREATE OR REPLACE FUNCTION public.test_correction_audit_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'synthetic correction audit failure';
        END;
        $$;
        DROP TRIGGER IF EXISTS test_correction_audit_failure
          ON public.recruitment_interview_correction_audit;
        CREATE TRIGGER test_correction_audit_failure
          AFTER INSERT ON public.recruitment_interview_correction_audit
          FOR EACH ROW EXECUTE FUNCTION public.test_correction_audit_failure();
      `),
      );
      const rollbackEtag = (yield* step(() => get(correctionId))).headers.get("etag")!;

      const rollbackResponse = yield* step(() =>
        correctPost(
          correctionId,
          correctionPayload(finalDetail, "Ja"),
          "correction-rollback-0105",
          rollbackEtag,
        ),
      );

      assert.ok([500, 503].includes(rollbackResponse.status));
      assert.deepEqual(yield* writeCount(), rollbackBefore);
      yield* step(() =>
        pool.query(`
        DROP TRIGGER test_correction_audit_failure
          ON public.recruitment_interview_correction_audit;
        DROP FUNCTION public.test_correction_audit_failure();
      `),
      );
      stage(
        "synthetic audit failure rolls back correction assessment, aggregate, receipt and audit",
      );
      yield* assertInterviewCorrectionIntegrity({ pool, interviewId: correctionId });
      recordGate(
        "direct SQL correction integrity rejects immutable mutations, invalid predecessor, aggregate mismatch, and cross-command receipt/audit tuples without writes",
      );
      yield* fs.writeFileString(
        path.join(artifacts, "correction-targeted-evidence.json"),
        yield* indentedJsonText({
          revision,
          correctionStages,
          beforeBody,
          afterFirst,
          afterSecond,
          finalDetail,
          failedSaveRetry: correctionAttempts,
        }),
      );
      yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));
    }

    yield* open(page, "Sofie Gjennomfører");
    yield* fill(page);
    assert.equal(yield* step(() => page.locator("#interviewer-recommendation").inputValue()), "");
    yield* step(() =>
      page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "editable-desktop.png") }),
    );
    yield* auditPage(page, "editable-desktop");
    yield* step(() => page.setViewportSize({ width: 390, height: 844 }));
    assert.ok(
      (yield* step(() =>
        page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth),
      )) <= page.viewportSize().width,
    );
    yield* step(() =>
      page.locator(".fs-conduct").screenshot({ path: path.join(artifacts, "editable-mobile.png") }),
    );
    yield* auditPage(page, "editable-mobile");

    // Viewport observations preserve fixed chrome; tall element captures can stitch it
    // across fields that are visible when the actual viewport is scrolled.
    for (const [selector, name] of [
      ["#question-interview-schema-native-conduct-0063-q0", "editable-mobile-answer-viewport"],
      ["#interviewer-recommendation", "editable-mobile-recommendation-viewport"],
    ] as const) {
      yield* step(() =>
        page
          .locator(selector)
          .evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" })),
      );
      yield* step(() => page.locator(selector).focus());
      yield* step(() => page.screenshot({ path: path.join(artifacts, `${name}.png`) }));
    }

    yield* step(() => page.setViewportSize({ width: 1280, height: 900 }));
    yield* step(() => page.getByRole("button", { name: "Fullfør intervju", exact: true }).click());
    yield* step(() =>
      page
        .getByText("Svar på alle spørsmål, velg alle tre scorer og en anbefaling.", { exact: true })
        .waitFor(),
    );
    assert.equal(yield* step(() => page.locator("#score-suitability").inputValue()), "8");
    yield* step(() => page.locator("#interviewer-recommendation").focus());
    yield* step(() => page.keyboard.press("Home"));
    yield* step(() => page.keyboard.press("ArrowDown"));
    yield* step(() => page.keyboard.press("Enter"));
    assert.equal(yield* step(() => page.locator("#interviewer-recommendation").inputValue()), "Ja");
    const finalResponsePromise = waitForRecruitmentOperation(page, "finalizeInterview");
    yield* step(() => page.getByRole("button", { name: "Fullfør intervju", exact: true }).click());
    yield* step(() => page.getByRole("dialog").waitFor());
    yield* step(() => page.screenshot({ path: path.join(artifacts, "confirmation.png") }));
    yield* auditPage(page, "confirmation");
    const finalResponse = finalResponsePromise;
    yield* step(() =>
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Fullfør intervju", exact: true })
        .press("Enter"),
    );
    assert.equal((yield* step(() => finalResponse)).status(), 200);
    yield* step(() => page.getByText("Intervjuet er fullført.", { exact: true }).waitFor());
    yield* step(() => page.reload());
    yield* open(page, "Sofie Gjennomfører");
    assert.equal(yield* step(() => page.locator("#interviewer-recommendation").inputValue()), "Ja");
    yield* step(() =>
      page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "recommendation-desktop.png") }),
    );
    yield* auditPage(page, "finalized-desktop");
    yield* step(() => page.setViewportSize({ width: 390, height: 844 }));
    assert.ok(
      (yield* step(() =>
        page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth),
      )) <= page.viewportSize().width,
    );
    yield* step(() =>
      page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "recommendation-mobile.png") }),
    );
    yield* auditPage(page, "finalized-mobile");
    yield* step(() => page.setViewportSize({ width: 1280, height: 900 }));
    recordGate(
      "ordinary assigned member: required choice, keyboard finalization, reload and exact stale-correction conflict retention",
    );

    const answers = [
      { questionId: "interview-schema-native-conduct-0063-q0", answer: "Et tydelig svar" },
      { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
      { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
      { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
    ];

    const payload = { answers, score: { explanatoryPower: 7, roleModel: 8, suitability: 9 } };

    const id = "interview-recommendation-maybe",
      initial = yield* step(() => get(id));

    assert.equal(initial.status, 200);
    const etag = initial.headers.get("etag")!;

    const lifecycleSnapshot = Effect.fnUntraced(function* () {
      return yield* jsonText(
        (yield* step(() =>
          pool.query(
            `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.interview_id) FROM public.recruitment_interview_conducts c) conducts,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.command_id) FROM public.recruitment_interview_lifecycle_command_receipts r) receipts,(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.command_id) FROM public.recruitment_interview_lifecycle_audit a) audit,(SELECT jsonb_agg(to_jsonb(h) ORDER BY to_jsonb(h)::text) FROM public.native_http_idempotency_receipts h) native_receipts`,
          ),
        )).rows[0],
      );
    });

    const before = yield* lifecycleSnapshot();

    const decodeDieCause = Schema.decodeOption(
      Schema.fromJsonString(Schema.Tuple([Schema.TaggedStruct("Die", {})])),
    );

    // A recommendation outside its schema fails in the RPC server before the handler, as a defect
    // (500) whose cause is a Die, where the HTTP route answered validation.failed (422).
    for (const [i, value] of [undefined, null, "invalid", 9].entries()) {
      const body = value === undefined ? payload : { ...payload, recommendation: value };

      const refused = yield* step(() =>
        post(
          id,
          body,
          [fixtureKeys.invalid0, fixtureKeys.invalid1, fixtureKeys.invalid2, fixtureKeys.invalid3][
            i
          ]!,
          etag,
        ),
      );

      const refusal = yield* step(() => refused.text());

      assert.equal(refused.status, 500, refusal);

      assert.ok(Option.isSome(decodeDieCause(refusal)), refusal);
    }

    assert.equal(yield* lifecycleSnapshot(), before);

    const first = yield* step(() =>
      post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag),
    );

    assert.equal(first.status, 200);
    const bytes = yield* step(() => first.text());
    assert.equal(
      yield* step(() =>
        post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag).then(
          (response) => response.text(),
        ),
      ),
      bytes,
    );
    assert.equal(
      (yield* step(() => post(id, { ...payload, recommendation: "Nei" }, fixtureKeys.maybe, etag)))
        .status,
      409,
    );
    const no = yield* step(() => get("interview-recommendation-no"));

    const race = yield* step(() =>
      Promise.all([
        post(
          "interview-recommendation-no",
          { ...payload, recommendation: "Nei" },
          fixtureKeys.raceA,
          no.headers.get("etag")!,
        ),
        post(
          "interview-recommendation-no",
          { ...payload, recommendation: "Ja" },
          fixtureKeys.raceB,
          no.headers.get("etag")!,
        ),
      ]),
    );

    assert.ok(race.filter((r) => r.status === 200).length === 1);
    assert.ok(race.every((r) => [200, 409, 412].includes(r.status)));

    const saved = (yield* step(() =>
      get("interview-recommendation-no").then((response) => response.json()),
    )).recommendation;

    assert.equal(saved, race[0].status === 200 ? "Nei" : "Ja");

    // Ensure Nei has an independent exact round trip even when Ja won the concurrent race.
    if (saved !== "Nei") {
      const b = yield* step(() => get("interview-native-conduct-b-0063"));
      assert.equal(
        (yield* step(() =>
          post(
            "interview-native-conduct-b-0063",
            { ...payload, recommendation: "Nei" },
            fixtureKeys.no,
            b.headers.get("etag")!,
          ),
        )).status,
        200,
      );
      assert.equal(
        (yield* step(() =>
          get("interview-native-conduct-b-0063").then((response) => response.json()),
        )).recommendation,
        "Nei",
      );
    }

    assert.equal(
      (yield* step(() => get(id).then((response) => response.json()))).recommendation,
      "Kanskje",
    );
    recordGate(
      "missing/null/unknown/numeric rejected without effects; all choices roundtrip; exact replay and conflicting/concurrent writes fenced",
    );
    const effectsAfterInterviewCompletions = yield* effectSnapshot();
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET is_suspended=true WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    assert.equal((yield* step(() => get(id))).status, 403);
    assert.equal(
      (yield* step(() =>
        post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag),
      )).status,
      403,
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET is_suspended=false WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    recordGate("suspended authority denies reads and stored receipt replay");
    const authorizationBefore = yield* lifecycleSnapshot();

    // Change current source authority, not authentication claims or an authorization stub.
    yield* step(() =>
      pool.query(
        `UPDATE public.recruitment_interviews SET interviewer_person_id='recommendation-other-0101' WHERE interview_id=$1`,
        [id],
      ),
    );
    assert.equal((yield* step(() => get(id))).status, 403);
    assert.equal(
      (yield* step(() =>
        post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag),
      )).status,
      403,
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.recruitment_interviews SET interviewer_person_id='journey-conduct-leader-0063' WHERE interview_id=$1`,
        [id],
      ),
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET end_at=date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC') - interval '24 hours' WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    assert.equal((yield* step(() => get(id))).status, 403);
    assert.equal(
      (yield* step(() =>
        post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag),
      )).status,
      403,
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET end_at=NULL WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    yield* step(() =>
      pool.query(
        `INSERT INTO public.organization_departments SELECT (jsonb_populate_record(NULL::public.organization_departments,to_jsonb(d)||'{"department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_departments d WHERE department_id='department-native-conduct-0063'`,
      ),
    );
    yield* step(() =>
      pool.query(
        `INSERT INTO public.organization_teams SELECT (jsonb_populate_record(NULL::public.organization_teams,to_jsonb(t)||'{"team_id":"team-other-recommendation-0101","department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_teams t WHERE team_id='team-native-conduct-0063'`,
      ),
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET team_id='team-other-recommendation-0101' WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    assert.equal((yield* step(() => get(id))).status, 403);
    assert.equal(
      (yield* step(() =>
        post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag),
      )).status,
      403,
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET team_id='team-native-conduct-0063' WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    yield* step(() =>
      pool.query(
        `INSERT INTO public.admission_period_departments
         SELECT (jsonb_populate_record(NULL::public.admission_period_departments,
           to_jsonb(d)||'{"department_id":"department-other-recommendation-0101"}'::jsonb)).*
         FROM public.admission_period_departments d
         WHERE d.department_id='department-native-conduct-0063'
         ON CONFLICT (department_id) DO NOTHING`,
      ),
    );
    assert.equal(yield* lifecycleSnapshot(), authorizationBefore);
    yield* step(() =>
      pool.query(
        `INSERT INTO public.recruitment_interview_conducts
         SELECT (jsonb_populate_record(NULL::public.recruitment_interview_conducts,
           to_jsonb(c)||'{"interview_id":"interview-recommendation-link-race","interview_revision":1}'::jsonb)).*
         FROM public.recruitment_interview_conducts c
         WHERE c.interview_id='interview-native-conduct-a-0063'
         ON CONFLICT (interview_id) DO NOTHING`,
      ),
    );
    const lifecycleBeforeCorrections = yield* lifecycleSnapshot();

    if (acceptedCorrectionReplay !== undefined && process.argv.includes("--correction-mode")) {
      const boundaryResult = yield* assertInterviewCorrectionBoundaries({
        pool,
        api,
        origin: ui,
        cookie,
        interviewId: "interview-recommendation-history",
        actorPersonId: "journey-conduct-leader-0063",
        otherPersonId: "recommendation-other-0101",
        membershipId: "membership-native-conduct-leader-0063",
        selfLinkRaceInterviewId: "interview-recommendation-link-race",
        acceptedReplay: acceptedCorrectionReplay,
        recordGate,
      });

      yield* fs.writeFileString(
        path.join(artifacts, "correction-boundaries.json"),
        yield* indentedJsonText({ revision, ...boundaryResult }),
      );
    }

    // The capability travels in the payload, with no session beside it.
    const applicantResponse = yield* step(() =>
      replacedFetch({
        origin: api,
        tag: "recruitment.readInvitationResponse",
        payload: { capability: invitationCapability },
        headers: { origin: ui },
      }),
    );

    assert.equal(applicantResponse.status, 200);
    const applicantObservation = yield* step(() => applicantResponse.text());
    assertNoRecommendation(yield* decodeJsonValue(applicantObservation));
    assert.ok(!applicantObservation.includes("Kanskje"));

    // The public application confirmation is an anonymous RPC.
    const confirmations = nativeScriptClient(api);

    const applicationProjection = yield* step(() =>
      confirmations.call({}, (client) =>
        client["admissions.readApplicationConfirmation"]({
          applicationId: PublicApplicationIdSchema.make("application-recommendation-maybe"),
        }),
      ),
    );

    yield* step(() => confirmations.dispose());
    assert.equal(applicationProjection.status, 200);
    const applicationBody = yield* jsonText(applicationProjection);
    assertNoRecommendation(yield* decodeJsonValue(applicationBody));
    assert.ok(!applicationBody.includes("Kanskje"));
    recordGate(
      "wrong department denied; actual applicant capability projection excludes recommendation",
    );

    recordGate(
      "removed assignment and ended membership deny read/write/replay without lifecycle writes",
    );

    const lifecycleBeforeSelf = yield* lifecycleSnapshot();
    assert.equal((yield* step(() => get("interview-recommendation-self"))).status, 403);
    assert.equal(
      (yield* step(() =>
        post(
          "interview-recommendation-self",
          { ...payload, recommendation: "Ja" },
          fixtureKeys.selfFinalize,
          etag,
        ),
      )).status,
      403,
    );

    const selfCancel = yield* step(() =>
      replacedFetch({
        origin: api,
        tag: "recruitment.cancelInterview",
        payload: {
          interviewId: "interview-recommendation-self",
          idempotencyKey: fixtureKeys.selfCancel,
          ifMatch: etag,
        },
        headers: { cookie, origin: ui },
      }),
    );

    assert.equal(selfCancel.status, 403);
    assert.deepEqual(yield* effectSnapshot(), effectsAfterInterviewCompletions);
    // This separate actual onboarding action observes its applicant-facing projection.
    const onboardingToken = `onboard_${randomBytes(32).toString("hex")}`;
    secrets.push(onboardingToken);
    yield* step(() =>
      pool.query(
        `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('identity-recommendation-no','application-recommendation-no','applicant-recommendation-no',$1,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Open','journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
        [createHash("sha256").update(onboardingToken).digest("hex")],
      ),
    );
    yield* step(() =>
      pool.query(
        `INSERT INTO public.applicant_account_delivery(invitation_id,state,secret,recipient) VALUES('identity-recommendation-no','Pending',$1,'no@example.invalid')`,
        [onboardingToken],
      ),
    );

    const onboardingProjection = yield* step(() =>
      replacedFetch({
        origin: api,
        tag: "onboarding.claim",
        payload: { mode: "ExistingAccount", token: onboardingToken },
        headers: { cookie, origin: ui },
      }),
    );

    assert.equal(onboardingProjection.status, 200);
    assert.deepEqual(yield* step(() => onboardingProjection.json()), {
      state: "Claimed",
      departmentId: "department-native-conduct-0063",
    });
    const effectsAfterOnboarding = yield* effectSnapshot();
    recordGate(
      "actual application confirmation and onboarding claim projections exclude recommendation; recommendation produced no effect rows",
    );

    assert.equal((yield* step(() => get("interview-recommendation-no"))).status, 403);
    const winner = race.findIndex((r) => r.status === 200);
    assert.equal(
      (yield* step(() =>
        post(
          "interview-recommendation-no",
          { ...payload, recommendation: winner === 0 ? "Nei" : "Ja" },
          winner === 0 ? fixtureKeys.raceA : fixtureKeys.raceB,
          no.headers.get("etag")!,
        ),
      )).status,
      403,
    );

    if (!process.argv.includes("--correction-mode")) {
      yield* run("bun", ["packages/database/runtime/recommendation-domain-replay.ts"], env);
      const raceRead = yield* step(() => get("interview-recommendation-link-race"));
      assert.equal(raceRead.status, 200);
      const locker = yield* step(() => pool.connect());
      heldIdentityClient = locker;
      yield* step(() => locker.query("BEGIN"));
      yield* step(() =>
        locker.query(
          `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-link-race' FOR UPDATE`,
        ),
      );

      const lockerPid = (yield* step(() => locker.query("SELECT pg_backend_pid() pid"))).rows[0]
        .pid;

      const waiting = post(
        "interview-recommendation-link-race",
        { ...payload, recommendation: "Ja" },
        fixtureKeys.linkRace,
        raceRead.headers.get("etag")!,
      );

      yield* ready(
        Effect.gen(function* () {
          return (
            (yield* step(() =>
              pool.query(
                `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
                [lockerPid],
              ),
            )).rows[0].n > 0
          );
        }),
      );
      yield* link("link-race", "journey-conduct-leader-0063", locker);
      yield* step(() => locker.query("COMMIT"));
      locker.release();
      heldIdentityClient = undefined;
      // Finalization retries a serialization failure once (74b037e2), so the request that waited on
      // the link answers with the self-denial of its retry instead of 409 transaction.conflict.
      const staleIdentity = yield* step(() => waiting);
      assert.equal(staleIdentity.status, 403);
      assert.equal((yield* step(() => staleIdentity.json())).code, "authority.denied");
      assert.equal(
        (yield* step(() =>
          post(
            "interview-recommendation-link-race",
            { ...payload, recommendation: "Ja" },
            fixtureKeys.linkRace,
            raceRead.headers.get("etag")!,
          ),
        )).status,
        403,
      );
      assert.equal((yield* step(() => get("interview-recommendation-link-race"))).status, 403);
    }

    const readLocker = yield* step(() => pool.connect());
    heldIdentityClient = readLocker;
    yield* step(() => readLocker.query("BEGIN"));
    yield* step(() =>
      readLocker.query(
        `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-read-race' FOR UPDATE`,
      ),
    );

    const readLockerPid = (yield* step(() => readLocker.query("SELECT pg_backend_pid() pid")))
      .rows[0].pid;

    const waitingRead = get("interview-recommendation-read-race");
    yield* ready(
      Effect.gen(function* () {
        return (
          (yield* step(() =>
            pool.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
              [readLockerPid],
            ),
          )).rows[0].n > 0
        );
      }),
    );
    yield* link("read-race", "journey-conduct-leader-0063", readLocker);
    yield* step(() => readLocker.query("COMMIT"));
    readLocker.release();
    heldIdentityClient = undefined;
    assert.equal((yield* step(() => waitingRead)).status, 403);
    assert.equal(yield* lifecycleSnapshot(), lifecycleBeforeSelf);
    recordGate(
      "known self denied before read/finalize/cancel and both receipt layers; different Person allowed; a finalization waiting on the identity link retries its serialization failure once and is denied as self",
    );

    const immutableUpdate = yield* Effect.exit(
      step(() =>
        pool.query(
          `UPDATE public.recruitment_interview_conducts SET recommendation='Ja' WHERE interview_id='interview-recommendation-history'`,
        ),
      ),
    );

    assert.ok(Exit.isFailure(immutableUpdate));

    for (const value of [null, "wrong", ""]) {
      const insert = yield* Effect.exit(
        step(() =>
          pool.query(
            `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('invalid-direct-0101','[]',1,1,1,'journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),1,$1)`,
            [value],
          ),
        ),
      );

      const refusal = Exit.isFailure(insert) ? thrownBy(insert.cause) : undefined;

      assert.ok(Predicate.hasProperty(refusal, "code") && refusal.code === "23514");
    }

    yield* step(() => page.reload());
    yield* open(page, "history Recommendation");

    const currentHistoryDetail = yield* step(() =>
      get("interview-recommendation-history").then((response) => response.json()),
    );
    // A historical row keeps no recommendation until a correction records one; the select then
    // shows its empty "Velg anbefaling" option.

    assert.equal(
      yield* step(() => page.locator("#interviewer-recommendation").inputValue()),
      currentHistoryDetail.recommendation ?? "",
    );
    assert.equal(
      yield* step(() => page.locator("#interviewer-recommendation option:checked").textContent()),
      currentHistoryDetail.recommendation ?? "Velg anbefaling",
    );
    yield* step(() =>
      page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "historical-desktop.png") }),
    );
    yield* auditPage(page, "historical-desktop");
    yield* step(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* step(() =>
      page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "historical-mobile.png") }),
    );
    yield* auditPage(page, "historical-mobile");
    // Leadership of the department's board (classified by seedInterviewReportCoordinator).
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET is_team_leader=true,position_id='teamleader' WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );
    yield* step(() => page.setViewportSize({ width: 1280, height: 900 }));
    yield* step(() => page.reload());
    yield* step(() => page.getByRole("link", { name: "Søkerkontoer", exact: true }).click());
    yield* step(() => page.waitForURL(/\/dashboard\/onboarding$/));
    yield* step(() => page.getByRole("heading", { name: "Søkerkontoer", exact: true }).waitFor());
    yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));
    const controlPanel = page.getByRole("link", { name: "Kontrollpanel", exact: true });
    yield* step(() => controlPanel.waitFor());
    // Only a global administrator maintains interview schemas since 7472f5ea, so a board leader's
    // navigation offers no schema link.
    assert.equal(
      yield* step(() => page.getByRole("link", { name: "Intervjuskjema", exact: true }).count()),
      0,
    );
    yield* step(() => controlPanel.click());
    yield* step(() => page.waitForURL(/\/dashboard\/?$/));
    yield* step(() =>
      page.getByRole("heading", { name: "Velkommen, Lina Lagleder", exact: true }).waitFor(),
    );
    yield* step(() =>
      pool.query(
        `UPDATE public.organization_memberships SET is_team_leader=false,position_id='member' WHERE membership_id='membership-native-conduct-leader-0063'`,
      ),
    );

    recordGate(
      "owned interview shell retains role-scoped onboarding and dashboard navigation without the global administrators' schema link",
    );

    const rows = (yield* step(() =>
      pool.query(
        `SELECT interview_id,recommendation,answers,explanatory_power,role_model,suitability FROM public.recruitment_interview_conducts ORDER BY interview_id`,
      ),
    )).rows;

    assert.equal(
      rows.find((r: any) => r.interview_id === "interview-native-conduct-a-0063").recommendation,
      "Ja",
    );
    assert.equal(
      rows.find((r: any) => r.interview_id === "interview-recommendation-history").recommendation,
      null,
    );
    const maybeRow = rows.find((r: any) => r.interview_id === id);
    assert.deepEqual(maybeRow.answers, answers);
    assert.equal(maybeRow.explanatory_power, 7);
    assert.equal(maybeRow.role_model, 8);
    assert.equal(maybeRow.suitability, 9);

    const lifecycle = (yield* step(() =>
      pool.query(
        `SELECT c.interview_id,c.recommendation,a.kind,a.resulting_revision,r.command_id FROM public.recruitment_interview_conducts c JOIN public.recruitment_interview_lifecycle_audit a USING(interview_id) JOIN public.recruitment_interview_lifecycle_command_receipts r ON r.command_id=a.command_id ORDER BY c.interview_id`,
      ),
    )).rows;

    const beforeLifecycle = yield* Schema.decodeUnknownEffect(
      Schema.StructWithRest(
        Schema.Struct({
          conducts: Schema.Json,
          receipts: Schema.Array(
            Schema.StructWithRest(
              Schema.Struct({ command_id: Schema.String, kind: Schema.String }),
              [Schema.Record(Schema.String, Schema.Json)],
            ),
          ),
          audit: Schema.Json,
        }),
        [Schema.Record(Schema.String, Schema.Json)],
      ),
    )(yield* decodeJsonText(lifecycleBeforeCorrections));

    const afterLifecycle = yield* Schema.decodeUnknownEffect(
      Schema.StructWithRest(
        Schema.Struct({
          conducts: Schema.Json,
          receipts: Schema.Array(
            Schema.StructWithRest(
              Schema.Struct({ command_id: Schema.String, kind: Schema.String }),
              [Schema.Record(Schema.String, Schema.Json)],
            ),
          ),
          audit: Schema.Json,
        }),
        [Schema.Record(Schema.String, Schema.Json)],
      ),
    )(yield* decodeJsonText(yield* lifecycleSnapshot()));

    assert.deepEqual(afterLifecycle.conducts, beforeLifecycle.conducts);
    assert.deepEqual(afterLifecycle.receipts, beforeLifecycle.receipts);
    assert.deepEqual(afterLifecycle.audit, beforeLifecycle.audit);

    const knownFinalizationCommandIds = beforeLifecycle.receipts
      .values()
      .filter((receipt) => receipt.kind === "InterviewFinalized")
      .map((receipt) => receipt.command_id)
      .toArray()
      .sort();

    assert.ok(knownFinalizationCommandIds.length > 0);
    assert.deepEqual(
      lifecycle.map((row: any) => row.command_id).sort(),
      knownFinalizationCommandIds,
    );
    assert.ok(lifecycle.every((r: any) => r.kind === "InterviewFinalized"));
    assert.equal(new Set(lifecycle.map((r: any) => r.interview_id)).size, lifecycle.length);
    assert.deepEqual(yield* effectSnapshot(), effectsAfterOnboarding);
    assert.deepEqual(errors, []);
    assert.ok(
      accessibility.every((result: any) => result.violations.length === 0),
      "Accessibility violations retained in accessibility.json",
    );

    for (const secret of secrets) assert.ok(!(yield* jsonText(logs)).includes(secret));
    recordGate(
      "historical immutable not-recorded display; direct storage constraints; desktop/mobile Axe; independent public-schema SQL",
    );

    const reportEvidence = process.argv.includes("--report")
      ? yield* observeInterviewReport({
          root,
          pool,
          browser,
          api,
          ui,
          artifacts,
          ordinaryCookie: cookie,
          password,
          secrets,
          correctionMode: process.argv.includes("--correction-mode"),
          expectedHistoricalReportRecommendation,
          revision,
          auditPage,
          recordGate,
        })
      : undefined;

    assert.ok(
      accessibility.every((result: any) => result.violations.length === 0),
      "Report accessibility violations retained",
    );
    yield* fs.writeFileString(
      path.join(artifacts, "evidence.json"),
      yield* indentedJsonText({
        revision,
        reportEvidence,
        gates,
        rows,
        lifecycle,
        pageErrors: errors,
        observer: "independent PostgreSQL connection",
        noNotificationEffects: true,
      }),
    );

    yield* assertArtifactsRedacted;

    return { result: "Passed" } satisfies Outcome;
  });

  /** Writes the redacted failure evidence while the cluster and browser still answer, then fails. */
  const reportFailure = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const error = thrownBy(cause);
      let detail = error.stack ?? error.message;

      const activeQueries: ReadonlyArray<unknown> =
        pool === undefined
          ? []
          : yield* step(() =>
              pool.query(
                `SELECT pid,state,wait_event_type,wait_event,left(query,240) AS query
             FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
             ORDER BY pid`,
              ),
            ).pipe(
              Effect.map((result: { rows: unknown[] }) => result.rows),
              Effect.orElseSucceed(() => []),
            );

      detail += ` Active PostgreSQL queries: ${yield* jsonText(activeQueries)}`;

      if (page !== undefined)
        detail += ` Current page: ${yield* step(() => page.locator("body").innerText()).pipe(
          Effect.orElseSucceed(() => "unavailable"),
        )}`;

      const safe = (value: string) =>
        secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), value);

      detail = safe(detail);

      const returningOutbox: ReadonlyArray<unknown> =
        pool === undefined
          ? []
          : yield* step(() =>
              pool.query(
                `SELECT effect_id,command_id,effect_type,ordinal,status,attempts,claimed_at,last_failure_tag,origin
             FROM public.admission_application_outbox
             WHERE origin='ReturningAssistant'
             ORDER BY effect_id`,
              ),
            ).pipe(
              Effect.map((result: { rows: unknown[] }) => result.rows),
              Effect.orElseSucceed(() => []),
            );

      const returningEffectCalls = effectCalls
        .values()
        .filter((call) => call.origin === "ReturningAssistant")
        .map(({ effectId, commandId, kind, status }) => ({ effectId, commandId, kind, status }))
        .toArray();

      const failureEvidence = {
        result: "Failed",
        revision,
        gates,
        detail,
        logs: logs.map(safe),
        returningOutbox,
        returningEffectCalls,
      };

      yield* fs.writeFileString(
        path.join(artifacts, "failure.json"),
        yield* indentedJsonText(failureEvidence),
      );
      yield* fs.writeFileString(
        path.join(artifacts, "runtime.log"),
        `${logs.map(safe).join("")}${detail}\n`,
      );
      yield* Console.error(yield* jsonText({ ...failureEvidence, artifacts }));

      return yield* new RecommendationFailed({ message: detail });
    });

  yield* Effect.scoped(
    recommendationJourney.pipe(
      Effect.tap((outcome: Outcome) =>
        jsonText({ result: outcome.result, revision, artifacts, gates, ...outcome.report }).pipe(
          Effect.map(say),
        ),
      ),
      Effect.catchCause(reportFailure),
    ),
  ).pipe(Effect.ensuring(flushOutput));
});

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
);
