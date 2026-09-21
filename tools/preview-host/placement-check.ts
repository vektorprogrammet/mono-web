import { createPromiseClient } from "../../packages/sdk/src/promise.js";
import { PlacementScope, PlacementCommand } from "../../packages/domain/src/placements/schema.js";
/** 0096 real local API + browser acceptance. Reuses native identity seed and owned process lifecycle. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stopPreviewScenarioBackend } from "./preview-scenario.js";
const root = new URL("../../", import.meta.url).pathname;
const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const requireApi = createRequire(new URL("../../packages/http-api/package.json", import.meta.url));
const { Schema } = await import(requireApi.resolve("effect"));
const { Pool } = requireDatabase("pg");
const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });
const mode = process.argv[2];
assert.ok(
  process.argv.length === 3 && (mode === "--browser" || mode === "--api-only"),
  "Usage: bun run tools/preview-host/placement-check.ts --browser | --api-only",
);
const revision = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed clean artifact");
const artifacts = await mkdtemp(join(tmpdir(), "vektor-placements-0096-"));
const children: ReturnType<typeof spawn>[] = [];
const outputs: string[] = [];
const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => outputs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => outputs.push(String(chunk)));
  return child;
};
const port = async (requested = 0): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requested, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const value = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pool: InstanceType<typeof Pool> | undefined;
let evidence: Record<string, unknown> | undefined;
try {
  const pgPort = await port();
  const backendPort = await port();
  const dashboardPort = await port(5174);
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start("postgres", ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts]);
  const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  pool = new Pool({ connectionString: postgresUrl });
  for (let n = 0; ; n++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (n > 100) throw e;
      await delay(100);
    }
  }
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const environment = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    JOURNEY_SEED_PG_URL: postgresUrl,
  };
  for (const key of Object.keys(environment))
    if (
      key.startsWith("CONTACT_") ||
      (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
    )
      delete environment[key as keyof typeof environment];
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
  const departmentId = "department-native-journey-0049";
  const semesterId = "semester-historical-0096";
  const secondSemesterId = "semester-native-journey-0049";
  const wrongDepartmentId = "department-wrong-0096";
  const leaderId = "journey-rec-leader-0049";
  const volunteerId = "journey-rec-interviewer-a-0049";
  const wrongId = "journey-rec-interviewer-b-0049";
  await pool.query(`
    INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES ('${semesterId}','2024-01-01','2024-07-01');
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
  `);
  const credentialSnapshot = async () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          (
            await pool.query(
              'SELECT id,"userId","providerId",password FROM auth.account ORDER BY id',
            )
          ).rows,
        ),
      )
      .digest("hex");
  const credentialsBefore = await credentialSnapshot();
  const peopleBefore = (await pool.query("SELECT * FROM person_profiles ORDER BY person_id")).rows;
  start("bun", ["run", "--cwd", "apps/backend", "start"], environment);
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(`${backendOrigin}/health`)).ok) break;
    } catch {}
    if (n > 150) throw Error("backend startup failed");
    await delay(200);
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
  };
  const login = async (person: { email: string; password: string }) => {
    const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: dashboardOrigin },
      body: JSON.stringify(person),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  };
  const leader = await login(persons.leader),
    volunteer = await login(persons.volunteer),
    wrong = await login(persons.wrongDepartment);
  const sdk = createPromiseClient(backendOrigin, { cookie: leader, origin: dashboardOrigin });
  const query = Schema.decodeUnknownSync(PlacementScope)({ departmentId, semesterId });
  const boardPath = `/api/placements?${new URLSearchParams(query)}`;
  const ownPath = `/api/placements/affiliation?departmentId=${departmentId}`;
  const request = async (
    path: string,
    cookie?: string,
    body?: unknown,
    etag?: string,
    key = randomBytes(18).toString("base64url"),
  ) =>
    fetch(`${backendOrigin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: dashboardOrigin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key,
              ...(etag ? { "if-match": etag } : {}),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const expectStatus = async (response: Response, status: number, code?: string) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    if (code) assert.equal(body.code, code);
    return body;
  };
  const readBoard = async () => (await sdk.placements.readBoard({ query, headers: {} })).body;
  const command = async (payload: unknown) => {
    const board = await readBoard();
    return (
      await sdk.placements.commandBoard({
        query,
        headers: {
          "if-match": board.etag,
          "idempotency-key": randomBytes(18).toString("base64url"),
        },
        payload: Schema.decodeUnknownSync(PlacementCommand)(payload),
      })
    ).body;
  };
  const boardResponse = await request(boardPath, leader);
  assert.equal(boardResponse.headers.get("cache-control"), "private, no-store");
  await expectStatus(boardResponse, 200);
  assert.deepEqual(
    (await readBoard()).schools.map((school) => school.schoolId),
    [961, 962],
  );
  assert.ok(
    (await sdk.placements.listScopes()).body.semesters.some(
      (semester) => semester.semesterId === semesterId,
    ),
  );
  await expectStatus(await request(boardPath), 401);
  await expectStatus(await request(boardPath, volunteer), 403, "authority.denied");
  await expectStatus(await request(boardPath, wrong), 403, "authority.denied");
  assert.equal((await expectStatus(await request(ownPath, volunteer), 200)).personId, volunteerId);
  assert.ok(
    !JSON.stringify(await expectStatus(await request(ownPath, volunteer), 200)).includes(leaderId),
  );
  // A real member still has no coordinator authority; the browser cohort has no team at all.
  await pool.query(
    "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,end_at,is_team_leader,is_suspended,revision) VALUES ('member-0096',$1,'team-native-journey-0049','2026-01-01',NULL,false,false,0)",
    [volunteerId],
  );
  await expectStatus(await request(boardPath, volunteer), 403, "authority.denied");
  await pool.query("DELETE FROM organization_memberships WHERE membership_id='member-0096'");
  await pool.query("UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1", [
    leaderId,
  ]);
  await expectStatus(await request(boardPath, leader), 403, "authority.denied");
  await pool.query("UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1", [
    leaderId,
  ]);
  await pool.query(
    "INSERT INTO organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-0096',$1,'2026-01-01',NULL,0)",
    [wrongId],
  );
  await expectStatus(await request(boardPath, wrong), 200);
  await pool.query(
    "DELETE FROM organization_global_administrator_grants WHERE grant_id='admin-0096'",
  );

  // API cohort uses the coordinator's own Person; browser starts with an untouched no-team volunteer.
  let own = await expectStatus(await request(ownPath, leader), 200);
  const ownKey = randomBytes(18).toString("base64url");
  const pending = await expectStatus(
    await request(ownPath, leader, { action: "Request" }, own.etag, ownKey),
    200,
  );
  assert.equal(pending.status, "Pending");
  assert.deepEqual(
    await expectStatus(
      await request(ownPath, leader, { action: "Request" }, own.etag, ownKey),
      200,
    ),
    pending,
  );
  await expectStatus(
    await request(ownPath, leader, { action: "Withdraw" }, own.etag, ownKey),
    409,
    "idempotency.digest-conflict",
  );
  await expectStatus(await request(ownPath, leader, { action: "Withdraw" }, pending.etag), 200);
  own = await expectStatus(await request(ownPath, leader), 200);
  await expectStatus(await request(ownPath, leader, { action: "Request" }, own.etag), 200);
  await command({ action: "Affiliation", personId: leaderId, transition: "Establish" });
  const create = {
    action: "Create",
    personId: leaderId,
    schoolId: 961,
    day: "Monday",
    workdays: 4,
    block: "1",
  };
  let board = await readBoard();
  await expectStatus(await request(boardPath, leader, create), 428, "precondition.required");
  for (const invalid of [
    { ...create, workdays: 0 },
    { ...create, workdays: 9 },
    { ...create, day: "Sunday" },
    { ...create, block: "3" },
  ])
    await expectStatus(await request(boardPath, leader, invalid, board.etag), 422);
  for (const schoolId of [963, 964])
    await expectStatus(
      await request(boardPath, leader, { ...create, schoolId }, board.etag),
      422,
      "scope.invalid",
    );
  await expectStatus(
    await request(boardPath, leader, { ...create, personId: volunteerId }, board.etag),
    422,
    "affiliation.inactive",
  );
  const createKey = randomBytes(18).toString("base64url");
  const createEtag = board.etag;
  const created = await expectStatus(
    await request(boardPath, leader, create, board.etag, createKey),
    200,
  );
  const placementId = created.placements.find(
    (p: { personId: string; block: string }) => p.personId === leaderId && p.block === "1",
  ).placementId;
  assert.deepEqual(
    await expectStatus(await request(boardPath, leader, create, board.etag, createKey), 200),
    created,
  );
  await expectStatus(
    await request(boardPath, leader, { ...create, workdays: 5 }, board.etag, createKey),
    409,
    "idempotency.digest-conflict",
  );
  await expectStatus(
    await request(boardPath, leader, { ...create, block: "2" }, board.etag),
    412,
    "precondition.failed",
  );
  board = await readBoard();
  await expectStatus(
    await request(boardPath, leader, create, board.etag),
    409,
    "placement.overlap",
  );
  await command({ ...create, block: "2" });
  await command({ ...create, block: "Both" });
  // Forging board scope never changes the persisted item's canonical semester.
  const otherPath = `/api/placements?${new URLSearchParams({ departmentId, semesterId: secondSemesterId })}`;
  const other = await expectStatus(await request(otherPath, leader), 200);
  await expectStatus(
    await request(otherPath, leader, { action: "Remove", placementId }, other.etag),
    404,
    "resource.not-found",
  );
  board = await readBoard();
  const edits = await Promise.all(
    [6, 7].map((workdays) =>
      request(
        boardPath,
        leader,
        { action: "Edit", placementId, schoolId: 961, day: "Tuesday", workdays, block: "1" },
        board.etag,
      ),
    ),
  );
  assert.equal(edits.filter((r) => r.status === 200).length, 1);
  for (const response of edits.filter((r) => r.status !== 200))
    await expectStatus(
      response,
      response.status === 409 ? 409 : 412,
      response.status === 409 ? "transaction.conflict" : "precondition.failed",
    );
  await command({ action: "Remove", placementId });
  const retained = await pool.query(
    "SELECT active,revision FROM assistant_placements WHERE placement_id=$1",
    [placementId],
  );
  assert.deepEqual(retained.rows, [{ active: false, revision: 3 }]);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT action FROM assistant_placement_audit WHERE placement_id=$1 ORDER BY revision",
        [placementId],
      )
    ).rows.map((r: { action: string }) => r.action),
    ["Create", "Edit", "Remove"],
  );
  board = await readBoard();
  const concurrentCreates = await Promise.all(
    [0, 1].map(() => request(boardPath, leader, create, board.etag)),
  );
  assert.equal(concurrentCreates.filter((r) => r.status === 200).length, 1);
  for (const response of concurrentCreates.filter((r) => r.status !== 200))
    await expectStatus(
      response,
      response.status === 409 ? 409 : 412,
      response.status === 409 ? "transaction.conflict" : "precondition.failed",
    );
  const replacement = (await readBoard()).placements.find(
    (p) => p.personId === leaderId && p.block === "1" && p.active,
  );
  assert.ok(replacement);
  await command({ action: "Remove", placementId: replacement.placementId });
  await command({ action: "Affiliation", personId: leaderId, transition: "Revoke" });
  board = await readBoard();
  assert.equal(
    board.placements.filter((p) => p.active).length,
    2,
    "affiliation revocation preserves historical placements",
  );
  await expectStatus(
    await request(boardPath, leader, create, board.etag),
    422,
    "affiliation.inactive",
  );
  await pool.query("UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1", [
    leaderId,
  ]);
  await expectStatus(
    await request(boardPath, leader, create, createEtag, createKey),
    403,
    "authority.denied",
  );
  await pool.query("UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1", [
    leaderId,
  ]);
  assert.equal((await expectStatus(await request(otherPath, leader), 200)).placements.length, 0);
  const apiHistoryBeforeBrowser = (
    await pool.query(
      "SELECT * FROM assistant_placements WHERE person_id=$1 ORDER BY placement_id",
      [leaderId],
    )
  ).rows;
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
  };
  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  let browserEvidence: Record<string, unknown> | null = null;
  if (mode === "--browser") {
    run(
      "bun",
      ["apps/dashboard/e2e/run-real-native-placement.mjs"],
      { ...environment, PLACEMENT_JOURNEY_MANIFEST: manifestPath },
      300_000,
    );
    browserEvidence = JSON.parse(await readFile(join(artifacts, "browser-evidence.json"), "utf8"));
    assert.equal(browserEvidence?.passed, true);
    assert.equal(browserEvidence?.revision, revision);
    const actual = (
      await pool.query(
        'SELECT placement_id AS "placementId",person_id AS "personId",school_id::integer AS "schoolId",semester_id AS "semesterId",day,workdays,block,active,revision FROM assistant_placements WHERE person_id=$1 ORDER BY block,placement_id',
        [volunteerId],
      )
    ).rows;
    assert.deepEqual(
      actual,
      browserEvidence?.finalExpected,
      "browser expectations independently read from PostgreSQL",
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM assistant_placements WHERE person_id=$1 ORDER BY placement_id",
          [leaderId],
        )
      ).rows,
      apiHistoryBeforeBrowser,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT action,actor_person_id FROM organization_volunteer_affiliation_audit WHERE person_id=$1 ORDER BY revision",
          [volunteerId],
        )
      ).rows,
      [
        { action: "Request", actor_person_id: volunteerId },
        { action: "Establish", actor_person_id: leaderId },
        { action: "Revoke", actor_person_id: leaderId },
      ],
    );
  }
  assert.deepEqual(
    await credentialSnapshot(),
    credentialsBefore,
    "placement does not mutate account credentials",
  );
  assert.deepEqual(
    (await pool.query("SELECT * FROM person_profiles ORDER BY person_id")).rows,
    peopleBefore,
    "canonical Person unchanged",
  );
  evidence = {
    revision,
    apiPassed: true,
    browserEvidence,
    runtime: {
      bun: process.versions.bun,
      postgres: (await pool.query("SELECT version() AS version")).rows[0].version,
    },
    apiGates: [
      "real generated SDK read/write decoding",
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
      "canonical Person and account credentials unchanged",
    ],
    scope: "owned synthetic loopback runtime; no production/provider effects",
  };
} catch (error) {
  process.stderr.write(outputs.join("").slice(-12000));
  throw error;
} finally {
  if (pool) await pool.end();
  for (const child of children.reverse()) await stopPreviewScenarioBackend(child);
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
  await rm(join(artifacts, "manifest.json"), { force: true });
  if (evidence) {
    await writeFile(
      join(artifacts, "evidence.json"),
      JSON.stringify(
        {
          ...evidence,
          cleanup: "owned processes exited; disposable PostgreSQL and credential manifest removed",
        },
        null,
        2,
      ),
    );
    process.stdout.write(`${artifacts}/evidence.json\n`);
  }
}
