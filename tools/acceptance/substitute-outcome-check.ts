/**
 * Admission outcomes and the substitutes on call: real local API and browser acceptance.
 * Owns a disposable PostgreSQL cluster, the native identity seed, the backend, and credentials.
 * With --browser, a child runs the production dashboard and Playwright against the same backend.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Predicate, Schema, Struct } from "effect";
import {
  AdmissionOutcomeBoardResource,
  type AdmissionOutcomeCommand,
  AdmissionOutcomeScope,
} from "../../packages/rpc/src/admission-outcomes.js";
import { nativeRpcPath } from "../../packages/rpc/src/api.js";
import { IdempotencyKey, type StrongETag } from "../../packages/rpc/src/problem.js";
import { nativeScriptClient, type ScriptCallResult } from "../../packages/rpc/src/script-client.js";
import { SubmitApplicationRequest } from "../../packages/rpc/src/v2-schemas.js";
import { localBackendEnvironment } from "../e2e/local-backend-environment.ts";
import {
  type DisposablePostgres,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "../postgres/index.ts";
import { stopOwnedProcess } from "./owned-process.js";

const root = new URL("../../", import.meta.url).pathname;

/** One RPC request on the JSON wire, for a payload that the typed client would refuse to encode. */
const WireRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

/** The one answer of a request that the server rejected with a defect before any handler ran. */
const RejectedBeforeHandler = Schema.Tuple([
  Schema.TaggedStruct("Exit", {
    exit: Schema.TaggedStruct("Failure", {
      cause: Schema.Tuple([Schema.TaggedStruct("Die", { defect: Schema.Unknown })]),
    }),
  }),
]);

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Client } = requireDatabase("pg");

const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });

const revision = run("git", ["rev-parse", "HEAD"]).trim();

assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed clean artifact");

const artifacts = await mkdtemp(join(tmpdir(), "vektor-substitutes-"));

const children: ChildProcess[] = [];

const outputs: string[] = [];

const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => outputs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => outputs.push(String(chunk)));

  return child;
};

let postgres: DisposablePostgres | undefined;

let database: InstanceType<typeof Client>;

let evidence: Schema.JsonObject | undefined;

let summary: { apiGates: number; browserGates: number; receiptCount: number } | undefined;

try {
  const [pgPort, backendPort, dashboardPort] = await reserveLoopbackPorts(3);
  postgres = await startDisposablePostgres({ port: pgPort });
  const postgresUrl = postgres.url;
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  database = client;

  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

  const environment = {
    ...process.env,
    ...localBackendEnvironment({
      backendOrigin,
      dashboardOrigin,
      postgresUrl,
      betterAuthSecret: randomBytes(32).toString("hex"),
    }),
    JOURNEY_SEED_PG_URL: postgresUrl,
  };

  for (const key of Object.keys(environment))
    if (
      key.startsWith("CONTACT_") ||
      (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
    )
      Reflect.deleteProperty(environment, key);
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);

  // The seed's department and open period hold the API cases; a historical period of the
  // same department holds the browser cases, so neither run can change the other's facts.
  const departmentId = "department-native-journey-0049",
    openSemesterId = "semester-native-journey-0049",
    openPeriodId = "admission-period-native-journey-0049",
    historicalSemesterId = "semester-historical-substitutes",
    historicalPeriodId = "period-historical-substitutes",
    noPeriodSemesterId = "semester-no-period-substitutes",
    otherDepartmentId = "department-other-substitutes",
    browserApplicationId = "application-browser-substitutes",
    undecidedBrowserApplicationId = "application-browser-undecided-substitutes",
    leaderPersonId = "journey-rec-leader-0049";

  await database.query(`INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at) VALUES ('${historicalSemesterId}','2024-01-01','2024-07-01'),('${noPeriodSemesterId}','2023-01-01','2023-07-01');
 INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES ('${historicalPeriodId}','${departmentId}','${historicalSemesterId}','2024-01-01','2024-06-01',0,'fixture-substitutes');
 INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
 SELECT '${browserApplicationId}',applicant_id,'${historicalPeriodId}',department_id,field_of_study_id,year_of_study,'2024-01-02',0 FROM public.admission_applications WHERE application_id='application-native-journey-0049';
 INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision) VALUES ('${otherDepartmentId}','Annen avdeling','Annen','annen@example.invalid','Annen',true,0);
 INSERT INTO public.organization_teams(team_id,department_id,name,active,revision) VALUES ('team-other-substitutes','${otherDepartmentId}','Annet team',true,0);
 UPDATE public.organization_memberships SET team_id='team-other-substitutes',is_team_leader=true WHERE person_id='journey-rec-interviewer-b-0049';`);
  start("bun", ["run", "--cwd", "apps/backend", "start"], environment);

  for (let n = 0; ; n++) {
    try {
      if ((await fetch(`${backendOrigin}/health`)).ok) break;
    } catch {}

    if (n > 150) throw Error("backend startup failed");
    await sleep(200);
  }

  const persons = {
    leader: { email: "lina.leader@example.invalid", password: "journey-secret-0123456789abcdef" },
    member: {
      email: "irene.intervjuer@example.invalid",
      password: "journey-secret-0123456789abcdef",
    },
    otherDepartment: {
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

    assert.equal(response.status, 200, `login: ${await response.text()}`);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);

    return cookie.split(";")[0]!;
  };

  const leader = await login(persons.leader),
    member = await login(persons.member),
    other = await login(persons.otherDepartment);

  const native = nativeScriptClient(backendOrigin);

  /** Headers of one call: the dashboard origin, and the person's session when there is one. */
  const as = (cookie?: string): Readonly<Record<string, string>> =>
    cookie === undefined ? { origin: dashboardOrigin } : { cookie, origin: dashboardOrigin };

  const newKey = () => IdempotencyKey.make(randomBytes(18).toString("base64url"));

  const expectValue = <A>(answer: ScriptCallResult<A>, gate: string): A => {
    if (!answer.ok) assert.fail(`${gate}: ${answer.code}`);

    return answer.value;
  };

  const expectProblem = <A>(answer: ScriptCallResult<A>, status: number, code: string, gate: string) => {
    assert.equal(answer.ok, false, gate);

    if (answer.ok) return;
    assert.equal(answer.status, status, `${gate}: ${answer.code}`);
    assert.equal(answer.code, code, gate);
  };

  const outcomeHistory = async (applicationId: string) =>
    (
      await database.query(
        `SELECT revision, outcome, decided_by_person_id AS "decidedBy" FROM public.admission_application_outcomes WHERE application_id=$1 ORDER BY revision`,
        [applicationId],
      )
    ).rows;

  const openScopeOutcomes = async () =>
    (
      await database.query(
        "SELECT outcome.* FROM public.admission_application_outcomes outcome INNER JOIN public.admission_applications application ON application.application_id=outcome.application_id WHERE application.admission_period_id=$1 ORDER BY outcome.application_id, outcome.revision",
        [openPeriodId],
      )
    ).rows;

  const gates: string[] = [];

  const listScopes = (cookie?: string) =>
    native.call(as(cookie), (client) => client["admissionOutcomes.listScopes"]());

  const scopeDepartments = async (cookie: string) =>
    expectValue(await listScopes(cookie), "scopes").departments.map((item) => item.departmentId);

  const scopeOf = (semesterId: string) =>
    Schema.decodeSync(AdmissionOutcomeScope)({ departmentId, semesterId });

  const readBoard = (semesterId: string, cookie?: string) =>
    native.call(as(cookie), (client) =>
      client["admissionOutcomes.readOutcomes"](scopeOf(semesterId)),
    );

  const board = async (semesterId: string, cookie = leader) =>
    expectValue(await readBoard(semesterId, cookie), `board ${semesterId}`);

  const leaderScopes = expectValue(await listScopes(leader), "leader scopes");
  assert.deepEqual(await scopeDepartments(leader), [departmentId]);
  assert.ok(
    [historicalSemesterId, openSemesterId, noPeriodSemesterId].every((semesterId) =>
      leaderScopes.semesters.some((item) => item.semesterId === semesterId),
    ),
  );
  assert.deepEqual(await scopeDepartments(member), [departmentId]);
  assert.deepEqual(await scopeDepartments(other), [otherDepartmentId]);
  await database.query(
    `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES ('membership-other-substitutes','${leaderPersonId}','team-other-substitutes',NULL,'2026-01-01',NULL,NULL,false,false,0)`,
  );
  assert.deepEqual(
    await scopeDepartments(leader),
    [otherDepartmentId, departmentId],
    "every department membership is evaluated",
  );
  gates.push("scopes list only the departments each person may read, from every membership");

  const submission = Schema.decodeSync(SubmitApplicationRequest)({
    departmentId,
    firstName: "Anne",
    lastName: "API",
    phone: "90011223",
    email: "anne.api@example.invalid",
    gender: 1,
    fieldOfStudyId: "field-native-journey-0049",
    yearOfStudy: 3,
    availability: {
      mondayUnavailable: false,
      tuesdayUnavailable: true,
      wednesdayUnavailable: false,
      thursdayUnavailable: false,
      fridayUnavailable: false,
      positionWeeks: 4,
      preferredGroup: "all",
      language: "Norsk",
    },
  });

  const { applicationId } = expectValue(
    await native.call(as(), (client) =>
      client["admissions.submitApplication"]({ idempotencyKey: newKey(), request: submission }),
    ),
    "submission",
  );

  await database.query(
    `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
     SELECT '${undecidedBrowserApplicationId}',applicant_id,'${historicalPeriodId}',department_id,field_of_study_id,year_of_study,'2024-01-03',0 FROM public.admission_applications WHERE application_id=$1`,
    [applicationId],
  );

  const openBoard = await board(openSemesterId);

  if (!Predicate.isTagged(openBoard, "Decide"))
    assert.fail("admission management decides the open board");
  assert.equal(openBoard.admissionPeriodId, openPeriodId);

  const periodApplications = (
    await database.query(
      "SELECT application_id FROM public.admission_applications WHERE admission_period_id=$1 ORDER BY application_id",
      [openPeriodId],
    )
  ).rows.map((row: { application_id: string }) => row.application_id);

  assert.deepEqual(
    periodApplications,
    [applicationId, "application-native-journey-0049"].toSorted(),
  );
  assert.deepEqual(
    openBoard.entries.map((entry) => entry.applicationId).toSorted(),
    periodApplications,
    "admission management sees every application of the period",
  );

  const initial = openBoard.entries.find((entry) => entry.applicationId === applicationId);

  assert.ok(initial);
  assert.deepEqual(
    {
      firstName: initial.firstName,
      lastName: initial.lastName,
      email: initial.email,
      phone: initial.phone,
      yearOfStudy: initial.yearOfStudy,
      outcome: initial.outcome,
      revision: initial.revision,
    },
    {
      firstName: "Anne",
      lastName: "API",
      email: submission.email,
      phone: submission.phone,
      yearOfStudy: 3,
      outcome: null,
      revision: 0,
    },
  );

  const readItem = (cookie?: string) =>
    native.call(as(cookie), (client) => client["admissionOutcomes.readOutcome"]({ applicationId }));

  const record = (
    cookie: string | undefined,
    request: AdmissionOutcomeCommand,
    ifMatch: StrongETag,
    idempotencyKey = newKey(),
  ) =>
    native.call(as(cookie), (client) =>
      client["admissionOutcomes.recordOutcome"]({ applicationId, idempotencyKey, ifMatch, request }),
    );

  const item = expectValue(await readItem(leader), "leader single read");
  assert.equal(item.etag, initial.etag);
  gates.push("admission management reads every application of the period with its version");

  // The payload schema requires ifMatch and one declared outcome, so the RPC server rejects an
  // invalid command while decoding it, before the handler: it answers a defect, not a problem.
  const invalidCommands: ReadonlyArray<Schema.Json> = [{}, { outcome: "Maybe" }, { outcome: null }];

  for (const invalid of invalidCommands) {
    const response = await fetch(`${backendOrigin}${nativeRpcPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: leader, origin: dashboardOrigin },
      body: JSON.stringify(
        WireRequest.make({
          id: "1",
          tag: "admissionOutcomes.recordOutcome",
          payload: { applicationId, idempotencyKey: newKey(), ifMatch: item.etag, request: invalid },
          headers: [],
        }),
      ),
    });

    assert.equal(response.status, 200, `invalid ${JSON.stringify(invalid)}`);
    Schema.decodeUnknownSync(RejectedBeforeHandler)(await response.json());
  }

  assert.deepEqual(await outcomeHistory(applicationId), [], "rejected commands record nothing");
  gates.push("invalid outcomes are rejected before the handler and record nothing");

  const key = newKey();
  const substitute = expectValue(await record(leader, { outcome: "Substitute" }, item.etag, key), "record");
  assert.notEqual(substitute.etag, item.etag);
  assert.equal(substitute.outcome, "Substitute");
  assert.equal(substitute.revision, 1);
  const substituteHistory = [{ revision: 1, outcome: "Substitute", decidedBy: leaderPersonId }];
  assert.deepEqual(await outcomeHistory(applicationId), substituteHistory);

  assert.deepEqual(
    expectValue(await record(leader, { outcome: "Substitute" }, item.etag, key), "replay"),
    substitute,
    "an exact replay answers the stored result",
  );
  assert.deepEqual(await outcomeHistory(applicationId), substituteHistory, "a replay adds no revision");
  expectProblem(
    await record(leader, { outcome: "Rejected" }, item.etag, key),
    409,
    "idempotency.digest-conflict",
    "another command under a used key",
  );
  assert.deepEqual(
    expectValue(await record(leader, { outcome: "Substitute" }, substitute.etag), "again"),
    substitute,
    "recording the current outcome again changes nothing",
  );
  assert.deepEqual(await outcomeHistory(applicationId), substituteHistory);
  gates.push(
    "Substitute is recorded once with ifMatch and an idempotency key; replay and a repeated outcome add no revision",
  );

  expectProblem(
    await record(leader, { outcome: "Rejected" }, item.etag),
    412,
    "precondition.failed",
    "stale version",
  );

  const staleKey = newKey();

  for (const attempt of ["initial stale record", "unchanged rejected retry"])
    expectProblem(
      await record(leader, { outcome: "Rejected" }, item.etag, staleKey),
      412,
      "precondition.failed",
      attempt,
    );

  assert.deepEqual(await outcomeHistory(applicationId), substituteHistory);
  gates.push("a stale version is refused (412), also on an unchanged retry, and records nothing");

  assert.deepEqual(
    await board(openSemesterId, member),
    AdmissionOutcomeBoardResource.cases.ReadOnly.make({
      ...scopeOf(openSemesterId),
      admissionPeriodId: openBoard.admissionPeriodId,
      substitutes: [
        {
          applicationId,
          firstName: submission.firstName,
          lastName: submission.lastName,
          email: submission.email,
          phone: submission.phone,
        },
      ],
    }),
    "a member reads only who is on call, with name, e-mail and phone",
  );
  expectProblem(await readItem(member), 403, "authority.denied", "member single read");
  expectProblem(
    await record(member, { outcome: "Rejected" }, substitute.etag),
    403,
    "authority.denied",
    "member record",
  );
  gates.push("a member reads the on-call list only; single reads and records are denied (403)");

  expectProblem(await readBoard(openSemesterId, other), 403, "authority.denied", "other department board");
  expectProblem(await readItem(other), 403, "authority.denied", "other department item");
  expectProblem(
    await record(other, { outcome: "Rejected" }, substitute.etag),
    403,
    "authority.denied",
    "other department record",
  );

  expectProblem(await listScopes(), 401, "credential.missing", "anonymous scopes");
  expectProblem(await readBoard(openSemesterId), 401, "credential.missing", "anonymous board");
  expectProblem(await readItem(), 401, "credential.missing", "anonymous item");
  expectProblem(
    await record(undefined, { outcome: "Rejected" }, substitute.etag),
    401,
    "credential.missing",
    "anonymous record",
  );
  assert.deepEqual(await outcomeHistory(applicationId), substituteHistory);
  gates.push("another department (403) and anonymous callers (401) read and record nothing");

  await database.query(
    `INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-substitutes','journey-rec-interviewer-b-0049','2026-01-01',NULL,0)`,
  );
  assert.equal(
    (await board(openSemesterId, other))._tag,
    "Decide",
    "an active global administrator decides in every department",
  );
  await database.query(
    "DELETE FROM public.organization_global_administrator_grants WHERE grant_id='admin-substitutes'",
  );
  expectProblem(await readBoard(openSemesterId, other), 403, "authority.denied", "ended grant");
  gates.push("an active global administrator decides in every department");

  const concurrent = await Promise.all([
    record(leader, { outcome: "Rejected" }, substitute.etag),
    record(leader, { outcome: "Rejected" }, substitute.etag),
  ]);

  const statuses = concurrent.map((answer) => answer.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1, `concurrent records ${statuses.join(",")}`);
  assert.ok(
    statuses.some((status) => status === 409 || status === 412),
    `concurrent rejection ${statuses.join(",")}`,
  );

  const rejectedHistory = [
    ...substituteHistory,
    { revision: 2, outcome: "Rejected", decidedBy: leaderPersonId },
  ];

  assert.deepEqual(await outcomeHistory(applicationId), rejectedHistory);
  const memberAfterReject = await board(openSemesterId, member);

  assert.deepEqual(
    Predicate.isTagged(memberAfterReject, "ReadOnly") ? memberAfterReject.substitutes : null,
    [],
    "a rejected applicant is no longer on call",
  );

  const leaderAfterReject = await board(openSemesterId);

  assert.equal(
    Predicate.isTagged(leaderAfterReject, "Decide")
      ? leaderAfterReject.entries.find((entry) => entry.applicationId === applicationId)?.outcome
      : null,
    "Rejected",
  );
  gates.push("of two concurrent records on one version exactly one applies; Rejected leaves the on-call list");

  await database.query(
    `UPDATE public.organization_memberships SET is_suspended=true WHERE person_id='${leaderPersonId}'`,
  );
  expectProblem(
    await record(leader, { outcome: "Substitute" }, item.etag, key),
    403,
    "authority.denied",
    "revoked authority cannot replay a stored result",
  );
  expectProblem(
    await readBoard(openSemesterId, leader),
    403,
    "authority.denied",
    "revoked authority cannot read",
  );
  await database.query(
    `UPDATE public.organization_memberships SET is_suspended=false WHERE person_id='${leaderPersonId}'`,
  );
  gates.push("revoked authority cannot replay a stored result or read");

  assert.deepEqual(
    await board(noPeriodSemesterId),
    AdmissionOutcomeBoardResource.cases.Decide.make({
      ...scopeOf(noPeriodSemesterId),
      admissionPeriodId: null,
      entries: [],
    }),
  );
  assert.deepEqual(
    await board(noPeriodSemesterId, member),
    AdmissionOutcomeBoardResource.cases.ReadOnly.make({
      ...scopeOf(noPeriodSemesterId),
      admissionPeriodId: null,
      substitutes: [],
    }),
  );
  expectProblem(
    await readBoard("semester-missing-substitutes", leader),
    422,
    "scope.invalid",
    "unknown semester",
  );
  gates.push("a scope without an admission period is empty with admissionPeriodId null; an unknown semester is invalid");

  for (const statement of [
    "UPDATE public.admission_application_outcomes SET outcome='Admitted' WHERE application_id=$1",
    "DELETE FROM public.admission_application_outcomes WHERE application_id=$1",
  ])
    await assert.rejects(database.query(statement, [applicationId]), (error) => {
      assert.ok(Predicate.hasProperty(error, "message"), statement);
      assert.match(String(error.message), /append-only/u, statement);

      return true;
    });
  assert.deepEqual(await outcomeHistory(applicationId), rejectedHistory);

  const receiptCount = (
    await database.query(
      "SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts WHERE operation_id='admissionOutcomes.recordOutcome'",
    )
  ).rows[0].count;

  // Receipts: the first Substitute, the repeated Substitute under a new key, and the concurrent winner.
  assert.equal(receiptCount, 3, "only executed records keep a receipt, not replays or refusals");
  gates.push("the outcome history is append-only and only executed records keep a receipt");
  await native.dispose();

  const manifest = {
    revision,
    backendOrigin,
    dashboardOrigin,
    artifacts,
    departmentId,
    semesterId: historicalSemesterId,
    noPeriodSemesterId,
    applicationId: browserApplicationId,
    leaderPersonId,
    onCall: "Sofie Søker, sofie.soker@example.invalid, 90000049",
    persons,
  };

  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const openScopeBefore = await openScopeOutcomes();
  let browserEvidence: Schema.JsonObject | null = null;

  if (process.argv.includes("--browser")) {
    run(
      "bun",
      ["apps/dashboard/e2e/run-real-native-substitutes.mjs"],
      {
        ...environment,
        SUBSTITUTE_JOURNEY_MANIFEST: manifestPath,
      },
      300_000,
    );
    browserEvidence = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject))(
      await readFile(join(artifacts, "browser-evidence.json"), "utf8"),
    );
    assert.equal(browserEvidence.passed, true);
    assert.equal(browserEvidence.revision, revision);
    assert.deepEqual(
      await outcomeHistory(browserApplicationId),
      browserEvidence.finalHistory,
      "browser outcomes independently observed in PostgreSQL",
    );
    assert.deepEqual(
      await outcomeHistory(undecidedBrowserApplicationId),
      [],
      "an application nobody decided keeps no outcome",
    );
    assert.deepEqual(
      await openScopeOutcomes(),
      openScopeBefore,
      "browser commands do not change another semester",
    );
  }

  const bunVersion = process.versions.bun;

  const postgresVersion = Schema.decodeUnknownSync(Schema.String)(
    (await database.query("SELECT version() AS version")).rows[0].version,
  );

  const runtime: { readonly postgres: string; readonly bun?: string } =
    bunVersion === undefined
      ? { postgres: postgresVersion }
      : { bun: bunVersion, postgres: postgresVersion };

  evidence = {
    revision,
    runtime,
    apiPassed: true,
    apiGates: gates,
    receiptCount,
    browserEvidence,
    scope: "owned loopback synthetic runtime; no production/provider effects",
  };
  summary = {
    apiGates: gates.length,
    browserGates:
      browserEvidence !== null && Array.isArray(browserEvidence.gates)
        ? browserEvidence.gates.length
        : 0,
    receiptCount,
  };
} catch (error) {
  process.stderr.write(outputs.join("").slice(-12000));
  throw error;
} finally {
  if (database) await database.end();

  for (const child of children.reverse()) await stopOwnedProcess(child);
  await postgres?.stop();
  await rm(join(artifacts, "manifest.json"), { force: true });

  if (evidence && summary) {
    const evidencePath = join(artifacts, "evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify(
        Struct.assign(evidence, {
          cleanup: "owned processes exited; disposable PostgreSQL and credential manifest removed",
        }),
        null,
        2,
      ),
    );
    process.stdout.write(`${JSON.stringify({ passed: true, evidencePath, ...summary })}\n`);
  }
}
