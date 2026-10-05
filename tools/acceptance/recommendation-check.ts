/**0101: previous-schema history -> actual migration -> production browser/API/PostgreSQL. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
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
import { stopOwnedProcess } from "./owned-process.js";
import {
  type DisposablePostgres,
  loopbackPortFree,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "../postgres/index.ts";
import {
  runReturningAssistantBrowserJourney,
  runReturningAssistantLoginProbe,
  seedReturningAssistant,
} from "./returning-assistant-journey.ts";
import {
  assertInterviewCorrectionPre0039Preserved,
  coInterviewerCorrection0106IdentitySeeds,
  seedCoInterviewerCorrection0106Fixture,
  seedInterviewCorrectionPre0039Fixture,
  seedRecruitmentMaintenanceJourneyFixture,
  type CoInterviewerCorrection0106Fixture,
  type InterviewCorrectionPre0039Fixture,
} from "./recommendation-preupgrade-fixture.ts";
import {
  assertInterviewCorrectionBoundaries,
  type InterviewCorrectionReplayRequest,
} from "./interview-correction-boundaries.ts";
import { assertInterviewCorrectionIntegrity } from "./interview-correction-integrity.ts";
import { runCoInterviewerCorrectionJourney } from "./co-interviewer-correction-0106.ts";
import { DatabaseLive } from "../../packages/database/src/layers.js";
import { TestPlatform } from "../../packages/database/src/test-support/platform.js";
import { AdmissionsLive } from "../../packages/database/src/admissions/index.js";
import { OrganizationLive } from "../../packages/database/src/organization/index.js";
import { ProfileLive } from "../../packages/database/src/profile/index.js";
import {
  deliverNextRecruitmentInvitation,
  type RecruitmentInvitationDeliveryResult,
} from "../../packages/database/src/recruitment/index.js";
import {
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidenceSchema,
} from "../../packages/domain/src/recruitment/index.js";
import { deliverJson } from "../../apps/backend/src/delivery/http.js";
import { deriveHttpIdentity, normalizeTarget } from "../../apps/backend/src/http-semantics.js";
import { NotificationGateway } from "../../packages/domain/src/notification/service.js";
import { Array as Arr, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { admissionJourneyClock } from "../e2e/journey-clock.ts";
import {
  AdmissionOutcomeResource,
  AdmissionOutcomeAnnounceResource,
  NativeProblem,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  QuestionnaireManagement,
  InterviewStaffingManagement,
  CorrectInterviewAssessmentRequest,
} from "../../packages/http-api/src/index.js";
import nativeOperations from "../../packages/sdk/native-api-operations.json";

const root = new URL("../../", import.meta.url).pathname;

const dbRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));

const uiRequire = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));

const { Pool } = dbRequire("pg");

const { Effect, Layer, Redacted } = dbRequire("effect");

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

class ReturningLoginProbeComplete<A> extends Error {
  constructor(readonly result: A) {
    super("returning login probe complete");
  }
}

class ReturningTargetedComplete<A> extends Error {
  constructor(readonly result: A) {
    super("returning targeted journey complete");
  }
}

class CorrectionTargetedComplete<A> extends Error {
  constructor(readonly result: A) {
    super("correction targeted journey complete");
  }
}

class CoInterviewerTargetedComplete<A> extends Error {
  constructor(readonly result: A) {
    super("co-interviewer targeted journey complete");
  }
}

class ApplicantProgressTargetedComplete<A> extends Error {
  constructor(readonly result: A) {
    super("applicant progress targeted journey complete");
  }
}

const coInterviewerMode = process.argv.includes("--co-interviewer-mode");

const applicantProgressMode = process.argv.includes("--applicant-progress-mode");

if (process.argv.includes("--report")) validateInterviewReportFixture();

if (process.argv.includes("--validate-fixture")) {
  // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: local fixture validation result.
  console.log("All recommendation fixture idempotency keys satisfy the canonical schema");
  process.exit(0);
}

const { chromium, expect } = uiRequire("@playwright/test");

const AxeBuilder = uiRequire("@axe-core/playwright").default;

const run = (cmd: string, args: string[], env = process.env, cwd = root): string => {
  try {
    return execFileSync(cmd, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  } catch (cause) {
    throw new Error(
      `runtime command failed: ${cmd} ${args.join(" ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

assert.equal(run("git", ["status", "--porcelain", "--", ".", ":(exclude).serena"]).trim(), "");

const revision = run("git", ["rev-parse", "HEAD"]).trim();

const artifacts = await mkdtemp(join(tmpdir(), "vektor-recommendation-0101-"));

const logs: string[] = [];

const children: ReturnType<typeof spawn>[] = [];

const start = (cmd: string, args: string[], env = process.env, cwd = root) => {
  const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  c.stdout?.on("data", (v) => logs.push(String(v)));
  c.stderr?.on("data", (v) => logs.push(String(v)));

  return c;
};

const ready = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    try {
      if (await test()) return;
    } catch {}

    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("Readiness failed");
};

let postgres: DisposablePostgres | undefined;

let pool: any, browser: any, page: any, heldIdentityClient: any, backend: any;

let correctionPre0039Fixture: InterviewCorrectionPre0039Fixture | undefined;

let acceptedCorrectionReplay: InterviewCorrectionReplayRequest | undefined;

let coInterviewerFixture: CoInterviewerCorrection0106Fixture | undefined;

let expectedHistoricalReportRecommendation: "Ja" | "Kanskje" | "Nei" | undefined;

let effectServer: Server | undefined;

const effectCalls: EffectReceiverCall[] = [];

const effectAttempts = new Map<string, number>();

const invitationCapabilities = new Map<string, string>();

let releaseEffectDelivery = false;

const gates: string[] = [];

const recordGate = (...observations: string[]) => {
  gates.push(...observations);
  // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: bounded synthetic rehearsal milestones.
  console.log(JSON.stringify({ observed: observations }));
};

const secrets: string[] = [];

const accessibility: Array<{ state: string; violations: ReadonlyArray<unknown> }> = [];

const auditPage = async (page: any, state: string) => {
  const violations = (await new AxeBuilder({ page }).analyze()).violations.map(
    (violation: any) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node: any) => ({
        target: node.target,
        checks: node.any.map((check: any) => ({ id: check.id, data: check.data })),
      })),
    }),
  );

  accessibility.push({ state, violations });
  let evidence = JSON.stringify(accessibility, null, 2);

  for (const secret of secrets) evidence = evidence.replaceAll(secret, "[redacted]");
  await writeFile(join(artifacts, "accessibility.json"), evidence);

  return violations;
};

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

const readRequestText = async (request: IncomingMessage): Promise<string> => {
  const chunks: string[] = [];

  for await (const chunk of request) chunks.push(String(chunk));

  return chunks.join("");
};

const stringField = (value: Schema.Json, key: string): string => {
  if (value === null || !(value === null || Predicate.isObjectOrArray(value)) || !(key in value))
    return "";
  const field = Schema.decodeUnknownSync(Schema.JsonObject)(value)[key];

  return Predicate.isString(field) ? field : "";
};

const startEffectReceiver = async (
  token: string,
  portNumber: number,
  captureInvitationCapability: (interviewId: string, capability: string) => void,
): Promise<Server> => {
  const server = createHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/effects") {
      response.statusCode = 404;
      response.end();

      return;
    }

    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end();

      return;
    }

    let body: Schema.Json;

    try {
      body = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readRequestText(request)));
    } catch {
      response.statusCode = 400;
      response.end();

      return;
    }

    if (stringField(body, "_tag") === "SendInterviewInvitation") {
      const interviewId = stringField(body, "interviewId");
      const capability = stringField(body, "responseCapability");

      if (interviewId !== "" && capability !== "")
        captureInvitationCapability(interviewId, capability);
    }

    const effectId = request.headers["idempotency-key"];
    const normalizedEffectId = Predicate.isString(effectId) ? effectId : "";
    const attempt = (effectAttempts.get(normalizedEffectId) ?? 0) + 1;
    effectAttempts.set(normalizedEffectId, attempt);
    const kind = stringField(body, "_tag");
    const status = releaseEffectDelivery || kind === "SendInterviewInvitation" ? 204 : 503;
    effectCalls.push({
      effectId: normalizedEffectId,
      commandId: stringField(body, "commandId"),
      origin: stringField(body, "origin"),
      kind: stringField(body, "_tag"),
      attempt,
      status,
    });
    response.statusCode = status;
    response.end();
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(portNumber, "127.0.0.1", listening.resolve);
  await listening.promise;

  return server;
};

const deliverRecruitmentInvitationOnce = async ({
  pgUrl,
  endpoint,
  token,
  claimId,
  now,
}: {
  readonly pgUrl: string;
  readonly endpoint: URL;
  readonly token: string;
  readonly claimId: string;
  readonly now: () => string;
}): Promise<RecruitmentInvitationDeliveryResult> => {
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

  const gateway = Layer.succeed(
    NotificationGateway,
    NotificationGateway.of({
      deliverInterviewCompletionReceipt: (request) =>
        deliverJson(request, transport, {
          "idempotency-key": request.effectId,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.map(() =>
            RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt: now(),
              providerReference: `loopback:${request.effectId}`,
            }),
          ),
          Effect.mapError(
            () =>
              new RecruitmentNotificationDeliveryError({
                effectId: request.effectId,
                message: "loopback interview completion receipt delivery unavailable",
              }),
          ),
        ),
      deliverInterviewInvitation: (request) =>
        deliverJson(request, transport, {
          "idempotency-key": request.effectId,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.map(() =>
            RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt: now(),
              providerReference: `loopback:${request.effectId}`,
            }),
          ),
          Effect.mapError(
            () =>
              new RecruitmentNotificationDeliveryError({
                effectId: request.effectId,
                message: "loopback recruitment invitation delivery unavailable",
              }),
          ),
        ),
      deliverInterviewInvitationResponse: (request) =>
        deliverJson(request, transport, {
          "idempotency-key": request.effectId,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.map(() =>
            RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt: now(),
              providerReference: `loopback:${request.effectId}`,
            }),
          ),
          Effect.mapError(
            () =>
              new RecruitmentNotificationDeliveryError({
                effectId: request.effectId,
                message: "loopback recruitment invitation response delivery unavailable",
              }),
          ),
        ),
    }),
  );

  return Effect.runPromise(
    Effect.scoped(
      deliverNextRecruitmentInvitation(claimId, now()).pipe(
        Effect.provide(gateway),
        Effect.provide(authorityLayers),
      ),
    ),
  );
};

try {
  // The cluster reserves its own port through the same construct, so no port repeats.
  const [apiPort, effectPort] = await reserveLoopbackPorts(2),
    uiPort = 5174;

  assert.ok(await loopbackPortFree(uiPort), `loopback port ${uiPort} is in use`);

  postgres = await startDisposablePostgres();

  const pg = postgres.url,
    api = `http://127.0.0.1:${apiPort}`,
    ui = `http://127.0.0.1:${uiPort}`;

  const effectMode = process.argv.includes("--returning-mode") ? "http" : "disabled";
  const effectToken = randomBytes(32).toString("hex");
  pool = new Pool({ connectionString: pg });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOURNEY_SEED_PG_URL: pg,
    BACKEND_PG_URL: pg,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(apiPort),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([ui]),
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

  if (effectMode === "http") {
    env.PUBLIC_APPLICATION_EFFECT_ENDPOINT = `http://127.0.0.1:${effectPort}/effects`;
    env.PUBLIC_APPLICATION_EFFECT_TOKEN = effectToken;
    env.PUBLIC_APPLICATION_EFFECT_POLL_MS = "1000";
    env.PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS = "2000";
  }

  assert.ok(env.BETTER_AUTH_SECRET);
  secrets.push(env.BETTER_AUTH_SECRET);
  recordGate("disposable PostgreSQL is ready");
  run("bun", ["tools/verification/recommendation-preupgrade-fixture.ts"], {
    ...env,
    RECOMMENDATION_PREUPGRADE_THROUGH_0038: "1",
  });

  const historicalBefore = (
    await pool.query(
      `SELECT to_jsonb(c)-'recommendation' value FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
    )
  ).rows[0].value;

  recordGate("previous-schema history fixture migrated");
  correctionPre0039Fixture = await seedInterviewCorrectionPre0039Fixture({ pool });
  recordGate("seeded 0105 pre-0039 correction rows from existing native base");
  run(
    "bun",
    ["run", "identity:seed"],
    {
      ...env,
      IDENTITY_SEED_PG_URL: pg,
      IDENTITY_SEED_PERSONS: JSON.stringify([
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
    join(root, "packages/database"),
  );

  if (coInterviewerMode) {
    coInterviewerFixture = await seedCoInterviewerCorrection0106Fixture({ pool });
    recordGate(
      "seeded synthetic 0106 co-interviewer designation after the canonical migration chain",
    );
  }

  await seedReturningAssistant({ pool, run, env, root });
  // Also classifies team-native-conduct-0063 as the board (Styret) of an independent department,
  // so promoting the conduct leader to its leader below grants department reach (O8-11).
  await seedInterviewReportCoordinator({ pool, secrets });

  const maintenanceFixture = process.argv.includes("--correction-mode")
    ? await seedRecruitmentMaintenanceJourneyFixture(pool)
    : undefined;

  if (effectMode === "http") {
    effectServer = await startEffectReceiver(effectToken, effectPort, (interviewId, capability) => {
      invitationCapabilities.set(interviewId, capability);
      secrets.push(capability);
    });
    secrets.push(effectToken);
  }

  const effectSnapshot = async () => {
    const tables = (
      await pool.query(
        `SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') AND (tablename LIKE '%outbox%' OR tablename LIKE '%effect%') ORDER BY schemaname,tablename`,
      )
    ).rows;

    return Promise.all(
      tables.map(async ({ schemaname, tablename }: any) => ({
        table: `${schemaname}.${tablename}`,
        rows: (
          await pool.query(
            `SELECT to_jsonb(t) value FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      })),
    );
  };

  const effectsBefore = await effectSnapshot();

  const link = async (suffix: string, personId: string, sql = pool) => {
    const invitation = `identity-recommendation-${suffix}`;
    await sql.query(
      `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Claimed','journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
      [
        invitation,
        `application-recommendation-${suffix}`,
        `applicant-recommendation-${suffix}`,
        createHash("sha256").update(invitation).digest("hex"),
      ],
    );
    await sql.query(
      `INSERT INTO public.applicant_account_links VALUES($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$3)`,
      [`applicant-recommendation-${suffix}`, personId, invitation],
    );
  };

  await pool.query(
    `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES('recommendation-other-0101','Other','Interviewer',0)`,
  );
  await link("self", "journey-conduct-leader-0063");
  await link("maybe", "recommendation-other-0101");

  if (applicantProgressMode) {
    await seedApplicantProgress0107(pool);
    recordGate("seeded synthetic current-semester applicant progress states");
    secrets.push(
      applicantProgressUnlinkedIdentity.email,
      applicantProgressUnlinkedIdentity.password,
    );
  }

  const invitationCapability = randomBytes(32).toString("base64url");
  secrets.push(invitationCapability);
  await pool.query(
    `UPDATE public.recruitment_invitations SET capability_sha256=$1 WHERE invitation_id='invitation-recommendation-maybe'`,
    [createHash("sha256").update(invitationCapability).digest("hex")],
  );

  backend = start("bun", ["apps/backend/src/main.ts"], env);
  await ready(async () => (await fetch(`${api}/health`)).ok);

  const historicalAfter = (
    await pool.query(
      `SELECT to_jsonb(c)-'recommendation' value,recommendation FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
    )
  ).rows[0];

  assert.deepEqual(historicalAfter.value, historicalBefore);
  assert.equal(historicalAfter.recommendation, null);
  recordGate(
    "immutable historical row survived actual0037 upgrade without invented recommendation",
  );
  assert.ok(correctionPre0039Fixture);
  await assertInterviewCorrectionPre0039Preserved(pool, correctionPre0039Fixture);
  recordGate(
    "0039/0040 upgrades preserved original interview/schedule/invitation/conduct/lifecycle rows",
  );
  run("bun", ["run", "build"], env, join(root, "packages/sdk"));
  run("bun", ["run", "build"], env, join(root, "apps/dashboard"));
  start("bun", ["server.mjs"], env, join(root, "apps/dashboard"));
  await ready(async () => (await fetch(`${ui}/login`)).ok);

  const password = "journey-conduct-secret-0123456789",
    email = "lina.conduct@example.invalid";

  secrets.push(password, email);

  const credentialCheck = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: ui, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!credentialCheck.ok) {
    const failure = await credentialCheck.json();
    throw new Error(`Native sign-in failed: ${credentialCheck.status} ${JSON.stringify(failure)}`);
  }

  await credentialCheck.body?.cancel();
  recordGate("seeded native credentials accepted by real identity engine");
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/etc/profiles/per-user/nori/bin/chromium",
  });
  const context = await browser.newContext();
  const errors: string[] = [];
  context.on("page", (p: any) => p.on("pageerror", () => errors.push("pageerror")));
  page = await context.newPage();
  await page.goto(`${ui}/login`);
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Passord", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await page.waitForURL(/\/dashboard\/?$/);
  await page.goto(`${ui}/dashboard/intervjuer`);

  if (process.argv.includes("--returning-login-probe")) {
    const probe = await runReturningAssistantLoginProbe({ browser, pool, ui, artifacts });
    throw new ReturningLoginProbeComplete(probe);
  }

  assert.equal(await page.getByRole("link", { name: "Søkerkontoer", exact: true }).count(), 0);
  const cookies = await context.cookies();
  const cookie = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  secrets.push(...cookies.map((c: any) => c.value));

  if (applicantProgressMode) {
    // Leadership of the department's board (classified by seedInterviewReportCoordinator).
    await pool.query(
      `UPDATE public.organization_memberships
       SET is_team_leader=true, position_id='teamleader'
       WHERE membership_id='membership-native-conduct-leader-0063'`,
    );

    const journey = await runApplicantProgress0107({
      pool,
      page,
      cookie,
      api,
      ui,
      artifacts,
      errors,
      audit: (journeyPage) => auditPage(journeyPage, "applicant-progress"),
    });

    recordGate("observed applicant-owned progress through the real browser/API/PostgreSQL path");

    for (const entry of await readdir(artifacts, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".png")) {
        const text = await readFile(join(artifacts, entry.name), "utf8");

        for (const secret of secrets)
          assert.ok(
            !text.includes(secret),
            `retained artifact ${entry.name} contains a credential`,
          );
      }
    }

    throw new ApplicantProgressTargetedComplete(journey);
  }

  if (coInterviewerMode) {
    if (coInterviewerFixture === undefined)
      throw new Error("co-interviewer targeted mode requires its synthetic designation fixture");

    const journey = await runCoInterviewerCorrectionJourney({
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

    for (const entry of await readdir(artifacts, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".png")) {
        const text = await readFile(join(artifacts, entry.name), "utf8");

        for (const secret of secrets)
          assert.ok(
            !text.includes(secret),
            `retained artifact ${entry.name} contains a credential`,
          );
      }
    }

    throw new CoInterviewerTargetedComplete(journey);
  }

  if (process.argv.includes("--returning-mode")) {
    let currentStage = "returning:startup";
    const returningStages: string[] = [];

    const stage = (name: string) => {
      currentStage = name;
      returningStages.push(name);
      // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit bounded returning-stage evidence.
      console.log(JSON.stringify({ returningStage: name }));
    };

    const bounded = async <T>(
      label: string,
      operation: Promise<T>,
      timeoutMs = 90_000,
    ): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;

      try {
        return await Promise.race([
          operation,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} timed out at ${currentStage}`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const returningResult = await bounded(
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
        deliverRecruitmentInvitation: async (claimId) => {
          const result = await deliverRecruitmentInvitationOnce({
            pgUrl: pg,
            endpoint: new URL(`${api.replace(/:\d+$/u, `:${effectPort}`)}/effects`),
            token: effectToken,
            claimId,
            now: () => new Date().toISOString(),
          });

          assert.equal(result._tag, "Delivered");

          const outbox = await pool.query(
            "SELECT status,attempts FROM public.recruitment_invitation_outbox WHERE effect_id=$1",
            [result.claim.effectId],
          );

          assert.deepEqual(outbox.rows, [{ status: "Delivered", attempts: 1 }]);

          return result;
        },
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

      const acceptedReturningRegistrations = await pool.query(
        "SELECT command_id,registration_id FROM public.admission_returning_command_receipts ORDER BY command_id",
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
              commandRows.map((row) => row.effect_type).join(",") === expectedEffectTypes.join(",")
            );
          },
        );
      };

      const readReturningOutbox = async () =>
        Schema.decodeUnknownSync(Schema.Array(ReturningOutboxRow))(
          (
            await pool.query(
              `SELECT effect_id,command_id,effect_type,ordinal,status,attempts,claimed_at,last_failure_tag,origin
           FROM public.admission_application_outbox
           WHERE origin='ReturningAssistant'
           ORDER BY effect_id`,
            )
          ).rows,
        );

      const waitForOutbox = async (
        predicate: (rows: ReadonlyArray<ReturningOutboxRow>) => boolean,
      ) => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const rows = await readReturningOutbox();

          if (predicate(rows)) return rows;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error("returning effect outbox did not reach expected state");
      };

      const failedRows = await bounded(
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
      const heldFailedRows = await readReturningOutbox();
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
      await stopOwnedProcess(backend);
      releaseEffectDelivery = true;
      backend = start("bun", ["apps/backend/src/main.ts"], env);
      await ready(async () => (await fetch(`${api}/health`)).ok);

      const deliveredRows = await bounded(
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

      await writeFile(
        join(artifacts, "returning-effect-evidence.json"),
        JSON.stringify(
          {
            outbox: deliveredRows,
            registrations: acceptedReturningRegistrations.rows,
            calls: effectCalls,
            preRestartCalls: preRestartEffectCalls,
            restart: true,
          },
          null,
          2,
        ),
      );
      recordGate("returning effect worker restarted and acknowledged all loopback effects");
    }

    const reportEvidence = await bounded(
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
    await writeFile(
      join(artifacts, "returning-targeted-evidence.json"),
      JSON.stringify(
        { revision, returningStages, returningResult, returningFalsifierManifest, reportEvidence },
        null,
        2,
      ),
    );
    assert.deepEqual(
      accessibility.filter((result) => result.violations.length > 0),
      [],
      "Returning registration and report accessibility violations retained in accessibility.json",
    );
    throw new ReturningTargetedComplete({ returningStages, reportEvidence });
  }

  const get = (id: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}`, { headers: { cookie, origin: ui } });

  const post = (id: string, body: Schema.Json, key: string, etag: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}:finalize`, {
      method: "POST",
      headers: {
        cookie,
        origin: ui,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": etag,
      },
      body: JSON.stringify(body),
    });

  const correctPost = (id: string, body: Schema.Json, key: string, etag: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}:correct`, {
      method: "POST",
      headers: {
        cookie,
        origin: ui,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": etag,
      },
      body: JSON.stringify(body),
    });

  const open = async (p: any, name: string) => {
    await p
      .getByRole("article")
      .filter({ hasText: name })
      .getByRole("button", { name: "Åpne intervju" })
      .click();
    await p.getByRole("heading", { name: `Intervju med ${name}` }).waitFor();
  };

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

  const fill = async (p: any) => {
    await p
      .locator("#question-interview-schema-native-conduct-0063-q0")
      .fill("Jeg vil forklare matematikk tydelig.");
    await p.locator("#question-interview-schema-native-conduct-0063-q1-1").check();
    await p.locator("#question-interview-schema-native-conduct-0063-q2-0").check();
    await p.locator("#question-interview-schema-native-conduct-0063-q3-0").check();

    for (const axis of ["explanatoryPower", "roleModel", "suitability"])
      await p.locator(`#score-${axis}`).selectOption("8");
  };

  if (process.argv.includes("--correction-mode")) {
    const correctionId = "interview-recommendation-history";
    const correctionName = "history Recommendation";
    const correctionStages: string[] = [];
    const stage = (name: string) => correctionStages.push(name);

    // Gate 5 observes native requests, not the dashboard bridge's operation envelope.
    const nativeOperation = (operationId: string) => {
      const matches = nativeOperations.operations.filter(
        (entry) => entry.operationId === operationId,
      );

      assert.equal(matches.length, 1, operationId);

      return matches[0]!;
    };

    const questionnairesOperation = nativeOperation("recruitment.readQuestionnaires");
    const staffingOperation = nativeOperation("recruitment.readInterviewStaffing");
    const maintenanceOperation = nativeOperation("recruitment.maintainRecruitment");
    const correctionOperation = nativeOperation("recruitment.correctInterviewAssessment");
    const decodeQuestionnaires = Schema.decodeUnknownSync(QuestionnaireManagement);
    const decodeStaffing = Schema.decodeUnknownSync(InterviewStaffingManagement);
    const decodeMaintenanceCommand = Schema.decodeUnknownSync(RecruitmentMaintenanceCommand);
    const encodeMaintenanceCommand = Schema.encodeSync(RecruitmentMaintenanceCommand);
    const decodeMaintenanceResult = Schema.decodeUnknownSync(RecruitmentMaintenanceResult);
    const decodeProblem = Schema.decodeUnknownSync(NativeProblem);

    const maintenanceRequests: Array<{
      operationId: string;
      method: string;
      path: string;
      status: number;
      body: unknown;
      command?: RecruitmentMaintenanceCommand;
      idempotencyKey?: string;
    }> = [];

    const maintenanceSqlObservations: Array<{ kind: string; body: unknown }> = [];

    const nativeResponseFor = (target: any, operation: typeof maintenanceOperation) =>
      target.waitForResponse((response: any) => {
        const url = new URL(response.url());

        return (
          response.request().method() === operation.method &&
          url.origin === api &&
          url.pathname === operation.path
        );
      });

    const observeMaintenanceRead = async <S extends Schema.ConstraintDecoder<unknown>>(
      target: any,
      operation: typeof maintenanceOperation,
      schema: S,
      trigger: () => Promise<void>,
    ): Promise<S["Type"]> => {
      const pending = nativeResponseFor(target, operation);
      await trigger();
      const response = await pending;
      assert.equal(response.status(), 200, await response.text());
      const body = Schema.decodeUnknownSync(schema)(await response.json());
      maintenanceRequests.push({ ...operation, status: response.status(), body });

      return body;
    };

    const observeMaintenanceSave = async (
      target: any,
      tag: RecruitmentMaintenanceCommand["_tag"],
      trigger: () => Promise<void>,
    ) => {
      const pending = nativeResponseFor(target, maintenanceOperation);
      await trigger();
      const response = await pending;
      const request = response.request();
      const command = decodeMaintenanceCommand(request.postDataJSON());
      const key = request.headers()["idempotency-key"];
      assert.equal(command._tag, tag);
      assert.equal(key, command.commandId);
      assert.equal(response.status(), 200, await response.text());
      const result = decodeMaintenanceResult(await response.json());
      const bytes = await response.text();
      maintenanceRequests.push({
        ...maintenanceOperation,
        status: response.status(),
        body: result,
        command,
        idempotencyKey: key,
      });

      return { command, result, bytes, rawBody: request.postData(), etag: response.headers().etag };
    };

    const postMaintenance = (command: RecruitmentMaintenanceCommand, authorityCookie: string) =>
      fetch(api + maintenanceOperation.path, {
        method: maintenanceOperation.method,
        headers: {
          cookie: authorityCookie,
          origin: ui,
          "content-type": "application/json",
          "idempotency-key": command.commandId,
        },
        body: JSON.stringify(encodeMaintenanceCommand(command)),
      });

    // Same initial-focus/keyboard assertions used by the existing conduct journey.
    const assertWindowFocus = async (target: any, dialog: any) => {
      await expect(dialog.getByRole("button", { name: "Tilbake", exact: true })).toBeFocused();
      const first = dialog.getByLabel("Begrunnelse for rettingsvindu", { exact: true });

      const last = dialog.getByRole("button", {
        name: "Last gjeldende versjon (erstatter utkast)",
        exact: true,
      });

      await first.focus();
      await target.keyboard.press("Shift+Tab");
      await expect(last).toBeFocused();
      await target.keyboard.press("Tab");
      await expect(first).toBeFocused();
    };

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

    const correctionPageOpen = async () => {
      await page
        .getByRole("article")
        .filter({ hasText: correctionName })
        .getByRole("button", { name: "Åpne intervju", exact: true })
        .click();
      await page.getByRole("heading", { name: `Intervju med ${correctionName}` }).waitFor();
    };

    const saveCorrection = async (recommendation: "Ja" | "Kanskje" | "Nei") => {
      await fill(page);
      await page.locator("#interviewer-recommendation").selectOption(recommendation);
      await page.locator("#score-explanatoryPower").selectOption("4");
      await page.locator("#score-roleModel").selectOption("5");
      await page.locator("#score-suitability").selectOption("6");
      await page.getByRole("button", { name: "Rett intervju", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
      const responsePromise = responseFor("correctInterviewAssessment");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Rett intervju", exact: true })
        .press("Enter");
      const response = await responsePromise;

      if (!response.ok())
        throw new Error(`correction response ${response.status()}: ${await response.text()}`);
      await page.locator("#interviewer-recommendation").waitFor({ state: "visible" });
      assert.equal(await page.locator("#interviewer-recommendation").inputValue(), recommendation);
    };

    const before = await get(correctionId);
    assert.equal(before.status, 200);
    const beforeBody = await before.json();

    const originalConductSql = (
      await pool.query(
        `SELECT to_jsonb(c) AS value
         FROM public.recruitment_interview_conducts c
         WHERE interview_id=$1`,
        [correctionId],
      )
    ).rows[0].value;

    assert.equal(beforeBody.completionState, "Completed");
    assert.equal(beforeBody.history[0]?._tag, "Original");
    assert.equal(beforeBody.history[0]?.recommendation, null);
    stage("historical-null completed detail opens");
    await correctionPageOpen();
    await saveCorrection("Ja");
    stage("browser keyboard correction saves and refreshes detail");
    const afterFirst = await (await get(correctionId)).json();
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
    await page.reload();
    await correctionPageOpen();
    assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Ja");
    const staleCorrectionEtag = (await get(correctionId)).headers.get("etag")!;

    const staleCorrectionContext = await browser.newContext({
      storageState: await context.storageState(),
    });

    const staleCorrection = await staleCorrectionContext.newPage();
    staleCorrection.on("pageerror", () => errors.push("stale-correction-pageerror"));
    await staleCorrection.goto(`${ui}/dashboard/intervjuer`);
    await staleCorrection
      .getByRole("article")
      .filter({ hasText: correctionName })
      .getByRole("button", { name: "Åpne intervju", exact: true })
      .click();
    await staleCorrection
      .getByRole("heading", { name: `Intervju med ${correctionName}` })
      .waitFor();
    await staleCorrection
      .locator("#question-interview-schema-native-conduct-0063-q0")
      .fill("Stale correction draft.");
    await staleCorrection.locator("#interviewer-recommendation").selectOption("Kanskje");
    await staleCorrection.locator("#score-explanatoryPower").selectOption("7");
    await page
      .locator("#question-interview-schema-native-conduct-0063-q0")
      .fill("Et nytt tydelig svar.");
    await page.locator("#score-explanatoryPower").selectOption("9");
    await page.locator("#interviewer-recommendation").selectOption("Nei");

    type CorrectionAttempt = {
      readonly phase: "failed-save" | "retry";
      readonly payload: unknown;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string | undefined;
      readonly fetchedStatus: number;
    };

    const correctionAttempts: CorrectionAttempt[] = [];
    let resolveFailedSave!: () => void;
    let rejectFailedSave!: (cause: unknown) => void;
    let resolveCorrectionRetry!: () => void;
    let rejectCorrectionRetry!: (cause: unknown) => void;

    const failedSaveSettled = new Promise<void>((resolve, reject) => {
      resolveFailedSave = resolve;
      rejectFailedSave = reject;
    });

    const correctionRetrySettled = new Promise<void>((resolve, reject) => {
      resolveCorrectionRetry = resolve;
      rejectCorrectionRetry = reject;
    });

    const correctionRoute = async (route: any) => {
      const request = route.request();

      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment") {
        await route.continue();

        return;
      }

      let payload: unknown;

      try {
        payload = request.postDataJSON();
      } catch {
        await route.continue();

        return;
      }

      if (
        payload === null ||
        !(payload === null || Predicate.isObjectOrArray(payload)) ||
        !("operation" in payload) ||
        payload.operation !== "correctInterviewAssessment"
      ) {
        await route.continue();

        return;
      }

      const headersValue = "headers" in payload ? payload.headers : undefined;

      const operationHeaders =
        (headersValue === null || Predicate.isObjectOrArray(headersValue)) && headersValue !== null
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

      try {
        const response = await route.fetch({ timeout: 30_000 });
        correctionAttempts.push({
          phase,
          payload,
          ifMatch,
          idempotencyKey,
          fetchedStatus: response.status(),
        });

        if (phase === "failed-save") {
          await response.body();
          await route.abort("failed");
          resolveFailedSave();

          return;
        }

        await route.fulfill({ response });
        resolveCorrectionRetry();
      } catch (cause) {
        (phase === "failed-save" ? rejectFailedSave : rejectCorrectionRetry)(cause);
      }
    };

    const rowsBeforeFailedSave = (
      await pool.query(
        `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

    assert.deepEqual(
      rowsBeforeFailedSave.map((row: any) => row.resulting_revision),
      [2],
    );
    await page.route("**/recruitment", correctionRoute);
    await page.getByRole("button", { name: "Rett intervju", exact: true }).last().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rett intervju", exact: true })
      .press("Enter");
    await failedSaveSettled;
    await page.locator("#interviewer-recommendation").waitFor({ state: "visible" });
    assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Nei");
    assert.equal(await page.locator("#score-explanatoryPower").inputValue(), "9");

    const rowsBeforeRetry = (
      await pool.query(
        `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

    assert.deepEqual(
      rowsBeforeRetry.map((row: any) => row.resulting_revision),
      [...rowsBeforeFailedSave.map((row: any) => row.resulting_revision), 3],
    );
    await page.getByRole("button", { name: "Rett intervju", exact: true }).last().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rett intervju", exact: true })
      .press("Enter");
    await correctionRetrySettled;
    assert.equal(correctionAttempts.length, 2);
    assert.deepEqual(correctionAttempts[1], {
      ...correctionAttempts[0],
      phase: "retry",
    });
    assert.equal(correctionAttempts[0]!.fetchedStatus, 200);
    await page.locator("#interviewer-recommendation").waitFor({ state: "visible" });
    await page.unroute("**/recruitment", correctionRoute);
    await page.reload();
    await correctionPageOpen();
    assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Nei");
    const browserHistory: any[] = (await (await get(correctionId)).json()).history;
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
        new Date(instant),
      );

    const historyView = page.locator(".fs-history");
    await historyView.waitFor();
    const historyText = () => historyView.textContent();
    assert.match((await historyText()) ?? "", /Original vurdering, versjon 1/u);
    assert.match((await historyText()) ?? "", /Korrigering, versjon 2/u);
    assert.match((await historyText()) ?? "", /Korrigering, versjon 3/u);
    assert.match((await historyText()) ?? "", /journey-conduct-leader-0063/u);
    const completionText = (await page.locator(".fs-conduct__completion").textContent()) ?? "";
    assert.match(completionText, /Fullført/u);
    assert.match(completionText, /journey-conduct-leader-0063/u);
    assert.match(completionText, new RegExp(formatUiInstant(beforeBody.finalizedAt), "u"));
    assert.match((await historyText()) ?? "", /Svar/u);
    assert.match((await historyText()) ?? "", /Et nytt tydelig svar/u);
    assert.match((await historyText()) ?? "", /Forklaringskraft7/u);
    assert.match((await historyText()) ?? "", /Rollemodell8/u);
    assert.match((await historyText()) ?? "", /Egnethet9/u);
    assert.match((await historyText()) ?? "", /Ja/u);
    assert.match((await historyText()) ?? "", /Nei/u);
    assert.match(
      (await historyText()) ?? "",
      new RegExp(formatUiInstant(browserHistory[0].finalizedAt), "u"),
    );
    assert.match(
      (await historyText()) ?? "",
      new RegExp(formatUiInstant(browserHistory[1].correctedAt), "u"),
    );
    assert.match(
      (await historyText()) ?? "",
      new RegExp(formatUiInstant(browserHistory[2].correctedAt), "u"),
    );
    const originalEntry = browserHistory[0];
    assert.deepEqual(originalEntry, beforeBody.history[0]);
    const originalView = historyView.locator(".fs-history__entry").nth(0);
    const originalText = (await originalView.textContent()) ?? "";
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
    assert.equal(await originalAnswerNodes.count(), Math.max(1, originalEntry.answers.length));

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

    assert.equal(await historyView.locator("input,textarea,select,button").count(), 0);
    await page.locator("#interviewer-recommendation").focus();
    assert.equal(
      await page
        .locator("#interviewer-recommendation")
        .evaluate((element: HTMLSelectElement) => element.ownerDocument.activeElement === element),
      true,
    );
    await page
      .locator(".fs-conduct")
      .screenshot({ path: join(artifacts, "correction-history-desktop.png") });
    await auditPage(page, "correction-history-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      (await page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth)) <= 390,
    );
    await page
      .locator(".fs-conduct")
      .screenshot({ path: join(artifacts, "correction-history-mobile.png") });
    await auditPage(page, "correction-history-mobile");
    await page.setViewportSize({ width: 1280, height: 900 });
    stage(
      "browser ordered original and correction history shows completion metadata after reload with keyboard/mobile/Axe evidence",
    );

    const staleCorrectionResponsePromise = staleCorrection.waitForResponse(
      (response: any) => operationFor(response.request()) === "correctInterviewAssessment",
    );

    await staleCorrection.getByRole("button", { name: "Rett intervju", exact: true }).click();
    await staleCorrection.getByRole("dialog").waitFor({ state: "visible" });
    await staleCorrection
      .getByRole("dialog")
      .getByRole("button", { name: "Rett intervju", exact: true })
      .press("Enter");
    const staleCorrectionResponse = await staleCorrectionResponsePromise;
    assert.equal(staleCorrectionResponse.status(), 409);
    const staleCorrectionRequest = staleCorrectionResponse.request();
    assert.equal(new URL(staleCorrectionRequest.url()).pathname, "/recruitment");
    const staleCorrectionRequestBody = staleCorrectionRequest.postDataJSON();
    assert.equal(staleCorrectionRequestBody.operation, "correctInterviewAssessment");
    assert.equal(staleCorrectionRequestBody.payload.expectedRevision, 2);
    assert.equal(staleCorrectionRequestBody.headers["if-match"], staleCorrectionEtag);
    assert.match(staleCorrectionRequestBody.headers["idempotency-key"] ?? "", /^[a-z0-9-]+$/);
    await staleCorrection
      .getByText(
        "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await staleCorrection
        .locator("#question-interview-schema-native-conduct-0063-q0")
        .inputValue(),
      "Stale correction draft.",
    );
    assert.equal(
      await staleCorrection.locator("#interviewer-recommendation").inputValue(),
      "Kanskje",
    );

    const staleRowsAfterConflict = (
      await pool.query(
        `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

    assert.deepEqual(
      staleRowsAfterConflict.map((row: any) => row.resulting_revision),
      [2, 3],
    );
    await staleCorrection.close();
    await staleCorrectionContext.close();
    stage("stale correction rejects old base and preserves visible draft without persistence");
    stage(
      "lost correction response retries identical payload, base and idempotency key without duplicate persistence",
    );
    stage("second correction and reload preserve ordered history");
    const afterSecond = await (await get(correctionId)).json();
    assert.ok(
      afterSecond.history.filter((entry: any) => Predicate.isTagged(entry, "Correction")).length >=
        2,
    );
    const afterSecondEtag = (await get(correctionId)).headers.get("etag");
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

    const originalConductAfterSql = (
      await pool.query(
        `SELECT to_jsonb(c) AS value
         FROM public.recruitment_interview_conducts c
         WHERE interview_id=$1`,
        [correctionId],
      )
    ).rows[0].value;

    assert.deepEqual(originalConductAfterSql, originalConductSql);

    const correctionRows = (
      await pool.query(
        `SELECT predecessor_revision AS "predecessorRevision",
                resulting_revision AS "resultingRevision",
                answers, explanatory_power AS "explanatoryPower",
                role_model AS "roleModel", suitability, recommendation,
                corrected_by_person_id AS "correctedByPersonId",
                command_id AS "commandId"
         FROM public.recruitment_interview_correction_assessments
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

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

    const receiptRows = (
      await pool.query(
        `SELECT command_id AS "commandId", predecessor_revision AS "predecessorRevision",
                resulting_revision AS "resultingRevision", command_json AS "commandJson",
                observation_json AS "observationJson"
         FROM public.recruitment_interview_correction_command_receipts
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

    const auditRows = (
      await pool.query(
        `SELECT command_id AS "commandId", actor_person_id AS "actorPersonId",
                predecessor_revision AS "predecessorRevision",
                resulting_revision AS "resultingRevision"
         FROM public.recruitment_interview_correction_audit
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;

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

    const writeCount = async () =>
      (
        await pool.query(
          `SELECT
             (SELECT count(*) FROM public.recruitment_interview_correction_assessments WHERE interview_id=$1) AS assessments,
             (SELECT count(*) FROM public.recruitment_interview_correction_command_receipts WHERE interview_id=$1) AS receipts,
             (SELECT count(*) FROM public.recruitment_interview_correction_audit WHERE interview_id=$1) AS audit,
             (SELECT revision FROM public.recruitment_interviews WHERE interview_id=$1) AS revision`,
          [correctionId],
        )
      ).rows[0];

    const beforeMismatch = await writeCount();

    const mismatched = await correctPost(
      correctionId,
      {
        expectedRevision: afterFirst.revision,
        answers: afterFirst.answers,
        score: afterFirst.score,
        recommendation: afterFirst.recommendation,
      },
      "correction-old-body-new-header-0105",
      afterSecondEtag!,
    );

    assert.equal(mismatched.status, 412);
    assert.deepEqual(await writeCount(), beforeMismatch);
    stage(
      "old displayed body with newer opaque ETag rejects at correction boundary without writes",
    );

    const correctionPayload = (detail: any, recommendation: "Ja" | "Kanskje" | "Nei") => ({
      expectedRevision: detail.revision,
      answers: [
        { questionId: "interview-schema-native-conduct-0063-q0", answer: "API correction answer" },
        { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
        { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
        { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
      ],
      score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
      recommendation,
    });

    const firstDirectDetail = await (await get(correctionId)).json();
    const firstDirectEtag = (await get(correctionId)).headers.get("etag")!;
    const firstDirectPayload = correctionPayload(firstDirectDetail, "Kanskje");

    const firstDirect = await correctPost(
      correctionId,
      firstDirectPayload,
      "correction-replay-0105-a",
      firstDirectEtag,
    );

    if (firstDirect.status !== 200) {
      throw new Error(`first direct correction ${firstDirect.status}: ${await firstDirect.text()}`);
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
    const firstBytes = await firstDirect.text();
    const secondDirectDetail = await (await get(correctionId)).json();
    const secondDirectEtag = (await get(correctionId)).headers.get("etag")!;

    const secondDirect = await correctPost(
      correctionId,
      correctionPayload(secondDirectDetail, "Nei"),
      "correction-replay-0105-b",
      secondDirectEtag,
    );

    assert.equal(secondDirect.status, 200);

    const replay = await correctPost(
      correctionId,
      acceptedCorrectionRequest.exactFourFieldPayload,
      acceptedCorrectionRequest.rawKey,
      acceptedCorrectionRequest.originalIfMatch,
    );

    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), firstBytes);
    stage("exact correction replay remains byte-stable after later correction");
    const raceDetail = await (await get(correctionId)).json();
    const raceEtag = (await get(correctionId)).headers.get("etag")!;
    const beforeRaceWrites = await writeCount();

    const race = await Promise.all(
      ["correction-race-0105-a", "correction-race-0105-b"].map((key, index) =>
        correctPost(
          correctionId,
          correctionPayload(raceDetail, index === 0 ? "Ja" : "Kanskje"),
          key,
          raceEtag,
        ),
      ),
    );

    assert.equal(race.filter((response) => response.status === 200).length, 1);
    assert.equal(race.filter((response) => response.status !== 200).length, 1);
    assert.ok(race.every((response) => [200, 409, 412].includes(response.status)));
    const winningRaceIndex = race.findIndex((response) => response.status === 200);
    expectedHistoricalReportRecommendation = winningRaceIndex === 0 ? "Ja" : "Kanskje";
    const afterRaceWrites = await writeCount();
    assert.equal(Number(afterRaceWrites.assessments), Number(beforeRaceWrites.assessments) + 1);
    assert.equal(Number(afterRaceWrites.receipts), Number(beforeRaceWrites.receipts) + 1);
    assert.equal(Number(afterRaceWrites.audit), Number(beforeRaceWrites.audit) + 1);
    assert.equal(Number(afterRaceWrites.revision), Number(beforeRaceWrites.revision) + 1);
    stage("same-revision concurrent corrections have one winner and one no-write loser");
    const finalDetail = await (await get(correctionId)).json();
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
    assert.deepEqual(await effectSnapshot(), effectsBefore);
    stage("corrections create no notification or application effects");
    await pool.query(
      `UPDATE public.organization_memberships SET is_suspended=true WHERE membership_id='membership-native-conduct-leader-0063'`,
    );
    assert.equal((await get(correctionId)).status, 403);
    assert.equal(
      (
        await correctPost(
          correctionId,
          acceptedCorrectionRequest.exactFourFieldPayload,
          acceptedCorrectionRequest.rawKey,
          acceptedCorrectionRequest.originalIfMatch,
        )
      ).status,
      403,
    );
    await pool.query(
      `UPDATE public.organization_memberships SET is_suspended=false WHERE membership_id='membership-native-conduct-leader-0063'`,
    );
    await pool.query(
      `UPDATE public.recruitment_interviews SET interviewer_person_id='recommendation-other-0101' WHERE interview_id=$1`,
      [correctionId],
    );
    assert.equal((await get(correctionId)).status, 403);
    assert.equal(
      (
        await correctPost(
          correctionId,
          acceptedCorrectionRequest.exactFourFieldPayload,
          acceptedCorrectionRequest.rawKey,
          acceptedCorrectionRequest.originalIfMatch,
        )
      ).status,
      403,
    );
    await pool.query(
      `UPDATE public.recruitment_interviews SET interviewer_person_id='journey-conduct-leader-0063' WHERE interview_id=$1`,
      [correctionId],
    );
    stage("authority revocation denies correction detail and replay before receipt reuse");
    await pool.query(
      `UPDATE public.organization_memberships SET end_at=date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC') - interval '24 hours' WHERE membership_id='membership-native-conduct-leader-0063'`,
    );
    assert.equal((await get(correctionId)).status, 403);
    assert.equal(
      (
        await correctPost(
          correctionId,
          acceptedCorrectionRequest.exactFourFieldPayload,
          acceptedCorrectionRequest.rawKey,
          acceptedCorrectionRequest.originalIfMatch,
        )
      ).status,
      403,
    );
    await pool.query(
      `UPDATE public.organization_memberships SET end_at=NULL WHERE membership_id='membership-native-conduct-leader-0063'`,
    );
    stage("ended membership denies correction detail and replay");
    const rollbackBefore = await writeCount();
    await pool.query(`
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
    `);
    const rollbackEtag = (await get(correctionId)).headers.get("etag")!;

    const rollbackResponse = await correctPost(
      correctionId,
      correctionPayload(finalDetail, "Ja"),
      "correction-rollback-0105",
      rollbackEtag,
    );

    assert.ok([500, 503].includes(rollbackResponse.status));
    assert.deepEqual(await writeCount(), rollbackBefore);
    await pool.query(`
      DROP TRIGGER test_correction_audit_failure
        ON public.recruitment_interview_correction_audit;
      DROP FUNCTION public.test_correction_audit_failure();
    `);
    stage("synthetic audit failure rolls back correction assessment, aggregate, receipt and audit");
    await assertInterviewCorrectionIntegrity(pool, correctionId);
    recordGate(
      "direct SQL correction integrity rejects immutable mutations, invalid predecessor, aggregate mismatch, and cross-command receipt/audit tuples without writes",
    );
    // R2: use a separate existing completed fixture, leaving the history/replay probes above intact.
    const windowInterviewId = "interview-correction-explicit-0105";
    const windowApplicationId = "application-correction-explicit-0105";
    const windowActor = "report-coordinator-0103";
    const windowGrant = "correction-window-announcement-grant-0029";
    const windowEnd = admissionJourneyClock().fromNow(1);

    const readWindowDetail = async () => {
      const response = await get(windowInterviewId);
      assert.equal(response.status, 200);

      return Schema.decodeUnknownSync(RecruitmentInterviewConductObservationSchema)(
        await response.json(),
      );
    };

    const openWindowInterview = async (target: any) => {
      const detail = await readWindowDetail();
      const name = `${detail.applicant.firstName} ${detail.applicant.lastName}`.trim();
      await target.goto(`${ui}/dashboard/intervjuer`);
      await target
        .getByRole("article")
        .filter({ hasText: name })
        .getByRole("button", { name: "Åpne intervju", exact: true })
        .click();
      await target.getByRole("heading", { name: `Intervju med ${name}` }).waitFor();
    };

    const windowSnapshot = async () =>
      (
        await pool.query(
          `SELECT
        (SELECT jsonb_agg(to_jsonb(row) ORDER BY revision) FROM public.admission_application_outcomes row WHERE application_id=$1) AS outcomes,
        (SELECT to_jsonb(row) FROM public.admission_outcome_announcements row WHERE application_id=$1) AS announcement,
        (SELECT jsonb_agg(jsonb_build_object('effectId',effect_id,'kind',kind,'template',template_revision_id,'payload',payload_json) ORDER BY effect_id) FROM public.admission_outcome_outbox WHERE application_id=$1) AS mail`,
          [windowApplicationId],
        )
      ).rows[0];
    // Synthetic fixture designation: the opener is also the assigned co-interviewer.

    await pool.query(
      "UPDATE public.recruitment_interviews SET co_interviewer_person_id=$1 WHERE interview_id=$2",
      [windowActor, windowInterviewId],
    );
    const windowContext = await browser.newContext();
    const windowPage = await windowContext.newPage();
    windowPage.on("pageerror", () => errors.push("correction-window-pageerror"));

    try {
      await windowPage.goto(`${ui}/login`);
      await windowPage
        .getByLabel("E-post", { exact: true })
        .fill("coordinator.report@example.invalid");
      await windowPage.getByLabel("Passord", { exact: true }).fill(password);
      await windowPage.getByRole("button", { name: "Logg inn", exact: true }).click();
      await windowPage.waitForURL(/\/dashboard\/?$/);
      const windowCookies = await windowContext.cookies();

      const windowCookie = windowCookies
        .map((entry: any) => `${entry.name}=${entry.value}`)
        .join("; ");

      secrets.push(...windowCookies.map((entry: any) => entry.value));
      assert.ok(maintenanceFixture, "correction mode owns an isolated nonterminal staffing target");
      const maintenanceGrant = "maintenance-journey-global-grant-0029";

      const maintenanceSnapshot = async () =>
        Schema.decodeUnknownSync(Schema.JsonObject)(
          (
            await pool.query(
              `SELECT
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_schema_id) FROM public.recruitment_interview_schemas r) AS questionnaires,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_schema_id,ordinal) FROM public.recruitment_interview_schema_questions r) AS questions,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_schema_id,revision) FROM public.recruitment_questionnaire_history r) AS questionnaire_history,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id,revision) FROM public.recruitment_staffing_history r) AS staffing_history,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id) FROM public.recruitment_interviews r) AS interviews,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id) FROM public.recruitment_interview_conducts r) AS conducts,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id,resulting_revision) FROM public.recruitment_interview_correction_assessments r) AS corrections,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM public.recruitment_interview_correction_command_receipts r) AS correction_receipts,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM public.recruitment_interview_correction_audit r) AS correction_audit,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id,sequence) FROM public.recruitment_assessment_correction_windows r) AS windows,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_person_id,command_id) FROM public.recruitment_assessment_correction_window_audit r) AS window_audit,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_person_id,command_id) FROM public.recruitment_maintenance_command_receipts r) AS maintenance_receipts,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY identity_sha256) FROM public.native_http_idempotency_receipts r) AS http_receipts`,
            )
          ).rows[0],
        );

      const capturedInterviewFacts = async () =>
        Schema.decodeUnknownSync(Schema.JsonObject)(
          (
            await pool.query(
              `SELECT
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id) FROM public.recruitment_interview_schedules r) AS schedules,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY invitation_id) FROM public.recruitment_invitations r) AS invitations,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY invitation_id,response_revision) FROM public.recruitment_invitation_response_audit r) AS responses,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY interview_id,ordinal) FROM public.recruitment_interview_question_snapshots r) AS questions`,
            )
          ).rows[0],
        );

      const capturedBeforeMaintenance = await capturedInterviewFacts();
      const effectsBeforeMaintenance = await effectSnapshot();

      const assertMaintenanceReceipt = async (
        attempt: Awaited<ReturnType<typeof observeMaintenanceSave>>,
      ) => {
        const domainRows = (
          await pool.query(
            "SELECT result_json FROM public.recruitment_maintenance_command_receipts WHERE actor_person_id=$1 AND command_id=$2",
            [windowActor, attempt.command.commandId],
          )
        ).rows;

        assert.equal(domainRows.length, 1);
        assert.deepEqual(decodeMaintenanceResult(domainRows[0].result_json), attempt.result);

        const identity = deriveHttpIdentity({
          credentialSubject: `Person:${windowActor}`,
          qualifiedOperationId: maintenanceOperation.operationId,
          normalizedTarget: maintenanceOperation.path,
          idempotencyKey: attempt.command.commandId,
        });

        const httpRows = (
          await pool.query(
            "SELECT operation_id,state,status,convert_from(body_bytes,'UTF8') AS body,headers_json FROM public.native_http_idempotency_receipts WHERE identity_sha256=$1",
            [identity.identitySha256],
          )
        ).rows;

        assert.equal(httpRows.length, 1);
        assert.deepEqual(httpRows[0], {
          operation_id: maintenanceOperation.operationId,
          state: "Complete",
          status: 200,
          body: attempt.bytes,
          headers_json: { "content-type": "application/json", etag: attempt.etag },
        });
        maintenanceSqlObservations.push({
          kind: "MaintenanceReceipts",
          body: { domain: domainRows, http: httpRows },
        });
      };

      const assertMaintenanceRefused = async (
        command: RecruitmentMaintenanceCommand,
        status: number,
        code: string,
        authorityCookie = windowCookie,
      ) => {
        const before = await maintenanceSnapshot();
        const effects = await effectSnapshot();
        const refused = await postMaintenance(command, authorityCookie);
        assert.equal(refused.status, status, await refused.clone().text());
        const problem = decodeProblem(await refused.json());
        assert.equal(problem.code, code);
        assert.deepEqual(
          await maintenanceSnapshot(),
          before,
          "refusal leaves state, history and both receipt kinds unchanged",
        );
        assert.deepEqual(await effectSnapshot(), effects, "refusal creates no effects");
        maintenanceRequests.push({
          ...maintenanceOperation,
          status: refused.status,
          body: problem,
          command,
          idempotencyKey: command.commandId,
        });
      };

      // This temporary grant owns maintenance only; the announcement below keeps its own grant.
      await pool.query(
        "INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at) VALUES($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))",
        [maintenanceGrant, windowActor],
      );

      try {
        const initialQuestionnaires = await observeMaintenanceRead(
          windowPage,
          questionnairesOperation,
          QuestionnaireManagement,
          async () => {
            await windowPage.goto(ui + "/dashboard/intervjusjema");
          },
        );

        await expect(windowPage.getByLabel("Velg intervjuskjema", { exact: true })).toBeEnabled();
        await windowPage
          .getByLabel("Navn på intervjuskjema", { exact: true })
          .fill("Maintenance journey questionnaire");
        await windowPage.getByLabel("Aktivt for nye intervjuer", { exact: true }).check();
        await windowPage.getByRole("button", { name: "Legg til spørsmål", exact: true }).click();
        await windowPage
          .getByLabel("Spørsmål", { exact: true })
          .fill("First saved maintenance question");
        await windowPage.getByRole("button", { name: "Legg til spørsmål", exact: true }).click();
        await windowPage
          .getByLabel("Spørsmål", { exact: true })
          .nth(1)
          .fill("Second saved maintenance question");
        await windowPage
          .getByLabel("Begrunnelse", { exact: true })
          .fill("Create an audited questionnaire");
        const createdRead = nativeResponseFor(windowPage, questionnairesOperation);

        const created = await observeMaintenanceSave(windowPage, "CreateQuestionnaire", () =>
          windowPage
            .getByRole("button", { name: "Opprett intervjuskjema", exact: true })
            .press("Enter"),
        );

        assert.ok(Predicate.isTagged(created.command, "CreateQuestionnaire"));
        assert.ok(Predicate.isTagged(created.result, "QuestionnaireSaved"));
        const questionnaireId = created.result.interviewSchemaId;
        assert.equal(created.result.revision, 0);
        assert.equal(
          initialQuestionnaires.questionnaires.some(
            (entry) => entry.interviewSchemaId === questionnaireId,
          ),
          false,
        );
        const createdResponse = await createdRead;
        assert.equal(createdResponse.status(), 200);
        const createdBoard = decodeQuestionnaires(await createdResponse.json());
        maintenanceRequests.push({ ...questionnairesOperation, status: 200, body: createdBoard });

        const firstDefinition = createdBoard.questionnaires.find(
          (entry) => entry.interviewSchemaId === questionnaireId,
        );

        assert.ok(firstDefinition);
        assert.deepEqual(firstDefinition.questions, created.command.questions);
        assert.equal(firstDefinition.active, true);
        assert.equal(firstDefinition.sourceState, "Available");
        assert.equal(firstDefinition.questionCount, 2);
        await expect(windowPage.getByLabel("Velg intervjuskjema", { exact: true })).toHaveValue(
          questionnaireId,
        );
        await expect(
          windowPage.getByLabel("Navn på intervjuskjema", { exact: true }),
        ).toBeEnabled();
        await windowPage
          .getByLabel("Navn på intervjuskjema", { exact: true })
          .fill("Revised maintenance journey questionnaire");
        await windowPage.getByRole("button", { name: "Flytt spørsmål 2 opp", exact: true }).click();
        await windowPage
          .getByLabel("Hjelpetekst (valgfritt)", { exact: true })
          .first()
          .fill("A revised saved explanation");
        await windowPage
          .getByLabel("Begrunnelse", { exact: true })
          .fill("Revise and reorder without changing captured interview questions");
        const revisedRead = nativeResponseFor(windowPage, questionnairesOperation);

        const revised = await observeMaintenanceSave(windowPage, "ReviseQuestionnaire", () =>
          windowPage
            .getByRole("button", { name: "Lagre intervjuskjema", exact: true })
            .press("Enter"),
        );

        assert.ok(Predicate.isTagged(revised.command, "ReviseQuestionnaire"));
        assert.ok(Predicate.isTagged(revised.result, "QuestionnaireSaved"));
        assert.equal(revised.command.interviewSchemaId, questionnaireId);
        assert.equal(revised.command.expectedRevision, firstDefinition.revision);
        assert.deepEqual(
          revised.result,
          RecruitmentMaintenanceResult.cases.QuestionnaireSaved.make({
            interviewSchemaId: questionnaireId,
            revision: firstDefinition.revision + 1,
          }),
        );
        const revisedResponse = await revisedRead;
        assert.equal(revisedResponse.status(), 200);
        const revisedBoard = decodeQuestionnaires(await revisedResponse.json());
        maintenanceRequests.push({ ...questionnairesOperation, status: 200, body: revisedBoard });

        const currentDefinition = revisedBoard.questionnaires.find(
          (entry) => entry.interviewSchemaId === questionnaireId,
        );

        assert.ok(currentDefinition);
        assert.deepEqual(currentDefinition.questions, revised.command.questions);
        assert.deepEqual(
          currentDefinition.questions.map((question) => question.prompt),
          ["Second saved maintenance question", "First saved maintenance question"],
        );

        const persistedQuestionnaire = Schema.decodeUnknownSync(Schema.JsonObject)(
          (
            await pool.query(
              `SELECT name,active,revision,question_count FROM public.recruitment_interview_schemas WHERE interview_schema_id=$1`,
              [questionnaireId],
            )
          ).rows[0],
        );

        assert.deepEqual(persistedQuestionnaire, {
          name: currentDefinition.name,
          active: currentDefinition.active,
          revision: currentDefinition.revision,
          question_count: currentDefinition.questionCount,
        });

        const persistedQuestions = Schema.decodeUnknownSync(
          QuestionnaireManagement.fields.questionnaires.value.fields.questions,
        )(
          (
            await pool.query(
              `SELECT question_id AS "questionId",ordinal,prompt,help_text AS "helpText",kind,alternatives
            FROM public.recruitment_interview_schema_questions WHERE interview_schema_id=$1 ORDER BY ordinal`,
              [questionnaireId],
            )
          ).rows,
        );

        assert.deepEqual(persistedQuestions, currentDefinition.questions);
        maintenanceSqlObservations.push({
          kind: "CurrentQuestionnaire",
          body: { definition: persistedQuestionnaire, questions: persistedQuestions },
        });

        const questionnaireHistorySql = Schema.decodeUnknownSync(
          QuestionnaireManagement.fields.history,
        )(
          (
            await pool.query(
              `SELECT command_id AS "commandId",actor_person_id AS "actorPersonId",interview_schema_id AS "interviewSchemaId",reason,revision,
            to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",before_json AS before,after_json AS after
            FROM public.recruitment_questionnaire_history WHERE interview_schema_id=$1 ORDER BY revision DESC`,
              [questionnaireId],
            )
          ).rows,
        );

        assert.equal(questionnaireHistorySql.length, 2);
        assert.deepEqual(
          revisedBoard.history.filter((entry) => entry.interviewSchemaId === questionnaireId),
          questionnaireHistorySql,
        );
        assert.deepEqual(
          questionnaireHistorySql.map((entry) => [
            entry.revision,
            entry.commandId,
            entry.actorPersonId,
            entry.reason,
            entry.before,
            entry.after,
          ]),
          [
            [
              currentDefinition.revision,
              revised.command.commandId,
              windowActor,
              revised.command.reason,
              firstDefinition,
              currentDefinition,
            ],
            [
              firstDefinition.revision,
              created.command.commandId,
              windowActor,
              created.command.reason,
              null,
              firstDefinition,
            ],
          ],
        );

        const reloadedQuestionnaires = await observeMaintenanceRead(
          windowPage,
          questionnairesOperation,
          QuestionnaireManagement,
          async () => {
            await windowPage.reload();
          },
        );

        assert.deepEqual(
          reloadedQuestionnaires.history.filter(
            (entry) => entry.interviewSchemaId === questionnaireId,
          ),
          questionnaireHistorySql,
        );
        assert.deepEqual(
          reloadedQuestionnaires.questionnaires.find(
            (entry) => entry.interviewSchemaId === questionnaireId,
          ),
          currentDefinition,
        );
        await windowPage
          .getByLabel("Velg intervjuskjema", { exact: true })
          .selectOption(questionnaireId);
        await expect(windowPage.getByLabel("Navn på intervjuskjema", { exact: true })).toHaveValue(
          currentDefinition.name,
        );
        await expect(windowPage.getByLabel("Spørsmål", { exact: true })).toHaveCount(2);

        for (const [index, question] of currentDefinition.questions.entries())
          await expect(windowPage.getByLabel("Spørsmål", { exact: true }).nth(index)).toHaveValue(
            question.prompt,
          );

        const questionnaireHistoryView = windowPage.getByRole("region", {
          name: "Vedlikeholdshistorikk",
          exact: true,
        });

        await expect(questionnaireHistoryView.locator(".rm-history-entry")).toHaveCount(2);

        for (const [index, saved] of questionnaireHistorySql.entries()) {
          const entry = questionnaireHistoryView.locator(".rm-history-entry").nth(index);
          await expect(entry).toContainText(
            `Versjon ${saved.revision} · ${saved.recordedAt} · ${windowActor}`,
          );
          await expect(entry).toContainText(saved.reason);
          await entry.locator("summary").press("Enter");
          await expect(entry).toContainText(saved.after.name);
          assert.deepEqual(
            await entry.locator("details > ol > li > p:first-child").allTextContents(),
            saved.after.questions.map((question) => `${question.prompt} (${question.kind})`),
          );
          assert.equal(await entry.locator("input,textarea,select,button").count(), 0);
        }

        await assertMaintenanceReceipt(created);
        await assertMaintenanceReceipt(revised);
        const questionnaireBeforeReplay = await maintenanceSnapshot();

        const replayedQuestionnaire = await fetch(api + maintenanceOperation.path, {
          method: maintenanceOperation.method,
          headers: {
            cookie: windowCookie,
            origin: ui,
            "content-type": "application/json",
            "idempotency-key": created.command.commandId,
          },
          body: created.rawBody,
        });

        assert.equal(replayedQuestionnaire.status, 200);
        assert.equal(await replayedQuestionnaire.text(), created.bytes);
        assert.deepEqual(await maintenanceSnapshot(), questionnaireBeforeReplay);
        await assertMaintenanceRefused(
          RecruitmentMaintenanceCommand.cases.ReviseQuestionnaire.make({
            ...revised.command,
            commandId: "maintenance-stale-questionnaire-0029",
            expectedRevision: firstDefinition.revision,
          }),
          412,
          "precondition.failed",
        );
        stage(
          "Gate5 native questionnaires create/revise, fresh/reload saved definitions and independent immutable history/receipt evidence",
        );

        const initialStaffing = await observeMaintenanceRead(
          windowPage,
          staffingOperation,
          InterviewStaffingManagement,
          async () => {
            await windowPage.goto(ui + "/dashboard/intervjubemanning");
          },
        );

        const initialInterview = initialStaffing.interviews.find(
          (entry) => entry.interviewId === maintenanceFixture.interviewId,
        );

        assert.ok(initialInterview);
        assert.equal(initialInterview.terminal, false);
        const { assessmentCorrection: _initialWindow, ...firstStaffing } = initialInterview;

        const primary = initialStaffing.candidates.find(
          (entry) =>
            entry.departmentId === initialInterview.departmentId &&
            entry.personId === initialInterview.interviewerPersonId,
        );

        const co = initialStaffing.candidates.find(
          (entry) =>
            entry.departmentId === initialInterview.departmentId &&
            entry.personId === windowActor &&
            entry.personId !== initialInterview.interviewerPersonId,
        );

        assert.ok(primary);
        assert.ok(co);
        await windowPage
          .getByLabel("Velg intervju", { exact: true })
          .selectOption(maintenanceFixture.interviewId);
        await windowPage
          .getByLabel("Hovedintervjuer", { exact: true })
          .selectOption(primary.personId);
        await windowPage
          .getByLabel("Medintervjuer (valgfritt)", { exact: true })
          .selectOption(co.personId);
        await windowPage
          .getByLabel("Begrunnelse", { exact: true })
          .fill("Designate the eligible maintenance interview pair");
        const changedRead = nativeResponseFor(windowPage, staffingOperation);

        const changed = await observeMaintenanceSave(windowPage, "ChangeInterviewStaffing", () =>
          windowPage.getByRole("button", { name: "Lagre bemanning", exact: true }).press("Enter"),
        );

        assert.ok(Predicate.isTagged(changed.command, "ChangeInterviewStaffing"));
        assert.ok(Predicate.isTagged(changed.result, "InterviewStaffingChanged"));
        assert.equal(changed.command.expectedRevision, firstStaffing.revision);
        const changedResponse = await changedRead;
        assert.equal(changedResponse.status(), 200);
        const changedBoard = decodeStaffing(await changedResponse.json());
        maintenanceRequests.push({ ...staffingOperation, status: 200, body: changedBoard });

        const changedInterview = changedBoard.interviews.find(
          (entry) => entry.interviewId === firstStaffing.interviewId,
        );

        assert.ok(changedInterview);
        const { assessmentCorrection: _changedWindow, ...secondStaffing } = changedInterview;
        assert.deepEqual(secondStaffing, {
          ...firstStaffing,
          interviewerPersonId: primary.personId,
          coInterviewerPersonId: co.personId,
          revision: firstStaffing.revision + 1,
        });
        assert.deepEqual(
          changed.result,
          RecruitmentMaintenanceResult.cases.InterviewStaffingChanged.make({
            interviewId: firstStaffing.interviewId,
            revision: secondStaffing.revision,
          }),
        );
        await expect(windowPage.getByLabel("Hovedintervjuer", { exact: true })).toBeEnabled();
        await windowPage.getByLabel("Hovedintervjuer", { exact: true }).selectOption(co.personId);
        await windowPage
          .getByLabel("Medintervjuer (valgfritt)", { exact: true })
          .selectOption(primary.personId);
        await windowPage
          .getByLabel("Begrunnelse", { exact: true })
          .fill("Swap the audited pair without changing invitation or answers");
        const swappedRead = nativeResponseFor(windowPage, staffingOperation);

        const swapped = await observeMaintenanceSave(windowPage, "ChangeInterviewStaffing", () =>
          windowPage.getByRole("button", { name: "Lagre bemanning", exact: true }).press("Enter"),
        );

        assert.ok(Predicate.isTagged(swapped.command, "ChangeInterviewStaffing"));
        assert.ok(Predicate.isTagged(swapped.result, "InterviewStaffingChanged"));
        assert.equal(swapped.command.expectedRevision, secondStaffing.revision);
        const swappedResponse = await swappedRead;
        assert.equal(swappedResponse.status(), 200);
        const swappedBoard = decodeStaffing(await swappedResponse.json());
        maintenanceRequests.push({ ...staffingOperation, status: 200, body: swappedBoard });

        const swappedInterview = swappedBoard.interviews.find(
          (entry) => entry.interviewId === firstStaffing.interviewId,
        );

        assert.ok(swappedInterview);
        const { assessmentCorrection: _swappedWindow, ...thirdStaffing } = swappedInterview;
        assert.deepEqual(thirdStaffing, {
          ...secondStaffing,
          interviewerPersonId: co.personId,
          coInterviewerPersonId: primary.personId,
          revision: secondStaffing.revision + 1,
        });
        assert.deepEqual(
          swapped.result,
          RecruitmentMaintenanceResult.cases.InterviewStaffingChanged.make({
            interviewId: firstStaffing.interviewId,
            revision: thirdStaffing.revision,
          }),
        );

        const staffingHistorySql = Schema.decodeUnknownSync(
          InterviewStaffingManagement.fields.history,
        )(
          (
            await pool.query(
              `SELECT command_id AS "commandId",actor_person_id AS "actorPersonId",interview_id AS "interviewId",reason,revision,
            to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",before_json AS before,after_json AS after
            FROM public.recruitment_staffing_history WHERE interview_id=$1 ORDER BY revision DESC`,
              [firstStaffing.interviewId],
            )
          ).rows,
        );

        assert.equal(staffingHistorySql.length, 2);
        assert.deepEqual(
          swappedBoard.history.filter((entry) => entry.interviewId === firstStaffing.interviewId),
          staffingHistorySql,
        );
        assert.deepEqual(
          staffingHistorySql.map((entry) => [
            entry.revision,
            entry.commandId,
            entry.actorPersonId,
            entry.reason,
            entry.before,
            entry.after,
          ]),
          [
            [
              thirdStaffing.revision,
              swapped.command.commandId,
              windowActor,
              swapped.command.reason,
              secondStaffing,
              thirdStaffing,
            ],
            [
              secondStaffing.revision,
              changed.command.commandId,
              windowActor,
              changed.command.reason,
              firstStaffing,
              secondStaffing,
            ],
          ],
        );

        const reloadedStaffing = await observeMaintenanceRead(
          windowPage,
          staffingOperation,
          InterviewStaffingManagement,
          async () => {
            await windowPage.reload();
          },
        );

        assert.deepEqual(
          reloadedStaffing.history.filter(
            (entry) => entry.interviewId === firstStaffing.interviewId,
          ),
          staffingHistorySql,
        );
        await windowPage
          .getByLabel("Velg intervju", { exact: true })
          .selectOption(firstStaffing.interviewId);
        await expect(windowPage.getByLabel("Hovedintervjuer", { exact: true })).toHaveValue(
          thirdStaffing.interviewerPersonId,
        );
        await expect(
          windowPage.getByLabel("Medintervjuer (valgfritt)", { exact: true }),
        ).toHaveValue(thirdStaffing.coInterviewerPersonId);

        const persistedStaffing = Schema.decodeUnknownSync(Schema.JsonObject)(
          (
            await pool.query(
              `SELECT interviewer_person_id,co_interviewer_person_id,revision FROM public.recruitment_interviews WHERE interview_id=$1`,
              [firstStaffing.interviewId],
            )
          ).rows[0],
        );

        assert.deepEqual(persistedStaffing, {
          interviewer_person_id: thirdStaffing.interviewerPersonId,
          co_interviewer_person_id: thirdStaffing.coInterviewerPersonId,
          revision: thirdStaffing.revision,
        });
        maintenanceSqlObservations.push({ kind: "CurrentStaffing", body: persistedStaffing });

        const staffingHistoryView = windowPage.getByRole("region", {
          name: "Vedlikeholdshistorikk",
          exact: true,
        });

        await expect(staffingHistoryView.locator(".rm-history-entry")).toHaveCount(2);

        for (const [index, saved] of staffingHistorySql.entries()) {
          const entry = staffingHistoryView.locator(".rm-history-entry").nth(index);
          await expect(entry).toContainText(
            `Versjon ${saved.revision} · ${saved.recordedAt} · ${windowActor}`,
          );
          await expect(entry).toContainText(saved.reason);
          await expect(entry).toContainText(
            `Fra: ${saved.before.interviewerPersonId} / ${saved.before.coInterviewerPersonId ?? "ingen medintervjuer"}`,
          );
          await expect(entry).toContainText(
            `Til: ${saved.after.interviewerPersonId} / ${saved.after.coInterviewerPersonId ?? "ingen medintervjuer"}`,
          );
          assert.equal(await entry.locator("input,textarea,select,button").count(), 0);
        }

        await assertMaintenanceReceipt(changed);
        await assertMaintenanceReceipt(swapped);
        const staffingBeforeReplay = await maintenanceSnapshot();

        const replayedStaffing = await fetch(api + maintenanceOperation.path, {
          method: maintenanceOperation.method,
          headers: {
            cookie: windowCookie,
            origin: ui,
            "content-type": "application/json",
            "idempotency-key": changed.command.commandId,
          },
          body: changed.rawBody,
        });

        assert.equal(replayedStaffing.status, 200);
        assert.equal(await replayedStaffing.text(), changed.bytes);
        assert.deepEqual(await maintenanceSnapshot(), staffingBeforeReplay);
        await assertMaintenanceRefused(
          RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.make({
            ...swapped.command,
            commandId: "maintenance-stale-staffing-0029",
            expectedRevision: secondStaffing.revision,
          }),
          412,
          "precondition.failed",
        );
        await assertMaintenanceRefused(
          RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.make({
            ...swapped.command,
            commandId: "maintenance-ineligible-staffing-0029",
            expectedRevision: thirdStaffing.revision,
            coInterviewerPersonId: co.personId,
          }),
          422,
          "recruitment.ineligible",
        );

        const terminal = reloadedStaffing.interviews.find(
          (entry) => entry.interviewId === windowInterviewId,
        );

        assert.ok(terminal?.terminal);
        await assertMaintenanceRefused(
          RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.make({
            ...swapped.command,
            commandId: "maintenance-terminal-staffing-0029",
            interviewId: terminal.interviewId,
            expectedRevision: terminal.revision,
          }),
          409,
          "recruitment.terminal",
        );
        const beforeImmutable = await maintenanceSnapshot();

        for (const [statement, identity] of [
          [
            "UPDATE public.recruitment_questionnaire_history SET reason='rewritten evidence' WHERE interview_schema_id=$1",
            questionnaireId,
          ],
          [
            "DELETE FROM public.recruitment_questionnaire_history WHERE interview_schema_id=$1",
            questionnaireId,
          ],
          [
            "UPDATE public.recruitment_staffing_history SET reason='rewritten evidence' WHERE interview_id=$1",
            firstStaffing.interviewId,
          ],
          [
            "DELETE FROM public.recruitment_staffing_history WHERE interview_id=$1",
            firstStaffing.interviewId,
          ],
          [
            "UPDATE public.recruitment_maintenance_command_receipts SET result_json='{}'::jsonb WHERE command_id=$1",
            created.command.commandId,
          ],
          [
            "DELETE FROM public.recruitment_maintenance_command_receipts WHERE command_id=$1",
            changed.command.commandId,
          ],
        ]) {
          await assert.rejects(pool.query(statement, [identity]), {
            code: "P0001",
            message: "Recruitment maintenance evidence is immutable",
          });
        }

        assert.deepEqual(await maintenanceSnapshot(), beforeImmutable);
        maintenanceSqlObservations.push({
          kind: "QuestionnaireHistory",
          body: questionnaireHistorySql,
        });
        maintenanceSqlObservations.push({ kind: "StaffingHistory", body: staffingHistorySql });
        assert.deepEqual(
          await capturedInterviewFacts(),
          capturedBeforeMaintenance,
          "maintenance retains schedules, invitations/responses and all captured interview questions",
        );
        assert.deepEqual(
          await effectSnapshot(),
          effectsBeforeMaintenance,
          "questionnaire/staffing edits create no notifications or application effects",
        );
        stage(
          "Gate5 native staffing pair changes, fresh/reload Fra/Til histories, SQL immutability, exact replay and no-write stale/ineligible/terminal refusal",
        );
      } finally {
        await pool.query(
          "DELETE FROM public.organization_global_administrator_grants WHERE grant_id=$1",
          [maintenanceGrant],
        );
      }

      const beforeQuestionnaireDenial = await maintenanceSnapshot();

      const deniedQuestionnaires = await fetch(api + questionnairesOperation.path, {
        headers: { cookie: windowCookie, origin: ui },
      });

      assert.equal(deniedQuestionnaires.status, 403);
      const deniedQuestionnaireProblem = decodeProblem(await deniedQuestionnaires.json());
      assert.equal(deniedQuestionnaireProblem.code, "authority.denied");
      maintenanceRequests.push({
        ...questionnairesOperation,
        status: 403,
        body: deniedQuestionnaireProblem,
      });
      await assertMaintenanceRefused(
        RecruitmentMaintenanceCommand.cases.CreateQuestionnaire.make({
          commandId: "maintenance-questionnaire-denied-0029",
          reason: "Scoped coordinators cannot create global questionnaires",
          name: "Denied questionnaire",
          active: false,
          questions: [],
        }),
        403,
        "authority.denied",
      );
      assert.deepEqual(await maintenanceSnapshot(), beforeQuestionnaireDenial);
      assert.deepEqual(await effectSnapshot(), effectsBeforeMaintenance);
      stage(
        "Gate5 questionnaire GET and native create deny after global grant removal without state, receipts, history or effects",
      );
      await pool.query(
        "INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at) VALUES($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))",
        [windowGrant, windowActor],
      );

      const outcomeRead = await fetch(`${api}/api/admission-outcomes/${windowApplicationId}`, {
        headers: { cookie: windowCookie, origin: ui },
      });

      assert.equal(outcomeRead.status, 200);
      const outcome = Schema.decodeUnknownSync(AdmissionOutcomeResource)(await outcomeRead.json());
      assert.equal(outcome.basis, "Ja");

      const announced = await fetch(
        `${api}/api/admission-outcomes/${windowApplicationId}:announce`,
        {
          method: "POST",
          headers: {
            cookie: windowCookie,
            origin: ui,
            "content-type": "application/json",
            "if-match": outcome.etag,
            "idempotency-key": "correction-window-announce-0029",
          },
          body: "{}",
        },
      );

      assert.equal(announced.status, 200, await announced.clone().text());
      assert.equal(
        Schema.decodeUnknownSync(AdmissionOutcomeAnnounceResource)(await announced.json()).outcome,
        "Admitted",
      );
      await pool.query(
        "DELETE FROM public.organization_global_administrator_grants WHERE grant_id=$1",
        [windowGrant],
      );
      const frozen = await windowSnapshot();
      const closed = await readWindowDetail();
      assert.equal(closed.assessmentCorrection._tag, "Closed");
      assert.equal(closed.assessmentCorrection.canCorrect, false);
      await openWindowInterview(page);
      assert.equal(
        await page.getByRole("button", { name: "Rett intervju", exact: true }).isDisabled(),
        true,
      );
      assert.equal(await page.locator("#interviewer-recommendation").isDisabled(), true);

      const windowStaffing = await observeMaintenanceRead(
        windowPage,
        staffingOperation,
        InterviewStaffingManagement,
        async () => {
          await windowPage.goto(`${ui}/dashboard/intervjubemanning`);
        },
      );

      const windowStaffingEntry = windowStaffing.interviews.find(
        (entry) => entry.interviewId === windowInterviewId,
      );

      assert.ok(windowStaffingEntry);
      assert.equal(windowStaffingEntry.assessmentCorrection._tag, "Closed");
      assert.equal(
        windowStaffingEntry.assessmentCorrection.sequence,
        closed.assessmentCorrection.sequence,
      );
      assert.equal(windowStaffingEntry.assessmentCorrection.canReopen, true);
      await windowPage.getByLabel("Velg intervju", { exact: true }).selectOption(windowInterviewId);
      const staleWindowPage = await windowContext.newPage();

      try {
        const staleStaffing = await observeMaintenanceRead(
          staleWindowPage,
          staffingOperation,
          InterviewStaffingManagement,
          async () => {
            await staleWindowPage.goto(`${ui}/dashboard/intervjubemanning`);
          },
        );

        const staleInterview = staleStaffing.interviews.find(
          (entry) => entry.interviewId === windowInterviewId,
        );

        assert.ok(staleInterview);
        assert.equal(
          staleInterview.assessmentCorrection.sequence,
          closed.assessmentCorrection.sequence,
        );
        await staleWindowPage
          .getByLabel("Velg intervju", { exact: true })
          .selectOption(windowInterviewId);
        await windowPage
          .getByRole("button", { name: "Gjenåpne retting", exact: true })
          .press("Enter");

        const windowDialog = windowPage.getByRole("dialog", {
          name: "Gjenåpne retting",
          exact: true,
        });

        await windowDialog.waitFor();
        await assertWindowFocus(windowPage, windowDialog);

        const reopenButton = windowPage.getByRole("button", {
          name: "Gjenåpne retting",
          exact: true,
        });

        const beforeReopenDismissal = await maintenanceSnapshot();
        await windowPage.keyboard.press("Escape");
        await windowDialog.waitFor({ state: "hidden" });
        await expect(reopenButton).toBeFocused();
        await reopenButton.press("Enter");
        await assertWindowFocus(windowPage, windowDialog);
        await windowDialog.getByRole("button", { name: "Tilbake", exact: true }).press("Enter");
        await windowDialog.waitFor({ state: "hidden" });
        await expect(reopenButton).toBeFocused();
        assert.deepEqual(
          await maintenanceSnapshot(),
          beforeReopenDismissal,
          "dismissal sends no reopen command",
        );
        await reopenButton.press("Enter");
        await assertWindowFocus(windowPage, windowDialog);
        await windowDialog
          .getByLabel("Begrunnelse for rettingsvindu", { exact: true })
          .fill("Synthetic audited correction window");
        await windowDialog
          .getByLabel("Sluttidspunkt (med tidssone)", { exact: true })
          .fill(windowEnd);
        assert.deepEqual(await auditPage(windowPage, "correction-window-dialog"), []);
        await windowPage.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          (await windowPage
            .locator("html")
            .evaluate((element: HTMLElement) => element.scrollWidth)) <=
            windowPage.viewportSize().width,
        );
        assert.deepEqual(await auditPage(windowPage, "correction-window-dialog-mobile"), []);
        await windowPage.setViewportSize({ width: 1280, height: 900 });
        const windowAttempts: Array<{ body: string; key: string | undefined }> = [];
        await windowPage.route("**" + maintenanceOperation.path, async (route: any) => {
          const request = route.request();

          if (request.method() !== "POST") return route.continue();

          const command = Schema.decodeUnknownSync(RecruitmentMaintenanceCommand)(
            request.postDataJSON(),
          );

          assert.ok(Predicate.isTagged(command, "ReopenAssessmentCorrection"));
          assert.equal(command.expectedSequence, closed.assessmentCorrection.sequence);
          windowAttempts.push({
            body: request.postData(),
            key: request.headers()["idempotency-key"],
          });
          assert.equal(request.headers()["idempotency-key"], command.commandId);
          assert.equal(command.interviewId, windowInterviewId);
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          const result = decodeMaintenanceResult(await response.json());
          assert.deepEqual(
            result,
            RecruitmentMaintenanceResult.cases.AssessmentCorrectionReopened.make({
              interviewId: windowInterviewId,
              sequence: closed.assessmentCorrection.sequence + 1,
            }),
          );

          const attempt = {
            command,
            result,
            bytes: await response.text(),
            rawBody: request.postData(),
            etag: response.headers().etag,
          };

          await assertMaintenanceReceipt(attempt);
          maintenanceRequests.push({
            ...maintenanceOperation,
            status: 200,
            body: result,
            command,
            idempotencyKey: request.headers()["idempotency-key"],
          });

          if (windowAttempts.length === 1) await route.abort("failed");
          else await route.fulfill({ response });
        });
        await windowDialog
          .getByRole("button", { name: "Bekreft gjenåpning", exact: true })
          .press("Enter");
        await windowDialog
          .getByRole("button", { name: "Prøv samme forespørsel igjen", exact: true })
          .waitFor();
        assert.equal(
          await windowDialog.getByLabel("Begrunnelse for rettingsvindu").inputValue(),
          "Synthetic audited correction window",
        );
        assert.equal(
          await windowDialog.getByLabel("Sluttidspunkt (med tidssone)").inputValue(),
          windowEnd,
        );
        const afterLostWindowResponse = await maintenanceSnapshot();
        const reopenedRead = nativeResponseFor(windowPage, staffingOperation);
        await windowDialog
          .getByRole("button", { name: "Prøv samme forespørsel igjen", exact: true })
          .press("Enter");
        await windowDialog.waitFor({ state: "hidden" });
        await windowPage.unroute("**" + maintenanceOperation.path);
        assert.equal(windowAttempts.length, 2);
        assert.deepEqual(
          windowAttempts[1],
          windowAttempts[0],
          "lost window response retries identical command/idempotency key",
        );
        assert.deepEqual(
          await maintenanceSnapshot(),
          afterLostWindowResponse,
          "exact window replay adds no SQL history, receipt or audit",
        );
        const reopenedResponse = await reopenedRead;
        assert.equal(reopenedResponse.status(), 200);
        const reopenedBoard = decodeStaffing(await reopenedResponse.json());
        maintenanceRequests.push({ ...staffingOperation, status: 200, body: reopenedBoard });

        const reopenedStaffing = reopenedBoard.interviews.find(
          (entry) => entry.interviewId === windowInterviewId,
        );

        assert.ok(reopenedStaffing);
        assert.ok(Predicate.isTagged(reopenedStaffing.assessmentCorrection, "Open"));
        assert.equal(reopenedStaffing.assessmentCorrection.openedBy, windowActor);
        assert.equal(
          reopenedStaffing.assessmentCorrection.sequence,
          closed.assessmentCorrection.sequence + 1,
        );
        await staleWindowPage
          .getByRole("button", { name: "Gjenåpne retting", exact: true })
          .press("Enter");

        const staleDialog = staleWindowPage.getByRole("dialog", {
          name: "Gjenåpne retting",
          exact: true,
        });

        await staleDialog.getByLabel("Begrunnelse for rettingsvindu").fill("Retained stale reason");
        await staleDialog.getByLabel("Sluttidspunkt (med tidssone)").fill(windowEnd);

        const beforeStaleWindow = await maintenanceSnapshot();
        const effectsBeforeStaleWindow = await effectSnapshot();
        const staleResponse = nativeResponseFor(staleWindowPage, maintenanceOperation);

        await staleDialog
          .getByRole("button", { name: "Bekreft gjenåpning", exact: true })
          .press("Enter");
        const refused = await staleResponse;
        assert.equal(refused.status(), 412);
        assert.equal(
          Schema.decodeUnknownSync(NativeProblem)(await refused.json()).code,
          "precondition.failed",
        );
        const staleCommand = decodeMaintenanceCommand(refused.request().postDataJSON());
        assert.ok(Predicate.isTagged(staleCommand, "ReopenAssessmentCorrection"));
        assert.equal(staleCommand.expectedSequence, closed.assessmentCorrection.sequence);
        assert.equal(refused.request().headers()["idempotency-key"], staleCommand.commandId);
        assert.deepEqual(await maintenanceSnapshot(), beforeStaleWindow);
        assert.deepEqual(await effectSnapshot(), effectsBeforeStaleWindow);
        await staleDialog.getByRole("alert").waitFor();
        assert.equal(
          await staleDialog.getByLabel("Begrunnelse for rettingsvindu").inputValue(),
          "Retained stale reason",
        );
        assert.equal(
          await staleDialog
            .getByRole("button", { name: "Bekreft gjenåpning", exact: true })
            .isDisabled(),
          true,
        );
        stage(
          "R2 window keyboard/mobile/Axe, exact lost-response replay and stale-sequence refusal preserve draft",
        );
      } finally {
        await staleWindowPage.close();
      }

      await openWindowInterview(windowPage);
      assert.equal(
        await windowPage.getByRole("button", { name: "Rett intervju", exact: true }).isDisabled(),
        true,
        "assigned co-interviewer opener cannot correct",
      );

      const openerDetailResponse = await fetch(
        api +
          normalizeTarget(nativeOperation("recruitment.readInterviewConduct").path, {
            interviewId: windowInterviewId,
          }),
        {
          headers: { cookie: windowCookie, origin: ui },
        },
      );

      assert.equal(openerDetailResponse.status, 200);

      const openerDetail = Schema.decodeUnknownSync(RecruitmentInterviewConductObservationSchema)(
        await openerDetailResponse.json(),
      );

      assert.ok(Predicate.isTagged(openerDetail.assessmentCorrection, "Open"));
      assert.equal(openerDetail.assessmentCorrection.openedBy, windowActor);
      assert.equal(openerDetail.assessmentCorrection.canCorrect, false);
      assert.ok(openerDetail.score);

      const openerPayload = Schema.decodeSync(CorrectInterviewAssessmentRequest)({
        expectedRevision: openerDetail.revision,
        answers: openerDetail.answers,
        score: openerDetail.score,
        recommendation: "Nei",
      });

      const openerEtag = openerDetailResponse.headers.get("etag");
      assert.ok(openerEtag);
      const beforeOpenerDenial = await maintenanceSnapshot();
      const effectsBeforeOpenerDenial = await effectSnapshot();

      const openerTarget = normalizeTarget(correctionOperation.path, {
        interviewId: windowInterviewId,
      });

      const openerDenied = await fetch(api + openerTarget, {
        method: correctionOperation.method,
        headers: {
          cookie: windowCookie,
          origin: ui,
          "content-type": "application/json",
          "idempotency-key": "correction-window-opener-denied-0029",
          "if-match": openerEtag,
        },
        body: JSON.stringify(Schema.encodeSync(CorrectInterviewAssessmentRequest)(openerPayload)),
      });

      assert.equal(openerDenied.status, 403, await openerDenied.clone().text());
      const openerProblem = decodeProblem(await openerDenied.json());
      assert.equal(openerProblem.code, "authority.denied");
      assert.deepEqual(
        await maintenanceSnapshot(),
        beforeOpenerDenial,
        "assigned opener denial leaves aggregate, assessment, audit, window and all receipts unchanged",
      );
      assert.deepEqual(await effectSnapshot(), effectsBeforeOpenerDenial);
      assert.deepEqual(await windowSnapshot(), frozen);
      maintenanceRequests.push({
        ...correctionOperation,
        path: openerTarget,
        status: 403,
        body: openerProblem,
      });
      maintenanceSqlObservations.push({ kind: "OpenerDenialUnchanged", body: beforeOpenerDenial });
      stage(
        "R2 assigned window opener native correction denies 403 authority.denied without SQL, receipt, frozen outcome or effects changes",
      );
      await openWindowInterview(page);
      assert.equal(
        await page.getByRole("button", { name: "Rett intervju", exact: true }).isEnabled(),
        true,
      );
      await fill(page);
      await page.locator("#interviewer-recommendation").selectOption("Nei");
      await page.getByRole("button", { name: "Rett intervju", exact: true }).press("Enter");
      const correctedResponse = waitForRecruitmentOperation(page, "correctInterviewAssessment");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Rett intervju", exact: true })
        .press("Enter");
      assert.equal((await correctedResponse).status(), 200);
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal((await readWindowDetail()).recommendation, "Nei");
      assert.deepEqual(
        await windowSnapshot(),
        frozen,
        "later assessment never changes cited final outcome or announcement mail",
      );

      const beforeCloseBoard = await observeMaintenanceRead(
        windowPage,
        staffingOperation,
        InterviewStaffingManagement,
        async () => {
          await windowPage.goto(`${ui}/dashboard/intervjubemanning`);
        },
      );

      const beforeCloseStaffing = beforeCloseBoard.interviews.find(
        (entry) => entry.interviewId === windowInterviewId,
      );

      assert.ok(beforeCloseStaffing);
      assert.equal(beforeCloseStaffing.assessmentCorrection._tag, "Open");
      await windowPage.getByLabel("Velg intervju", { exact: true }).selectOption(windowInterviewId);

      const closeButton = windowPage.getByRole("button", {
        name: "Lukk rettingsvindu",
        exact: true,
      });

      await closeButton.press("Enter");

      const closeDialog = windowPage.getByRole("dialog", {
        name: "Lukk rettingsvindu",
        exact: true,
      });

      await closeDialog.waitFor();
      await assertWindowFocus(windowPage, closeDialog);
      const beforeCloseDismissal = await maintenanceSnapshot();
      await windowPage.keyboard.press("Escape");
      await closeDialog.waitFor({ state: "hidden" });
      await expect(closeButton).toBeFocused();
      await closeButton.press("Enter");
      await assertWindowFocus(windowPage, closeDialog);
      await closeDialog.getByRole("button", { name: "Tilbake", exact: true }).press("Enter");
      await closeDialog.waitFor({ state: "hidden" });
      await expect(closeButton).toBeFocused();
      assert.deepEqual(
        await maintenanceSnapshot(),
        beforeCloseDismissal,
        "dismissal sends no close command",
      );
      await closeButton.press("Enter");
      await assertWindowFocus(windowPage, closeDialog);
      await closeDialog.getByLabel("Begrunnelse for rettingsvindu").fill("Synthetic audited close");
      assert.deepEqual(await auditPage(windowPage, "correction-window-close-dialog"), []);
      await windowPage.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        (await windowPage
          .locator("html")
          .evaluate((element: HTMLElement) => element.scrollWidth)) <= 390,
      );
      assert.deepEqual(await auditPage(windowPage, "correction-window-close-dialog-mobile"), []);
      await windowPage.setViewportSize({ width: 1280, height: 900 });
      const closeRead = nativeResponseFor(windowPage, staffingOperation);

      const closedAttempt = await observeMaintenanceSave(
        windowPage,
        "CloseAssessmentCorrection",
        () =>
          closeDialog.getByRole("button", { name: "Bekreft lukking", exact: true }).press("Enter"),
      );

      assert.ok(Predicate.isTagged(closedAttempt.command, "CloseAssessmentCorrection"));
      assert.ok(Predicate.isTagged(closedAttempt.result, "AssessmentCorrectionClosed"));
      assert.equal(closedAttempt.command.interviewId, windowInterviewId);
      assert.equal(
        closedAttempt.command.expectedSequence,
        beforeCloseStaffing.assessmentCorrection.sequence,
      );
      assert.equal(closedAttempt.command.reason, "Synthetic audited close");
      assert.deepEqual(
        closedAttempt.result,
        RecruitmentMaintenanceResult.cases.AssessmentCorrectionClosed.make({
          interviewId: windowInterviewId,
          sequence: beforeCloseStaffing.assessmentCorrection.sequence,
        }),
      );
      await closeDialog.waitFor({ state: "hidden" });
      const closeReadResponse = await closeRead;
      assert.equal(closeReadResponse.status(), 200);
      const closeBoard = decodeStaffing(await closeReadResponse.json());
      maintenanceRequests.push({ ...staffingOperation, status: 200, body: closeBoard });

      const closedStaffing = closeBoard.interviews.find(
        (entry) => entry.interviewId === windowInterviewId,
      );

      assert.ok(closedStaffing);
      assert.equal(closedStaffing.assessmentCorrection._tag, "Closed");
      assert.equal(closedStaffing.assessmentCorrection.canCorrect, false);
      assert.equal(closedStaffing.assessmentCorrection.canClose, false);
      assert.equal(closedStaffing.assessmentCorrection.canReopen, true);
      assert.equal(closedStaffing.assessmentCorrection.sequence, closedAttempt.result.sequence);
      const afterClose = await readWindowDetail();
      assert.equal(afterClose.assessmentCorrection._tag, "Closed");
      assert.equal(afterClose.assessmentCorrection.canCorrect, false);
      assert.ok(afterClose.assessmentCorrection.sequence > closed.assessmentCorrection.sequence);
      assert.deepEqual(await windowSnapshot(), frozen);
      await assertMaintenanceReceipt(closedAttempt);

      const windowAudit = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        (
          await pool.query(
            `SELECT command_id AS "commandId",actor_person_id AS "actorPersonId",sequence,action,reason,
          to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
          FROM public.recruitment_assessment_correction_window_audit WHERE interview_id=$1 ORDER BY sequence,action DESC`,
            [windowInterviewId],
          )
        ).rows,
      );

      assert.deepEqual(
        windowAudit.map((entry) => [
          entry.action,
          entry.reason,
          entry.sequence,
          entry.actorPersonId,
        ]),
        [
          [
            "Reopen",
            "Synthetic audited correction window",
            closedAttempt.result.sequence,
            windowActor,
          ],
          ["Close", "Synthetic audited close", closedAttempt.result.sequence, windowActor],
        ],
      );
      assert.equal(windowAudit[1]?.commandId, closedAttempt.command.commandId);
      maintenanceSqlObservations.push({ kind: "CorrectionWindowAudit", body: windowAudit });
      await expect(
        windowPage.getByRole("button", { name: "Lukk rettingsvindu", exact: true }),
      ).toBeDisabled();
      assert.deepEqual(await auditPage(windowPage, "correction-window-refreshed-closed"), []);
      // R8 falsifier: after success the next valid action, not the disabled close trigger, owns focus.

      const reopenedControl = windowPage.getByRole("button", {
        name: "Gjenåpne retting",
        exact: true,
      });

      await expect(reopenedControl).toBeEnabled();
      await expect(reopenedControl).toBeFocused();
      stage(
        "R2 scoped staffing opens and closes existing maintenance variants; opener exclusion and frozen outcome hold through real UI",
      );
      stage(
        "R8 window initial focus, tab loop, Escape/Tilbake restoration, close result/SQL audit and refreshed Closed focus/Axe",
      );
    } finally {
      try {
        await pool.query(
          "DELETE FROM public.organization_global_administrator_grants WHERE grant_id=$1",
          [windowGrant],
        );
      } finally {
        try {
          await windowContext.close();
        } finally {
          // Retain the native/SQL observations also when a new focus falsifier is red.
          await writeFile(
            join(artifacts, "correction-targeted-evidence.json"),
            JSON.stringify(
              {
                revision,
                correctionStages,
                beforeBody,
                afterFirst,
                afterSecond,
                finalDetail,
                failedSaveRetry: correctionAttempts,
                maintenanceRequests,
                maintenanceSqlObservations,
              },
              null,
              2,
            ),
          );
        }
      }
    }

    await page.goto(`${ui}/dashboard/intervjuer`);
  }

  await open(page, "Sofie Gjennomfører");
  await fill(page);
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "");
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "editable-desktop.png") });
  await auditPage(page, "editable-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    (await page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth)) <=
      page.viewportSize().width,
  );
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "editable-mobile.png") });
  await auditPage(page, "editable-mobile");

  // Viewport observations preserve fixed chrome; tall element captures can stitch it
  // across fields that are visible when the actual viewport is scrolled.
  for (const [selector, name] of [
    ["#question-interview-schema-native-conduct-0063-q0", "editable-mobile-answer-viewport"],
    ["#interviewer-recommendation", "editable-mobile-recommendation-viewport"],
  ] as const) {
    await page
      .locator(selector)
      .evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" }));
    await page.locator(selector).focus();
    await page.screenshot({ path: join(artifacts, `${name}.png`) });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
  await page
    .getByText("Svar på alle spørsmål, velg alle tre scorer og en anbefaling.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#score-suitability").inputValue(), "8");
  await page.locator("#interviewer-recommendation").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Ja");
  const finalResponsePromise = waitForRecruitmentOperation(page, "finalizeInterview");
  await page.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(artifacts, "confirmation.png") });
  await auditPage(page, "confirmation");
  const finalResponse = finalResponsePromise;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fullfør intervju", exact: true })
    .press("Enter");
  assert.equal((await finalResponse).status(), 200);
  await page.getByText("Intervjuet er fullført.", { exact: true }).waitFor();
  await page.reload();
  await open(page, "Sofie Gjennomfører");
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Ja");
  await page
    .locator(".fs-conduct")
    .screenshot({ path: join(artifacts, "recommendation-desktop.png") });
  await auditPage(page, "finalized-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    (await page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth)) <=
      page.viewportSize().width,
  );
  await page
    .locator(".fs-conduct")
    .screenshot({ path: join(artifacts, "recommendation-mobile.png") });
  await auditPage(page, "finalized-mobile");
  await page.setViewportSize({ width: 1280, height: 900 });
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
    initial = await get(id);

  assert.equal(initial.status, 200);
  const etag = initial.headers.get("etag")!;

  const lifecycleSnapshot = async () =>
    JSON.stringify(
      (
        await pool.query(
          `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.interview_id) FROM public.recruitment_interview_conducts c) conducts,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.command_id) FROM public.recruitment_interview_lifecycle_command_receipts r) receipts,(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.command_id) FROM public.recruitment_interview_lifecycle_audit a) audit,(SELECT jsonb_agg(to_jsonb(h) ORDER BY to_jsonb(h)::text) FROM public.native_http_idempotency_receipts h) native_receipts`,
        )
      ).rows[0],
    );

  const before = await lifecycleSnapshot();

  for (const [i, value] of [undefined, null, "invalid", 9].entries()) {
    const body = value === undefined ? payload : { ...payload, recommendation: value };
    assert.equal(
      (
        await post(
          id,
          body,
          [fixtureKeys.invalid0, fixtureKeys.invalid1, fixtureKeys.invalid2, fixtureKeys.invalid3][
            i
          ]!,
          etag,
        )
      ).status,
      422,
    );
  }

  assert.equal(await lifecycleSnapshot(), before);
  const first = await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag);
  assert.equal(first.status, 200);
  const bytes = await first.text();
  assert.equal(
    await (
      await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag)
    ).text(),
    bytes,
  );
  assert.equal(
    (await post(id, { ...payload, recommendation: "Nei" }, fixtureKeys.maybe, etag)).status,
    409,
  );
  const no = await get("interview-recommendation-no");

  const race = await Promise.all([
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
  ]);

  assert.ok(race.filter((r) => r.status === 200).length === 1);
  assert.ok(race.every((r) => [200, 409, 412].includes(r.status)));
  const saved = (await (await get("interview-recommendation-no")).json()).recommendation;
  assert.equal(saved, race[0].status === 200 ? "Nei" : "Ja");

  // Ensure Nei has an independent exact round trip even when Ja won the concurrent race.
  if (saved !== "Nei") {
    const b = await get("interview-native-conduct-b-0063");
    assert.equal(
      (
        await post(
          "interview-native-conduct-b-0063",
          { ...payload, recommendation: "Nei" },
          fixtureKeys.no,
          b.headers.get("etag")!,
        )
      ).status,
      200,
    );
    assert.equal(
      (await (await get("interview-native-conduct-b-0063")).json()).recommendation,
      "Nei",
    );
  }

  assert.equal((await (await get(id)).json()).recommendation, "Kanskje");
  recordGate(
    "missing/null/unknown/numeric rejected without effects; all choices roundtrip; exact replay and conflicting/concurrent writes fenced",
  );
  const effectsAfterInterviewCompletions = await effectSnapshot();
  await pool.query(
    `UPDATE public.organization_memberships SET is_suspended=true WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag)).status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET is_suspended=false WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  recordGate("suspended authority denies reads and stored receipt replay");
  const authorizationBefore = await lifecycleSnapshot();

  // Change current source authority, not authentication claims or an authorization stub.
  await pool.query(
    `UPDATE public.recruitment_interviews SET interviewer_person_id='recommendation-other-0101' WHERE interview_id=$1`,
    [id],
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag)).status,
    403,
  );
  await pool.query(
    `UPDATE public.recruitment_interviews SET interviewer_person_id='journey-conduct-leader-0063' WHERE interview_id=$1`,
    [id],
  );
  await pool.query(
    `UPDATE public.organization_memberships SET end_at=date_trunc('milliseconds', CURRENT_TIMESTAMP, 'UTC') - interval '24 hours' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag)).status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET end_at=NULL WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await pool.query(
    `INSERT INTO public.organization_departments SELECT (jsonb_populate_record(NULL::public.organization_departments,to_jsonb(d)||'{"department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_departments d WHERE department_id='department-native-conduct-0063'`,
  );
  await pool.query(
    `INSERT INTO public.organization_teams SELECT (jsonb_populate_record(NULL::public.organization_teams,to_jsonb(t)||'{"team_id":"team-other-recommendation-0101","department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_teams t WHERE team_id='team-native-conduct-0063'`,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET team_id='team-other-recommendation-0101' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, fixtureKeys.maybe, etag)).status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET team_id='team-native-conduct-0063' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await pool.query(
    `INSERT INTO public.admission_period_departments
       SELECT (jsonb_populate_record(NULL::public.admission_period_departments,
         to_jsonb(d)||'{"department_id":"department-other-recommendation-0101"}'::jsonb)).*
       FROM public.admission_period_departments d
       WHERE d.department_id='department-native-conduct-0063'
       ON CONFLICT (department_id) DO NOTHING`,
  );
  assert.equal(await lifecycleSnapshot(), authorizationBefore);
  await pool.query(
    `INSERT INTO public.recruitment_interview_conducts
       SELECT (jsonb_populate_record(NULL::public.recruitment_interview_conducts,
         to_jsonb(c)||'{"interview_id":"interview-recommendation-link-race","interview_revision":1}'::jsonb)).*
       FROM public.recruitment_interview_conducts c
       WHERE c.interview_id='interview-native-conduct-a-0063'
       ON CONFLICT (interview_id) DO NOTHING`,
  );
  const lifecycleBeforeCorrections = await lifecycleSnapshot();

  if (acceptedCorrectionReplay !== undefined && process.argv.includes("--correction-mode")) {
    const boundaryResult = await assertInterviewCorrectionBoundaries({
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

    await writeFile(
      join(artifacts, "correction-boundaries.json"),
      JSON.stringify({ revision, ...boundaryResult }, null, 2),
    );
  }

  const applicantResponse = await fetch(`${api}/api/recruitment/invitation-response`, {
    headers: { "x-recruitment-invitation-capability": invitationCapability, origin: ui },
  });

  assert.equal(applicantResponse.status, 200);
  const applicantObservation = await applicantResponse.text();
  assertNoRecommendation(JSON.parse(applicantObservation));
  assert.ok(!applicantObservation.includes("Kanskje"));

  const applicationProjection = await fetch(
    `${api}/api/applications/application-recommendation-maybe`,
  );

  assert.equal(applicationProjection.status, 200);
  const applicationBody = await applicationProjection.text();
  assertNoRecommendation(JSON.parse(applicationBody));
  assert.ok(!applicationBody.includes("Kanskje"));
  recordGate(
    "wrong department denied; actual applicant capability projection excludes recommendation",
  );

  recordGate(
    "removed assignment and ended membership deny read/write/replay without lifecycle writes",
  );

  const lifecycleBeforeSelf = await lifecycleSnapshot();
  assert.equal((await get("interview-recommendation-self")).status, 403);
  assert.equal(
    (
      await post(
        "interview-recommendation-self",
        { ...payload, recommendation: "Ja" },
        fixtureKeys.selfFinalize,
        etag,
      )
    ).status,
    403,
  );

  const selfCancel = await fetch(
    `${api}/api/recruitment/interviews/interview-recommendation-self:cancel`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: ui,
        "content-type": "application/json",
        "if-match": etag,
        "idempotency-key": fixtureKeys.selfCancel,
      },
      body: "{}",
    },
  );

  assert.equal(selfCancel.status, 403);
  assert.deepEqual(await effectSnapshot(), effectsAfterInterviewCompletions);
  // This separate actual onboarding action observes its applicant-facing projection.
  const onboardingToken = `onboard_${randomBytes(32).toString("hex")}`;
  secrets.push(onboardingToken);
  await pool.query(
    `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('identity-recommendation-no','application-recommendation-no','applicant-recommendation-no',$1,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Open','journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
    [createHash("sha256").update(onboardingToken).digest("hex")],
  );
  await pool.query(
    `INSERT INTO public.applicant_account_delivery(invitation_id,state,secret,recipient) VALUES('identity-recommendation-no','Pending',$1,'no@example.invalid')`,
    [onboardingToken],
  );

  const onboardingProjection = await fetch(`${api}/api/onboarding/claim`, {
    method: "POST",
    headers: { cookie, origin: ui, "content-type": "application/json" },
    body: JSON.stringify({ mode: "ExistingAccount", token: onboardingToken }),
  });

  assert.equal(onboardingProjection.status, 200);
  assert.deepEqual(await onboardingProjection.json(), {
    state: "Claimed",
    departmentId: "department-native-conduct-0063",
  });
  const effectsAfterOnboarding = await effectSnapshot();
  recordGate(
    "actual application confirmation and onboarding claim projections exclude recommendation; recommendation produced no effect rows",
  );

  assert.equal((await get("interview-recommendation-no")).status, 403);
  const winner = race.findIndex((r) => r.status === 200);
  assert.equal(
    (
      await post(
        "interview-recommendation-no",
        { ...payload, recommendation: winner === 0 ? "Nei" : "Ja" },
        winner === 0 ? fixtureKeys.raceA : fixtureKeys.raceB,
        no.headers.get("etag")!,
      )
    ).status,
    403,
  );

  if (!process.argv.includes("--correction-mode")) {
    run("bun", ["packages/database/runtime/recommendation-domain-replay.ts"], env);
    const raceRead = await get("interview-recommendation-link-race");
    assert.equal(raceRead.status, 200);
    const locker = await pool.connect();
    heldIdentityClient = locker;
    await locker.query("BEGIN");
    await locker.query(
      `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-link-race' FOR UPDATE`,
    );
    const lockerPid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;

    const waiting = post(
      "interview-recommendation-link-race",
      { ...payload, recommendation: "Ja" },
      fixtureKeys.linkRace,
      raceRead.headers.get("etag")!,
    );

    await ready(
      async () =>
        (
          await pool.query(
            `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
            [lockerPid],
          )
        ).rows[0].n > 0,
    );
    await link("link-race", "journey-conduct-leader-0063", locker);
    await locker.query("COMMIT");
    locker.release();
    heldIdentityClient = undefined;
    // Finalization retries a serialization failure once (74b037e2), so the request that waited on
    // the link answers with the self-denial of its retry instead of 409 transaction.conflict.
    const staleIdentity = await waiting;
    assert.equal(staleIdentity.status, 403);
    assert.equal((await staleIdentity.json()).code, "authority.denied");
    assert.equal(
      (
        await post(
          "interview-recommendation-link-race",
          { ...payload, recommendation: "Ja" },
          fixtureKeys.linkRace,
          raceRead.headers.get("etag")!,
        )
      ).status,
      403,
    );
    assert.equal((await get("interview-recommendation-link-race")).status, 403);
  }

  const readLocker = await pool.connect();
  heldIdentityClient = readLocker;
  await readLocker.query("BEGIN");
  await readLocker.query(
    `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-read-race' FOR UPDATE`,
  );
  const readLockerPid = (await readLocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  const waitingRead = get("interview-recommendation-read-race");
  await ready(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
          [readLockerPid],
        )
      ).rows[0].n > 0,
  );
  await link("read-race", "journey-conduct-leader-0063", readLocker);
  await readLocker.query("COMMIT");
  readLocker.release();
  heldIdentityClient = undefined;
  assert.equal((await waitingRead).status, 403);
  assert.equal(await lifecycleSnapshot(), lifecycleBeforeSelf);
  recordGate(
    "known self denied before read/finalize/cancel and both receipt layers; different Person allowed; a finalization waiting on the identity link retries its serialization failure once and is denied as self",
  );
  let immutable = false;

  try {
    await pool.query(
      `UPDATE public.recruitment_interview_conducts SET recommendation='Ja' WHERE interview_id='interview-recommendation-history'`,
    );
  } catch {
    immutable = true;
  }

  assert.ok(immutable);

  for (const value of [null, "wrong", ""]) {
    let rejected = false;

    try {
      await pool.query(
        `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('invalid-direct-0101','[]',1,1,1,'journey-conduct-leader-0063',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),1,$1)`,
        [value],
      );
    } catch (e) {
      rejected = Predicate.hasProperty(e, "code") && e.code === "23514";
    }

    assert.ok(rejected);
  }

  await page.reload();
  await open(page, "history Recommendation");
  const currentHistoryDetail = await (await get("interview-recommendation-history")).json();
  // A historical row keeps no recommendation until a correction records one; the select then
  // shows its empty "Velg anbefaling" option.
  assert.equal(
    await page.locator("#interviewer-recommendation").inputValue(),
    currentHistoryDetail.recommendation ?? "",
  );
  assert.equal(
    await page.locator("#interviewer-recommendation option:checked").textContent(),
    currentHistoryDetail.recommendation ?? "Velg anbefaling",
  );
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "historical-desktop.png") });
  await auditPage(page, "historical-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "historical-mobile.png") });
  await auditPage(page, "historical-mobile");
  // Leadership of the department's board (classified by seedInterviewReportCoordinator).
  await pool.query(
    `UPDATE public.organization_memberships SET is_team_leader=true,position_id='teamleader' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("link", { name: "Søkerkontoer", exact: true }).click();
  await page.waitForURL(/\/dashboard\/onboarding$/);
  await page.getByRole("heading", { name: "Søkerkontoer", exact: true }).waitFor();
  await page.goto(`${ui}/dashboard/intervjuer`);
  const controlPanel = page.getByRole("link", { name: "Kontrollpanel", exact: true });
  await controlPanel.waitFor();
  // Only a global administrator maintains interview schemas since 7472f5ea, so a board leader's
  // navigation offers no schema link.
  assert.equal(await page.getByRole("link", { name: "Intervjuskjema", exact: true }).count(), 0);
  await controlPanel.click();
  await page.waitForURL(/\/dashboard\/?$/);
  await page.getByRole("heading", { name: "Velkommen, Lina Lagleder", exact: true }).waitFor();
  await pool.query(
    `UPDATE public.organization_memberships SET is_team_leader=false,position_id='member' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );

  recordGate(
    "owned interview shell retains role-scoped onboarding and dashboard navigation without the global administrators' schema link",
  );

  const rows = (
    await pool.query(
      `SELECT interview_id,recommendation,answers,explanatory_power,role_model,suitability FROM public.recruitment_interview_conducts ORDER BY interview_id`,
    )
  ).rows;

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

  const lifecycle = (
    await pool.query(
      `SELECT c.interview_id,c.recommendation,a.kind,a.resulting_revision,r.command_id FROM public.recruitment_interview_conducts c JOIN public.recruitment_interview_lifecycle_audit a USING(interview_id) JOIN public.recruitment_interview_lifecycle_command_receipts r ON r.command_id=a.command_id ORDER BY c.interview_id`,
    )
  ).rows;

  const beforeLifecycle = Schema.decodeUnknownSync(
    Schema.StructWithRest(
      Schema.Struct({
        conducts: Schema.Json,
        receipts: Schema.Array(
          Schema.StructWithRest(Schema.Struct({ command_id: Schema.String, kind: Schema.String }), [
            Schema.Record(Schema.String, Schema.Json),
          ]),
        ),
        audit: Schema.Json,
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  )(JSON.parse(lifecycleBeforeCorrections));

  const afterLifecycle = Schema.decodeUnknownSync(
    Schema.StructWithRest(
      Schema.Struct({
        conducts: Schema.Json,
        receipts: Schema.Array(
          Schema.StructWithRest(Schema.Struct({ command_id: Schema.String, kind: Schema.String }), [
            Schema.Record(Schema.String, Schema.Json),
          ]),
        ),
        audit: Schema.Json,
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  )(JSON.parse(await lifecycleSnapshot()));

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
  assert.deepEqual(lifecycle.map((row: any) => row.command_id).sort(), knownFinalizationCommandIds);
  assert.ok(lifecycle.every((r: any) => r.kind === "InterviewFinalized"));
  assert.equal(new Set(lifecycle.map((r: any) => r.interview_id)).size, lifecycle.length);
  assert.deepEqual(await effectSnapshot(), effectsAfterOnboarding);
  assert.deepEqual(errors, []);
  assert.ok(
    accessibility.every((result: any) => result.violations.length === 0),
    "Accessibility violations retained in accessibility.json",
  );

  for (const secret of secrets) assert.ok(!JSON.stringify(logs).includes(secret));
  recordGate(
    "historical immutable not-recorded display; direct storage constraints; desktop/mobile Axe; independent public-schema SQL",
  );

  const reportEvidence = process.argv.includes("--report")
    ? await observeInterviewReport({
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
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(
      {
        revision,
        reportEvidence,
        gates,
        rows,
        lifecycle,
        pageErrors: errors,
        observer: "independent PostgreSQL connection",
        noNotificationEffects: true,
      },
      null,
      2,
    ),
  );

  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith(".png")) {
      const text = await readFile(join(artifacts, entry.name), "utf8");

      for (const secret of secrets)
        assert.ok(!text.includes(secret), `retained artifact ${entry.name} contains a credential`);
    }
  }

  // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: sanitized local acceptance artifact location.
  console.log(JSON.stringify({ result: "Passed", revision, artifacts, gates }));
} catch (error) {
  if (error instanceof ReturningLoginProbeComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit the bounded local login-probe result.
    console.log(
      JSON.stringify({
        result: "ReturningLoginProbe",
        revision,
        artifacts,
        gates,
        probe: error.result,
      }),
    );
  } else if (error instanceof ReturningTargetedComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit the bounded returning journey result.
    console.log(
      JSON.stringify({
        result: "ReturningTargeted",
        revision,
        artifacts,
        gates,
        journey: error.result,
      }),
    );
  } else if (error instanceof ApplicantProgressTargetedComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit the bounded applicant-progress result.
    console.log(
      JSON.stringify({
        result: "ApplicantProgressTargeted",
        revision,
        artifacts,
        gates,
        journey: error.result,
      }),
    );
  } else if (error instanceof CoInterviewerTargetedComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit the bounded co-interviewer result.
    console.log(
      JSON.stringify({
        result: "CoInterviewerTargeted",
        revision,
        artifacts,
        gates,
        journey: error.result,
      }),
    );
  } else if (error instanceof CorrectionTargetedComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: emit the bounded correction result.
    console.log(
      JSON.stringify({
        result: "CorrectionTargeted",
        revision,
        artifacts,
        gates,
        journey: error.result,
      }),
    );
  } else {
    let detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

    const activeQueries = pool
      ? await pool
          .query(
            `SELECT pid,state,wait_event_type,wait_event,left(query,240) AS query
             FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
             ORDER BY pid`,
          )
          .then((result: { rows: unknown[] }) => result.rows)
          .catch(() => [])
      : [];

    detail += ` Active PostgreSQL queries: ${JSON.stringify(activeQueries)}`;

    if (page)
      detail += ` Current page: ${await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")}`;

    const safe = (value: string) =>
      secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), value);

    detail = safe(detail);

    const returningOutbox = pool
      ? await pool
          .query(
            `SELECT effect_id,command_id,effect_type,ordinal,status,attempts,claimed_at,last_failure_tag,origin
             FROM public.admission_application_outbox
             WHERE origin='ReturningAssistant'
             ORDER BY effect_id`,
          )
          .then((result: { rows: unknown[] }) => result.rows)
          .catch(() => [])
      : [];

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

    await writeFile(join(artifacts, "failure.json"), JSON.stringify(failureEvidence, null, 2));
    await writeFile(join(artifacts, "runtime.log"), `${logs.map(safe).join("")}${detail}\n`);
    // oxlint-effect-plugin allow(no-ambient-console): dev only: EX-0009: redacted local rehearsal failure evidence.
    console.error(JSON.stringify({ ...failureEvidence, artifacts }));
    process.exitCode = 1;
  }
} finally {
  await browser?.close();

  if (effectServer !== undefined) {
    const closed = Promise.withResolvers<void>();
    effectServer.close(() => closed.resolve());
    await closed.promise;
  }

  if (heldIdentityClient) {
    await heldIdentityClient.query("ROLLBACK");
    heldIdentityClient.release();
  }

  await pool?.end();

  for (const child of children.reverse()) await stopOwnedProcess(child);
  await postgres?.stop();
}
