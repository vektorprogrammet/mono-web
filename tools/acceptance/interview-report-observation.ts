import { RecruitmentInterviewConductObservationSchema } from "../../packages/domain/src/recruitment/schema.js";
/**0103 observer: reuse0101's real finalized conduct and owned production runtime. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  InterviewReport,
  InterviewReportQuery,
  InterviewReportRow,
} from "../../packages/domain/src/recruitment/report.js";
import {
  Effect,
  Fiber,
  FileSystem,
  Match,
  Path,
  type PlatformError,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  jsonText,
  type JourneyStepFailed,
  step,
  thrownBy,
  withPoolClient,
} from "./journey-step.ts";
import { indentedJsonText, ProbeFailure } from "./acceptance-process.ts";
import { nativeRpcPath } from "../../packages/rpc/src/api.js";
import {
  nativeRpcOutcome,
  nativeRpcRequestBody,
  nativeRpcStatus,
  nativeRpcValue,
} from "../../apps/dashboard/e2e/native-operations.js";

const ids = {
  person: "report-coordinator-0103",
  member: "report-coordinator-membership-0103",
  department: "department-native-conduct-0063",
  team: "team-native-conduct-0063",
  period: "admission-period-native-conduct-0063",
  closed: "report-closed-period-0103",
  empty: "report-empty-period-0103",
  foreign: "report-foreign-period-0103",
  otherDepartment: "report-other-department-0103",
  otherTeam: "report-other-team-0103",
};

const fixtures = [
  { key: "low", recommendation: "Nei", scores: [1, 2, 0] },
  { key: "tie-a", recommendation: "Ja", scores: [8, 8, 8] },
  { key: "tie-b", recommendation: "Ja", scores: [8, 8, 8] },
  { key: "known-self", recommendation: "Nei", scores: [10, 10, 10] },
  { key: "race", recommendation: "Kanskje", scores: [4, 4, 4] },
  { key: "closed", recommendation: "Ja", scores: [1, 1, 1] },
  { key: "foreign", recommendation: "Nei", scores: [2, 2, 2] },
] as const;

export function validateInterviewReportFixture() {
  for (const period of [ids.period, ids.closed, ids.empty, ids.foreign])
    for (const recommendation of ["all", "Ja", "Kanskje", "Nei", "not-recorded"])
      for (const sort of ["applicant", "recommendation", "total"])
        for (const direction of ["asc", "desc"])
          Schema.decodeUnknownSync(InterviewReportQuery)({
            admissionPeriodId: period,
            recommendation,
            participation: "all",
            sort,
            direction,
          });

  for (const f of fixtures)
    Schema.decodeSync(InterviewReportRow)({
      interviewId: `report-interview-${f.key}`,
      firstName: "Report",
      lastName: f.key,
      completedAt: "2026-09-07T00:00:00.000Z",
      recommendation: f.recommendation,
      participation: "Unknown",
      explanatoryPower: f.scores[0],
      roleModel: f.scores[1],
      suitability: f.scores[2],
    });
}

type Options = {
  root: string;
  pool: any;
  browser: any;
  api: string;
  ui: string;
  artifacts: string;
  ordinaryCookie: string;
  password: string;
  secrets: string[];
  revision: string;
  correctionMode: boolean;
  returningPopulated?: boolean;
  expectedHistoricalReportRecommendation?: "Ja" | "Kanskje" | "Nei";
  auditPage: (
    page: any,
    state: string,
  ) => Effect.Effect<unknown, JourneyStepFailed | PlatformError.PlatformError | Schema.SchemaError>;
  recordGate: (...observations: string[]) => void;
};

export const seedInterviewReportCoordinator = Effect.fnUntraced(function* (o: {
  pool: any;
  secrets: string[];
}) {
  const { pool, secrets } = o;

  const clone = Effect.fnUntraced(function* (
    table: string,
    where: string,
    values: Schema.JsonObject,
  ) {
    return yield* step(() =>
      pool.query(
        `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(s)||$1::jsonb)).* FROM ${table} s WHERE ${where} ON CONFLICT DO NOTHING`,
        [JSON.stringify(values)],
      ),
    );
  });

  const ids = {
    person: "report-coordinator-0103",
    member: "report-coordinator-membership-0103",
    department: "department-native-conduct-0063",
    team: "team-native-conduct-0063",
  } as const;

  const email = "coordinator.report@example.invalid";

  if (!secrets.includes(email)) secrets.push(email);
  yield* clone("public.person_profiles", "person_id='journey-conduct-leader-0063'", {
    person_id: ids.person,
    first_name: "Report",
    last_name: "Coordinator",
  });
  yield* clone("public.person_contact_profiles", "person_id='journey-conduct-leader-0063'", {
    person_id: ids.person,
    email,
  });
  yield* clone('auth."user"', "id='journey-conduct-leader-0063'", {
    id: ids.person,
    email,
    name: "Report Coordinator",
  });
  yield* clone('auth."account"', "\"userId\"='journey-conduct-leader-0063'", {
    id: "report-account-0103",
    userId: ids.person,
    accountId: ids.person,
  });
  // The coordinator leads team-native-conduct-0063, the department's board (Styret) of an
  // independent department, so the leadership reaches the department (O8-11). The conduct seed
  // also runs against the pre-0037 schema, so the classification is set here; every clone of the
  // team or department below, and in recommendation-check.ts, inherits it.
  yield* step(() =>
    pool.query(`UPDATE public.organization_teams SET kind='DepartmentBoard' WHERE team_id=$1`, [
      ids.team,
    ]),
  );
  yield* step(() =>
    pool.query(
      `UPDATE public.organization_departments SET independent=true WHERE department_id=$1`,
      [ids.department],
    ),
  );
  yield* clone(
    "public.organization_memberships",
    "membership_id='membership-native-conduct-leader-0063'",
    {
      membership_id: ids.member,
      person_id: ids.person,
      is_team_leader: true,
      position_id: "teamleader",
    },
  );
});

export const observeInterviewReport = Effect.fnUntraced(function* (o: Options) {
  const { pool, api, ui } = o;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const require = createRequire(path.join(o.root, "apps/dashboard/package.json"));
  const { expect } = require("@playwright/test");
  const gates: string[] = [];

  const record = (...observations: string[]) => {
    gates.push(...observations);
    o.recordGate(...observations);
  };

  yield* seedInterviewReportCoordinator({ pool, secrets: o.secrets });
  const email = "coordinator.report@example.invalid";

  const clone = Effect.fnUntraced(function* (
    table: string,
    where: string,
    values: Schema.JsonObject,
  ) {
    return yield* step(() =>
      pool.query(
        `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(s)||$1::jsonb)).* FROM ${table} s WHERE ${where}`,
        [JSON.stringify(values)],
      ),
    );
  });

  yield* clone("public.organization_departments", `department_id='${ids.department}'`, {
    department_id: ids.otherDepartment,
    name: "Other report department",
    short_name: "Other0103",
    email: "other.report@example.invalid",
  });
  yield* clone("public.organization_teams", `team_id='${ids.team}'`, {
    team_id: ids.otherTeam,
    department_id: ids.otherDepartment,
  });
  yield* clone("public.admission_period_departments", `department_id='${ids.department}'`, {
    department_id: ids.otherDepartment,
    name: "Other report",
  });
  yield* clone(
    "public.admission_period_fields_of_study",
    "field_of_study_id='field-native-conduct-0063'",
    { field_of_study_id: "report-other-field-0103", department_id: ids.otherDepartment },
  );

  for (const [period, year, department] of [
    [ids.closed, 2024, ids.department],
    [ids.empty, 2023, ids.department],
    [ids.foreign, 2025, ids.otherDepartment],
  ] as const) {
    yield* clone(
      "public.admission_period_semesters",
      "semester_id='semester-native-conduct-0063'",
      {
        semester_id: `${period}-semester`,
        start_at: `${year}-01-01T00:00:00Z`,
        end_at: `${year}-12-31T23:59:59Z`,
      },
    );
    yield* clone("public.admission_periods", `admission_period_id='${ids.period}'`, {
      admission_period_id: period,
      semester_id: `${period}-semester`,
      department_id: department,
      start_at: `${year}-02-01T00:00:00Z`,
      end_at: `${year}-03-01T00:00:00Z`,
    });
  }

  yield* clone("public.organization_departments", `department_id='${ids.department}'`, {
    department_id: "report-empty-department",
    name: "Empty report department",
    short_name: "Empty0103",
    email: "empty.report@example.invalid",
  });
  yield* clone("public.organization_teams", `team_id='${ids.team}'`, {
    team_id: "report-empty-team",
    department_id: "report-empty-department",
  });
  yield* clone("public.admission_period_departments", `department_id='${ids.department}'`, {
    department_id: "report-empty-department",
    name: "Empty report",
  });

  for (const f of fixtures) {
    const applicant = `report-applicant-${f.key}`,
      application = `report-application-${f.key}`,
      interview = `report-interview-${f.key}`;

    const department = f.key === "foreign" ? ids.otherDepartment : ids.department;
    yield* clone("public.admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
      applicant_id: applicant,
      field_of_study_id:
        f.key === "foreign" ? "report-other-field-0103" : "field-native-conduct-0063",
      email: `${f.key}.report@example.invalid`,
      normalized_email: `${f.key}.report@example.invalid`,
      first_name: "Report",
      last_name: f.key.startsWith("tie-") ? "Tie" : f.key,
    });
    yield* clone(
      "public.admission_applications",
      "application_id='application-native-conduct-a-0063'",
      {
        application_id: application,
        field_of_study_id:
          f.key === "foreign" ? "report-other-field-0103" : "field-native-conduct-0063",
        applicant_id: applicant,
        admission_period_id: Match.value(f.key).pipe(
          Match.when("closed", () => ids.closed),
          Match.when("foreign", () => ids.foreign),
          Match.orElse(() => ids.period),
        ),
        department_id: department,
      },
    );
    yield* clone(
      "public.recruitment_interviews",
      "interview_id='interview-native-conduct-a-0063'",
      {
        interview_id: interview,
        application_id: application,
        department_id: department,
      },
    );
    yield* clone(
      "public.recruitment_interview_conducts",
      "interview_id='interview-native-conduct-a-0063'",
      {
        interview_id: interview,
        recommendation: f.recommendation,
        explanatory_power: f.scores[0],
        role_model: f.scores[1],
        suitability: f.scores[2],
      },
    );
  }

  const link = Effect.fnUntraced(function* (key: string, client = pool) {
    const invitation = `report-link-${key}`;
    yield* step(() =>
      client.query(
        `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Claimed',$5,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
        [
          invitation,
          `report-application-${key}`,
          `report-applicant-${key}`,
          createHash("sha256").update(invitation).digest("hex"),
          ids.person,
        ],
      ),
    );
    yield* step(() =>
      client.query(
        `INSERT INTO public.applicant_account_links VALUES($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$3)`,
        [`report-applicant-${key}`, ids.person, invitation],
      ),
    );
  });

  yield* link("known-self");

  const signIn = yield* HttpClient.execute(
    HttpClientRequest.post(`${api}/api/auth/sign-in/email`).pipe(
      HttpClientRequest.setHeaders({ origin: ui }),
      HttpClientRequest.bodyText(
        yield* jsonText({ email, password: o.password }),
        "application/json",
      ),
    ),
  );

  assert.equal(signIn.status, 200);

  const cookie = Object.values(signIn.cookies.cookies)
    .map((sent) => `${sent.name}=${sent.valueEncoded}`)
    .join("; ");

  assert.ok(cookie);
  o.secrets.push(cookie, ...cookie.split("; ").map((v) => v.slice(v.indexOf("=") + 1)));
  assert.equal(
    (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
    )(yield* signIn.json)).user.id,
    ids.person,
  );

  /**
   * One RPC as a browser posts it, with the session cookie and the dashboard origin. The payload is
   * hand built, so a value that its schema refuses reaches the server, which answers a defect.
   */
  const rpc = (tag: string, payload: Schema.Json, session: string) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${api}${nativeRpcPath}`).pipe(
          HttpClientRequest.setHeaders(
            session !== "" ? { origin: ui, cookie: session } : { origin: ui },
          ),
          HttpClientRequest.bodyText(nativeRpcRequestBody(tag, payload), "application/json"),
        ),
      );

      const text = yield* response.text;
      const outcome = nativeRpcOutcome(text);

      return {
        status: nativeRpcStatus(text) ?? response.status,
        value: nativeRpcValue(text),
        problem: Predicate.isTagged(outcome, "Problem") ? outcome.problem : undefined,
        text,
      };
    });

  const get = (query: Record<string, string> = {}, session = cookie) =>
    rpc("recruitment.readInterviewReport", query, session);

  /** The code of the problem that an RPC answered; an answer without one fails the gate. */
  const problemCode = (response: {
    readonly problem: { readonly code: string } | undefined;
    readonly text: string;
  }) => {
    assert.ok(response.problem !== undefined, response.text);

    return response.problem.code;
  };

  const read = Effect.fnUntraced(function* (query: Record<string, string> = {}) {
    const response = yield* get(query);

    if (response.status !== 200) {
      const authority = (yield* step(() =>
        pool.query(
          `SELECT m.membership_id,m.is_team_leader,m.is_suspended,m.end_at,t.team_id,t.kind team_kind,t.active team_active,d.department_id,d.independent department_independent,d.active department_active FROM public.organization_memberships m JOIN public.organization_teams t USING(team_id) JOIN public.organization_departments d USING(department_id) WHERE m.person_id=$1`,
          [ids.person],
        ),
      )).rows;

      throw new Error(
        yield* jsonText({
          gate: "report read",
          query,
          status: response.status,
          problem: response.text,
          authority,
        }),
      );
    }

    return yield* Schema.decodeUnknownEffect(InterviewReport)(response.value, {
      onExcessProperty: "error",
    });
  });

  const snapshot = Effect.fnUntraced(function* () {
    const tables = (yield* step(() =>
      pool.query(
        `SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') ORDER BY schemaname,tablename`,
      ),
    )).rows;

    const hashes = [];

    for (const t of tables)
      hashes.push([
        `${t.schemaname}.${t.tablename}`,
        (yield* step(() =>
          pool.query(
            `SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) hash FROM "${t.schemaname}"."${t.tablename}" t`,
          ),
        )).rows[0].hash,
      ]);

    return hashes;
  });

  const before = yield* snapshot();
  const unselected = yield* read();
  assert.equal(unselected.selectedPeriodId, null);
  assert.equal(unselected.rows.length, 0);
  assert.ok(unselected.periods.some((p) => p.id === ids.closed));
  assert.ok(!unselected.periods.some((p) => p.id === ids.foreign));

  const report: InterviewReport = yield* read(
    yield* Schema.encodeEffect(InterviewReportQuery)(
      yield* Schema.decodeEffect(InterviewReportQuery)({ admissionPeriodId: ids.period }),
    ),
  );

  const sqlRows = (yield* step(() =>
    pool.query(
      `SELECT i.interview_id FROM public.recruitment_interviews i JOIN public.admission_applications a USING(application_id) JOIN public.recruitment_interview_conducts c USING(interview_id) LEFT JOIN public.applicant_account_links l USING(applicant_id) WHERE a.admission_period_id=$1 AND (l.person_id IS NULL OR l.person_id<>$2) ORDER BY i.interview_id`,
      [ids.period, ids.person],
    ),
  )).rows;

  assert.deepEqual(
    report.rows.map((r) => r.interviewId).sort(),
    sqlRows.map((r: any) => r.interview_id),
  );

  if (o.correctionMode) {
    assert.equal(
      report.rows.find((row) => row.interviewId === "interview-recommendation-history")
        ?.recommendation,
      o.expectedHistoricalReportRecommendation,
    );
  } else {
    assert.ok(report.rows.some((r) => r.recommendation === null));
  }

  for (const row of report.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "interviewId",
        "firstName",
        "lastName",
        "completedAt",
        "recommendation",
        "participation",
        "explanatoryPower",
        "roleModel",
        "suitability",
      ].sort(),
    );

    const persisted = (yield* step(() =>
      pool.query(
        `SELECT
           COALESCE(correction.explanatory_power, conduct.explanatory_power) AS explanatory_power,
           COALESCE(correction.role_model, conduct.role_model) AS role_model,
           COALESCE(correction.suitability, conduct.suitability) AS suitability,
           COALESCE(correction.recommendation, conduct.recommendation) AS recommendation
         FROM public.recruitment_interview_conducts conduct
         LEFT JOIN LATERAL (
           SELECT explanatory_power, role_model, suitability, recommendation
           FROM public.recruitment_interview_correction_assessments
           WHERE interview_id = conduct.interview_id
           ORDER BY resulting_revision DESC
           LIMIT 1
         ) correction ON TRUE
         WHERE conduct.interview_id=$1`,
        [row.interviewId],
      ),
    )).rows[0];

    assert.deepEqual(
      [row.explanatoryPower, row.roleModel, row.suitability, row.recommendation],
      [
        persisted.explanatory_power,
        persisted.role_model,
        persisted.suitability,
        persisted.recommendation,
      ],
    );
  }

  for (const filter of ["Ja", "Kanskje", "Nei", "not-recorded"]) {
    const filtered = yield* read({ admissionPeriodId: ids.period, recommendation: filter });
    assert.deepEqual(
      filtered.rows,
      report.rows.filter((r) => (r.recommendation ?? "not-recorded") === filter),
    );

    if (o.correctionMode && filter === "not-recorded") {
      assert.equal(filtered.rows.length, 0);
    } else {
      assert.ok(filtered.rows.length > 0);
    }
  }

  for (const filter of ["Returning", "Unknown"]) {
    const filtered = yield* read({ admissionPeriodId: ids.period, participation: filter });
    assert.deepEqual(
      filtered.rows,
      report.rows.filter((r) => r.participation === filter),
    );

    if (o.returningPopulated !== true && filter === "Returning") {
      assert.equal(filtered.rows.length, 0);
    } else {
      assert.ok(filtered.rows.length > 0);
    }
  }

  for (const sort of ["applicant", "recommendation", "total"])
    for (const direction of ["asc", "desc"]) {
      const rows = (yield* read({ admissionPeriodId: ids.period, sort, direction })).rows;

      const values = rows.map((r) =>
        Match.value(sort).pipe(
          Match.when("total", () => r.explanatoryPower + r.roleModel + r.suitability),
          Match.when("recommendation", () => r.recommendation ?? "Ikke registrert"),
          Match.orElse(() => `${r.lastName} ${r.firstName}`),
        ),
      );

      for (let i = 1; i < values.length; i++) {
        assert.ok(
          direction === "asc" ? values[i - 1]! <= values[i]! : values[i - 1]! >= values[i]!,
        );

        if (values[i - 1] === values[i]) assert.ok(rows[i - 1]!.interviewId < rows[i]!.interviewId);
      }
    }

  assert.equal((yield* read({ admissionPeriodId: ids.closed })).rows.length, 1);
  assert.equal((yield* read({ admissionPeriodId: ids.empty })).rows.length, 0);
  assert.equal((yield* get({ admissionPeriodId: ids.foreign })).status, 403);
  assert.equal((yield* get({}, "")).status, 401);
  assert.equal((yield* get({}, o.ordinaryCookie)).status, 403);

  const conduct = (session: string) =>
    rpc(
      "recruitment.readInterviewConduct",
      { interviewId: "interview-native-conduct-a-0063" },
      session,
    );

  const assignedDetailResponse = yield* conduct(o.ordinaryCookie);

  assert.equal(assignedDetailResponse.status, 200, assignedDetailResponse.text);

  const assignedResource = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ detail: Schema.Json, etag: Schema.String }),
  )(assignedDetailResponse.value);

  const assignedDetail = yield* Schema.decodeUnknownEffect(
    RecruitmentInterviewConductObservationSchema,
  )(assignedResource.detail);

  const assignedETag = assignedResource.etag;
  assert.ok(Predicate.isString(assignedETag));
  assert.ok(Predicate.isNumber(assignedDetail.revision));
  assert.ok(Array.isArray(assignedDetail.answers));
  assert.ok(
    (assignedDetail.score === null || Predicate.isObjectOrArray(assignedDetail.score)) &&
      assignedDetail.score !== null,
  );
  assert.notEqual(assignedDetail.recommendation, null);

  const coordinatorDetailResponse = yield* conduct(cookie);

  assert.equal(coordinatorDetailResponse.status, 403, coordinatorDetailResponse.text);

  const coordinatorCorrectionResponse = yield* rpc(
    "recruitment.correctInterviewAssessment",
    {
      interviewId: "interview-native-conduct-a-0063",
      idempotencyKey: "report-coordinator-correction-denied-0103",
      ifMatch: assignedETag,
      request: yield* Schema.encodeEffect(Schema.Json)({
        expectedRevision: assignedDetail.revision,
        answers: assignedDetail.answers,
        score: assignedDetail.score,
        recommendation: assignedDetail.recommendation,
      }),
    },
    cookie,
  );

  assert.equal(coordinatorCorrectionResponse.status, 403, coordinatorCorrectionResponse.text);
  assert.deepEqual(yield* snapshot(), before);
  record(
    "report coordinator detail and correction deny for a non-assigned interview; no co-interviewer grant or writes",
  );
  assert.equal((yield* conduct(cookie)).status, 403);

  // The payload schema drops an unknown member, and refuses a value outside it before the
  // handler: the server answers a defect where the HTTP query answered 400 or 422.
  assert.equal((yield* get({ departmentId: ids.department })).status, 200);

  for (const [key, value] of [
    ["sort", "bogus"],
    ["recommendation", ""],
  ] as const)
    assert.equal((yield* get({ [key]: value })).status, 500);
  assert.deepEqual(yield* snapshot(), before);
  record(
    "real ordinary-interviewer conduct reported to non-assigned leader; exact population/projection/history/SQL and closed/empty periods; sort/filter/ties; no report writes; raw conduct remains denied",
  );

  yield* step(() =>
    pool.query(
      `UPDATE public.organization_memberships SET team_id='report-empty-team' WHERE membership_id=$1`,
      [ids.member],
    ),
  );
  const emptyDepartmentBefore = yield* snapshot();
  const emptyDepartment = yield* read();
  assert.deepEqual(emptyDepartment.periods, []);
  assert.deepEqual(emptyDepartment.rows, []);
  assert.deepEqual(yield* snapshot(), emptyDepartmentBefore);
  yield* step(() =>
    pool.query(`UPDATE public.organization_memberships SET team_id=$1 WHERE membership_id=$2`, [
      ids.team,
      ids.member,
    ]),
  );
  record("authorized department without periods returns explicit empty selection and no rows");
  // The report carries no entity tag over RPC, so a denial takes no prior conditional token.
  const authorityDenials: Array<{ condition: string; status: number; code: string }> = [];

  const denyMutation = Effect.fnUntraced(function* (setup: string, restore: string) {
    yield* step(() => pool.query(setup));
    const baseline = yield* snapshot();

    const denial = yield* get({ admissionPeriodId: ids.period }, cookie);

    const status = denial.status;
    assert.ok([401, 403].includes(status));
    const code = problemCode(denial);
    assert.ok(["authority.denied", "credential.invalid"].includes(code));
    authorityDenials.push({ condition: setup, status, code });
    assert.deepEqual(yield* snapshot(), baseline);
    yield* step(() => pool.query(restore));
  });

  for (const [field, bad, good] of [
    ["is_suspended", "true", "false"],
    // Ends after it starts, as the interval check requires, and long before the run.
    ["end_at", "start_at+interval '24 hours'", "NULL"],
    ["is_team_leader", "false", "true"],
  ])
    yield* denyMutation(
      `UPDATE public.organization_memberships SET ${field}=${bad} WHERE membership_id='${ids.member}'`,
      `UPDATE public.organization_memberships SET ${field}=${good} WHERE membership_id='${ids.member}'`,
    );
  yield* denyMutation(
    `UPDATE public.organization_teams SET active=false WHERE team_id='${ids.team}'`,
    `UPDATE public.organization_teams SET active=true WHERE team_id='${ids.team}'`,
  );
  yield* denyMutation(
    `UPDATE public.organization_departments SET active=false WHERE department_id='${ids.department}'`,
    `UPDATE public.organization_departments SET active=true WHERE department_id='${ids.department}'`,
  );
  yield* clone("public.organization_memberships", `membership_id='${ids.member}'`, {
    membership_id: "report-ambiguous-membership",
    team_id: ids.otherTeam,
  });
  const ambiguousResponse = yield* get();
  const ambiguousStatus = ambiguousResponse.status;
  assert.ok([401, 403].includes(ambiguousStatus));
  authorityDenials.push({
    condition: "ambiguous-department",
    status: ambiguousStatus,
    code: problemCode(ambiguousResponse),
  });
  yield* step(() =>
    pool.query(
      `DELETE FROM public.organization_memberships WHERE membership_id='report-ambiguous-membership'`,
    ),
  );
  yield* step(() =>
    pool.query(
      `INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at) VALUES('report-admin-grant',$1,'2026-01-01')`,
      [ids.person],
    ),
  );
  yield* denyMutation(
    `DELETE FROM public.organization_memberships WHERE membership_id='${ids.member}'`,
    `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,start_at,position_id,is_team_leader,is_suspended,revision) VALUES('${ids.member}','${ids.person}','${ids.team}','2026-01-01','teamleader',true,false,0)`,
  );
  yield* step(() =>
    pool.query(
      `DELETE FROM public.organization_global_administrator_grants WHERE grant_id='report-admin-grant'`,
    ),
  );
  record(
    "anonymous/member/admin-only/ambiguous/revoked/ended/suspended/inactive scope denied, including prior conditional token",
  );

  let concurrentReadStatus: number | undefined;
  yield* withPoolClient(pool, (locker: any) =>
    Effect.gen(function* () {
      yield* step(() => locker.query("BEGIN"));
      yield* step(() =>
        locker.query(
          `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='report-applicant-race' FOR UPDATE`,
        ),
      );
      const pid = (yield* step(() => locker.query("SELECT pg_backend_pid() pid"))).rows[0].pid;
      const waiting = yield* Effect.forkChild(get({ admissionPeriodId: ids.period }));
      let blocked = false;

      for (let n = 0; n < 100; n++) {
        blocked =
          (yield* step(() =>
            pool.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
              [pid],
            ),
          )).rows[0].n > 0;

        if (blocked) break;
        yield* Effect.sleep("50 millis");
      }

      assert.ok(blocked, "report held by authoritative applicant custody");
      yield* link("race", locker);
      yield* step(() => locker.query("COMMIT"));
      const afterLink = yield* snapshot();
      const response = yield* Fiber.join(waiting);
      concurrentReadStatus = response.status;
      assert.ok([200, 409, 503].includes(response.status));

      if (response.status === 200)
        assert.ok(
          !(yield* Schema.decodeUnknownEffect(InterviewReport)(response.value)).rows.some(
            (r) => r.interviewId === "report-interview-race",
          ),
        );

      for (const filter of ["all", "Ja", "Nei", "Kanskje", "not-recorded"])
        assert.ok(
          !(yield* read({ admissionPeriodId: ids.period, recommendation: filter })).rows.some((r) =>
            ["report-interview-race", "report-interview-known-self"].includes(r.interviewId),
          ),
        );
      assert.deepEqual(yield* snapshot(), afterLink);
    }).pipe(Effect.ensuring(step(() => locker.query("ROLLBACK")).pipe(Effect.orDie))),
  );

  record(
    "known self excluded from every filter/count; absent/different links eligible; actual concurrent link/read custody excludes newly known self",
  );

  const context = yield* step(() =>
    o.browser.newContext({ viewport: { width: 1280, height: 900 } }),
  );

  const errors: string[] = [];
  const expectedFaults: string[] = [];
  let intentionalReadFailure = false;

  return yield* Effect.gen(function* () {
    for (const part of cookie.split("; ")) {
      const n = part.indexOf("=");
      yield* step(() =>
        context.addCookies([
          {
            name: part.slice(0, n),
            value: part.slice(n + 1),
            url: ui,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]),
      );
    }

    const page = yield* step(() => context.newPage());
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", (m: any) => {
      if (m.type() === "error") {
        if (intentionalReadFailure && /server responded with a status of 503/.test(m.text()))
          expectedFaults.push("induced-report-503");
        else errors.push("console-error");
      }
    });
    const baseline = yield* snapshot();
    yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));
    yield* step(() =>
      page.getByRole("link", { name: "Fullførte intervjuer", exact: true }).click(),
    );
    yield* step(() => expect(page.getByRole("status")).toContainText("Velg en opptaksperiode"));

    const submit = Effect.fnUntraced(function* () {
      const fields = new URLSearchParams();

      for (const name of [
        "admissionPeriodId",
        "recommendation",
        "participation",
        "sort",
        "direction",
      ])
        fields.set(name, yield* step(() => page.locator(`[name="${name}"]`).inputValue()));
      const target = new URL(page.url());
      target.search = fields.toString();
      yield* step(() => page.getByRole("button", { name: "Vis rapport", exact: true }).focus());
      yield* step(() => page.keyboard.press("Enter"));
      yield* step(() => expect(page).toHaveURL(target.href));
      yield* step(() =>
        expect(page.locator('section[aria-labelledby="report-heading"]')).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      );
    });

    yield* step(() => page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period));
    yield* submit();
    const expected = (yield* read({ admissionPeriodId: ids.period })).rows.length;
    yield* step(() =>
      expect(page.getByRole("status")).toHaveText(`${expected} fullførte intervjuer`),
    );

    const assertRendered = Effect.fnUntraced(function* () {
      const query = Object.fromEntries(new URL(page.url()).searchParams);
      const expectedRows = (yield* read(query)).rows;

      const expectedCells = expectedRows.map((r) => [
        `${r.firstName} ${r.lastName}`,
        r.participation === "Returning" ? "Tilbakevendende" : "Ukjent",
        r.recommendation ?? "Ikke registrert",
        String(r.explanatoryPower),
        String(r.roleModel),
        String(r.suitability),
        String(r.explanatoryPower + r.roleModel + r.suitability),
      ]);

      yield* step(() =>
        expect
          .poll(() =>
            page.locator("tbody tr").evaluateAll((elements: any[]) =>
              elements.map((element: any) =>
                Array.from(element.querySelectorAll("th,td"))
                  .filter((_, index) => index !== 2)
                  .map((cell: any) => cell.textContent.trim()),
              ),
            ),
          )
          .toEqual(expectedCells),
      );
    });

    yield* assertRendered();

    for (const label of ["Søker", "Anbefaling", "Sum"]) {
      for (let n = 0; n < 2; n++) {
        const control = page.getByRole("link", { name: label, exact: true });

        const expectedUrl = new URL(yield* step(() => control.getAttribute("href")), page.url())
          .href;

        yield* step(() => control.focus());
        yield* step(() => page.keyboard.press("Enter"));
        yield* step(() => expect(page).toHaveURL(expectedUrl));
        yield* step(() =>
          expect(page.locator('section[aria-labelledby="report-heading"]')).toHaveAttribute(
            "aria-busy",
            "false",
          ),
        );
        yield* step(() =>
          expect(control.locator("..")).toHaveAttribute(
            "aria-sort",
            new URL(page.url()).searchParams.get("direction") === "desc"
              ? "descending"
              : "ascending",
          ),
        );
        yield* assertRendered();
      }
    }

    yield* step(() => page.getByLabel("Anbefaling", { exact: true }).focus());
    yield* step(() => page.keyboard.press("End"));
    yield* step(() =>
      expect(page.getByLabel("Anbefaling", { exact: true })).toHaveValue("not-recorded"),
    );
    yield* submit();
    yield* assertRendered();
    yield* step(() =>
      expect(page.getByRole("status")).toHaveText(
        `${o.correctionMode ? 0 : 1} fullførte intervjuer`,
      ),
    );

    if (o.correctionMode) {
      yield* step(() => expect(page.locator("tbody tr")).toHaveCount(0));
    } else {
      yield* step(() => expect(page.locator("tbody")).toContainText("Ikke registrert"));
    }

    const selectedUrl = page.url();
    yield* step(() => page.reload());
    assert.equal(page.url(), selectedUrl);
    yield* step(() =>
      expect(page.getByLabel("Anbefaling", { exact: true })).toHaveValue("not-recorded"),
    );
    yield* o.auditPage(page, "report-desktop-filtered");
    yield* step(() => page.screenshot({ path: path.join(o.artifacts, "report-desktop.png") }));
    yield* step(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* step(() => page.getByLabel("Anbefaling", { exact: true }).focus());
    yield* o.auditPage(page, "report-mobile-focus");
    yield* step(() => page.screenshot({ path: path.join(o.artifacts, "report-mobile.png") }));
    yield* step(() => page.getByLabel("Anbefaling", { exact: true }).selectOption("all"));
    yield* submit();
    yield* step(() =>
      expect(page.getByRole("status")).toHaveText(`${expected} fullførte intervjuer`),
    );
    const sumFocus = page.getByRole("link", { name: "Sum", exact: true });
    yield* step(() => sumFocus.focus());
    yield* step(() => sumFocus.scrollIntoViewIfNeeded());
    yield* step(() => expect(sumFocus).toBeFocused());
    const sumBounds = yield* step(() => sumFocus.boundingBox());
    assert.ok(sumBounds && sumBounds.x >= 0 && sumBounds.x + sumBounds.width <= 390);
    yield* o.auditPage(page, "report-mobile-sum-focus");
    yield* step(() => page.screenshot({ path: path.join(o.artifacts, "report-mobile-sum.png") }));
    yield* step(() => page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.closed));
    yield* submit();
    yield* step(() => expect(page.getByRole("status")).toHaveText("1 fullførte intervjuer"));
    yield* step(() => page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.empty));
    yield* submit();
    yield* step(() => expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer"));
    yield* step(() =>
      expect(page.getByText("Ingen fullførte intervjuer samsvarer med valgene.")).toBeVisible(),
    );
    // Actual backend SQL read failure, restored before retry. No mutation of stored conduct.
    intentionalReadFailure = true;
    yield* step(() =>
      pool.query(
        "ALTER TABLE public.recruitment_interview_conducts RENAME TO report_temporarily_unavailable_conducts",
      ),
    );

    yield* Effect.gen(function* () {
      yield* step(() =>
        page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period),
      );
      yield* step(() => page.getByRole("button", { name: "Vis rapport", exact: true }).click());
      yield* step(() =>
        expect(page.getByRole("alert")).toContainText("Rapporten kunne ikke hentes"),
      );
      yield* step(() => expect(page.locator("tbody")).toHaveCount(0));
      yield* o.auditPage(page, "report-failed-read");
      yield* step(() =>
        page.screenshot({ path: path.join(o.artifacts, "report-failure-mobile.png") }),
      );
    }).pipe(
      Effect.ensuring(
        step(() =>
          pool.query(
            "ALTER TABLE public.report_temporarily_unavailable_conducts RENAME TO recruitment_interview_conducts",
          ),
        ).pipe(Effect.orDie),
      ),
    );

    yield* step(() => page.getByRole("button", { name: "Prøv igjen", exact: true }).click());
    yield* step(() =>
      expect(page.getByRole("status")).toHaveText(`${expected} fullførte intervjuer`),
    );
    intentionalReadFailure = false;
    // Browser back supersedes a pending period request; releasing its real response cannot relabel rows.
    yield* step(() =>
      page.goto(`${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${ids.empty}`),
    );
    yield* step(() => page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period));
    yield* submit();
    let heldRequest: any;

    // The browser callbacks below settle these; the journey awaits them as steps.
    const settled = Promise.withResolvers<{ fulfilled: boolean; fetchStatus: number | null }>();
    const settle = settled.resolve;

    const terminated = Promise.withResolvers<{
      kind: "finished" | "failed";
      error: string | null;
    }>();

    const terminal = terminated.resolve;

    const finished = (request: any) => {
      if (request === heldRequest) terminal({ kind: "finished", error: null });
    };

    const failed = (request: any) => {
      if (request === heldRequest)
        terminal({ kind: "failed", error: request.failure()?.errorText ?? null });
    };

    page.on("requestfinished", finished);
    page.on("requestfailed", failed);

    /** The value of the promise, or a failure named by the gate after ten seconds. */
    const bounded = <T>(promise: Promise<T>, gate: string) =>
      step(() => promise).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new ProbeFailure({ message: gate })),
        }),
      );

    let supersededResponse:
      | {
          fulfilled: boolean;
          fetchStatus: number | null;
          kind: "finished" | "failed";
          error: string | null;
        }
      | undefined;

    const hold = Promise.withResolvers<void>();
    const release = () => hold.resolve();
    const arrived = Promise.withResolvers<void>();
    const captured = () => arrived.resolve();

    const observedNavigations: Array<{ path: string; period: string | null }> = [];
    yield* step(() =>
      page.route("**/*", (route: any) => {
        const requested = new URL(route.request().url());

        if (requested.pathname.includes("rapport"))
          observedNavigations.push({
            path: requested.pathname,
            period: requested.searchParams.get("admissionPeriodId"),
          });

        if (requested.searchParams.get("admissionPeriodId") === ids.closed) {
          assert.equal(heldRequest, undefined, "only one superseded request may be held");
          heldRequest = route.request();
          let fetchStatus: number | null = null;

          return route
            .fetch()
            .then((response: any) => {
              fetchStatus = response.status();
              captured();

              return hold.promise.then(() => route.fulfill({ response }));
            })
            .then(
              () => settle({ fulfilled: true, fetchStatus }),
              // A failed interception is accepted below only when this same browser
              // request independently reports the router's expected abort.
              () => settle({ fulfilled: false, fetchStatus }),
            );
        }

        return route.continue();
      }),
    );

    yield* Effect.gen(function* () {
      yield* step(() =>
        page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.closed),
      );
      yield* step(() => page.getByRole("button", { name: "Vis rapport", exact: true }).click());
      yield* step(() => arrived.promise).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProbeFailure({
                message: JSON.stringify({ gate: "superseded report request", observedNavigations }),
              }),
            ),
        }),
      );
      yield* step(() => expect(page.getByRole("status")).toHaveText("Henter rapporten …"));
      yield* step(() => expect(page.locator("tbody")).toHaveCount(0));
      yield* step(() => page.goBack());
      release();

      const fulfillment = yield* bounded(
        settled.promise,
        "superseded response fulfillment did not settle",
      );

      const termination = yield* bounded(
        terminated.promise,
        "superseded browser request did not terminate",
      );

      supersededResponse = { ...fulfillment, ...termination };
      assert.equal(fulfillment.fetchStatus, 200, "held response must be a real successful report");

      if (termination.kind === "failed") assert.equal(termination.error, "net::ERR_ABORTED");

      if (!fulfillment.fulfilled)
        assert.deepEqual(termination, { kind: "failed", error: "net::ERR_ABORTED" });
      yield* step(() =>
        expect(page).toHaveURL(`${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${ids.empty}`),
      );
      yield* step(() =>
        expect(page.locator("section[aria-busy]")).toHaveAttribute("aria-busy", "false"),
      );
      yield* step(() =>
        expect(page.getByLabel("Opptaksperiode", { exact: true })).toHaveValue(ids.empty),
      );
      yield* step(() => expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer"));
      yield* step(() => expect(page.locator("tbody")).toHaveCount(0));
      yield* step(() =>
        expect(page.getByText("Ingen fullførte intervjuer samsvarer med valgene.")).toBeVisible(),
      );
      yield* step(() =>
        page.screenshot({ path: path.join(o.artifacts, "report-superseded-settled.png") }),
      );
      yield* step(() => page.reload());
      yield* step(() => expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer"));
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          release();
          yield* step(() => page.unroute("**/*"));
          page.off("requestfinished", finished);
          page.off("requestfailed", failed);
        }).pipe(Effect.orDie),
      ),
    );

    assert.deepEqual(yield* snapshot(), baseline);
    assert.deepEqual(errors, []);
    record(
      "production navigation/keyboard sorts/filter/count/reload, historical/empty period, desktop/mobile Axe and viewport; real SQL failure/retry and superseded-period navigation; no report writes",
    );

    const evidence = {
      specId: "0103",
      revision: o.revision,
      gates,
      rowsBeforeConcurrentSelfLink: report.rows,
      observer: "independent PostgreSQL connection",
      browserErrors: errors,
      expectedFaults,
      concurrentReadStatus,
      supersededResponse,
      authorityDenials,
      conditionalRequest: "dropped: an RPC read takes no If-None-Match",
      scope: "all completed native, not first-time-only; local synthetic; no effects",
    };

    yield* fs.writeFileString(
      path.join(o.artifacts, "report-evidence.json"),
      yield* indentedJsonText(evidence),
    );

    return evidence;
  }).pipe(
    Effect.tapCause((cause) =>
      Effect.gen(function* () {
        const pages = context.pages();
        const current = pages[pages.length - 1];

        if (current === undefined) return;

        const error = thrownBy(cause);

        yield* step(() =>
          current.screenshot({ path: path.join(o.artifacts, "report-browser-failure.png") }),
        ).pipe(Effect.ignore);

        let detail = yield* jsonText({
          revision: o.revision,
          gates,
          error: error.message,
          path: new URL(current.url()).pathname,
          query: Object.fromEntries(new URL(current.url()).searchParams),
          status: yield* step(() => current.getByRole("status").allTextContents()),
          alerts: yield* step(() => current.getByRole("alert").allTextContents()),
        });

        for (const secret of o.secrets) detail = detail.replaceAll(secret, "[redacted]");
        yield* fs.writeFileString(path.join(o.artifacts, "report-browser-failure.json"), detail);
      }),
    ),
    Effect.ensuring(step(() => context.close()).pipe(Effect.orDie)),
  );
});
