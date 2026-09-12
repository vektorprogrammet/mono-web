import { IdempotencyKey } from "../../packages/http-api/src/http-semantics.js";
/**0101: previous-schema history -> actual migration -> production browser/API/PostgreSQL. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  observeInterviewReport,
  seedInterviewReportCoordinator,
  validateInterviewReportFixture,
} from "./interview-report-observation.js";
import { stopPreviewScenarioBackend } from "./preview-scenario.js";
import {
  returningAssistantFixture,
  runReturningAssistantBrowserJourney,
  runReturningAssistantLoginProbe,
  seedReturningAssistant,
} from "./returning-assistant-journey.ts";
import {
  assertInterviewCorrectionPre0039Preserved,
  seedInterviewCorrectionPre0039Fixture,
  type InterviewCorrectionPre0039Fixture,
} from "./recommendation-preupgrade-fixture.ts";
import {
  assertInterviewCorrectionBoundaries,
  type InterviewCorrectionReplayRequest,
} from "./interview-correction-boundaries.ts";
import { assertInterviewCorrectionIntegrity } from "./interview-correction-integrity.ts";
import { DatabaseLive } from "../../packages/database/src/index.js";
import { AdmissionsLive } from "../../packages/domain/src/admissions/index.js";
import { OrganizationLive } from "../../packages/domain/src/organization/index.js";
import { ProfileLive } from "../../packages/domain/src/profile/index.js";
import {
  deliverNextRecruitmentInvitation,
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidenceSchema,
  type RecruitmentInvitationDeliveryResult,
} from "../../packages/domain/src/recruitment/index.js";
import { deliverJson } from "../../apps/backend/src/delivery/http.js";
import { NotificationGateway } from "../../packages/domain/src/notification/service.js";
const root = new URL("../../", import.meta.url).pathname;
const dbRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const uiRequire = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));
const { Pool } = dbRequire("pg");
const { Schema } = dbRequire("effect");
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
class ReturningLoginProbeComplete extends Error {
  constructor(readonly result: unknown) {
    super("returning login probe complete");
  }
}
class ReturningTargetedComplete extends Error {
  constructor(readonly result: unknown) {
    super("returning targeted journey complete");
  }
}
class CorrectionTargetedComplete extends Error {
  constructor(readonly result: unknown) {
    super("correction targeted journey complete");
  }
}
if (process.argv.includes("--report")) validateInterviewReportFixture();
if (process.argv.includes("--validate-fixture")) {
  // oxlint-effect-plugin allow(no-ambient-console): dev only: local fixture validation result.
  console.log("All recommendation fixture idempotency keys satisfy the canonical schema");
  process.exit(0);
}
const { chromium } = uiRequire("@playwright/test");
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
const port = async (preferred = 0) => {
  const s = createServer();
  await new Promise<void>((yes, no) => {
    s.once("error", no);
    s.listen(preferred, "127.0.0.1", yes);
  });
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  await new Promise<void>((yes) => s.close(() => yes()));
  return a.port;
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
let pool: any, browser: any, page: any, heldIdentityClient: any, backend: any;
let correctionPre0039Fixture: InterviewCorrectionPre0039Fixture | undefined;
let acceptedCorrectionReplay: InterviewCorrectionReplayRequest | undefined;
let effectServer: Server | undefined;
const effectCalls: EffectReceiverCall[] = [];
const effectAttempts = new Map<string, number>();
const invitationCapabilities = new Map<string, string>();
let releaseEffectDelivery = false;
const gates: string[] = [];
const recordGate = (...observations: string[]) => {
  gates.push(...observations);
  // oxlint-effect-plugin allow(no-ambient-console): dev only: bounded synthetic rehearsal milestones.
  console.log(JSON.stringify({ observed: observations }));
};
const secrets: string[] = [];
const accessibility: Array<unknown> = [];
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
};
const assertNoRecommendation = (value: unknown): void => {
  if (Array.isArray(value)) for (const item of value) assertNoRecommendation(item);
  else if (typeof value === "object" && value !== null)
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

const stringField = (value: unknown, key: string): string => {
  if (value === null || typeof value !== "object" || !(key in value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
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
    let body: unknown;
    try {
      body = JSON.parse(await readRequestText(request));
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
    const normalizedEffectId = typeof effectId === "string" ? effectId : "";
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
  });
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
      deliverInterviewInvitation: (request) =>
        deliverJson(request, transport, globalThis.fetch, {
          "idempotency-key": request.effectId,
        }).pipe(
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
        deliverJson(request, transport, globalThis.fetch, {
          "idempotency-key": request.effectId,
        }).pipe(
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
  const pgPort = await port(),
    apiPort = await port(),
    effectPort = await port(),
    uiPort = await port(5174);
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start("postgres", ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts]);
  const pg = `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
    api = `http://127.0.0.1:${apiPort}`,
    ui = `http://127.0.0.1:${uiPort}`;
  const effectMode = process.argv.includes("--returning-mode") ? "http" : "disabled";
  const effectToken = randomBytes(32).toString("hex");
  pool = new Pool({ connectionString: pg });
  await ready(async () => {
    await pool.query("SELECT 1");
    return true;
  });
  const env = {
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
    ...(effectMode === "http"
      ? {
          PUBLIC_APPLICATION_EFFECT_ENDPOINT: `http://127.0.0.1:${effectPort}/effects`,
          PUBLIC_APPLICATION_EFFECT_TOKEN: effectToken,
          PUBLIC_APPLICATION_EFFECT_POLL_MS: "1000",
          PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: "2000",
        }
      : {}),
    API_URL: api,
    VITE_API_URL: api,
    DASHBOARD_MOUNT: "/",
    HOST: "127.0.0.1",
    PORT: String(uiPort),
    NODE_ENV: "production",
  };
  secrets.push(env.BETTER_AUTH_SECRET);
  recordGate("disposable PostgreSQL is ready");
  run(
    "bun",
    ["packages/database/runtime/recommendation-preupgrade-fixture.ts"],
    { ...env, RECOMMENDATION_PREUPGRADE_THROUGH_0038: "1" },
  );
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
      ]),
    },
    join(root, "packages/database"),
  );
  await seedReturningAssistant({ pool, run, env, root });
  await seedInterviewReportCoordinator({ pool, secrets });
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
      `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed','journey-conduct-leader-0063',CURRENT_TIMESTAMP)`,
      [
        invitation,
        `application-recommendation-${suffix}`,
        `applicant-recommendation-${suffix}`,
        createHash("sha256").update(invitation).digest("hex"),
      ],
    );
    await sql.query(
      `INSERT INTO public.applicant_account_links VALUES($1,$2,CURRENT_TIMESTAMP,$3)`,
      [`applicant-recommendation-${suffix}`, personId, invitation],
    );
  };
  await pool.query(
    `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES('recommendation-other-0101','Other','Interviewer',0)`,
  );
  await link("self", "journey-conduct-leader-0063");
  await link("maybe", "recommendation-other-0101");

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
  recordGate("immutable historical row survived actual0037 upgrade without invented recommendation");
  assert.ok(correctionPre0039Fixture);
  await assertInterviewCorrectionPre0039Preserved(pool, correctionPre0039Fixture);
  recordGate("0039 upgrade preserved original interview/schedule/invitation/conduct/lifecycle rows");
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
  if (process.argv.includes("--returning-mode")) {
    let currentStage = "returning:startup";
    const returningStages: string[] = [];
    const stage = (name: string) => {
      currentStage = name;
      returningStages.push(name);
      // oxlint-effect-plugin allow(no-ambient-console): dev-only bounded stage evidence.
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
          if (result._tag !== "Delivered")
            throw new Error(`recruitment invitation delivery ${result._tag}`);
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
      type ReturningOutboxRow = {
        readonly effect_id: string;
        readonly command_id: string;
        readonly effect_type: string;
        readonly ordinal: number;
        readonly status: string;
        readonly attempts: number;
        readonly claimed_at: string | null;
        readonly last_failure_tag: string | null;
        readonly origin: string;
      };
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
      const hasExactReturningEffectShape = (rows: ReadonlyArray<ReturningOutboxRow>) => {
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
        (
          await pool.query(
            `SELECT effect_id,command_id,effect_type,ordinal,status,attempts,claimed_at,last_failure_tag,origin
           FROM public.admission_application_outbox
           WHERE origin='ReturningAssistant'
           ORDER BY effect_id`,
          )
        ).rows as ReturningOutboxRow[];
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
            hasExactReturningEffectShape(rows) &&
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
      assert.ok(hasExactReturningEffectShape(failedRows));
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
      assert.ok(hasExactReturningEffectShape(heldFailedRows));
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
      await stopPreviewScenarioBackend(backend);
      releaseEffectDelivery = true;
      backend = start("bun", ["apps/backend/src/main.ts"], env);
      await ready(async () => (await fetch(`${api}/health`)).ok);
      const deliveredRows = await bounded(
        "returning effect restart delivery",
        waitForOutbox(
          (rows) =>
            hasExactReturningEffectShape(rows) && rows.every((row) => row.status === "Delivered"),
        ),
        90_000,
      );
      assert.equal(deliveredRows.length, expectedOutboxCount);
      assert.ok(hasExactReturningEffectShape(deliveredRows));
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
        revision,
        auditPage,
        recordGate,
      }),
    );
    const observedReturningGates = new Set(
      returningResult.trace
        .filter(
          (entry): entry is { phase: "negative-gate"; gate: string; status: unknown } =>
            entry.phase === "negative-gate",
        )
        .map((entry) => entry.gate),
    );
    const reportGates = Array.isArray(reportEvidence?.gates) ? reportEvidence.gates : [];
    const returningFalsifierManifest = [
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
      ["original-app-receipt-activation-conduct", "preserved-original-receipt-activation-conduct"],
      ["new-period-no-new-interview", "new-period-no-new-interview"],
    ].map(([falsifier, gate]) => ({
      falsifier,
      gate,
      status: observedReturningGates.has(gate) ? "observed" : "missing",
    }));
    returningFalsifierManifest.push(
      {
        falsifier: "report-self-privacy/read-only",
        gate: "0103 report observer",
        status: reportGates.some(
          (gate) => typeof gate === "string" && gate.includes("no report writes"),
        )
          ? "observed"
          : "missing",
      },
      {
        falsifier: "report-exact-period/classification/filter-reload",
        gate: "0103 report observer",
        status: reportGates.some((gate) => typeof gate === "string" && gate.includes("period"))
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
    throw new ReturningTargetedComplete({ returningStages, reportEvidence });
  }
  const get = (id: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}`, { headers: { cookie, origin: ui } });
  const post = (id: string, body: unknown, key: string, etag: string) =>
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
  const correctPost = (id: string, body: unknown, key: string, etag: string) =>
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
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/recruitment")
        return false;
      try {
        const payload: unknown = response.request().postDataJSON();
        return (
          typeof payload === "object" &&
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
    const operationFor = (request: any): string | undefined => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment")
        return undefined;
      try {
        const payload: unknown = request.postDataJSON();
        return typeof payload === "object" &&
          payload !== null &&
          "operation" in payload &&
          typeof payload.operation === "string"
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
      if (!response.ok()) throw new Error(`correction response ${response.status()}: ${await response.text()}`);
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
      { questionId: "interview-schema-native-conduct-0063-q0", answer: "Jeg vil forklare matematikk tydelig." },
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
    const staleCorrectionContext = await browser.newContext({ storageState: await context.storageState() });
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
    await staleCorrection.locator("#question-interview-schema-native-conduct-0063-q0").fill("Stale correction draft.");
    await staleCorrection.locator("#interviewer-recommendation").selectOption("Kanskje");
    await staleCorrection.locator("#score-explanatoryPower").selectOption("7");
    await page.locator("#question-interview-schema-native-conduct-0063-q0").fill("Et nytt tydelig svar.");
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
        typeof payload !== "object" ||
        !("operation" in payload) ||
        payload.operation !== "correctInterviewAssessment"
      ) {
        await route.continue();
        return;
      }
      const headersValue = "headers" in payload ? payload.headers : undefined;
      const operationHeaders =
        typeof headersValue === "object" && headersValue !== null ? headersValue : {};
      const ifMatch =
        "if-match" in operationHeaders && typeof operationHeaders["if-match"] === "string"
          ? operationHeaders["if-match"]
          : undefined;
      const idempotencyKey =
        "idempotency-key" in operationHeaders && typeof operationHeaders["idempotency-key"] === "string"
          ? operationHeaders["idempotency-key"]
          : undefined;
      const phase: CorrectionAttempt["phase"] = correctionAttempts.length === 0 ? "failed-save" : "retry";
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
    assert.deepEqual(rowsBeforeFailedSave.map((row: any) => row.resulting_revision), [2]);
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
    assert.equal(correctionAttempts[0].fetchedStatus, 200);
    await page.locator("#interviewer-recommendation").waitFor({ state: "visible" });
    await page.unroute("**/recruitment", correctionRoute);
    await page.reload();
    await correctionPageOpen();
    assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Nei");
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
      await staleCorrection.locator("#question-interview-schema-native-conduct-0063-q0").inputValue(),
      "Stale correction draft.",
    );
    assert.equal(await staleCorrection.locator("#interviewer-recommendation").inputValue(), "Kanskje");
    const staleRowsAfterConflict = (
      await pool.query(
        `SELECT resulting_revision FROM public.recruitment_interview_correction_assessments
         WHERE interview_id=$1 ORDER BY resulting_revision`,
        [correctionId],
      )
    ).rows;
    assert.deepEqual(staleRowsAfterConflict.map((row: any) => row.resulting_revision), [2, 3]);
    await staleCorrection.close();
    await staleCorrectionContext.close();
    stage("stale correction rejects old base and preserves visible draft without persistence");
    stage("lost correction response retries identical payload, base and idempotency key without duplicate persistence");
    stage("second correction and reload preserve ordered history");
    const afterSecond = await (await get(correctionId)).json();
    assert.ok(afterSecond.history.filter((entry: any) => entry._tag === "Correction").length >= 2);
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
    const secondCorrections = afterSecond.history.filter((entry: any) => entry._tag === "Correction");
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
          typeof entry.correctedAt === "string" &&
          typeof entry.commandId === "string",
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
          typeof row.commandId === "string",
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
      receiptRows.map((row: any) => [row.commandId, row.predecessorRevision, row.resultingRevision]),
      correctionRows.map((row: any) => [row.commandId, row.predecessorRevision, row.resultingRevision]),
    );
    assert.ok(
      receiptRows.every(
        (row: any) =>
          typeof row.commandJson === "object" &&
          row.commandJson !== null &&
          typeof row.observationJson === "object" &&
          row.observationJson !== null,
      ),
    );
    assert.deepEqual(
      auditRows.map((row: any) => [row.commandId, row.actorPersonId, row.predecessorRevision, row.resultingRevision]),
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
    stage("old displayed body with newer opaque ETag rejects at correction boundary without writes");
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
    assert.equal(finalDetail.history.filter((entry: any) => entry._tag === "Correction").length, 5);
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
      `UPDATE public.organization_memberships SET end_at=CURRENT_TIMESTAMP - interval '1 day' WHERE membership_id='membership-native-conduct-leader-0063'`,
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
        },
        null,
        2,
      ),
    );
    await page.goto(`${ui}/dashboard/intervjuer`);
    await open(page, "Sofie Gjennomfører");
  }
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
  await page.getByText("Completed", { exact: true }).waitFor();
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
  recordGate("ordinary assigned member: required choice, keyboard finalization, reload and exact stale-correction conflict retention");
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
    `UPDATE public.organization_memberships SET end_at=CURRENT_TIMESTAMP - interval '1 day' WHERE membership_id='membership-native-conduct-leader-0063'`,
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
  assert.deepEqual(await effectSnapshot(), effectsBefore);
  // This separate actual onboarding action observes its applicant-facing projection.
  const onboardingToken = `onboard_${randomBytes(32).toString("hex")}`;
  secrets.push(onboardingToken);
  await pool.query(
    `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('identity-recommendation-no','application-recommendation-no','applicant-recommendation-no',$1,CURRENT_TIMESTAMP+interval '1 day','Open','journey-conduct-leader-0063',CURRENT_TIMESTAMP)`,
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
  const staleIdentity = await waiting;
  assert.equal(staleIdentity.status, 409);
  assert.equal((await staleIdentity.json()).code, "transaction.conflict");
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
    "known self denied before read/finalize/cancel and both receipt layers; different Person allowed; real waiting serializable snapshot fails409 then self-denial",
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
        `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('invalid-direct-0101','[]',1,1,1,'journey-conduct-leader-0063',CURRENT_TIMESTAMP,1,$1)`,
        [value],
      );
    } catch (e) {
      rejected = (e as { code?: string }).code === "23514";
    }
    assert.ok(rejected);
  }
  await page.reload();
  await open(page, "history Recommendation");
  const currentHistoryDetail = await (await get("interview-recommendation-history")).json();
  assert.equal(
    await page.locator("#interviewer-recommendation").inputValue(),
    currentHistoryDetail.recommendation,
  );
  assert.equal(
    await page.locator("#interviewer-recommendation option:checked").textContent(),
    currentHistoryDetail.recommendation,
  );
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "historical-desktop.png") });
  await auditPage(page, "historical-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".fs-conduct").screenshot({ path: join(artifacts, "historical-mobile.png") });
  await auditPage(page, "historical-mobile");
  await pool.query(
    `UPDATE public.organization_memberships SET is_team_leader=true,position_id='teamleader' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("link", { name: "Søkerkontoer", exact: true }).click();
  await page.waitForURL(/\/dashboard\/onboarding$/);
  await page.getByRole("heading", { name: "Søkerkontoer", exact: true }).waitFor();
  await page.goto(`${ui}/dashboard/intervjuer`);
  await page.getByRole("link", { name: "Intervjuskjema", exact: true }).click();
  await page.waitForURL(/\/dashboard\/intervjusjema$/);
  await page.getByRole("heading", { name: "Intervjusjema", exact: true }).waitFor();
  await page.goto(`${ui}/dashboard/intervjuer`);
  await page.getByRole("link", { name: "Kontrollpanel", exact: true }).click();
  await page.waitForURL(/\/dashboard\/?$/);
  await page.getByRole("heading", { name: "Velkommen, Lina Lagleder", exact: true }).waitFor();
  await pool.query(
    `UPDATE public.organization_memberships SET is_team_leader=false,position_id='member' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  if (!process.argv.includes("--correction-mode")) {
  await runReturningAssistantBrowserJourney({
    browser,
    page,
    pool,
    api,
    ui,
    artifacts,
    auditPage,
    coordinatorEmail: "coordinator.report@example.invalid",
    coordinatorPassword: password,
    errors,
  });
  recordGate(
    `returning registration route ${"/dashboard/tidligere-assistenter"} and report population ${returningAssistantFixture.admissionPeriodId}`,
  );
  }

  recordGate(
    "owned interview shell retains role-scoped onboarding and existing schema/dashboard navigation",
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
  const lifecycleExpectedInterviewIds = rows
    .map((row: any) => row.interview_id)
    .filter(
      (interviewId: string) =>
        !["interview-recommendation-history", "interview-recommendation-link-race"].includes(interviewId),
    )
    .sort();
  assert.deepEqual(
    lifecycle.map((row: any) => row.interview_id).sort(),
    lifecycleExpectedInterviewIds,
  );
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
  // oxlint-effect-plugin allow(no-ambient-console): dev only: sanitized local acceptance artifact location.
  console.log(JSON.stringify({ result: "Passed", revision, artifacts, gates }));
} catch (error) {
  if (error instanceof ReturningLoginProbeComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): bounded local login probe result.
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
    // oxlint-effect-plugin allow(no-ambient-console): bounded returning/report result.
    console.log(
      JSON.stringify({
        result: "ReturningTargeted",
        revision,
        artifacts,
        gates,
        journey: error.result,
      }),
    );
  } else if (error instanceof CorrectionTargetedComplete) {
    // oxlint-effect-plugin allow(no-ambient-console): bounded local correction result.
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
      .filter((call) => call.origin === "ReturningAssistant")
      .map(({ effectId, commandId, kind, status }) => ({ effectId, commandId, kind, status }));
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
    // oxlint-effect-plugin allow(no-ambient-console): dev only: redacted local rehearsal failure evidence.
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
  for (const child of children.reverse()) await stopPreviewScenarioBackend(child);
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
}
