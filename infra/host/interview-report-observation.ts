/**0103 observer: reuse0101's real finalized conduct and owned production runtime. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
const { Schema } = createRequire(new URL("../../packages/database/package.json", import.meta.url))(
  "effect",
);
import {
  InterviewReport,
  InterviewReportQuery,
  InterviewReportRow,
} from "../../packages/domain/src/recruitment/report.js";

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
    Schema.decodeUnknownSync(InterviewReportRow)({
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
  auditPage: (page: any, state: string) => Promise<void>;
  recordGate: (...observations: string[]) => void;
};
export async function observeInterviewReport(o: Options) {
  const { pool, api, ui } = o;
  const require = createRequire(join(o.root, "apps/dashboard/package.json"));
  const { expect } = require("@playwright/test");
  const gates: string[] = [];
  const record = (...observations: string[]) => {
    gates.push(...observations);
    o.recordGate(...observations);
  };
  const clone = async (table: string, where: string, values: Record<string, unknown>) =>
    pool.query(
      `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(s)||$1::jsonb)).* FROM ${table} s WHERE ${where}`,
      [JSON.stringify(values)],
    );
  // Synthetic credentials copy the installed engine's existing fixture hash, never product provisioning.
  const email = "coordinator.report@example.invalid";
  o.secrets.push(email);
  await clone("public.person_profiles", "person_id='journey-conduct-leader-0063'", {
    person_id: ids.person,
    first_name: "Report",
    last_name: "Coordinator",
  });
  await clone("public.person_contact_profiles", "person_id='journey-conduct-leader-0063'", {
    person_id: ids.person,
    email,
  });
  await clone('auth."user"', "id='journey-conduct-leader-0063'", {
    id: ids.person,
    email,
    name: "Report Coordinator",
  });
  await clone('auth."account"', "\"userId\"='journey-conduct-leader-0063'", {
    id: "report-account-0103",
    userId: ids.person,
    accountId: ids.person,
  });
  await clone(
    "public.organization_memberships",
    "membership_id='membership-native-conduct-leader-0063'",
    {
      membership_id: ids.member,
      person_id: ids.person,
      is_team_leader: true,
      position_id: "teamleader",
    },
  );
  await clone("public.organization_departments", `department_id='${ids.department}'`, {
    department_id: ids.otherDepartment,
    name: "Other report department",
    short_name: "Other0103",
    email: "other.report@example.invalid",
  });
  await clone("public.organization_teams", `team_id='${ids.team}'`, {
    team_id: ids.otherTeam,
    department_id: ids.otherDepartment,
  });
  await clone("public.admission_period_departments", `department_id='${ids.department}'`, {
    department_id: ids.otherDepartment,
    name: "Other report",
  });
  await clone(
    "public.admission_period_fields_of_study",
    "field_of_study_id='field-native-conduct-0063'",
    { field_of_study_id: "report-other-field-0103", department_id: ids.otherDepartment },
  );
  for (const [period, year, department] of [
    [ids.closed, 2024, ids.department],
    [ids.empty, 2023, ids.department],
    [ids.foreign, 2025, ids.otherDepartment],
  ] as const) {
    await clone("public.admission_period_semesters", "semester_id='semester-native-conduct-0063'", {
      semester_id: `${period}-semester`,
      start_at: `${year}-01-01T00:00:00Z`,
      end_at: `${year}-12-31T23:59:59Z`,
    });
    await clone("public.admission_periods", `admission_period_id='${ids.period}'`, {
      admission_period_id: period,
      semester_id: `${period}-semester`,
      department_id: department,
      start_at: `${year}-02-01T00:00:00Z`,
      end_at: `${year}-03-01T00:00:00Z`,
    });
  }
  await clone("public.organization_departments", `department_id='${ids.department}'`, {
    department_id: "report-empty-department",
    name: "Empty report department",
    short_name: "Empty0103",
    email: "empty.report@example.invalid",
  });
  await clone("public.organization_teams", `team_id='${ids.team}'`, {
    team_id: "report-empty-team",
    department_id: "report-empty-department",
  });
  await clone("public.admission_period_departments", `department_id='${ids.department}'`, {
    department_id: "report-empty-department",
    name: "Empty report",
  });
  for (const f of fixtures) {
    const applicant = `report-applicant-${f.key}`,
      application = `report-application-${f.key}`,
      interview = `report-interview-${f.key}`;
    const department = f.key === "foreign" ? ids.otherDepartment : ids.department;
    await clone("public.admission_applicants", "applicant_id='applicant-native-conduct-a-0063'", {
      applicant_id: applicant,
      field_of_study_id:
        f.key === "foreign" ? "report-other-field-0103" : "field-native-conduct-0063",
      email: `${f.key}.report@example.invalid`,
      normalized_email: `${f.key}.report@example.invalid`,
      first_name: "Report",
      last_name: f.key.startsWith("tie-") ? "Tie" : f.key,
    });
    await clone(
      "public.admission_applications",
      "application_id='application-native-conduct-a-0063'",
      {
        application_id: application,
        field_of_study_id:
          f.key === "foreign" ? "report-other-field-0103" : "field-native-conduct-0063",
        applicant_id: applicant,
        admission_period_id:
          f.key === "closed" ? ids.closed : f.key === "foreign" ? ids.foreign : ids.period,
        department_id: department,
      },
    );
    await clone("public.recruitment_interviews", "interview_id='interview-native-conduct-a-0063'", {
      interview_id: interview,
      application_id: application,
      department_id: department,
    });
    await clone(
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
  const link = async (key: string, client = pool) => {
    const invitation = `report-link-${key}`;
    await client.query(
      `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed',$5,CURRENT_TIMESTAMP)`,
      [
        invitation,
        `report-application-${key}`,
        `report-applicant-${key}`,
        createHash("sha256").update(invitation).digest("hex"),
        ids.person,
      ],
    );
    await client.query(
      `INSERT INTO public.applicant_account_links VALUES($1,$2,CURRENT_TIMESTAMP,$3)`,
      [`report-applicant-${key}`, ids.person, invitation],
    );
  };
  await link("known-self");
  const signIn = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: ui, "content-type": "application/json" },
    body: JSON.stringify({ email, password: o.password }),
  });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  o.secrets.push(cookie, ...cookie.split("; ").map((v) => v.slice(v.indexOf("=") + 1)));
  assert.equal((await signIn.json()).user.id, ids.person);
  const get = (
    query: Record<string, string> = {},
    session = cookie,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${api}/api/recruitment/interview-report?${new URLSearchParams(query)}`, {
      headers: { cookie: session, origin: ui, ...extra },
    });
  const read = async (query: Record<string, string> = {}): Promise<InterviewReport> => {
    const response = await get(query);
    if (response.status !== 200) {
      const problem = await response.json().catch(() => ({}));
      const authority = (
        await pool.query(
          `SELECT m.membership_id,m.is_team_leader,m.is_suspended,m.end_at,t.team_id,t.active team_active,d.department_id,d.active department_active FROM public.organization_memberships m JOIN public.organization_teams t USING(team_id) JOIN public.organization_departments d USING(department_id) WHERE m.person_id=$1`,
          [ids.person],
        )
      ).rows;
      throw new Error(
        JSON.stringify({
          gate: "report read",
          query,
          status: response.status,
          code: problem.code,
          authority,
        }),
      );
    }
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return Schema.decodeUnknownSync(InterviewReport)(await response.json(), {
      onExcessProperty: "error",
    });
  };
  const snapshot = async () => {
    const tables = (
      await pool.query(
        `SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') ORDER BY schemaname,tablename`,
      )
    ).rows;
    const hashes = [];
    for (const t of tables)
      hashes.push([
        `${t.schemaname}.${t.tablename}`,
        (
          await pool.query(
            `SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) hash FROM "${t.schemaname}"."${t.tablename}" t`,
          )
        ).rows[0].hash,
      ]);
    return hashes;
  };
  const before = await snapshot();
  const unselected = await read();
  assert.equal(unselected.selectedPeriodId, null);
  assert.equal(unselected.rows.length, 0);
  assert.ok(unselected.periods.some((p) => p.id === ids.closed));
  assert.ok(!unselected.periods.some((p) => p.id === ids.foreign));
  const { createPromiseClient } = require("@vektorprogrammet/sdk");
  const sdkResult = await createPromiseClient(api, {
    cookie,
    origin: ui,
  }).recruitment.readInterviewReport({
    query: Schema.decodeUnknownSync(InterviewReportQuery)({ admissionPeriodId: ids.period }),
  });
  const report: InterviewReport = Schema.decodeUnknownSync(InterviewReport)(sdkResult.body, {
    onExcessProperty: "error",
  });
  const sqlRows = (
    await pool.query(
      `SELECT i.interview_id FROM public.recruitment_interviews i JOIN public.admission_applications a USING(application_id) JOIN public.recruitment_interview_conducts c USING(interview_id) LEFT JOIN public.applicant_account_links l USING(applicant_id) WHERE a.admission_period_id=$1 AND (l.person_id IS NULL OR l.person_id<>$2) ORDER BY i.interview_id`,
      [ids.period, ids.person],
    )
  ).rows;
  assert.deepEqual(
    report.rows.map((r) => r.interviewId).sort(),
    sqlRows.map((r: any) => r.interview_id),
  );
  assert.ok(report.rows.some((r) => r.recommendation === null));
  for (const row of report.rows) {
    assert.deepEqual(
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
    const persisted = (
      await pool.query(
        `SELECT explanatory_power,role_model,suitability,recommendation FROM public.recruitment_interview_conducts WHERE interview_id=$1`,
        [row.interviewId],
      )
    ).rows[0];
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
    const filtered = await read({ admissionPeriodId: ids.period, recommendation: filter });
    assert.deepEqual(
      filtered.rows,
      report.rows.filter((r) => (r.recommendation ?? "not-recorded") === filter),
    );
    assert.ok(filtered.rows.length > 0);
  }
  for (const filter of ["Returning", "Unknown"]) {
    const filtered = await read({ admissionPeriodId: ids.period, participation: filter });
    assert.deepEqual(filtered.rows, report.rows.filter((r) => r.participation === filter));
    assert.ok(filtered.rows.length > 0);
  }
  for (const sort of ["applicant", "recommendation", "total"])
    for (const direction of ["asc", "desc"]) {
      const rows = (await read({ admissionPeriodId: ids.period, sort, direction })).rows;
      const values = rows.map((r) =>
        sort === "total"
          ? r.explanatoryPower + r.roleModel + r.suitability
          : sort === "recommendation"
            ? (r.recommendation ?? "Ikke registrert")
            : `${r.lastName} ${r.firstName}`,
      );
      for (let i = 1; i < values.length; i++) {
        assert.ok(
          direction === "asc" ? values[i - 1]! <= values[i]! : values[i - 1]! >= values[i]!,
        );
        if (values[i - 1] === values[i]) assert.ok(rows[i - 1]!.interviewId < rows[i]!.interviewId);
      }
    }
  assert.equal((await read({ admissionPeriodId: ids.closed })).rows.length, 1);
  assert.equal((await read({ admissionPeriodId: ids.empty })).rows.length, 0);
  assert.equal((await get({ admissionPeriodId: ids.foreign })).status, 403);
  assert.equal((await get({}, "")).status, 401);
  assert.equal((await get({}, o.ordinaryCookie)).status, 403);
  assert.equal(
    (
      await fetch(`${api}/api/recruitment/interviews/interview-native-conduct-a-0063`, {
        headers: { cookie, origin: ui },
      })
    ).status,
    403,
  );
  for (const bad of [
    { departmentId: ids.department },
    { sort: "bogus" },
    { recommendation: "" },
  ] as Array<Record<string, string>>)
    assert.ok([400, 422].includes((await get(bad)).status));
  assert.deepEqual(await snapshot(), before);
  record(
    "real ordinary-interviewer conduct reported to non-assigned leader; exact population/projection/history/SQL and closed/empty periods; sort/filter/ties; no report writes; raw conduct remains denied",
  );

  await pool.query(
    `UPDATE public.organization_memberships SET team_id='report-empty-team' WHERE membership_id=$1`,
    [ids.member],
  );
  const emptyDepartmentBefore = await snapshot();
  const emptyDepartment = await read();
  assert.deepEqual(emptyDepartment.periods, []);
  assert.deepEqual(emptyDepartment.rows, []);
  assert.deepEqual(await snapshot(), emptyDepartmentBefore);
  await pool.query(`UPDATE public.organization_memberships SET team_id=$1 WHERE membership_id=$2`, [
    ids.team,
    ids.member,
  ]);
  record("authorized department without periods returns explicit empty selection and no rows");
  const priorEtag = (await get({ admissionPeriodId: ids.period })).headers.get("etag");
  const oldCondition = priorEtag ?? "*";
  const authorityDenials: Array<{ condition: string; status: number; code: string }> = [];
  const denyMutation = async (setup: string, restore: string) => {
    await pool.query(setup);
    const baseline = await snapshot();
    const denial = await get({ admissionPeriodId: ids.period }, cookie, {
      "if-none-match": oldCondition,
    });
    const status = denial.status;
    assert.ok([401, 403].includes(status));
    const code = (await denial.json()).code;
    assert.ok(["authority.denied", "credential.invalid"].includes(code));
    authorityDenials.push({ condition: setup, status, code });
    assert.deepEqual(await snapshot(), baseline);
    await pool.query(restore);
  };
  for (const [field, bad, good] of [
    ["is_suspended", "true", "false"],
    ["end_at", "'2026-02-01'", "NULL"],
    ["is_team_leader", "false", "true"],
  ])
    await denyMutation(
      `UPDATE public.organization_memberships SET ${field}=${bad} WHERE membership_id='${ids.member}'`,
      `UPDATE public.organization_memberships SET ${field}=${good} WHERE membership_id='${ids.member}'`,
    );
  await denyMutation(
    `UPDATE public.organization_teams SET active=false WHERE team_id='${ids.team}'`,
    `UPDATE public.organization_teams SET active=true WHERE team_id='${ids.team}'`,
  );
  await denyMutation(
    `UPDATE public.organization_departments SET active=false WHERE department_id='${ids.department}'`,
    `UPDATE public.organization_departments SET active=true WHERE department_id='${ids.department}'`,
  );
  await clone("public.organization_memberships", `membership_id='${ids.member}'`, {
    membership_id: "report-ambiguous-membership",
    team_id: ids.otherTeam,
  });
  const ambiguousResponse = await get();
  const ambiguousStatus = ambiguousResponse.status;
  assert.ok([401, 403].includes(ambiguousStatus));
  authorityDenials.push({
    condition: "ambiguous-department",
    status: ambiguousStatus,
    code: (await ambiguousResponse.json()).code,
  });
  await pool.query(
    `DELETE FROM public.organization_memberships WHERE membership_id='report-ambiguous-membership'`,
  );
  await pool.query(
    `INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at) VALUES('report-admin-grant',$1,'2026-01-01')`,
    [ids.person],
  );
  await denyMutation(
    `DELETE FROM public.organization_memberships WHERE membership_id='${ids.member}'`,
    `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,start_at,position_id,is_team_leader,is_suspended,revision) VALUES('${ids.member}','${ids.person}','${ids.team}','2026-01-01','teamleader',true,false,0)`,
  );
  await pool.query(
    `DELETE FROM public.organization_global_administrator_grants WHERE grant_id='report-admin-grant'`,
  );
  record(
    "anonymous/member/admin-only/ambiguous/revoked/ended/suspended/inactive scope denied, including prior conditional token",
  );

  let concurrentReadStatus: number | undefined;
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(
      `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='report-applicant-race' FOR UPDATE`,
    );
    const pid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const waiting = get({ admissionPeriodId: ids.period });
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      blocked =
        (
          await pool.query(
            `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
            [pid],
          )
        ).rows[0].n > 0;
      if (blocked) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(blocked, "report held by authoritative applicant custody");
    await link("race", locker);
    await locker.query("COMMIT");
    const afterLink = await snapshot();
    const response = await waiting;
    concurrentReadStatus = response.status;
    assert.ok([200, 409, 503].includes(response.status));
    if (response.status === 200)
      assert.ok(
        !(await response.json()).rows.some((r: any) => r.interviewId === "report-interview-race"),
      );
    for (const filter of ["all", "Ja", "Nei", "Kanskje", "not-recorded"])
      assert.ok(
        !(await read({ admissionPeriodId: ids.period, recommendation: filter })).rows.some((r) =>
          ["report-interview-race", "report-interview-known-self"].includes(r.interviewId),
        ),
      );
    assert.deepEqual(await snapshot(), afterLink);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  record(
    "known self excluded from every filter/count; absent/different links eligible; actual concurrent link/read custody excludes newly known self",
  );

  const context = await o.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  const expectedFaults: string[] = [];
  let intentionalReadFailure = false;
  try {
    for (const part of cookie.split("; ")) {
      const n = part.indexOf("=");
      await context.addCookies([
        {
          name: part.slice(0, n),
          value: part.slice(n + 1),
          url: ui,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }
    const page = await context.newPage();
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", (m: any) => {
      if (m.type() === "error") {
        if (intentionalReadFailure && /server responded with a status of 503/.test(m.text()))
          expectedFaults.push("induced-report-503");
        else errors.push("console-error");
      }
    });
    const baseline = await snapshot();
    await page.goto(`${ui}/dashboard/intervjuer`);
    await page.getByRole("link", { name: "Fullførte intervjuer", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Velg en opptaksperiode");
    const submit = async () => {
      const fields = new URLSearchParams();
      for (const name of ["admissionPeriodId", "recommendation", "sort", "direction"])
        fields.set(name, await page.locator(`[name="${name}"]`).inputValue());
      const target = new URL(page.url());
      target.search = fields.toString();
      await page.getByRole("button", { name: "Vis rapport", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(target.href);
      await expect(page.locator('section[aria-labelledby="report-heading"]')).toHaveAttribute(
        "aria-busy",
        "false",
      );
    };
    await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period);
    await submit();
    const expected = (await read({ admissionPeriodId: ids.period })).rows.length;
    await expect(page.getByRole("status")).toHaveText(`${expected} fullførte intervjuer`);
    const assertRendered = async () => {
      const query = Object.fromEntries(new URL(page.url()).searchParams);
      const expectedRows = (await read(query)).rows;
      const expectedCells = expectedRows.map((r) => [
        `${r.firstName} ${r.lastName}`,
        r.recommendation ?? "Ikke registrert",
        String(r.explanatoryPower),
        String(r.roleModel),
        String(r.suitability),
        String(r.explanatoryPower + r.roleModel + r.suitability),
      ]);
      await expect
        .poll(async () =>
          page.locator("tbody tr").evaluateAll((elements: any[]) =>
            elements.map((element: any) =>
              Array.from(element.querySelectorAll("th,td"))
                .filter((_, index) => index !== 1)
                .map((cell: any) => cell.textContent.trim()),
            ),
          ),
        )
        .toEqual(expectedCells);
    };
    await assertRendered();
    for (const label of ["Søker", "Anbefaling", "Sum"]) {
      for (let n = 0; n < 2; n++) {
        const control = page.getByRole("link", { name: label, exact: true });
        const expectedUrl = new URL(await control.getAttribute("href"), page.url()).href;
        await control.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(expectedUrl);
        await expect(page.locator('section[aria-labelledby="report-heading"]')).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await expect(control.locator("..")).toHaveAttribute(
          "aria-sort",
          new URL(page.url()).searchParams.get("direction") === "desc" ? "descending" : "ascending",
        );
        await assertRendered();
      }
    }
    await page.getByLabel("Anbefaling", { exact: true }).focus();
    await page.keyboard.press("End");
    await expect(page.getByLabel("Anbefaling", { exact: true })).toHaveValue("not-recorded");
    await submit();
    await assertRendered();
    await expect(page.getByRole("status")).toHaveText("1 fullførte intervjuer");
    await expect(page.locator("tbody")).toContainText("Ikke registrert");
    const selectedUrl = page.url();
    await page.reload();
    assert.equal(page.url(), selectedUrl);
    await expect(page.getByLabel("Anbefaling", { exact: true })).toHaveValue("not-recorded");
    await o.auditPage(page, "report-desktop-filtered");
    await page.screenshot({ path: join(o.artifacts, "report-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Anbefaling", { exact: true }).focus();
    await o.auditPage(page, "report-mobile-focus");
    await page.screenshot({ path: join(o.artifacts, "report-mobile.png") });
    const sumFocus = page.getByRole("link", { name: "Sum", exact: true });
    await sumFocus.focus();
    await sumFocus.scrollIntoViewIfNeeded();
    await expect(sumFocus).toBeFocused();
    const sumBounds = await sumFocus.boundingBox();
    assert.ok(sumBounds && sumBounds.x >= 0 && sumBounds.x + sumBounds.width <= 390);
    await o.auditPage(page, "report-mobile-sum-focus");
    await page.screenshot({ path: join(o.artifacts, "report-mobile-sum.png") });
    await page.getByLabel("Anbefaling", { exact: true }).selectOption("all");
    await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.closed);
    await submit();
    await expect(page.getByRole("status")).toHaveText("1 fullførte intervjuer");
    await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.empty);
    await submit();
    await expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer");
    await expect(page.getByText("Ingen fullførte intervjuer samsvarer med valgene.")).toBeVisible();
    // Actual backend SQL read failure, restored before retry. No mutation of stored conduct.
    intentionalReadFailure = true;
    await pool.query(
      "ALTER TABLE public.recruitment_interview_conducts RENAME TO report_temporarily_unavailable_conducts",
    );
    try {
      await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period);
      await page.getByRole("button", { name: "Vis rapport", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Rapporten kunne ikke hentes");
      await expect(page.locator("tbody")).toHaveCount(0);
      await o.auditPage(page, "report-failed-read");
      await page.screenshot({ path: join(o.artifacts, "report-failure-mobile.png") });
    } finally {
      await pool.query(
        "ALTER TABLE public.report_temporarily_unavailable_conducts RENAME TO recruitment_interview_conducts",
      );
    }
    await page.getByRole("button", { name: "Prøv igjen", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`${expected} fullførte intervjuer`);
    intentionalReadFailure = false;
    // Browser back supersedes a pending period request; releasing its real response cannot relabel rows.
    await page.goto(`${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${ids.empty}`);
    await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.period);
    await submit();
    let release!: () => void, captured!: () => void;
    let settle!: (result: { fulfilled: boolean; fetchStatus: number | null }) => void;
    let terminal!: (result: { kind: "finished" | "failed"; error: string | null }) => void;
    let heldRequest: any;
    const settled = new Promise<{ fulfilled: boolean; fetchStatus: number | null }>((resolve) => {
      settle = resolve;
    });
    const terminated = new Promise<{ kind: "finished" | "failed"; error: string | null }>(
      (resolve) => {
        terminal = resolve;
      },
    );
    const finished = (request: any) => {
      if (request === heldRequest) terminal({ kind: "finished", error: null });
    };
    const failed = (request: any) => {
      if (request === heldRequest)
        terminal({ kind: "failed", error: request.failure()?.errorText ?? null });
    };
    page.on("requestfinished", finished);
    page.on("requestfailed", failed);
    const bounded = async <T>(promise: Promise<T>, gate: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(gate)), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let supersededResponse:
      | {
          fulfilled: boolean;
          fetchStatus: number | null;
          kind: "finished" | "failed";
          error: string | null;
        }
      | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const observedNavigations: Array<{ path: string; period: string | null }> = [];
    await page.route("**/*", async (route: any) => {
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
        try {
          const response = await route.fetch();
          fetchStatus = response.status();
          captured();
          await hold;
          await route.fulfill({ response });
          settle({ fulfilled: true, fetchStatus });
        } catch {
          // A failed interception is accepted below only when this same browser
          // request independently reports the router's expected abort.
          settle({ fulfilled: false, fetchStatus });
        }
      } else await route.continue();
    });
    try {
      await page.getByLabel("Opptaksperiode", { exact: true }).selectOption(ids.closed);
      await page.getByRole("button", { name: "Vis rapport", exact: true }).click();
      await Promise.race([
        arrived,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  JSON.stringify({ gate: "superseded report request", observedNavigations }),
                ),
              ),
            10000,
          ),
        ),
      ]);
      await expect(page.getByRole("status")).toHaveText("Henter rapporten …");
      await expect(page.locator("tbody")).toHaveCount(0);
      await page.goBack();
      release();
      const fulfillment = await bounded(settled, "superseded response fulfillment did not settle");
      const termination = await bounded(terminated, "superseded browser request did not terminate");
      supersededResponse = { ...fulfillment, ...termination };
      assert.equal(fulfillment.fetchStatus, 200, "held response must be a real successful report");
      if (termination.kind === "failed") assert.equal(termination.error, "net::ERR_ABORTED");
      if (!fulfillment.fulfilled)
        assert.deepEqual(termination, { kind: "failed", error: "net::ERR_ABORTED" });
      await expect(page).toHaveURL(
        `${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${ids.empty}`,
      );
      await expect(page.locator("section[aria-busy]")).toHaveAttribute("aria-busy", "false");
      await expect(page.getByLabel("Opptaksperiode", { exact: true })).toHaveValue(ids.empty);
      await expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer");
      await expect(page.locator("tbody")).toHaveCount(0);
      await expect(
        page.getByText("Ingen fullførte intervjuer samsvarer med valgene."),
      ).toBeVisible();
      await page.screenshot({ path: join(o.artifacts, "report-superseded-settled.png") });
      await page.reload();
      await expect(page.getByRole("status")).toHaveText("0 fullførte intervjuer");
    } finally {
      release();
      await page.unroute("**/*");
      page.off("requestfinished", finished);
      page.off("requestfailed", failed);
    }
    assert.deepEqual(await snapshot(), baseline);
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
      conditionalRequest: { priorEtag, ifNoneMatch: oldCondition },
      scope: "all completed native, not first-time-only; local synthetic; no effects",
    };
    await writeFile(join(o.artifacts, "report-evidence.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    const pages = context.pages();
    const current = pages[pages.length - 1];
    if (current) {
      await current
        .screenshot({ path: join(o.artifacts, "report-browser-failure.png") })
        .catch(() => {});
      let detail = JSON.stringify({
        revision: o.revision,
        gates,
        error: error instanceof Error ? error.message : "report browser failure",
        path: new URL(current.url()).pathname,
        query: Object.fromEntries(new URL(current.url()).searchParams),
        status: await current.getByRole("status").allTextContents(),
        alerts: await current.getByRole("alert").allTextContents(),
      });
      for (const secret of o.secrets) detail = detail.replaceAll(secret, "[redacted]");
      await writeFile(join(o.artifacts, "report-browser-failure.json"), detail);
    }
    throw error;
  } finally {
    await context.close();
  }
}
