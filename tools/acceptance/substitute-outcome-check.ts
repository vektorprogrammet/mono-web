/**
 * Admission outcomes and the substitutes on call: real local API and browser acceptance.
 * Owns a disposable PostgreSQL cluster, the native identity seed, the backend, and credentials.
 * With --browser, a child runs the production dashboard and Playwright against the same backend.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schedule,
  Schema,
  Struct,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
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
import { reserveLoopbackPorts, startDisposablePostgres } from "../postgres/index.ts";
import { jsonText } from "../../apps/backend/src/rpc/problem.js";
import {
  answersOk,
  commandOutput,
  indentedJsonText,
  ProbeFailure,
  startOwnedProcess,
  withheldVariables,
} from "./acceptance-process.ts";

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

/** A PostgreSQL client call, or the disposable cluster, that failed. */
class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{ readonly cause: unknown }> {}

/** The rows of one query; the probe reads the columns that its statement selects. */
interface QueryResult {
  readonly rows: Array<any>;
}

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Client } = requireDatabase("pg");

/** The name and value of the first cookie that a response sets, as a `Cookie` header sends it. */
const firstCookie = (response: HttpClientResponse.HttpClientResponse): string | undefined => {
  const cookie = Object.values(response.cookies.cookies)[0];

  return cookie === undefined ? undefined : `${cookie.name}=${cookie.valueEncoded}`;
};

/** The journey: its evidence and summary once every owned resource is released. */
const journey = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");

  const git = (args: ReadonlyArray<string>) =>
    commandOutput({ command: "git", args, cwd: root, deadline: "60 seconds" });

  const revision = (yield* git(["rev-parse", "HEAD"])).trim();

  assert.equal(
    (yield* git(["status", "--porcelain"])).trim(),
    "",
    "requires committed clean artifact",
  );

  const artifacts = yield* fs.makeTempDirectory({ prefix: "vektor-substitutes-" });
  const manifestPath = path.join(artifacts, "manifest.json");
  const outputs: string[] = [];

  const api = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => fs.remove(manifestPath, { force: true }).pipe(Effect.ignore));

    const [pgPort, backendPort, dashboardPort] = yield* Effect.tryPromise({
      try: () => reserveLoopbackPorts(3),
      catch: (cause) => new DatabaseFailure({ cause }),
    });

    const postgres = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startDisposablePostgres({ port: pgPort }),
        catch: (cause) => new DatabaseFailure({ cause }),
      }),
      (cluster) => Effect.promise(() => cluster.stop()),
    );

    const postgresUrl = postgres.url;

    const database = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const client = new Client({ connectionString: postgresUrl });

        yield* Effect.tryPromise({
          try: () => client.connect(),
          catch: (cause) => new DatabaseFailure({ cause }),
        });

        return client;
      }),
      (client) => Effect.promise(() => client.end()),
    );

    const query = (text: string, values?: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: (): Promise<QueryResult> => database.query(text, values),
        catch: (cause) => new DatabaseFailure({ cause }),
      });

    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

    const environment = {
      ...(yield* withheldVariables),
      ...localBackendEnvironment({
        backendOrigin,
        dashboardOrigin,
        postgresUrl,
        betterAuthSecret: randomBytes(32).toString("hex"),
      }),
      JOURNEY_SEED_PG_URL: postgresUrl,
    };

    yield* commandOutput({
      command: "bun",
      args: ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"],
      cwd: root,
      env: environment,
      deadline: "60 seconds",
    });

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

    yield* query(`INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at) VALUES ('${historicalSemesterId}','2024-01-01','2024-07-01'),('${noPeriodSemesterId}','2023-01-01','2023-07-01');
 INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES ('${historicalPeriodId}','${departmentId}','${historicalSemesterId}','2024-01-01','2024-06-01',0,'fixture-substitutes');
 INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
 SELECT '${browserApplicationId}',applicant_id,'${historicalPeriodId}',department_id,field_of_study_id,year_of_study,'2024-01-02',0 FROM public.admission_applications WHERE application_id='application-native-journey-0049';
 INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision) VALUES ('${otherDepartmentId}','Annen avdeling','Annen','annen@example.invalid','Annen',true,0);
 INSERT INTO public.organization_teams(team_id,department_id,name,active,revision) VALUES ('team-other-substitutes','${otherDepartmentId}','Annet team',true,0);
 UPDATE public.organization_memberships SET team_id='team-other-substitutes',is_team_leader=true WHERE person_id='journey-rec-interviewer-b-0049';`);

    yield* startOwnedProcess({
      command: "bun",
      args: ["run", "--cwd", "apps/backend", "start"],
      cwd: root,
      env: environment,
      output: (text) => outputs.push(text),
    });

    yield* answersOk(`${backendOrigin}/health`).pipe(
      Effect.filterOrFail(
        (ready) => ready,
        () => new ProbeFailure({ message: "backend startup failed" }),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 151 }),
    );

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

    const login = (person: { email: string; password: string }) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${backendOrigin}/api/auth/sign-in/email`, {
            headers: { origin: dashboardOrigin },
          }).pipe(HttpClientRequest.bodyText(yield* jsonText(person), "application/json")),
        );

        assert.equal(response.status, 200, `login: ${yield* response.text}`);
        const cookie = firstCookie(response);
        assert.ok(cookie);

        return cookie;
      });

    const leader = yield* login(persons.leader),
      member = yield* login(persons.member),
      other = yield* login(persons.otherDepartment);

    const native = yield* Effect.acquireRelease(
      Effect.sync(() => nativeScriptClient(backendOrigin)),
      (client) => Effect.promise(() => client.dispose()),
    );

    /** One RPC call as the person with `headers`; the script client never rejects. */
    const call = <A, E>(...args: Parameters<typeof native.call<A, E>>) =>
      Effect.promise(() => native.call(...args));

    /** Headers of one call: the dashboard origin, and the person's session when there is one. */
    const as = (cookie?: string): Readonly<Record<string, string>> =>
      cookie === undefined ? { origin: dashboardOrigin } : { cookie, origin: dashboardOrigin };

    const newKey = () => IdempotencyKey.make(randomBytes(18).toString("base64url"));

    const expectValue = <A>(answer: ScriptCallResult<A>, gate: string): A => {
      if (!answer.ok) assert.fail(`${gate}: ${answer.code}`);

      return answer.value;
    };

    const expectProblem = <A>(
      answer: ScriptCallResult<A>,
      status: number,
      code: string,
      gate: string,
    ) => {
      assert.equal(answer.ok, false, gate);

      if (answer.ok) return;
      assert.equal(answer.status, status, `${gate}: ${answer.code}`);
      assert.equal(answer.code, code, gate);
    };

    const outcomeHistory = (applicationId: string) =>
      Effect.map(
        query(
          `SELECT revision, outcome, decided_by_person_id AS "decidedBy" FROM public.admission_application_outcomes WHERE application_id=$1 ORDER BY revision`,
          [applicationId],
        ),
        (result) => result.rows,
      );

    const openScopeOutcomes = Effect.map(
      query(
        "SELECT outcome.* FROM public.admission_application_outcomes outcome INNER JOIN public.admission_applications application ON application.application_id=outcome.application_id WHERE application.admission_period_id=$1 ORDER BY outcome.application_id, outcome.revision",
        [openPeriodId],
      ),
      (result) => result.rows,
    );

    const gates: string[] = [];

    const listScopes = (cookie?: string) =>
      call(as(cookie), (client) => client["admissionOutcomes.listScopes"]());

    const scopeDepartments = (cookie: string) =>
      Effect.map(listScopes(cookie), (answer) =>
        expectValue(answer, "scopes").departments.map((item) => item.departmentId),
      );

    const scopeOf = (semesterId: string) =>
      Schema.decodeSync(AdmissionOutcomeScope)({ departmentId, semesterId });

    const readBoard = (semesterId: string, cookie?: string) =>
      call(as(cookie), (client) => client["admissionOutcomes.readOutcomes"](scopeOf(semesterId)));

    const board = (semesterId: string, cookie = leader) =>
      Effect.map(readBoard(semesterId, cookie), (answer) =>
        expectValue(answer, `board ${semesterId}`),
      );

    const leaderScopes = expectValue(yield* listScopes(leader), "leader scopes");
    assert.deepEqual(yield* scopeDepartments(leader), [departmentId]);
    assert.ok(
      [historicalSemesterId, openSemesterId, noPeriodSemesterId].every((semesterId) =>
        leaderScopes.semesters.some((item) => item.semesterId === semesterId),
      ),
    );
    assert.deepEqual(yield* scopeDepartments(member), [departmentId]);
    assert.deepEqual(yield* scopeDepartments(other), [otherDepartmentId]);
    yield* query(
      `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES ('membership-other-substitutes','${leaderPersonId}','team-other-substitutes',NULL,'2026-01-01',NULL,NULL,false,false,0)`,
    );
    assert.deepEqual(
      yield* scopeDepartments(leader),
      [otherDepartmentId, departmentId],
      "every department membership is evaluated",
    );
    gates.push("scopes list only the departments each person may read, from every membership");

    const submission = yield* Schema.decodeEffect(SubmitApplicationRequest)({
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
      yield* call(as(), (client) =>
        client["admissions.submitApplication"]({ idempotencyKey: newKey(), request: submission }),
      ),
      "submission",
    );

    yield* query(
      `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
     SELECT '${undecidedBrowserApplicationId}',applicant_id,'${historicalPeriodId}',department_id,field_of_study_id,year_of_study,'2024-01-03',0 FROM public.admission_applications WHERE application_id=$1`,
      [applicationId],
    );

    const openBoard = yield* board(openSemesterId);

    if (!Predicate.isTagged(openBoard, "Decide"))
      assert.fail("admission management decides the open board");
    assert.equal(openBoard.admissionPeriodId, openPeriodId);

    const periodApplications = (
      yield* query(
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
      call(as(cookie), (client) => client["admissionOutcomes.readOutcome"]({ applicationId }));

    const record = (
      cookie: string | undefined,
      request: AdmissionOutcomeCommand,
      ifMatch: StrongETag,
      idempotencyKey = newKey(),
    ) =>
      call(as(cookie), (client) =>
        client["admissionOutcomes.recordOutcome"]({
          applicationId,
          idempotencyKey,
          ifMatch,
          request,
        }),
      );

    const item = expectValue(yield* readItem(leader), "leader single read");
    assert.equal(item.etag, initial.etag);
    gates.push("admission management reads every application of the period with its version");

    // The payload schema requires ifMatch and one declared outcome, so the RPC server rejects an
    // invalid command while decoding it, before the handler: it answers a defect, not a problem.
    const invalidCommands: ReadonlyArray<Schema.Json> = [
      {},
      { outcome: "Maybe" },
      { outcome: null },
    ];

    for (const invalid of invalidCommands) {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${backendOrigin}${nativeRpcPath}`, {
          headers: { cookie: leader, origin: dashboardOrigin },
        }).pipe(
          HttpClientRequest.bodyText(
            yield* jsonText(
              WireRequest.make({
                id: "1",
                tag: "admissionOutcomes.recordOutcome",
                payload: {
                  applicationId,
                  idempotencyKey: newKey(),
                  ifMatch: item.etag,
                  request: invalid,
                },
                headers: [],
              }),
            ),
            "application/json",
          ),
        ),
      );

      assert.equal(response.status, 200, `invalid ${yield* jsonText(invalid)}`);
      yield* Schema.decodeUnknownEffect(RejectedBeforeHandler)(yield* response.json);
    }

    assert.deepEqual(yield* outcomeHistory(applicationId), [], "rejected commands record nothing");
    gates.push("invalid outcomes are rejected before the handler and record nothing");

    const key = newKey();

    const substitute = expectValue(
      yield* record(leader, { outcome: "Substitute" }, item.etag, key),
      "record",
    );

    assert.notEqual(substitute.etag, item.etag);
    assert.equal(substitute.outcome, "Substitute");
    assert.equal(substitute.revision, 1);
    const substituteHistory = [{ revision: 1, outcome: "Substitute", decidedBy: leaderPersonId }];
    assert.deepEqual(yield* outcomeHistory(applicationId), substituteHistory);

    assert.deepEqual(
      expectValue(yield* record(leader, { outcome: "Substitute" }, item.etag, key), "replay"),
      substitute,
      "an exact replay answers the stored result",
    );
    assert.deepEqual(
      yield* outcomeHistory(applicationId),
      substituteHistory,
      "a replay adds no revision",
    );
    expectProblem(
      yield* record(leader, { outcome: "Rejected" }, item.etag, key),
      409,
      "idempotency.digest-conflict",
      "another command under a used key",
    );
    assert.deepEqual(
      expectValue(yield* record(leader, { outcome: "Substitute" }, substitute.etag), "again"),
      substitute,
      "recording the current outcome again changes nothing",
    );
    assert.deepEqual(yield* outcomeHistory(applicationId), substituteHistory);
    gates.push(
      "Substitute is recorded once with ifMatch and an idempotency key; replay and a repeated outcome add no revision",
    );

    expectProblem(
      yield* record(leader, { outcome: "Rejected" }, item.etag),
      412,
      "precondition.failed",
      "stale version",
    );

    const staleKey = newKey();

    for (const attempt of ["initial stale record", "unchanged rejected retry"])
      expectProblem(
        yield* record(leader, { outcome: "Rejected" }, item.etag, staleKey),
        412,
        "precondition.failed",
        attempt,
      );

    assert.deepEqual(yield* outcomeHistory(applicationId), substituteHistory);
    gates.push("a stale version is refused (412), also on an unchanged retry, and records nothing");

    assert.deepEqual(
      yield* board(openSemesterId, member),
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
    expectProblem(yield* readItem(member), 403, "authority.denied", "member single read");
    expectProblem(
      yield* record(member, { outcome: "Rejected" }, substitute.etag),
      403,
      "authority.denied",
      "member record",
    );
    gates.push("a member reads the on-call list only; single reads and records are denied (403)");

    expectProblem(
      yield* readBoard(openSemesterId, other),
      403,
      "authority.denied",
      "other department board",
    );
    expectProblem(yield* readItem(other), 403, "authority.denied", "other department item");
    expectProblem(
      yield* record(other, { outcome: "Rejected" }, substitute.etag),
      403,
      "authority.denied",
      "other department record",
    );

    expectProblem(yield* listScopes(), 401, "credential.missing", "anonymous scopes");
    expectProblem(yield* readBoard(openSemesterId), 401, "credential.missing", "anonymous board");
    expectProblem(yield* readItem(), 401, "credential.missing", "anonymous item");
    expectProblem(
      yield* record(undefined, { outcome: "Rejected" }, substitute.etag),
      401,
      "credential.missing",
      "anonymous record",
    );
    assert.deepEqual(yield* outcomeHistory(applicationId), substituteHistory);
    gates.push("another department (403) and anonymous callers (401) read and record nothing");

    yield* query(
      `INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-substitutes','journey-rec-interviewer-b-0049','2026-01-01',NULL,0)`,
    );
    assert.equal(
      (yield* board(openSemesterId, other))._tag,
      "Decide",
      "an active global administrator decides in every department",
    );
    yield* query(
      "DELETE FROM public.organization_global_administrator_grants WHERE grant_id='admin-substitutes'",
    );
    expectProblem(yield* readBoard(openSemesterId, other), 403, "authority.denied", "ended grant");
    gates.push("an active global administrator decides in every department");

    const concurrent = yield* Effect.all(
      [
        record(leader, { outcome: "Rejected" }, substitute.etag),
        record(leader, { outcome: "Rejected" }, substitute.etag),
      ],
      { concurrency: "unbounded" },
    );

    const statuses = concurrent.map((answer) => answer.status);
    assert.equal(
      statuses.filter((status) => status === 200).length,
      1,
      `concurrent records ${statuses.join(",")}`,
    );
    assert.ok(
      statuses.some((status) => status === 409 || status === 412),
      `concurrent rejection ${statuses.join(",")}`,
    );

    const rejectedHistory = [
      ...substituteHistory,
      { revision: 2, outcome: "Rejected", decidedBy: leaderPersonId },
    ];

    assert.deepEqual(yield* outcomeHistory(applicationId), rejectedHistory);
    const memberAfterReject = yield* board(openSemesterId, member);

    assert.deepEqual(
      Predicate.isTagged(memberAfterReject, "ReadOnly") ? memberAfterReject.substitutes : null,
      [],
      "a rejected applicant is no longer on call",
    );

    const leaderAfterReject = yield* board(openSemesterId);

    assert.equal(
      Predicate.isTagged(leaderAfterReject, "Decide")
        ? leaderAfterReject.entries.find((entry) => entry.applicationId === applicationId)?.outcome
        : null,
      "Rejected",
    );
    gates.push(
      "of two concurrent records on one version exactly one applies; Rejected leaves the on-call list",
    );

    yield* query(
      `UPDATE public.organization_memberships SET is_suspended=true WHERE person_id='${leaderPersonId}'`,
    );
    expectProblem(
      yield* record(leader, { outcome: "Substitute" }, item.etag, key),
      403,
      "authority.denied",
      "revoked authority cannot replay a stored result",
    );
    expectProblem(
      yield* readBoard(openSemesterId, leader),
      403,
      "authority.denied",
      "revoked authority cannot read",
    );
    yield* query(
      `UPDATE public.organization_memberships SET is_suspended=false WHERE person_id='${leaderPersonId}'`,
    );
    gates.push("revoked authority cannot replay a stored result or read");

    assert.deepEqual(
      yield* board(noPeriodSemesterId),
      AdmissionOutcomeBoardResource.cases.Decide.make({
        ...scopeOf(noPeriodSemesterId),
        admissionPeriodId: null,
        entries: [],
      }),
    );
    assert.deepEqual(
      yield* board(noPeriodSemesterId, member),
      AdmissionOutcomeBoardResource.cases.ReadOnly.make({
        ...scopeOf(noPeriodSemesterId),
        admissionPeriodId: null,
        substitutes: [],
      }),
    );
    expectProblem(
      yield* readBoard("semester-missing-substitutes", leader),
      422,
      "scope.invalid",
      "unknown semester",
    );
    gates.push(
      "a scope without an admission period is empty with admissionPeriodId null; an unknown semester is invalid",
    );

    for (const statement of [
      "UPDATE public.admission_application_outcomes SET outcome='Admitted' WHERE application_id=$1",
      "DELETE FROM public.admission_application_outcomes WHERE application_id=$1",
    ]) {
      const refusal = yield* Effect.flip(query(statement, [applicationId]));
      assert.ok(Predicate.hasProperty(refusal.cause, "message"), statement);
      assert.match(String(refusal.cause.message), /append-only/u, statement);
    }

    assert.deepEqual(yield* outcomeHistory(applicationId), rejectedHistory);

    const receiptCount = (
      yield* query(
        "SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts WHERE operation_id='admissionOutcomes.recordOutcome'",
      )
    ).rows[0].count;

    // Receipts: the first Substitute, the repeated Substitute under a new key, and the concurrent winner.
    assert.equal(receiptCount, 3, "only executed records keep a receipt, not replays or refusals");
    gates.push("the outcome history is append-only and only executed records keep a receipt");

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

    yield* fs.writeFileString(manifestPath, yield* jsonText(manifest), { mode: 0o600 });
    const openScopeBefore = yield* openScopeOutcomes;
    let browserEvidence: Schema.JsonObject | null = null;

    if (process.argv.includes("--browser")) {
      yield* commandOutput({
        command: "bun",
        args: ["apps/dashboard/e2e/run-real-native-substitutes.mjs"],
        cwd: root,
        env: { ...environment, SUBSTITUTE_JOURNEY_MANIFEST: manifestPath },
        deadline: "300 seconds",
      });
      browserEvidence = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
        yield* fs.readFileString(path.join(artifacts, "browser-evidence.json")),
      );
      assert.equal(browserEvidence.passed, true);
      assert.equal(browserEvidence.revision, revision);
      assert.deepEqual(
        yield* outcomeHistory(browserApplicationId),
        browserEvidence.finalHistory,
        "browser outcomes independently observed in PostgreSQL",
      );
      assert.deepEqual(
        yield* outcomeHistory(undecidedBrowserApplicationId),
        [],
        "an application nobody decided keeps no outcome",
      );
      assert.deepEqual(
        yield* openScopeOutcomes,
        openScopeBefore,
        "browser commands do not change another semester",
      );
    }

    const bunVersion = process.versions.bun;

    const postgresVersion = yield* Schema.decodeUnknownEffect(Schema.String)(
      (yield* query("SELECT version() AS version")).rows[0].version,
    );

    const runtime: { readonly postgres: string; readonly bun?: string } =
      bunVersion === undefined
        ? { postgres: postgresVersion }
        : { bun: bunVersion, postgres: postgresVersion };

    const evidence: Schema.JsonObject = {
      revision,
      runtime,
      apiPassed: true,
      apiGates: gates,
      receiptCount,
      browserEvidence,
      scope: "owned loopback synthetic runtime; no production/provider effects",
    };

    const summary = {
      apiGates: gates.length,
      browserGates:
        browserEvidence !== null && Array.isArray(browserEvidence.gates)
          ? browserEvidence.gates.length
          : 0,
      receiptCount,
    };

    return { evidence, summary };
  }).pipe(
    Effect.tapCause(() => Console.error(outputs.join("").slice(-12000))),
    Effect.scoped,
  );

  const { evidence, summary } = yield* api;
  const evidencePath = path.join(artifacts, "evidence.json");

  yield* fs.writeFileString(
    evidencePath,
    yield* indentedJsonText(
      Struct.assign(evidence, {
        cleanup: "owned processes exited; disposable PostgreSQL and credential manifest removed",
      }),
    ),
  );
  yield* Console.log(yield* jsonText({ passed: true, evidencePath, ...summary }));
});

BunRuntime.runMain(
  journey.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
);
