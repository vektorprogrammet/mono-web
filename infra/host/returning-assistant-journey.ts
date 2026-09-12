import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Browser, Locator, Page } from "@playwright/test";

const person = {
  personId: "journey-returning-assistant-0104",
  firstName: "Rita",
  lastName: "Tilbake",
  email: "rita.returning@example.invalid",
  password: "returning-e2e-0104-password",
} as const;
const departmentId = "department-native-conduct-0063";
const semesterId = "semester-native-conduct-0063";
const admissionPeriodId = "admission-period-native-conduct-0063";
const nextSemesterId = "semester-returning-next-0104";
const historicalDepartmentId = "department-returning-history-0104";
const historicalSemesterId = "semester-returning-history-0104";
const nextAdmissionPeriodId = "admission-period-returning-next-0104";
const fieldOfStudyId = "field-native-conduct-0063";
const applicantId = "applicant-returning-0104";
const applicationId = "application-returning-0104";
const invitationId = "invitation-returning-0104";
const placementId = `placement-${"f".repeat(64)}`;
const teamId = "team-native-conduct-0063";
const foreignDepartmentId = "department-returning-foreign-0104";
const foreignTeamId = "team-returning-foreign-0104";
const negativeProbePersons = [
  {
    personId: "journey-returning-no-placement-0104",
    firstName: "Ingen",
    lastName: "Plassering",
    email: "returning.no-placement@example.invalid",
    password: "returning-negative-0104-password",
  },
  {
    personId: "journey-returning-no-link-0104",
    firstName: "Ingen",
    lastName: "Kobling",
    email: "returning.no-link@example.invalid",
    password: "returning-negative-0104-password",
  },
  {
    personId: "journey-returning-multi-link-0104",
    firstName: "Flere",
    lastName: "Koblinger",
    email: "returning.multi-link@example.invalid",
    password: "returning-negative-0104-password",
  },
  {
    personId: "journey-returning-invalid-study-0104",
    firstName: "Ugyldig",
    lastName: "Studie",
    email: "returning.invalid-study@example.invalid",
    password: "returning-negative-0104-password",
  },
] as const;

export const returningAssistantFixture = {
  person,
  semesterId,
  nextSemesterId,
  admissionPeriodId,
  nextAdmissionPeriodId,
  teamId,
  applicantId,
  applicationId,
};

export const seedReturningAssistant = async ({
  pool,
  run,
  env,
  root,
}: {
  readonly pool: Pool;
  readonly run: (command: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string) => string;
  readonly env: NodeJS.ProcessEnv;
  readonly root: string;
}) => {
  run("bun", ["run", "identity:seed"], {
    ...env,
    IDENTITY_SEED_PG_URL: env.JOURNEY_SEED_PG_URL,
    NATIVE_IDENTITY_TRUSTED_ORIGINS: env.NATIVE_IDENTITY_TRUSTED_ORIGINS,
    IDENTITY_SEED_PERSONS: JSON.stringify([person, ...negativeProbePersons]),
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  }, join(root, "packages/database"));
  const client = await pool.connect();
  const seedQuery = async (label: string, text: string, values?: unknown[]) => {
    try {
      return values === undefined
        ? await client.query(text)
        : await client.query(text, values as any[]);
    } catch (cause) {
      throw new Error(
        `returning seed ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  };
  try {
    await client.query("BEGIN");
    await seedQuery(
      "next semester",
      `INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at,revision)
       VALUES($1,'2026-08-02T00:00:00Z','2026-12-31T23:59:59.999Z',0)
       ON CONFLICT (semester_id) DO NOTHING`,
      [nextSemesterId],
    );
    await seedQuery(
      "next admission period",
      `INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id)
       VALUES($1,$2,$3,'2026-08-02T00:00:00Z','2026-12-31T23:59:59.999Z',0,'returning-next-period-seed-0104')
       ON CONFLICT (admission_period_id) DO NOTHING`,
      [nextAdmissionPeriodId, departmentId, nextSemesterId],
    );
    await seedQuery(
      "historical department",
      `INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision)
       VALUES($1,'Returning History','RH','returning-history@example.invalid','History City',true,0)
       ON CONFLICT (department_id) DO NOTHING`,
      [historicalDepartmentId],
    );
    await seedQuery(
      "foreign department",
      `INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision)
       VALUES($1,'Returning Foreign','RF','returning-foreign@example.invalid','Foreign City',true,0)
       ON CONFLICT (department_id) DO NOTHING`,
      [foreignDepartmentId],
    );
    await seedQuery(
      "foreign team",
      `INSERT INTO public.organization_teams(team_id,department_id,name)
       VALUES($1,$2,'Returning Foreign Team')
       ON CONFLICT (team_id) DO NOTHING`,
      [foreignTeamId, foreignDepartmentId],
    );
    await seedQuery(
      "historical semester",
      `INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at,revision)
       VALUES($1,'2025-01-01T00:00:00Z','2025-06-30T23:59:59.999Z',0)
       ON CONFLICT (semester_id) DO NOTHING`,
      [historicalSemesterId],
    );
    await seedQuery("volunteer affiliation", 
      `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
      [person.personId, departmentId],
    );
    await seedQuery("volunteer affiliation audit", 
      `INSERT INTO public.organization_volunteer_affiliation_audit(person_id,department_id,revision,action,actor_person_id,occurred_at)
       VALUES($1,$2,1,'Establish','journey-conduct-leader-0063','2026-01-04T00:00:00Z') ON CONFLICT DO NOTHING`,
      [person.personId, departmentId],
    );
    await seedQuery("applicant", 
      `INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest)
       VALUES($1,'rita.returning@example.invalid','rita.returning@example.invalid','Rita','Tilbake','90000104',0,$2,2,NULL) ON CONFLICT DO NOTHING`,
      [applicantId, fieldOfStudyId],
    );
    await seedQuery("application", 
      `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
       VALUES($1,$2,$3,$4,$5,2,'2026-08-20T10:00:00Z',0) ON CONFLICT DO NOTHING`,
      [applicationId, applicantId, admissionPeriodId, departmentId, fieldOfStudyId],
    );
    await seedQuery("invitation", 
      `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
       VALUES($1,$2,$3,$4,'2026-12-31T00:00:00Z','Claimed','journey-conduct-leader-0063','2026-01-02T00:00:00Z') ON CONFLICT DO NOTHING`,
      [
        invitationId,
        applicationId,
        applicantId,
        createHash("sha256").update(invitationId).digest("hex"),
      ],
    );
    await seedQuery("account link", 
      `INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id)
       VALUES($1,$2,'2026-01-03T00:00:00Z',$3) ON CONFLICT DO NOTHING`,
      [applicantId, person.personId, invitationId],
    );
    const negativeApplicants = [
      {
        applicantId: "applicant-returning-no-placement-0104",
        personId: negativeProbePersons[0].personId,
        email: negativeProbePersons[0].email,
        field: fieldOfStudyId,
        applicationId: "application-returning-no-placement-0104",
      },
      {
        applicantId: "applicant-returning-invalid-study-0104",
        personId: negativeProbePersons[3].personId,
        email: negativeProbePersons[3].email,
        field: fieldOfStudyId,
        applicationId: "application-returning-invalid-study-0104",
      },
      {
        applicantId: "applicant-returning-multi-a-0104",
        personId: negativeProbePersons[2].personId,
        email: "returning.multi-a@example.invalid",
        field: fieldOfStudyId,
        applicationId: "application-returning-multi-a-0104",
      },
      {
        applicantId: "applicant-returning-multi-b-0104",
        personId: negativeProbePersons[2].personId,
        email: "returning.multi-b@example.invalid",
        field: fieldOfStudyId,
        applicationId: "application-returning-multi-b-0104",
      },
    ] as const;
    for (const [index, negative] of negativeApplicants.entries()) {
      await seedQuery(
        `negative applicant ${index}`,
        `INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest)
         VALUES($1,$2,$2,'Negative','Probe','9000010${index}',0,$3,2,NULL) ON CONFLICT DO NOTHING`,
        [negative.applicantId, negative.email, negative.field],
      );
      await seedQuery(
        `negative application ${index}`,
        `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
         VALUES($1,$2,$3,$4,$5,2,'2026-08-20T10:00:00Z',0) ON CONFLICT DO NOTHING`,
        [negative.applicationId, negative.applicantId, admissionPeriodId, departmentId, negative.field],
      );
      const negativeInvitation = `invitation-returning-negative-${index}-0104`;
      await seedQuery(
        `negative invitation ${index}`,
        `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
         VALUES($1,$2,$3,$4,'2026-12-31T00:00:00Z','Claimed','journey-conduct-leader-0063','2026-01-02T00:00:00Z') ON CONFLICT DO NOTHING`,
        [
          negativeInvitation,
          negative.applicationId,
          negative.applicantId,
          createHash("sha256").update(negativeInvitation).digest("hex"),
        ],
      );
      await seedQuery(
        `negative account link ${index}`,
        `INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id)
         VALUES($1,$2,'2026-01-03T00:00:00Z',$3) ON CONFLICT DO NOTHING`,
        [negative.applicantId, negative.personId, negativeInvitation],
      );
    }
    await seedQuery(
      "no-placement affiliation",
      `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
      [negativeProbePersons[0].personId, departmentId],
    );
    await seedQuery(
      "invalid-study affiliation",
      `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
      [negativeProbePersons[3].personId, departmentId],
    );
    await seedQuery("school", 
      `INSERT INTO public.schools_directory_schools(name,contact_person,email,phone,language,active,revision)
       VALUES('Returning School','School Contact','school-returning@example.invalid','+47 900000106','Norwegian',true,0) ON CONFLICT DO NOTHING`,
    );
    const school = await seedQuery("school lookup", 
      "SELECT school_id FROM public.schools_directory_schools WHERE name='Returning School'",
    );
    assert.equal(school.rows.length, 1);
    await seedQuery("school department", 
      "INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
      [school.rows[0].school_id, departmentId],
    );
    await seedQuery(
      "historical school department",
      "INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
      [school.rows[0].school_id, historicalDepartmentId],
    );
    await seedQuery(
      "historical volunteer affiliation",
      `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Inactive',1) ON CONFLICT DO NOTHING`,
      [person.personId, historicalDepartmentId],
    );
    await seedQuery(
      "historical placement",
      `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Tuesday',4,'1',false,2) ON CONFLICT DO NOTHING`,
      [`placement-${"0".repeat(64)}`, person.personId, historicalDepartmentId, historicalSemesterId, school.rows[0].school_id],
    );
    await seedQuery(
      "placement",
      `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Monday',4,'1',true,1) ON CONFLICT DO NOTHING`,
      [placementId, person.personId, departmentId, semesterId, school.rows[0].school_id],
    );
    await seedQuery(
      "invalid-study placement",
      `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Monday',4,'1',true,1) ON CONFLICT DO NOTHING`,
      [`placement-${"b".repeat(64)}`, negativeProbePersons[3].personId, departmentId, semesterId, school.rows[0].school_id],
    );
    await seedQuery("placement audit",
      `INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot)
       VALUES($1::text,1,$2::text,'2026-01-04T00:00:00Z','Create',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Monday','workdays',4,'block','1','active',true,'revision',1)) ON CONFLICT DO NOTHING`,
      [placementId, person.personId, departmentId, semesterId, school.rows[0].school_id],
    );
    await seedQuery(
      "historical placement audit",
      `INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot)
       VALUES
       ($1,1,'journey-conduct-leader-0063','2025-01-04T00:00:00Z','Create',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Tuesday','workdays',4,'block','1','active',true,'revision',1)),
       ($1,2,'journey-conduct-leader-0063','2025-06-30T00:00:00Z','Remove',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Tuesday','workdays',4,'block','1','active',false,'revision',2))
       ON CONFLICT DO NOTHING`,
      [`placement-${"0".repeat(64)}`, person.personId, historicalDepartmentId, historicalSemesterId, school.rows[0].school_id],
    );
    await seedQuery("interview", 
      `INSERT INTO public.recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision)
       VALUES('interview-returning-0104',$1,$2,'journey-returning-assistant-0104','interview-schema-native-conduct-0063','journey-conduct-leader-0063','2026-08-21T10:00:00Z',1) ON CONFLICT DO NOTHING`,
      [applicationId, departmentId],
    );
    await seedQuery("question snapshots", 
      `INSERT INTO public.recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,help_text,kind,alternatives)
       SELECT 'interview-returning-0104',question_id,ordinal,prompt,help_text,kind,alternatives
       FROM public.recruitment_interview_schema_questions
       WHERE interview_schema_id='interview-schema-native-conduct-0063'
       ON CONFLICT DO NOTHING`,
    );
    await seedQuery("interview conduct", 
      `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation)
       VALUES('interview-returning-0104','[]'::jsonb,8,8,8,'journey-conduct-leader-0063','2026-08-22T10:00:00Z',1,'Ja') ON CONFLICT DO NOTHING`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const counts = await pool.query(
    `SELECT (SELECT count(*)::int FROM public.applicant_account_links WHERE person_id=$1) links,
            (SELECT count(*)::int FROM public.assistant_placements WHERE person_id=$1) placements,
            (SELECT count(*)::int FROM public.organization_departments WHERE department_id=$2) foreign_departments,
            (SELECT count(*)::int FROM public.organization_teams WHERE team_id=$3 AND department_id=$2) foreign_teams`,
    [person.personId, foreignDepartmentId, foreignTeamId],
  );
  assert.deepEqual(counts.rows[0], { links: 1, placements: 2, foreign_departments: 1, foreign_teams: 1 });
};

export const runReturningAssistantBrowserJourney = async ({
  browser,
  page,
  pool,
  api,
  ui,
  artifacts,
  auditPage,
  errors,
  stage,
}: {
  readonly browser: Browser;
  readonly page: Page;
  readonly pool: Pool;
  readonly api: string;
  readonly ui: string;
  readonly artifacts: string;
  readonly auditPage: (page: Page, state: string) => Promise<void>;
  readonly errors: string[];
  readonly stage?: (name: string) => void;
}) => {
  stage?.("returning:browser.newContext");
  const context = await browser.newContext();
  const responses: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  stage?.("returning:browser.newPage");
  const returning = await context.newPage();
  returning.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.includes("/dashboard/tidligere-assistenter")
      || url.pathname.includes("/api/returning-assistant/")
      || url.pathname.includes("/api/auth/")
    ) {
      responses.push(`request ${request.method()} ${url.pathname}`);
    }
  });
  returning.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      !url.pathname.includes("/dashboard/tidligere-assistenter")
      && !url.pathname.includes("/api/returning-assistant/")
      && !url.pathname.includes("/api/auth/")
    )
      return;
    let code = "unknown";
    if (url.pathname.endsWith(".data")) {
      const body = await response.text().catch(() => "");
      try {
        const value: unknown = JSON.parse(body);
        if (value !== null && typeof value === "object" && "code" in value && typeof value.code === "string")
          code = value.code;
      } catch {}
    }
    responses.push(`response ${response.status()} ${url.pathname} code=${code}`);
  });
  returning.on("pageerror", (error: Error) => errors.push(`returning:${error.message}`));
  const captureReturningFailure = async (phase: string, cause: unknown): Promise<never> => {
    const markup = await returning.content().catch(() => "<unavailable>");
    await writeFile(
      join(artifacts, `returning-${phase}-failure.html`),
      markup.replaceAll(person.email, "[redacted]"),
    );
    await returning.screenshot({ path: join(artifacts, `returning-${phase}-failure.png`), fullPage: true });
    const kind = cause instanceof Error ? cause.name : typeof cause;
    await writeFile(join(artifacts, "returning-registration-trace.json"), JSON.stringify(trace, null, 2));
    throw new Error(
      `returning ${phase} failed phase=browser-action kind=${kind} url=${returning.url()} responses=${responses.join(" | ")}`,
      { cause },
    );
  };
  returning.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.startsWith("/dashboard/tidligere-assistenter")) {
      const body = new URLSearchParams(request.postData() ?? "");
      const row = {
        phase: "dashboard-post",
        admissionPeriodId: body.get("admissionPeriodId"),
        expectedRevision: body.get("expectedRevision"),
        commandId: body.get("commandId"),
      };
      trace.push(row);
      responses.push(
        `dashboard POST request period=${row.admissionPeriodId} expectedRevision=${row.expectedRevision} commandId=${row.commandId}`,
      );
    }
  });
  const destination = "/dashboard/tidligere-assistenter";
  stage?.("returning:login");
  try {
    await returning.goto(`${ui}/login?redirectTo=${encodeURIComponent(destination)}`);
    await returning.getByLabel("E-post", { exact: true }).fill(person.email);
    await returning.getByLabel("Passord", { exact: true }).fill(person.password);
    await returning.getByRole("button", { name: "Logg inn", exact: true }).click({ noWaitAfter: true });
    await returning.waitForURL(/\/dashboard\/tidligere-assistenter$/);
  } catch (cause) {
    await captureReturningFailure("login", cause);
  }
  const cookieHeader = (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const optionsResponse = await context.request.get(`${api}/api/returning-assistant/options`, {
    headers: { origin: ui, accept: "application/json", cookie: cookieHeader },
  });
  responses.push(`context.request options ${optionsResponse.status()}`);
  const negativeMutationSnapshot = async (personId: string) =>
    (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM public.applicant_account_links WHERE person_id=$1) AS links,
         (SELECT count(*)::int FROM public.admission_applications a JOIN public.applicant_account_links l USING(applicant_id) WHERE l.person_id=$1) AS applications,
         (SELECT count(*)::int FROM public.admission_returning_registrations WHERE person_id=$1) AS registrations`,
      [personId],
    )).rows[0];
  const probeNegativeOptions = async (
    gate: string,
    probePerson: (typeof negativeProbePersons)[number],
    expectedStatus: number,
  ) => {
    let signIn = await fetch(`${api}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: ui, "content-type": "application/json" },
      body: JSON.stringify({ email: probePerson.email, password: probePerson.password }),
    });
    for (let retry = 0; signIn.status === 429 && retry < 30; retry += 1) {
      const cooldown = Promise.withResolvers<void>();
      setTimeout(cooldown.resolve, 1_000);
      await cooldown.promise;
      signIn = await fetch(`${api}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: ui, "content-type": "application/json" },
        body: JSON.stringify({ email: probePerson.email, password: probePerson.password }),
      });
    }
    assert.equal(signIn.status, 200, `${gate} sign-in`);
    const cookie = signIn.headers.get("set-cookie")?.match(/^([^=;]+=[^;]+)/u)?.[1];
    assert.ok(cookie, `${gate} session cookie`);
    const before = await negativeMutationSnapshot(probePerson.personId);
    const response = await fetch(`${api}/api/returning-assistant/options`, {
      headers: { origin: ui, accept: "application/json", cookie },
    });
    const body = await response.text();
    assert.equal(response.status, expectedStatus, `${gate} status body=${body}`);
    const after = await negativeMutationSnapshot(probePerson.personId);
    if (JSON.stringify(after) !== JSON.stringify(before))
      throw new Error(`${gate} must not mutate before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    trace.push({ phase: "negative-gate", gate, status: response.status, body });
  };
  await probeNegativeOptions("no-placement-despite-affiliation", negativeProbePersons[0], 404);
  await probeNegativeOptions("missing-applicant-person-link", negativeProbePersons[1], 404);
  await probeNegativeOptions("multiple-applicant-person-links", negativeProbePersons[2], 409);
  await pool.query(
    "UPDATE public.admission_period_fields_of_study SET active=false WHERE field_of_study_id=$1",
    [fieldOfStudyId],
  );
  try {
    await probeNegativeOptions("inactive-study-mapping", negativeProbePersons[3], 409);
  } finally {
    await pool.query(
      "UPDATE public.admission_period_fields_of_study SET active=true WHERE field_of_study_id=$1",
      [fieldOfStudyId],
    );
  }
  const mappingKey = await pool.query(
    `SELECT to_jsonb(array_agg(a.attname::text ORDER BY k.ordinality)) AS columns
     FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
     WHERE i.indrelid='public.admission_period_fields_of_study'::regclass AND i.indisprimary
     GROUP BY i.indexrelid`,
  );
  const expectedMappingKey = [{ columns: ["field_of_study_id"] }];
  if (JSON.stringify(mappingKey.rows) !== JSON.stringify(expectedMappingKey))
    throw new Error(`ambiguous-study-mapping structural key mismatch actual=${JSON.stringify(mappingKey.rows)} expected=${JSON.stringify(expectedMappingKey)}`);
  trace.push({ phase: "negative-gate", gate: "ambiguous-study-mapping-structural-primary-key", status: "proven" });
  const browserOptions = await returning.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    return { status: response.status };
  }, `${api}/api/returning-assistant/options`);
  const originalCustody = await pool.query(
    `SELECT
       to_jsonb(application) - 'year_of_study' - 'revision' AS application_immutable,
       to_jsonb(applicant) - 'activation_digest' AS applicant_profile,
       applicant.activation_digest,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.command_id)
         FROM public.admission_application_command_receipts receipt
         WHERE receipt.application_id=application.application_id
       ), '[]'::jsonb) AS public_receipts,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(conduct) ORDER BY conduct.interview_id)
         FROM public.recruitment_interviews interview
         JOIN public.recruitment_interview_conducts conduct USING(interview_id)
         WHERE interview.application_id=application.application_id
       ), '[]'::jsonb) AS conducts
     FROM public.admission_applications application
     JOIN public.admission_applicants applicant USING(applicant_id)
     WHERE application.application_id=$1`,
    [applicationId],
  );
  assert.equal(originalCustody.rows.length, 1);
  let form: Locator;
  stage?.("returning:form");
  try {
    form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    await form.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(nextAdmissionPeriodId);
    await form.getByRole("combobox", { name: "Studieår" }).selectOption("4");
    await form.getByLabel("Mandag", { exact: true }).check();
    await form.getByLabel("Torsdag", { exact: true }).check();
    await form.getByRole("combobox", { name: "Stillingslengde" }).selectOption("8");
    await form.getByRole("combobox", { name: "Semesterblokk" }).selectOption("block-1");
    await form.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk");
    await form.getByLabel("Ønsket skole (valgfritt)", { exact: true }).fill("Returning School");
    await form.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).check();
    await form.locator(`input[name="teamIds"][value="${teamId}"]`).check();
  } catch (cause) {
    await captureReturningFailure("form", cause);
  }
  let submit = form.locator('button[type="submit"]');
  let droppedResponse = false;
  let interceptedActions = 0;
  let firstCommandKey: string | undefined;
  let firstExpectedRevision: string | undefined;
  let routeFailure: string | undefined;
  const firstPayload = {
    admissionPeriodId: nextAdmissionPeriodId,
    expectedRevision: 0,
    yearOfStudy: 4,
    mondayUnavailable: true,
    tuesdayUnavailable: false,
    wednesdayUnavailable: false,
    thursdayUnavailable: true,
    fridayUnavailable: false,
    positionWeeks: 8,
    preferredGroup: "block-1",
    language: "Norsk og engelsk",
    preferredSchool: "Returning School",
    teamInterest: true,
    teamIds: [teamId],
  } as const;
  const anonymousBefore = await negativeMutationSnapshot(person.personId);
  const anonymous = await fetch(`${api}/api/returning-assistant/options`, {
    headers: { origin: ui, accept: "application/json" },
  });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await negativeMutationSnapshot(person.personId), anonymousBefore);
  trace.push({ phase: "negative-gate", gate: "anonymous-options", status: anonymous.status });
  const foreignTeam = await pool.query(
    "SELECT team_id FROM public.organization_teams WHERE department_id<>$1 ORDER BY team_id LIMIT 1",
    [departmentId],
  );
  assert.equal(foreignTeam.rows.length, 1);
  const wrongTeamBefore = await negativeMutationSnapshot(person.personId);
  const wrongTeam = await context.request.post(`${api}/api/returning-assistant/registrations`, {
    headers: { "content-type": "application/json", "idempotency-key": "returning-wrong-team-0104", origin: ui },
    data: { ...firstPayload, commandId: "returning-wrong-team-0104", teamInterest: true, teamIds: [foreignTeam.rows[0].team_id] },
  });
  const wrongTeamBody = await wrongTeam.json() as { code?: string };
  assert.equal(wrongTeam.status(), 403);
  assert.equal(wrongTeamBody.code, "returning.team-scope-denied");
  assert.deepEqual(await negativeMutationSnapshot(person.personId), wrongTeamBefore);
  trace.push({ phase: "negative-gate", gate: "cross-department-team", status: wrongTeam.status(), code: wrongTeamBody.code });
  let resolveFirstAction!: () => void;
  let rejectFirstAction!: (cause: unknown) => void;
  let resolveSecondAction!: () => void;
  let rejectSecondAction!: (cause: unknown) => void;
  const firstActionSettled = new Promise<void>((resolve, reject) => {
    resolveFirstAction = resolve;
    rejectFirstAction = reject;
  });
  const secondActionSettled = new Promise<void>((resolve, reject) => {
    resolveSecondAction = resolve;
    rejectSecondAction = reject;
  });
  await returning.route("**/dashboard/tidligere-assistenter*", async (route) => {
    try {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      interceptedActions += 1;
      const formData = new URLSearchParams(route.request().postData() ?? "");
      const commandKey = formData.get("commandId");
      const expectedRevision = formData.get("expectedRevision");
      const phase = droppedResponse ? "retry" : "first";
      stage?.(`returning:mutation:${phase}:request`);
      const response = await route.fetch({ timeout: 30_000 });
      stage?.(`returning:mutation:${phase}:response`);
      const status = response.status();
      trace.push({
        phase,
        form: [...formData.entries()],
        admissionPeriodId: formData.get("admissionPeriodId"),
        expectedRevision,
        commandId: commandKey,
        responseStatus: status,
      });
      responses.push(
        `intercepted POST /dashboard/tidligere-assistenter.data phase=${phase} status=${status}`,
      );
      if (!droppedResponse) {
        droppedResponse = true;
        firstCommandKey = commandKey ?? undefined;
        firstExpectedRevision = expectedRevision ?? undefined;
        if (status < 200 || status >= 300) routeFailure = `first action status ${status}`;
        trace.push({ phase: "first-delivery", transport: "aborted", fetchedStatus: status });
        await response.body();
        await route.abort("failed");
        resolveFirstAction();
        return;
      }
      if (commandKey !== firstCommandKey || expectedRevision !== firstExpectedRevision)
        routeFailure = "retry payload identity changed";
      if (status < 200 || status >= 300) routeFailure = `retry action status ${status}`;
      await route.fulfill({ response });
      resolveSecondAction();
    } catch (cause) {
      routeFailure = `intercepted ${interceptedActions === 1 ? "first" : "retry"} action failed`;
      (interceptedActions === 1 ? rejectFirstAction : rejectSecondAction)(cause);
    }
  });
  stage?.("returning:mutation");
  try {
    stage?.("returning:mutation:first:click");
    await submit.click();
    stage?.("returning:mutation:first:await");
    await firstActionSettled;
    stage?.("returning:mutation:first:settled");
    stage?.("returning:mutation:recovery");
    const recovery = returning.getByRole("button", { name: "Prøv igjen", exact: true });
    await recovery.waitFor();
    await recovery.click();
    form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    await form.waitFor();
    const restoredEntries = await form.evaluate((node) =>
      [...new FormData(node as HTMLFormElement)].map(([name, value]) => [name, String(value)]),
    );
    const firstRequest = trace.find((entry) => entry.phase === "first");
    assert.ok(firstRequest && Array.isArray(firstRequest.form));
    assert.deepEqual(restoredEntries, firstRequest.form);
    assert.equal(await form.locator('input[name="commandId"]').inputValue(), firstCommandKey);
    assert.equal(await form.locator('input[name="expectedRevision"]').inputValue(), firstExpectedRevision);
    submit = form.locator('button[type="submit"]');
    stage?.("returning:retry");
    stage?.("returning:mutation:retry:click");
    await submit.click();
    stage?.("returning:mutation:retry:await");
    await secondActionSettled;
  } catch (cause) {
    await captureReturningFailure("submit", cause);
  }
  assert.equal(interceptedActions, 2);
  assert.equal(droppedResponse, true);
  assert.equal(routeFailure, undefined, routeFailure);
  const captureCommitted = async (phase: string, periodId: string) => {
    const committed = await pool.query(
      `SELECT admission_period_id,revision,command_id
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision`,
      [person.personId, periodId],
    );
    trace.push({ phase, sqlCommitted: committed.rows });
    await writeFile(join(artifacts, "returning-registration-trace.json"), JSON.stringify(trace, null, 2));
  };
  try {
    await assertStatus(form, "Registreringen er lagret.");
  } catch (cause) {
    await captureReturningFailure("submit-status", cause);
  }
  await returning.unroute("**/dashboard/tidligere-assistenter*");
  await returning.reload();
  const reloaded = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await expectValue(reloaded.getByRole("combobox", { name: "Opptaksperiode" }), nextAdmissionPeriodId);
  await expectValue(reloaded.getByRole("combobox", { name: "Studieår" }), "4");
  await expectValue(reloaded.getByRole("combobox", { name: "Stillingslengde" }), "8");
  await expectValue(reloaded.getByRole("combobox", { name: "Semesterblokk" }), "block-1");
  await expectValue(reloaded.getByRole("combobox", { name: "Språk" }), "Norsk og engelsk");
  assert.equal(await reloaded.getByLabel("Mandag", { exact: true }).isChecked(), true);
  assert.equal(await reloaded.getByLabel("Torsdag", { exact: true }).isChecked(), true);
  assert.equal(await reloaded.getByLabel("Ønsket skole (valgfritt)", { exact: true }).inputValue(), "Returning School");
  assert.equal(await reloaded.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).isChecked(), true);
  assert.equal(await reloaded.locator(`input[name="teamIds"][value="${teamId}"]`).isChecked(), true);

  await reloaded.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(admissionPeriodId);
  await reloaded.getByRole("combobox", { name: "Studieår" }).selectOption("2");
  await reloaded.getByLabel("Torsdag", { exact: true }).uncheck();
  await reloaded.getByRole("combobox", { name: "Stillingslengde" }).selectOption("4");
  await reloaded.getByRole("combobox", { name: "Semesterblokk" }).selectOption("all");
  await reloaded.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk");
  await reloaded.getByLabel("Ønsket skole (valgfritt)", { exact: true }).fill("");
  await reloaded.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).uncheck();
  await reloaded.locator(`input[name="teamIds"][value="${teamId}"]`).uncheck();
  await reloaded.locator('button[type="submit"]').click();
  try {
    await assertStatus(reloaded, "Registreringen er lagret.");
  } catch (cause) {
    await captureReturningFailure("existing-registration-status", cause);
  }
  await captureCommitted("existing-period-after-registration", admissionPeriodId);

  await returning.reload();
  const existing = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await expectValue(existing.getByRole("combobox", { name: "Opptaksperiode" }), admissionPeriodId);
  await expectValue(existing.getByRole("combobox", { name: "Studieår" }), "2");
  await expectValue(existing.getByRole("combobox", { name: "Stillingslengde" }), "4");
  await expectValue(existing.getByRole("combobox", { name: "Semesterblokk" }), "all");
  await expectValue(existing.getByRole("combobox", { name: "Språk" }), "Norsk og engelsk");
  await existing.getByRole("combobox", { name: "Studieår" }).selectOption("3");
  await existing.getByRole("combobox", { name: "Språk" }).selectOption("Engelsk");
  await existing.getByRole("button", { name: "Lagre endringer" }).click();
  try {
    await assertStatus(existing, "Registreringen er lagret.");
  } catch (cause) {
    await captureReturningFailure("update-status", cause);
  }
  await captureCommitted("existing-period-after-update", admissionPeriodId);
  await returning.reload();
  const updated = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await expectValue(updated.getByRole("combobox", { name: "Opptaksperiode" }), admissionPeriodId);
  await expectValue(updated.getByRole("combobox", { name: "Studieår" }), "3");
  await expectValue(updated.getByRole("combobox", { name: "Språk" }), "Engelsk");
  await auditPage(returning, "returning-registration");
  const finalCustody = await pool.query(
    `SELECT
       to_jsonb(application) - 'year_of_study' - 'revision' AS application_immutable,
       to_jsonb(applicant) - 'activation_digest' AS applicant_profile,
       applicant.activation_digest,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.command_id)
         FROM public.admission_application_command_receipts receipt
         WHERE receipt.application_id=application.application_id
       ), '[]'::jsonb) AS public_receipts,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(conduct) ORDER BY conduct.interview_id)
         FROM public.recruitment_interviews interview
         JOIN public.recruitment_interview_conducts conduct USING(interview_id)
         WHERE interview.application_id=application.application_id
       ), '[]'::jsonb) AS conducts
     FROM public.admission_applications application
     JOIN public.admission_applicants applicant USING(applicant_id)
     WHERE application.application_id=$1`,
    [applicationId],
  );
  assert.deepEqual(finalCustody.rows, originalCustody.rows);
  trace.push({ phase: "negative-gate", gate: "preserved-original-receipt-activation-conduct", status: "observed" });
  const nextInterviews = await pool.query(
    `SELECT count(*)::int AS count
     FROM public.recruitment_interviews interview
     JOIN public.admission_applications application USING(application_id)
     WHERE application.admission_period_id=$1`,
    [nextAdmissionPeriodId],
  );
  assert.deepEqual(nextInterviews.rows, [{ count: 0 }]);
  trace.push({ phase: "negative-gate", gate: "new-period-no-new-interview", status: "observed" });
  const registrations = await pool.query("SELECT admission_period_id,revision,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids FROM public.admission_returning_registrations WHERE person_id=$1 ORDER BY admission_period_id,revision", [person.personId]);
  assert.deepEqual(registrations.rows, [
    { admission_period_id: admissionPeriodId, revision: 1, year_of_study: 2, monday_unavailable: false, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: false, friday_unavailable: false, position_weeks: 4, preferred_group: "all", language: "Norsk og engelsk", preferred_school: null, team_interest: false, team_ids: [] },
    { admission_period_id: admissionPeriodId, revision: 2, year_of_study: 3, monday_unavailable: false, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: false, friday_unavailable: false, position_weeks: 4, preferred_group: "all", language: "Engelsk", preferred_school: null, team_interest: false, team_ids: [] },
    { admission_period_id: nextAdmissionPeriodId, revision: 1, year_of_study: 4, monday_unavailable: true, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: true, friday_unavailable: false, position_weeks: 8, preferred_group: "block-1", language: "Norsk og engelsk", preferred_school: "Returning School", team_interest: true, team_ids: [teamId] },
  ]);
  const provenance = await pool.query(
    `SELECT DISTINCT placement_id,department_id,semester_id
     FROM public.admission_returning_registrations
     WHERE person_id=$1`,
    [person.personId],
  );
  assert.deepEqual(provenance.rows, [{
    placement_id: `placement-${"0".repeat(64)}`,
    department_id: historicalDepartmentId,
    semester_id: historicalSemesterId,
  }]);
  trace.push({ phase: "negative-gate", gate: "retained-inactive-cross-department-placement", status: "observed" });
  assert.ok(firstCommandKey);
  assert.ok(firstExpectedRevision !== undefined);
  const firstReplayPayload = {
    commandId: firstCommandKey,
    ...firstPayload,
    expectedRevision: Number(firstExpectedRevision),
  };
  const nextRevisionBeforeReplay = await pool.query(
    "SELECT count(*)::int AS count FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2",
    [person.personId, nextAdmissionPeriodId],
  );
  const exactReplay = await context.request.post(`${api}/api/returning-assistant/registrations`, {
    headers: {
      "content-type": "application/json",
      "idempotency-key": firstCommandKey,
      origin: ui,
    },
    data: firstReplayPayload,
  });
  assert.equal(exactReplay.status(), 200);
  const nextRevisionAfterReplay = await pool.query(
    "SELECT count(*)::int AS count FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2",
    [person.personId, nextAdmissionPeriodId],
  );
  assert.deepEqual(nextRevisionAfterReplay.rows, nextRevisionBeforeReplay.rows);
  const closedBefore = await negativeMutationSnapshot(person.personId);
  await pool.query(
    "UPDATE public.admission_periods SET end_at='2026-01-01T00:00:00Z' WHERE admission_period_id=$1",
    [nextAdmissionPeriodId],
  );
  try {
    const closedReplay = await context.request.post(`${api}/api/returning-assistant/registrations`, {
      headers: {
        "content-type": "application/json",
        "idempotency-key": firstCommandKey,
        origin: ui,
      },
      data: firstReplayPayload,
    });
    assert.equal(closedReplay.status(), 409);
    assert.deepEqual(await negativeMutationSnapshot(person.personId), closedBefore);
    trace.push({ phase: "negative-gate", gate: "closed-period", status: closedReplay.status() });
  } finally {
    await pool.query(
      "UPDATE public.admission_periods SET end_at='2026-12-31T23:59:59.999Z' WHERE admission_period_id=$1",
      [nextAdmissionPeriodId],
    );
  }
  const concurrent = await Promise.all([
    context.request.post(`${api}/api/returning-assistant/registrations`, {
      headers: { "content-type": "application/json", "idempotency-key": "returning-concurrent-a-0104", origin: ui },
      data: {
        commandId: "returning-concurrent-a-0104",
        admissionPeriodId,
        expectedRevision: 2,
        yearOfStudy: 4,
        mondayUnavailable: false,
        tuesdayUnavailable: false,
        wednesdayUnavailable: false,
        thursdayUnavailable: false,
        fridayUnavailable: false,
        positionWeeks: 4,
        preferredGroup: "all",
        language: "Engelsk",
        preferredSchool: null,
        teamInterest: false,
        teamIds: [],
      },
    }),
    context.request.post(`${api}/api/returning-assistant/registrations`, {
      headers: { "content-type": "application/json", "idempotency-key": "returning-concurrent-b-0104", origin: ui },
      data: {
        commandId: "returning-concurrent-b-0104",
        admissionPeriodId,
        expectedRevision: 2,
        yearOfStudy: 5,
        mondayUnavailable: false,
        tuesdayUnavailable: false,
        wednesdayUnavailable: false,
        thursdayUnavailable: false,
        fridayUnavailable: false,
        positionWeeks: 8,
        preferredGroup: "block-2",
        language: "Norsk",
        preferredSchool: null,
        teamInterest: false,
        teamIds: [],
      },
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status()).sort((a, b) => a - b), [200, 412]);
  const concurrentRows = await pool.query(
    "SELECT revision FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2 ORDER BY revision",
    [person.personId, admissionPeriodId],
  );
  assert.deepEqual(concurrentRows.rows, [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
  const returningOutbox = await pool.query(
    "SELECT effect_id,status,attempts FROM public.admission_application_outbox WHERE origin='ReturningAssistant' ORDER BY effect_id",
  );
  assert.equal(returningOutbox.rows.length, 12);
  const revokedBefore = await negativeMutationSnapshot(person.personId);
  const session = await pool.query('SELECT count(*)::int AS count FROM auth.session WHERE "userId"=$1', [person.personId]);
  assert.equal(session.rows[0].count, 1);
  await pool.query('DELETE FROM auth.session WHERE "userId"=$1', [person.personId]);
  const revokedReplay = await context.request.post(`${api}/api/returning-assistant/registrations`, {
    headers: {
      "content-type": "application/json",
      "idempotency-key": firstCommandKey,
      origin: ui,
    },
    data: firstReplayPayload,
  });
  assert.equal(revokedReplay.status(), 401);
  assert.deepEqual(await negativeMutationSnapshot(person.personId), revokedBefore);
  trace.push({ phase: "negative-gate", gate: "stale-revoked-auth", status: revokedReplay.status() });
  stage?.("returning:report");
  await page.goto(`${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${encodeURIComponent(admissionPeriodId)}`);
  await page.getByRole("heading", { level: 1, name: "Fullførte intervjuer" }).waitFor();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).getByText("Tilbakevendende").waitFor();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).getByText("Ja").waitFor();
  await page.reload();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).waitFor();
  await auditPage(page, "returning-report");
  await page.screenshot({ path: join(artifacts, "returning-report.png"), fullPage: true });
  stage?.("returning:cleanup");
  await returning.close();
  await context.close();
  await page.goto(`${ui}/dashboard/intervjuer`);
  return { trace };
};

export const runReturningAssistantLoginProbe = async ({
  browser,
  pool,
  api,
  ui,
  artifacts,
}: {
  readonly browser: Browser;
  readonly pool: Pool;
  readonly api: string;
  readonly ui: string;
  readonly artifacts: string;
}) => {
  const context = await browser.newContext();
  const probe = await context.newPage();
  const events: string[] = [];
  const dbSnapshot = async (label: string) => ({
    label,
    activity: (
      await pool.query(
        `SELECT pid,state,wait_event_type,wait_event,left(query,240) AS query
         FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
         ORDER BY pid`,
      )
    ).rows,
    locks: (
      await pool.query(
        `SELECT a.pid,l.locktype,l.mode,l.granted,left(a.query,240) AS query
         FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
         WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
         ORDER BY a.pid,l.locktype,l.mode`,
      )
    ).rows,
  });
  probe.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/login") || url.pathname.includes("/api/auth/"))
      events.push(`request ${request.method()} ${url.pathname}`);
  });
  probe.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes("/login") || url.pathname.includes("/api/auth/"))
      events.push(`response ${response.status()} ${url.pathname}`);
  });
  probe.on("console", (message) => events.push(`console ${message.type()}`));
  probe.on("pageerror", (error) => events.push(`pageerror ${error.message}`));
  const before = await dbSnapshot("before-login");
  await probe.goto(`${ui}/login?redirectTo=${encodeURIComponent("/dashboard/tidligere-assistenter")}`);
  await probe.getByLabel("E-post", { exact: true }).fill(person.email);
  await probe.getByLabel("Passord", { exact: true }).fill(person.password);
  await probe.screenshot({ path: join(artifacts, "returning-login-before.png"), fullPage: true });
  let click = "not-started";
  try {
    await probe.getByRole("button", { name: "Logg inn", exact: true }).click({
      timeout: 10_000,
      noWaitAfter: true,
    });
    click = "resolved";
  } catch (cause) {
    click = `error:${cause instanceof Error ? cause.name : typeof cause}`;
  }
  const afterClick = await dbSnapshot("after-click");
  let navigation = "not-started";
  try {
    await probe.waitForURL(/\/dashboard\/tidligere-assistenter$/, { timeout: 10_000 });
    navigation = "dashboard";
  } catch (cause) {
    navigation = `error:${cause instanceof Error ? cause.name : typeof cause}`;
  }
  const afterNavigation = await dbSnapshot("after-navigation");
  await probe.screenshot({ path: join(artifacts, "returning-login-after.png"), fullPage: true });
  const html = await probe.content().catch(() => "<unavailable>");
  await writeFile(
    join(artifacts, "returning-login-probe.html"),
    html.replaceAll(person.email, "[redacted]").replaceAll(person.password, "[redacted]"),
  );
  const result = { click, navigation, events, before, afterClick, afterNavigation, url: probe.url() };
  await writeFile(join(artifacts, "returning-login-probe.json"), JSON.stringify(result, null, 2));
  await context.close();
  return result;
};

const assertStatus = async (form: Locator, expected: string) => {
  await form.getByRole("status").filter({ hasText: expected }).waitFor();
};
const expectValue = async (field: Locator, expected: string) => {
  assert.equal(await field.inputValue(), expected);
};
