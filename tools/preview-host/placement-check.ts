import { createPromiseClient } from "../../packages/sdk/src/promise.js";
import {
  CoverageCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementScope,
  SchoolServiceDispatchNotificationRequest,
  SchoolServiceNotificationRequest,
} from "../../packages/domain/src/placements/schema.js";
import { IdempotencyIfMatchHeaders } from "../../packages/http-api/src/http-semantics.js";
/** 0096/0110/0111 real local API + browser acceptance with an owned process lifecycle. */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {type PreviewRuntimeObservation,  stopPreviewScenarioBackend } from "./preview-scenario.js";
import { Predicate, Schema, Record as Rec } from "effect";

const root = new URL("../../", import.meta.url).pathname;

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Pool } = requireDatabase("pg");

const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });

const execFileAsync = promisify(execFile);

const runAsync = async (command: string, args: string[], env = process.env, timeout = 60_000) =>
  (
    await execFileAsync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout;

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
  assert.ok(address && !Predicate.isString(address));
  const value = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return value;
};

const eventually = async <T>(
  description: string,
  inspect: () => Promise<T | undefined>,
  timeout = 20_000,
): Promise<T> => {
  const deadline = Date.now() + timeout;

  for (;;) {
    const value = await inspect();

    if (value !== undefined) return value;

    if (Date.now() >= deadline) throw Error(`Timed out waiting for ${description}`);
    await delay(50);
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let pool: InstanceType<typeof Pool> | undefined;

let evidence: Schema.JsonObject | undefined;

let notificationServer: HttpServer | undefined;

let dispatchProviderFails = true;

type NotificationCapture<Payload> = {
  authorization?: string;
  idempotencyKey?: string;
  readonly body: Payload;
};

const notificationRequests: Array<NotificationCapture<typeof SchoolServiceNotificationRequest.Type>> = [];

const dispatchNotificationRequests: Array<NotificationCapture<typeof SchoolServiceDispatchNotificationRequest.Type>> = [];

try {
  const pgPort = await port();
  const backendPort = await port();
  const dashboardPort = await port();
  const notificationPort = await port();

  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const idempotencyKeyHeader = request.headers["idempotency-key"];

    const idempotencyKey = Array.isArray(idempotencyKeyHeader)
      ? idempotencyKeyHeader[0]
      : idempotencyKeyHeader;

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (Predicate.isTagged(payload, "NotifySchoolServiceSubstituteOffer")) {
      const observed: NotificationCapture<typeof SchoolServiceDispatchNotificationRequest.Type> = {
        body: Schema.decodeUnknownSync(SchoolServiceDispatchNotificationRequest)(payload),
      };

      if (request.headers.authorization !== undefined) observed.authorization = request.headers.authorization;

      if (idempotencyKey !== undefined) observed.idempotencyKey = idempotencyKey;
      dispatchNotificationRequests.push(observed);
      response.statusCode = dispatchProviderFails ? 503 : 204;
      response.end();

      return;
    }

    const observed: NotificationCapture<typeof SchoolServiceNotificationRequest.Type> = {
      body: Schema.decodeUnknownSync(SchoolServiceNotificationRequest)(payload),
    };

    if (request.headers.authorization !== undefined) observed.authorization = request.headers.authorization;

    if (idempotencyKey !== undefined) observed.idempotencyKey = idempotencyKey;
    notificationRequests.push(observed);
    response.statusCode = 204;
    response.end();
  });

  notificationServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(notificationPort, "127.0.0.1", resolve);
  });
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
    SCHOOL_SERVICE_NOTIFICATION_MODE: "http",
    SCHOOL_SERVICE_NOTIFICATION_URL: `http://127.0.0.1:${notificationPort}/school-service`,
    SCHOOL_SERVICE_NOTIFICATION_TOKEN: "synthetic-school-service-token",
    SCHOOL_SERVICE_NOTIFICATION_POLL_MS: "25",
    SCHOOL_SERVICE_NOTIFICATION_STALE_MS: "1000",
    SCHOOL_SERVICE_NOTIFICATION_TIMEOUT_MS: "2000",
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE: "http",
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_URL: `http://127.0.0.1:${notificationPort}/school-service`,
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TOKEN: "synthetic-school-service-dispatch-token",
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_POLL_MS: "25",
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_STALE_MS: "1000",
    SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TIMEOUT_MS: "2000",
  };

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

  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
  run("bun", ["run", "--cwd", "packages/database", "identity:seed"], {
    ...environment,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify([substitute]),
  });
  const departmentId = "department-native-journey-0049";
  const semesterId = "semester-historical-0096";
  const secondSemesterId = "semester-native-journey-0049";
  const wrongDepartmentId = "department-wrong-0096";
  const leaderId = "journey-rec-leader-0049";
  const volunteerId = "journey-rec-interviewer-a-0049";
  const wrongId = "journey-rec-interviewer-b-0049";
  await pool.query(`
    INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES ('${semesterId}','2024-01-01','2024-07-01');
    INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES
      ('admission-period-coverage-0111','${departmentId}','${semesterId}','2024-01-01','2024-07-01',0,'coverage-seed-0111');
    INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest) VALUES
      ('applicant-coverage-0111','${substitute.email}','${substitute.email}','${substitute.firstName}','${substitute.lastName}','90000111',0,'field-native-journey-0049',3,NULL);
    INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision) VALUES
      ('application-coverage-0111','applicant-coverage-0111','admission-period-coverage-0111','${departmentId}','field-native-journey-0049',3,'2024-02-01T10:00:00.000Z',0);
    INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES
      ('invitation-coverage-0111','application-coverage-0111','applicant-coverage-0111','${"c".repeat(64)}','2027-01-01T00:00:00.000Z','Claimed','${leaderId}','2024-02-01T10:00:00.000Z');
    INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES
      ('applicant-coverage-0111','${substitute.personId}','2024-02-01T10:00:00.000Z','invitation-coverage-0111');
    INSERT INTO admission_substitute_preferences(application_id,active,monday,tuesday,wednesday,thursday,friday,language,revision) VALUES
      ('application-coverage-0111',true,true,true,false,false,false,'Norwegian',1);
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
    candidate: { email: substitute.email, password: substitute.password },
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
    wrong = await login(persons.wrongDepartment),
    candidate = await login(persons.candidate);

  const sdk = createPromiseClient(backendOrigin, { cookie: leader, origin: dashboardOrigin });

  const volunteerSdk = createPromiseClient(backendOrigin, {
    cookie: volunteer,
    origin: dashboardOrigin,
  });

  const wrongSdk = createPromiseClient(backendOrigin, { cookie: wrong, origin: dashboardOrigin });

  const candidateSdk = createPromiseClient(backendOrigin, {
    cookie: candidate,
    origin: dashboardOrigin,
  });

  const query = Schema.decodeUnknownSync(PlacementScope)({ departmentId, semesterId });
  const boardPath = `/api/placements?${new URLSearchParams(query)}`;
  const ownPath = `/api/placements/affiliation?departmentId=${departmentId}`;
  const coverageBoardPath = `/api/placements/coverage?${new URLSearchParams(query)}`;
  const ownCoveragePath = `/api/placements/coverage/own?${new URLSearchParams(query)}`;

  const request = async (
    path: string,
    cookie?: string,
    body?: Schema.Json,
    etag?: string,
    key = randomBytes(18).toString("base64url"),
  ) => {
    const nativeHeaders = new Headers();
    nativeHeaders.set("origin", dashboardOrigin);

    if (cookie) {
      nativeHeaders.set("cookie", cookie);
    }

    if (!(body === undefined)) {
      nativeHeaders.set("content-type", "application/json");
      nativeHeaders.set("idempotency-key", key);

      if (etag) {
        nativeHeaders.set("if-match", etag);
      }
    }

    const requestBody: Pick<RequestInit, "body"> =
      body === undefined ? {} : { body: JSON.stringify(body) };

    return fetch(`${backendOrigin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: nativeHeaders,
      ...requestBody,
    });
  };

  const expectStatus = async (response: Response, status: number, code?: string) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));

    if (code) assert.equal(body.code, code);

    return body;
  };

  const idempotencyHeaders = (etag: string, key = randomBytes(18).toString("base64url")) =>
    Schema.decodeUnknownSync(IdempotencyIfMatchHeaders)({
      "if-match": etag,
      "idempotency-key": key,
    });

  const readBoard = async () => (await sdk.placements.readBoard({ query })).body;

  const command = async (payload: Schema.Json) => {
    const board = await readBoard();

    return (
      await sdk.placements.commandBoard({
        query,
        headers: idempotencyHeaders(board.etag),
        payload: Schema.decodeUnknownSync(PlacementCommand)(payload),
      })
    ).body;
  };

  const readOwnCoverage = async (client: typeof sdk) =>
    (await client.placements.readOwnCoverage({ query })).body;

  const readCoverageBoard = async () => (await sdk.placements.readCoverageBoard({ query })).body;

  const commandOwnCoverage = async (
    client: typeof sdk,
    payload: Schema.Json,
    etag?: string,
    key?: string,
  ) => {
    const resource = etag === undefined ? await readOwnCoverage(client) : undefined;

    return (
      await client.placements.commandOwnCoverage({
        query,
        headers: idempotencyHeaders(etag ?? resource!.etag, key),
        payload: Schema.decodeUnknownSync(OwnCoverageCommand)(payload),
      })
    ).body;
  };

  const commandCoverage = async (payload: Schema.Json, etag?: string, key?: string) => {
    const resource = etag === undefined ? await readCoverageBoard() : undefined;

    return (
      await sdk.placements.commandCoverageBoard({
        query,
        headers: idempotencyHeaders(etag ?? resource!.etag, key),
        payload: Schema.decodeUnknownSync(CoverageCommand)(payload),
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

  for (const placement of (await readBoard()).placements.filter(
    (candidate) => candidate.personId === leaderId && candidate.active,
  ))
    await command({ action: "Remove", placementId: placement.placementId });
  assert.equal((await expectStatus(await request(otherPath, leader), 200)).placements.length, 0);
  // The API cohort begins from a confirmed roster; the browser independently
  // confirms a two-person roster through the placement/service journey.
  const candidateAffiliation = await expectStatus(await request(ownPath, candidate), 200);
  assert.equal(candidateAffiliation.status, "Absent");
  assert.equal(
    (
      await expectStatus(
        await request(ownPath, candidate, { action: "Request" }, candidateAffiliation.etag),
        200,
      )
    ).status,
    "Pending",
  );
  const wrongAffiliation = await expectStatus(await request(ownPath, wrong), 200);
  assert.equal(wrongAffiliation.status, "Absent");
  assert.equal(
    (
      await expectStatus(
        await request(ownPath, wrong, { action: "Request" }, wrongAffiliation.etag),
        200,
      )
    ).status,
    "Pending",
  );
  const leaderAffiliation = await expectStatus(await request(ownPath, leader), 200);
  assert.equal(leaderAffiliation.status, "Inactive");
  assert.equal(
    (
      await expectStatus(
        await request(ownPath, leader, { action: "Request" }, leaderAffiliation.etag),
        200,
      )
    ).status,
    "Pending",
  );
  await command({ action: "Affiliation", personId: substitute.personId, transition: "Establish" });
  await command({ action: "Affiliation", personId: wrongId, transition: "Establish" });
  await command({ action: "Affiliation", personId: leaderId, transition: "Establish" });
  const apiCoverageProposalId = `school-service-proposal-${"a".repeat(64)}`;
  await pool.query(
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
  );
  const historicalOccurrenceId = `school-service-occurrence-${"3".repeat(64)}`;
  // Simulate a pre-migration row in the disposable database. Product writes cannot bypass this guard.
  const fixtureClient = await pool.connect();

  try {
    await fixtureClient.query("BEGIN");
    await fixtureClient.query(
      "ALTER TABLE school_service_occurrences DISABLE TRIGGER school_service_occurrence_insert_guard",
    );
    await fixtureClient.query(
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
    );
    await fixtureClient.query(
      "ALTER TABLE school_service_occurrences ENABLE TRIGGER school_service_occurrence_insert_guard",
    );
    await fixtureClient.query("COMMIT");
  } catch (error) {
    await fixtureClient.query("ROLLBACK");
    throw error;
  } finally {
    fixtureClient.release();
  }

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
    const before = await readBoard();
    const result = await command(schedule(day, serviceDate));

    const commitment = result.commitments.find(
      (item) => item.schoolId === 961 && item.serviceDate === serviceDate && item.block === "1",
    );

    assert.ok(commitment);
    assert.equal(commitment.requiredVolunteers, day === "Wednesday" ? 2 : 1);
    assert.equal(commitment.decision, null);
    commitmentIds.set(day, commitment.commitmentId);

    if (day === "Monday") {
      await expectStatus(
        await request(boardPath, leader, schedule(day, serviceDate), before.etag),
        412,
        "precondition.failed",
      );
      await expectStatus(
        await request(boardPath, leader, schedule(day, serviceDate), result.etag),
        409,
      );
    }
  }

  const commitments = Schema.decodeUnknownSync(
    Schema.Struct(Rec.map(serviceDates, () => Schema.String)),
  )(Object.fromEntries(commitmentIds));

  assert.equal(
    (await readCoverageBoard()).commitments.filter(
      (item) => item.proposalId === apiCoverageProposalId,
    ).length,
    4,
  );
  assert.equal(
    (await readBoard()).commitments.filter((item) => item.proposalId === apiCoverageProposalId)
      .length,
    4,
  );
  await expectStatus(
    await request(
      boardPath,
      volunteer,
      schedule("Monday", serviceDates.Monday),
      (await readBoard()).etag,
    ),
    403,
    "authority.denied",
  );
  await expectStatus(
    await request(
      boardPath,
      leader,
      { ...schedule("Monday", serviceDates.Monday), serviceDate: "2024-03-05" },
      (await readBoard()).etag,
    ),
    422,
  );
  await expectStatus(
    await request(
      boardPath,
      leader,
      { ...schedule("Monday", serviceDates.Monday), startTime: "11:00", endTime: "09:00" },
      (await readBoard()).etag,
    ),
    422,
  );
  await expectStatus(
    await request(boardPath, leader, schedule("Friday", "2024-03-08"), (await readBoard()).etag),
    409,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT commitment_id FROM school_service_occurrences WHERE occurrence_id=$1",
        [historicalOccurrenceId],
      )
    ).rows[0].commitment_id,
    null,
  );
  const beforeOverlap = await readBoard();
  await expectStatus(
    await request(
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
    (await readBoard()).etag,
    beforeOverlap.etag,
    "overlapping person appointment has no write",
  );
  assert.equal((await request(ownCoveragePath)).status, 401);
  assert.equal((await request(coverageBoardPath)).status, 401);
  await expectStatus(await request(coverageBoardPath, volunteer), 403, "authority.denied");
  await expectStatus(await request(coverageBoardPath, wrong), 403, "authority.denied");
  await expectStatus(
    await request(
      `/api/placements/coverage?${new URLSearchParams({
        departmentId: wrongDepartmentId,
        semesterId,
      })}`,
      leader,
    ),
    403,
    "authority.denied",
  );
  const ownCoverageResponse = await request(ownCoveragePath, volunteer);
  assert.equal(ownCoverageResponse.headers.get("cache-control"), "private, no-store");
  await expectStatus(ownCoverageResponse, 200);
  const initialOwnCoverage = await readOwnCoverage(volunteerSdk);
  assert.deepEqual(
    initialOwnCoverage.commitments
      .filter((item) => item.proposalId === apiCoverageProposalId)
      .map((item) => item.commitmentId)
      .sort(),
    [commitments.Monday, commitments.Wednesday].sort(),
  );
  assert.deepEqual(
    (await readOwnCoverage(wrongSdk)).commitments.filter(
      (item) => item.proposalId === apiCoverageProposalId,
    ),
    [],
  );
  assert.deepEqual(
    (await readOwnCoverage(candidateSdk)).commitments.filter(
      (item) => item.proposalId === apiCoverageProposalId,
    ),
    [],
  );
  await expectStatus(
    await request(
      ownCoveragePath,
      volunteer,
      { action: "ReportAbsence", commitmentId: commitments.Tuesday },
      initialOwnCoverage.etag,
    ),
    422,
  );
  const coveredAbsenceCommand = { action: "ReportAbsence", commitmentId: commitments.Monday };
  const reportAbsenceKey = randomBytes(18).toString("base64url");

  const reportedOwnCoverage = await commandOwnCoverage(
    volunteerSdk,
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
    await expectStatus(
      await request(
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
  await expectStatus(
    await request(
      ownCoveragePath,
      volunteer,
      { ...coveredAbsenceCommand, commitmentId: commitments.Wednesday },
      initialOwnCoverage.etag,
      reportAbsenceKey,
    ),
    409,
    "idempotency.digest-conflict",
  );

  const overlapBoard = await command({
    action: "Create",
    personId: substitute.personId,
    schoolId: 961,
    day: "Monday",
    workdays: 4,
    block: "1",
  });

  const overlapPlacement = overlapBoard.placements.find(
    (placement) =>
      placement.personId === substitute.personId &&
      placement.day === "Monday" &&
      placement.block === "1" &&
      placement.active,
  );

  assert.ok(overlapPlacement);
  let coverageBoard = await readCoverageBoard();

  const dispatch = (candidatePersonId: string) => ({
    action: "DispatchSubstituteOffer",
    absenceId: coveredAbsence.absenceId,
    candidatePersonId,
  });

  await expectStatus(
    await request(coverageBoardPath, leader, dispatch(volunteerId), coverageBoard.etag),
    422,
    "offer.candidate-ineligible",
  );
  await expectStatus(
    await request(coverageBoardPath, leader, dispatch(wrongId), coverageBoard.etag),
    422,
    "offer.candidate-ineligible",
  );
  await expectStatus(
    await request(coverageBoardPath, leader, dispatch(substitute.personId), coverageBoard.etag),
    422,
    "offer.candidate-ineligible",
  );
  await command({ action: "Remove", placementId: overlapPlacement.placementId });
  coverageBoard = await readCoverageBoard();
  assert.deepEqual(
    coverageBoard.candidates.filter(
      (candidate) => candidate.absenceId === coveredAbsence.absenceId,
    ),
    [
      {
        absenceId: coveredAbsence.absenceId,
        applicationId: "application-coverage-0111",
        personId: substitute.personId,
        firstName: substitute.firstName,
        lastName: substitute.lastName,
      },
    ],
  );

  const dispatchedCoverage = await commandCoverage(
    dispatch(substitute.personId),
    coverageBoard.etag,
  );

  const coveredOffer = dispatchedCoverage.offers.find(
    (offer) => offer.absenceId === coveredAbsence.absenceId,
  );

  assert.ok(coveredOffer);
  assert.equal(coveredOffer.status, "Offered");

  const failedDelivery = await eventually("failed substitute-offer delivery", async () => {
    const row = (
      await pool.query(
        `SELECT effect_id AS "effectId",status,attempts,last_failure_tag AS "lastFailureTag",
           payload_json AS payload
         FROM school_service_dispatch_notification_outbox WHERE offer_id=$1`,
        [coveredOffer.offerId],
      )
    ).rows[0];

    return row?.status === "Failed" && row.attempts >= 1 ? row : undefined;
  });

  assert.ok(failedDelivery.lastFailureTag);
  dispatchProviderFails = false;

  const deliveredDispatch = await eventually("retried substitute-offer delivery", async () => {
    const row = (
      await pool.query(
        `SELECT effect_id AS "effectId",status,attempts,last_failure_tag AS "lastFailureTag",
           payload_json AS payload
         FROM school_service_dispatch_notification_outbox WHERE offer_id=$1`,
        [coveredOffer.offerId],
      )
    ).rows[0];

    return row?.status === "Delivered" && row.attempts >= 2 ? row : undefined;
  });

  const deliveredDispatchRequests = dispatchNotificationRequests.filter(
    (request) => request.body.offerId === coveredOffer.offerId,
  );

  assert.ok(deliveredDispatchRequests.length >= 2);
  assert.equal(new Set(deliveredDispatchRequests.map((request) => request.body.effectId)).size, 1);
  assert.equal(new Set(deliveredDispatchRequests.map((request) => request.idempotencyKey)).size, 1);

  for (const request of deliveredDispatchRequests) {
    assert.equal(request.authorization, "Bearer synthetic-school-service-dispatch-token");
    assert.deepEqual(request.body, deliveredDispatchRequests[0]?.body);
  }

  assert.deepEqual(deliveredDispatch.payload, deliveredDispatchRequests[0]?.body);
  const deliveredCoverage = await readCoverageBoard();
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      {
        action: "CancelService",
        commitmentId: commitments.Monday,
        reason: "Skolen avlyste tjenesten",
        evidenceSource: "Skole Alfa kontakt, telefon",
      },
      deliveredCoverage.etag,
    ),
    409,
    "commitment.pending-offer",
  );
  assert.equal(
    (await readCoverageBoard()).commitments.find((item) => item.commitmentId === commitments.Monday)
      ?.decision,
    null,
  );
  assert.equal(
    deliveredCoverage.offers.find((offer) => offer.offerId === coveredOffer.offerId)?.status,
    "Offered",
    "delivery is not an acceptance",
  );
  assert.equal(
    deliveredCoverage.responses.filter((response) => response.offerId === coveredOffer.offerId)
      .length,
    0,
  );
  assert.equal(
    deliveredCoverage.acknowledgements.filter(
      (acknowledgement) => acknowledgement.offerId === coveredOffer.offerId,
    ).length,
    0,
  );
  await expectStatus(
    await request(coverageBoardPath, leader, dispatch(substitute.personId), deliveredCoverage.etag),
    409,
    "offer.unresolved",
  );
  const wrongCoverage = await readOwnCoverage(wrongSdk);

  const wrongResponseFactsBefore = (
    await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM school_service_substitute_offer_responses WHERE offer_id=$1) AS responses,
         (SELECT count(*)::integer FROM school_service_coverage_audit WHERE snapshot->>'offerId'=$1) AS audit`,
      [coveredOffer.offerId],
    )
  ).rows;

  await expectStatus(
    await request(
      ownCoveragePath,
      wrong,
      { action: "RespondToOffer", offerId: coveredOffer.offerId, response: "Accept" },
      wrongCoverage.etag,
    ),
    403,
    "offer.owner-invalid",
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM school_service_substitute_offer_responses WHERE offer_id=$1) AS responses,
           (SELECT count(*)::integer FROM school_service_coverage_audit WHERE snapshot->>'offerId'=$1) AS audit`,
        [coveredOffer.offerId],
      )
    ).rows,
    wrongResponseFactsBefore,
    "a wrong Person cannot produce an offer response or audit fact",
  );
  const candidateCoverage = await readOwnCoverage(candidateSdk);

  const acceptOffer = {
    action: "RespondToOffer",
    offerId: coveredOffer.offerId,
    response: "Accept",
  };

  const acceptanceRace = await Promise.all(
    [0, 1].map(() =>
      request(
        ownCoveragePath,
        candidate,
        acceptOffer,
        candidateCoverage.etag,
        randomBytes(18).toString("base64url"),
      ),
    ),
  );

  const acceptanceResults = await Promise.all(
    acceptanceRace.map(async (response) => ({
      status: response.status,
      body: await response.json(),
    })),
  );

  assert.equal(acceptanceResults.filter((result) => result.status === 200).length, 1);
  const losingAcceptance = acceptanceResults.find((result) => result.status !== 200);
  assert.ok(losingAcceptance);
  assert.ok([409, 412].includes(losingAcceptance.status));
  assert.ok(
    ["offer.response-invalid", "precondition.failed", "transaction.conflict"].includes(
      losingAcceptance.body.code,
    ),
  );
  const acceptedCoverage = await readCoverageBoard();
  assert.equal(
    acceptedCoverage.responses.filter(
      (response) => response.offerId === coveredOffer.offerId && response.response === "Accept",
    ).length,
    1,
  );
  assert.equal(
    acceptedCoverage.offers.find((offer) => offer.offerId === coveredOffer.offerId)?.status,
    "Accepted",
  );
  const acknowledgementSnapshot = await readCoverageBoard();
  const staleAcknowledgementSnapshot = await readCoverageBoard();
  assert.equal(acknowledgementSnapshot.etag, staleAcknowledgementSnapshot.etag);
  const acknowledgeOffer = { action: "AcknowledgeCoverage", offerId: coveredOffer.offerId };

  const acknowledgedCoverage = await commandCoverage(
    acknowledgeOffer,
    acknowledgementSnapshot.etag,
  );

  const acknowledgement = acknowledgedCoverage.acknowledgements.find(
    (item) => item.offerId === coveredOffer.offerId,
  );

  assert.ok(acknowledgement);
  assert.deepEqual(
    (await readOwnCoverage(candidateSdk)).commitments
      .filter((item) => item.proposalId === apiCoverageProposalId)
      .map((item) => item.commitmentId),
    [commitments.Monday],
  );

  const acknowledgementFacts = (
    await pool.query(
      `SELECT count(*)::integer AS acknowledgements,
         (SELECT count(*)::integer FROM school_service_coverage_audit
          WHERE action='AcknowledgeCoverage' AND snapshot->>'offerId'=$1) AS audit
       FROM school_service_coverage_acknowledgements WHERE offer_id=$1`,
      [coveredOffer.offerId],
    )
  ).rows;

  await expectStatus(
    await request(coverageBoardPath, leader, acknowledgeOffer, staleAcknowledgementSnapshot.etag),
    412,
    "precondition.failed",
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT count(*)::integer AS acknowledgements,
           (SELECT count(*)::integer FROM school_service_coverage_audit
            WHERE action='AcknowledgeCoverage' AND snapshot->>'offerId'=$1) AS audit
         FROM school_service_coverage_acknowledgements WHERE offer_id=$1`,
        [coveredOffer.offerId],
      )
    ).rows,
    acknowledgementFacts,
    "a stale acknowledgement does not write another acknowledgement or audit fact",
  );

  const completeCovered = {
    action: "CompleteService",
    commitmentId: commitments.Monday,
    attendedPersonIds: [substitute.personId],
    evidenceSource: "Skole Alfa kontakt, telefon 2024-03-04",
  };

  let closeCoverageBoard = await readCoverageBoard();
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      { ...completeCovered, attendedPersonIds: [volunteerId] },
      closeCoverageBoard.etag,
    ),
    422,
    "commitment.attendance-invalid",
  );
  const completeKey = randomBytes(18).toString("base64url");

  const coveredClosure = await commandCoverage(
    completeCovered,
    closeCoverageBoard.etag,
    completeKey,
  );

  assert.equal(
    coveredClosure.commitments.find((item) => item.commitmentId === commitments.Monday)?.decision
      ?.outcome,
    "Completed",
  );
  assert.deepEqual(
    coveredClosure.closures
      .filter((closure) => closure.absenceId === coveredAbsence.absenceId)
      .map((closure) => ({
        outcome: closure.outcome,
        substitutePersonId: closure.substitutePersonId,
        acknowledgementId: closure.acknowledgementId,
      })),
    [
      {
        outcome: "Covered",
        substitutePersonId: substitute.personId,
        acknowledgementId: acknowledgement.acknowledgementId,
      },
    ],
  );
  assert.deepEqual(
    await expectStatus(
      await request(
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
  closeCoverageBoard = await readCoverageBoard();
  await expectStatus(
    await request(coverageBoardPath, leader, completeCovered, closeCoverageBoard.etag),
    409,
  );
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      {
        action: "CancelService",
        commitmentId: commitments.Monday,
        reason: "Feilaktig konkurrerende avlysning",
        evidenceSource: "Skole Alfa kontakt, telefon",
      },
      closeCoverageBoard.etag,
    ),
    409,
  );
  await expectStatus(
    await request(
      ownCoveragePath,
      volunteer,
      coveredAbsenceCommand,
      (await readOwnCoverage(volunteerSdk)).etag,
    ),
    409,
  );
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      dispatch(substitute.personId),
      closeCoverageBoard.etag,
    ),
    409,
    "commitment.closed",
  );
  await expectStatus(
    await request(coverageBoardPath, leader, acknowledgeOffer, closeCoverageBoard.etag),
    409,
  );
  await expectStatus(
    await request(
      ownCoveragePath,
      candidate,
      acceptOffer,
      (await readOwnCoverage(candidateSdk)).etag,
    ),
    409,
  );
  assert.equal(
    (await readCoverageBoard()).etag,
    closeCoverageBoard.etag,
    "post-terminal commands write no second fact",
  );

  const coordinatorAbsence = {
    action: "ReportAbsenceForVolunteer",
    personId: leaderId,
    commitmentId: commitments.Tuesday,
  };

  const coordinatorAbsenceBoard = await commandCoverage(
    coordinatorAbsence,
    closeCoverageBoard.etag,
  );

  const uncoveredAbsence = coordinatorAbsenceBoard.absences.find(
    (absence) =>
      absence.proposalId === apiCoverageProposalId &&
      absence.personId === leaderId &&
      absence.serviceDate === "2024-03-05",
  );

  assert.ok(uncoveredAbsence);

  const declinedDispatchBoard = await commandCoverage(
    {
      action: "DispatchSubstituteOffer",
      absenceId: uncoveredAbsence.absenceId,
      candidatePersonId: substitute.personId,
    },
    coordinatorAbsenceBoard.etag,
  );

  const declinedOffer = declinedDispatchBoard.offers.find(
    (offer) => offer.absenceId === uncoveredAbsence.absenceId,
  );

  assert.ok(declinedOffer);
  await eventually("sequential declined-offer delivery", async () => {
    const row = (
      await pool.query(
        `SELECT status FROM school_service_dispatch_notification_outbox WHERE offer_id=$1`,
        [declinedOffer.offerId],
      )
    ).rows[0];

    return row?.status === "Delivered" ? row : undefined;
  });
  const candidateDeclineCoverage = await readOwnCoverage(candidateSdk);

  const declinedCoverage = await commandOwnCoverage(
    candidateSdk,
    { action: "RespondToOffer", offerId: declinedOffer.offerId, response: "Decline" },
    candidateDeclineCoverage.etag,
  );

  assert.equal(
    declinedCoverage.responses.find((response) => response.offerId === declinedOffer.offerId)
      ?.response,
    "Decline",
  );

  const redispatchBoard = await commandCoverage(
    {
      action: "DispatchSubstituteOffer",
      absenceId: uncoveredAbsence.absenceId,
      candidatePersonId: substitute.personId,
    },
    (await readCoverageBoard()).etag,
  );

  const withdrawnOffer = redispatchBoard.offers.find(
    (offer) =>
      offer.absenceId === uncoveredAbsence.absenceId && offer.offerId !== declinedOffer.offerId,
  );

  assert.ok(withdrawnOffer);
  await eventually("sequential withdrawn-offer delivery", async () => {
    const row = (
      await pool.query(
        `SELECT status FROM school_service_dispatch_notification_outbox WHERE offer_id=$1`,
        [withdrawnOffer.offerId],
      )
    ).rows[0];

    return row?.status === "Delivered" ? row : undefined;
  });

  const withdrawnBoard = await commandCoverage(
    { action: "WithdrawSubstituteOffer", offerId: withdrawnOffer.offerId },
    (await readCoverageBoard()).etag,
  );

  assert.equal(
    withdrawnBoard.offers.find((offer) => offer.offerId === withdrawnOffer.offerId)?.status,
    "Withdrawn",
  );

  const zeroUnfulfilled = {
    action: "MarkUnfulfilledService",
    commitmentId: commitments.Tuesday,
    attendedPersonIds: [],
    reason: "Ingen frivillige møtte",
    evidenceSource: "Skole Alfa kontakt, telefon 2024-03-05",
  };

  closeCoverageBoard = await readCoverageBoard();
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      { ...zeroUnfulfilled, attendedPersonIds: [substitute.personId] },
      closeCoverageBoard.etag,
    ),
    422,
    "commitment.attendance-invalid",
  );
  assert.equal(
    (await readCoverageBoard()).etag,
    closeCoverageBoard.etag,
    "invalid attendance leaves the board unchanged",
  );
  const uncoveredClosure = await commandCoverage(zeroUnfulfilled, closeCoverageBoard.etag);
  assert.equal(
    uncoveredClosure.commitments.find((item) => item.commitmentId === commitments.Tuesday)?.decision
      ?.outcome,
    "Unfulfilled",
  );
  assert.equal(
    uncoveredClosure.commitments.find((item) => item.commitmentId === commitments.Tuesday)?.decision
      ?.occurrenceId,
    null,
  );
  assert.deepEqual(
    uncoveredClosure.closures
      .filter((closure) => closure.absenceId === uncoveredAbsence.absenceId)
      .map((closure) => [closure.outcome, closure.occurrenceId]),
    [["Uncovered", null]],
  );
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      {
        action: "DispatchSubstituteOffer",
        absenceId: uncoveredAbsence.absenceId,
        candidatePersonId: substitute.personId,
      },
      uncoveredClosure.etag,
    ),
    409,
  );

  const partialUnfulfilled = {
    action: "MarkUnfulfilledService",
    commitmentId: commitments.Wednesday,
    attendedPersonIds: [leaderId],
    reason: "Én av to frivillige møtte",
    evidenceSource: "Skole Alfa kontakt, telefon 2024-03-06",
  };

  const partialBoard = await readCoverageBoard();
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      { ...partialUnfulfilled, attendedPersonIds: [leaderId, volunteerId] },
      partialBoard.etag,
    ),
    422,
  );

  const competingPartial = await Promise.all(
    [0, 1].map(() => request(coverageBoardPath, leader, partialUnfulfilled, partialBoard.etag)),
  );

  assert.equal(competingPartial.filter((response) => response.status === 200).length, 1);

  for (const response of competingPartial.filter((result) => result.status !== 200)) {
    assert.ok([409, 412].includes(response.status));
    await response.json();
  }

  const partialDecision = (await readCoverageBoard()).commitments.find(
    (item) => item.commitmentId === commitments.Wednesday,
  )?.decision;

  assert.equal(partialDecision?.outcome, "Unfulfilled");
  assert.deepEqual(partialDecision?.attendedPersonIds, [leaderId]);
  assert.ok(partialDecision?.occurrenceId);

  const cancelAbsence = await commandCoverage({
    action: "ReportAbsenceForVolunteer",
    personId: leaderId,
    commitmentId: commitments.Thursday,
  });

  const cancelledAbsenceId = cancelAbsence.absences.find(
    (item) => item.commitmentId === commitments.Thursday,
  )?.absenceId;

  assert.ok(cancelledAbsenceId);

  const cancel = {
    action: "CancelService",
    commitmentId: commitments.Thursday,
    reason: "Skolen avlyste undervisningen",
    evidenceSource: "Skole Alfa kontakt, telefon 2024-03-07",
  };

  const beforeCancel = await readCoverageBoard();
  const cancelled = await commandCoverage(cancel, beforeCancel.etag);
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
  await expectStatus(
    await request(
      coverageBoardPath,
      leader,
      { ...partialUnfulfilled, commitmentId: commitments.Thursday },
      cancelled.etag,
    ),
    409,
  );
  const finalApiCoverage = await readCoverageBoard();
  assert.deepEqual(
    finalApiCoverage.commitments
      .filter((item) => item.proposalId === apiCoverageProposalId)
      .map((item) => item.decision?.outcome)
      .sort(),
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
  }> = (
    await pool.query(
      `SELECT commitment.commitment_id AS "commitmentId",commitment.service_date::text AS "serviceDate",
       commitment.required_volunteers AS "requiredVolunteers",commitment.start_time::text AS "startTime",
       commitment.end_time::text AS "endTime",decision.outcome,decision.evidence_source AS "evidenceSource",
       decision.reason,decision.attended_person_ids AS "attendedPersonIds",
       decision.occurrence_id AS "occurrenceId",decision.decided_by_person_id AS "decidedBy"
     FROM school_service_commitments AS commitment
     JOIN school_service_decisions AS decision USING(commitment_id)
     WHERE commitment.proposal_id=$1 ORDER BY commitment.service_date`,
      [apiCoverageProposalId],
    )
  ).rows;

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
        [leaderId],
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
    (
      await pool.query(
        `SELECT commitment_id AS "commitmentId",attended_person_ids AS "attendedPersonIds"
    FROM school_service_occurrences WHERE commitment_id=ANY($1) ORDER BY occurred_on`,
        [Object.values(commitments)],
      )
    ).rows,
    [
      { commitmentId: commitments.Monday, attendedPersonIds: [substitute.personId] },
      { commitmentId: commitments.Wednesday, attendedPersonIds: [leaderId] },
    ],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS count FROM school_service_closures WHERE absence_id=$1",
        [cancelledAbsenceId],
      )
    ).rows[0].count,
    0,
  );

  const apiCoverageAudit = (
    await pool.query(
      `SELECT action,actor_person_id AS "actorPersonId"
       FROM school_service_coverage_audit ORDER BY audit_id`,
    )
  ).rows;

  assert.deepEqual(apiCoverageAudit, [
    { action: "ReportAbsence", actorPersonId: volunteerId },
    { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
    { action: "RespondToOffer", actorPersonId: substitute.personId },
    { action: "AcknowledgeCoverage", actorPersonId: leaderId },
    { action: "CompleteService", actorPersonId: leaderId },
    { action: "ReportAbsence", actorPersonId: leaderId },
    { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
    { action: "RespondToOffer", actorPersonId: substitute.personId },
    { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
    { action: "WithdrawSubstituteOffer", actorPersonId: leaderId },
    { action: "MarkUnfulfilledService", actorPersonId: leaderId },
    { action: "MarkUnfulfilledService", actorPersonId: leaderId },
    { action: "ReportAbsence", actorPersonId: leaderId },
    { action: "CancelService", actorPersonId: leaderId },
  ]);
  const apiCoverageAuditCount = apiCoverageAudit.length;
  assert.deepEqual(
    (
      await pool.query(
        `SELECT response,responder_person_id AS "responderPersonId"
         FROM school_service_substitute_offer_responses ORDER BY responded_at,offer_id`,
      )
    ).rows,
    [
      { response: "Accept", responderPersonId: substitute.personId },
      { response: "Decline", responderPersonId: substitute.personId },
    ],
  );

  const apiCoverageEvidence = {
    proposalId: apiCoverageProposalId,
    coveredAbsenceId: coveredAbsence.absenceId,
    uncoveredAbsenceId: uncoveredAbsence.absenceId,
    coveredOfferId: coveredOffer.offerId,
    acknowledgementId: acknowledgement.acknowledgementId,
    deliveredEffectId: deliveredDispatch.effectId,
    deliveredAttempts: deliveredDispatch.attempts,
    auditActions: apiCoverageAudit.map((entry: { action: string }) => entry.action),
  };

  const browserLeaderBoard = await command({
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

  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  let browserEvidence: Schema.JsonObject | null = null;

  if (mode === "--browser") {
    await runAsync(
      "bun",
      ["apps/dashboard/e2e/run-real-native-placement.mjs"],
      { ...environment, PLACEMENT_JOURNEY_MANIFEST: manifestPath },
      300_000,
    );
    browserEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      await readFile(join(artifacts, "browser-evidence.json"), "utf8"),
    );
    assert.equal(browserEvidence?.passed, true);
    assert.equal(browserEvidence?.revision, revision);

    const browserCoverageExpected = Schema.decodeUnknownSync(
      Schema.Struct({
        absencePosts: Schema.Number,
        proposalId: Schema.String,
        completedCommitmentId: Schema.String,
        unfulfilledCommitmentId: Schema.String,
        cancelledCommitmentId: Schema.String,
        coveredAbsenceId: Schema.String,
        uncoveredAbsenceId: Schema.String,
        coveredOfferId: Schema.String,
        declinedOfferId: Schema.String,
        withdrawnOfferId: Schema.String,
        coveredAcknowledgementId: Schema.String,
        occurrenceId: Schema.String,
        uncoveredOccurrenceId: Schema.String,
      }),
    )(browserEvidence?.coverageExpected);

    assert.ok(browserCoverageExpected);
    assert.equal(browserCoverageExpected.absencePosts, 1);

    const browserDispatches = await eventually("browser substitute-offer delivery", async () => {
      const rows = (
        await pool.query(
          `SELECT notification.effect_id AS "effectId",notification.offer_id AS "offerId",
             notification.person_id AS "personId",notification.status,notification.attempts
           FROM school_service_dispatch_notification_outbox AS notification
           JOIN school_service_substitute_offers AS offer
             ON offer.offer_id=notification.offer_id
             AND offer.absence_id=notification.absence_id
           JOIN school_service_absences AS absence ON absence.absence_id=offer.absence_id
           WHERE absence.proposal_id=$1 ORDER BY absence.service_date,notification.effect_id`,
          [browserCoverageExpected.proposalId],
        )
      ).rows;

      return rows.length === 3 &&
        rows.every((row: { status: string }) => row.status === "Delivered")
        ? rows
        : undefined;
    });

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

    const serviceProposal = (
      await pool.query(
        `SELECT proposal_id AS "proposalId",status,revision,
           jsonb_array_length(exception_snapshot) AS "exceptionCount",
           jsonb_array_length(assignment_snapshot) AS "assignmentCount"
         FROM school_service_proposals
         WHERE department_id=$1 AND semester_id=$2
         ORDER BY created_at DESC LIMIT 1`,
        [departmentId, semesterId],
      )
    ).rows[0];

    assert.deepEqual(serviceProposal, {
      proposalId: browserEvidence?.serviceProposalId,
      status: "Confirmed",
      revision: 2,
      exceptionCount: 1,
      assignmentCount: 2,
    });
    assert.equal(browserCoverageExpected.proposalId, serviceProposal.proposalId);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT required_volunteers AS "requiredVolunteers"
           FROM school_service_demand
           WHERE department_id=$1 AND semester_id=$2 AND school_id=$3
             AND day='Monday' AND block='2'`,
          [departmentId, semesterId, 962],
        )
      ).rows,
      [{ requiredVolunteers: 2 }],
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT person_id AS "personId",status,attempts
           FROM school_service_notification_outbox
           WHERE proposal_id=$1 ORDER BY person_id`,
          [serviceProposal.proposalId],
        )
      ).rows,
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
    }> = (
      await pool.query(
        `SELECT commitment.commitment_id AS "commitmentId",commitment.required_volunteers AS "requiredVolunteers",
         commitment.service_date::text AS "serviceDate",decision.outcome,
         decision.attended_person_ids AS "attendedPersonIds",decision.reason,
         decision.evidence_source AS "evidenceSource",decision.occurrence_id AS "occurrenceId"
       FROM school_service_commitments AS commitment JOIN school_service_decisions AS decision USING(commitment_id)
       WHERE commitment.proposal_id=$1 ORDER BY commitment.service_date`,
        [browserCoverageExpected.proposalId],
      )
    ).rows;

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
          [leaderId, substitute.personId],
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

    const browserAbsences = (
      await pool.query(
        `SELECT absence_id AS "absenceId",person_id AS "personId",
           reporter_person_id AS "reporterPersonId",service_date::text AS "serviceDate"
         FROM school_service_absences
         WHERE proposal_id=$1 ORDER BY service_date,absence_id`,
        [browserCoverageExpected.proposalId],
      )
    ).rows;

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

    const browserOffers = (
      await pool.query(
        `SELECT offer.offer_id AS "offerId",offer.absence_id AS "absenceId",
           offer.candidate_person_id AS "candidatePersonId",offer.status
         FROM school_service_substitute_offers AS offer
         JOIN school_service_absences AS absence USING(absence_id)
         WHERE absence.proposal_id=$1
         ORDER BY absence.service_date,offer.dispatched_at,offer.offer_id`,
        [browserCoverageExpected.proposalId],
      )
    ).rows;

    assert.equal(browserOffers.length, 3);
    assert.deepEqual(
      browserOffers.map(
        (offer: {
          readonly offerId: string;
          readonly absenceId: string;
          readonly candidatePersonId: string;
          readonly status: string;
        }) => ({
          offerId: offer.offerId,
          absenceId: offer.absenceId,
          candidatePersonId: offer.candidatePersonId,
          status: offer.status,
        }),
      ),
      [
        {
          offerId: browserCoverageExpected.coveredOfferId,
          absenceId: browserCoverageExpected.coveredAbsenceId,
          candidatePersonId: substitute.personId,
          status: "Acknowledged",
        },
        {
          offerId: browserCoverageExpected.declinedOfferId,
          absenceId: browserCoverageExpected.uncoveredAbsenceId,
          candidatePersonId: substitute.personId,
          status: "Declined",
        },
        {
          offerId: browserCoverageExpected.withdrawnOfferId,
          absenceId: browserCoverageExpected.uncoveredAbsenceId,
          candidatePersonId: substitute.personId,
          status: "Withdrawn",
        },
      ],
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT response.offer_id AS "offerId",response.response,
             response.responder_person_id AS "responderPersonId"
           FROM school_service_substitute_offer_responses AS response
           JOIN school_service_substitute_offers AS offer
             ON offer.offer_id=response.offer_id
           JOIN school_service_absences AS absence ON absence.absence_id=offer.absence_id
           WHERE absence.proposal_id=$1
           ORDER BY absence.service_date,response.responded_at,response.offer_id`,
          [browserCoverageExpected.proposalId],
        )
      ).rows,
      [
        {
          offerId: browserCoverageExpected.coveredOfferId,
          response: "Accept",
          responderPersonId: substitute.personId,
        },
        {
          offerId: browserCoverageExpected.declinedOfferId,
          response: "Decline",
          responderPersonId: substitute.personId,
        },
      ],
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT acknowledgement_id AS "acknowledgementId",offer_id AS "offerId",
             absence_id AS "absenceId",candidate_person_id AS "candidatePersonId",
             acknowledged_by_person_id AS "acknowledgedByPersonId"
           FROM school_service_coverage_acknowledgements
           WHERE absence_id=$1`,
          [browserCoverageExpected.coveredAbsenceId],
        )
      ).rows,
      [
        {
          acknowledgementId: browserCoverageExpected.coveredAcknowledgementId,
          offerId: browserCoverageExpected.coveredOfferId,
          absenceId: browserCoverageExpected.coveredAbsenceId,
          candidatePersonId: substitute.personId,
          acknowledgedByPersonId: leaderId,
        },
      ],
    );

    const browserOccurrences = (
      await pool.query(
        `SELECT occurrence_id AS "occurrenceId",occurred_on::text AS "occurredOn",
           attended_person_ids AS "attendedPersonIds",recorded_by_person_id AS "recordedByPersonId"
         FROM school_service_occurrences
         WHERE proposal_id=$1 ORDER BY occurred_on,occurrence_id`,
        [browserCoverageExpected.proposalId],
      )
    ).rows;

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
      (
        await pool.query(
          `SELECT closure.absence_id AS "absenceId",closure.outcome,
             closure.acknowledgement_id AS "acknowledgementId",
             closure.substitute_person_id AS "substitutePersonId",
             closure.scheduled_person_id AS "scheduledPersonId",
             closure.closed_by_person_id AS "closedByPersonId"
           FROM school_service_closures AS closure
           JOIN school_service_absences AS absence USING(absence_id)
           WHERE absence.proposal_id=$1 ORDER BY absence.service_date,closure.closure_id`,
          [browserCoverageExpected.proposalId],
        )
      ).rows,
      [
        {
          absenceId: browserCoverageExpected.coveredAbsenceId,
          outcome: "Covered",
          acknowledgementId: browserCoverageExpected.coveredAcknowledgementId,
          substitutePersonId: substitute.personId,
          scheduledPersonId: volunteerId,
          closedByPersonId: leaderId,
        },
        {
          absenceId: browserCoverageExpected.uncoveredAbsenceId,
          outcome: "Uncovered",
          acknowledgementId: null,
          substitutePersonId: null,
          scheduledPersonId: leaderId,
          closedByPersonId: leaderId,
        },
      ],
    );
    assert.ok(
      browserDispatches.every(
        (dispatch: { readonly personId: string; readonly attempts: number }) =>
          dispatch.personId === substitute.personId && dispatch.attempts === 1,
      ),
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT action,actor_person_id AS "actorPersonId"
           FROM school_service_coverage_audit
           ORDER BY audit_id OFFSET $1`,
          [apiCoverageAuditCount],
        )
      ).rows,
      [
        { action: "ReportAbsence", actorPersonId: volunteerId },
        { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
        { action: "RespondToOffer", actorPersonId: substitute.personId },
        { action: "AcknowledgeCoverage", actorPersonId: leaderId },
        { action: "CompleteService", actorPersonId: leaderId },
        { action: "ReportAbsence", actorPersonId: leaderId },
        { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
        { action: "RespondToOffer", actorPersonId: substitute.personId },
        { action: "DispatchSubstituteOffer", actorPersonId: leaderId },
        { action: "WithdrawSubstituteOffer", actorPersonId: leaderId },
        { action: "MarkUnfulfilledService", actorPersonId: leaderId },
        { action: "CancelService", actorPersonId: leaderId },
      ],
    );
    assert.equal(notificationRequests.length, 2);

    for (const delivered of notificationRequests) {
      assert.equal(delivered.authorization, "Bearer synthetic-school-service-token");
      assert.equal(delivered.idempotencyKey, delivered.body.effectId);
    }
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
  const bunVersion = process.versions.bun;

  const postgresVersion = Schema.decodeUnknownSync(Schema.String)(
    (await pool.query("SELECT version() AS version")).rows[0].version,
  );

  const runtime: PreviewRuntimeObservation = bunVersion === undefined
    ? { postgres: postgresVersion }
    : { bun: bunVersion, postgres: postgresVersion };

  evidence = {
    revision,
    apiPassed: true,
    browserEvidence,
    apiCoverage: apiCoverageEvidence,
    notificationRequests,
    dispatchNotificationRequests,
    runtime,
    implementation: {
      generatedCoverageOperations: [
        "placements.readOwnCoverage",
        "placements.commandOwnCoverage",
        "placements.readCoverageBoard",
        "placements.commandCoverageBoard",
      ],
      coverageGates: [
        "anonymous, wrong-scope, owner, roster/date, candidate, ETag, and idempotency boundaries",
        "sequential offers, wrong-person response, acceptance race, stale acknowledgement, exact decision replay and competing decision denial",
        "immutable commitments, attendance evidence, zero and partial unmet demand, cancellation without occurrence, old occurrence, closure and audit history",
      ],
    },
    localRuntime: {
      mode,
      postgres: "disposable loopback PostgreSQL",
      backend: backendOrigin,
      dashboard: mode === "--browser" ? dashboardOrigin : null,
      notificationProvider: "owned loopback HTTP provider with forced failure then recovery",
    },
    productionBoundary:
      "No production data, provider, credentials, deployment, or cutover is contacted or changed.",
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
      "dated commitment scope, old/duplicate occurrence, candidate eligibility, offer, response, acknowledgement, terminal evidence and closure gates",
      "retry keeps one substitute dispatch effect identity and payload while delivery stays distinct from acceptance",
      "canonical Person and account credentials unchanged",
    ],
  };
} catch (error) {
  process.stderr.write(outputs.join("").slice(-12000));
  throw error;
} finally {
  if (pool) await pool.end();
  const ownedNotificationServer = notificationServer;

  if (ownedNotificationServer)
    await new Promise<void>((resolve, reject) =>
      ownedNotificationServer.close((error) => (error ? reject(error) : resolve())),
    );

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
