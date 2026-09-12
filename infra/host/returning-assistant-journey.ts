import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const fieldOfStudyId = "field-native-conduct-0063";
const applicantId = "applicant-returning-0104";
const applicationId = "application-returning-0104";
const placementId = `placement-${"a".repeat(64)}`;
const invitationId = "invitation-returning-0104";

export const returningAssistantFixture = {
  person,
  departmentId,
  semesterId,
  admissionPeriodId,
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
    IDENTITY_SEED_PERSONS: JSON.stringify([person]),
    NATIVE_IDENTITY_TRUSTED_ORIGINS: env.NATIVE_IDENTITY_TRUSTED_ORIGINS,
    NATIVE_IDENTITY_DEPLOYMENT: env.NATIVE_IDENTITY_DEPLOYMENT,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  }, join(root, "packages/database"));
  await pool.query(
    `BEGIN;
     INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
     VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING;
     INSERT INTO public.organization_volunteer_affiliation_audit(person_id,department_id,revision,action,actor_person_id,occurred_at)
     VALUES($1,$2,1,'Establish','journey-conduct-leader-0063','2026-01-04T00:00:00Z') ON CONFLICT DO NOTHING;
     INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest)
     VALUES($3,'rita.returning@example.invalid','rita.returning@example.invalid','Rita','Tilbake','90000104',0,$4,2,NULL) ON CONFLICT DO NOTHING;
     INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
     VALUES($5,$3,$6,$2,$4,2,'2026-08-20T10:00:00Z',0) ON CONFLICT DO NOTHING;
     INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
     VALUES($7,$5,$3,$8,'2026-12-31T00:00:00Z','Claimed','journey-conduct-leader-0063','2026-01-02T00:00:00Z') ON CONFLICT DO NOTHING;
     INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id)
     VALUES($3,$1,'2026-01-03T00:00:00Z',$7) ON CONFLICT DO NOTHING;
     INSERT INTO public.schools_directory_schools(name,contact_person,email,phone,language,active,revision)
     VALUES('Returning School','School Contact','school-returning@example.invalid','+47 900000106','Norwegian',true,0) ON CONFLICT DO NOTHING;
     COMMIT;`,
    [person.personId, departmentId, applicantId, fieldOfStudyId, applicationId, admissionPeriodId, invitationId, createHash("sha256").update(invitationId).digest("hex")],
  );
  const school = await pool.query("SELECT school_id FROM public.schools_directory_schools WHERE name='Returning School'");
  assert.equal(school.rows.length, 1);
  await pool.query("INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0) ON CONFLICT DO NOTHING", [school.rows[0].school_id, departmentId]);
  await pool.query(
    `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
     VALUES($1,$2,$3,$4,$5,'Monday',4,'1',true,1) ON CONFLICT DO NOTHING;
     INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot)
     VALUES($1,1,$2,'2026-01-04T00:00:00Z','Create',jsonb_build_object('placementId',$1,'personId',$2,'departmentId',$3,'semesterId',$4,'schoolId',$5,'day','Monday','workdays',4,'block','1','active',true,'revision',1)) ON CONFLICT DO NOTHING;`,
    [placementId, person.personId, departmentId, semesterId, school.rows[0].school_id],
  );
  await pool.query(
    `INSERT INTO public.recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision)
     VALUES('interview-returning-0104',$1,$2,'journey-returning-assistant-0104','interview-schema-native-conduct-0063','journey-conduct-leader-0063','2026-08-21T10:00:00Z',1) ON CONFLICT DO NOTHING;
     INSERT INTO public.recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,help_text,kind,alternatives)
     SELECT 'interview-returning-0104',question_id,ordinal,prompt,help_text,kind,alternatives
     FROM public.recruitment_interview_schema_questions
     WHERE interview_schema_id='interview-schema-native-conduct-0063'
     ON CONFLICT DO NOTHING;
     INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation)
     VALUES('interview-returning-0104','[]'::jsonb,8,8,8,'journey-conduct-leader-0063','2026-08-22T10:00:00Z',1,'Ja') ON CONFLICT DO NOTHING;`,
    [applicationId, departmentId],
  );
  const counts = await pool.query(
    `SELECT (SELECT count(*)::int FROM public.applicant_account_links WHERE person_id=$1) links,
            (SELECT count(*)::int FROM public.assistant_placements WHERE person_id=$1) placements`,
    [person.personId],
  );
  assert.deepEqual(counts.rows[0], { links: 1, placements: 1 });
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
}: {
  readonly browser: Browser;
  readonly page: Page;
  readonly pool: Pool;
  readonly api: string;
  readonly ui: string;
  readonly artifacts: string;
  readonly auditPage: (page: Page, state: string) => Promise<void>;
  readonly errors: string[];
}) => {
  const context = await browser.newContext();
  const returning = await context.newPage();
  returning.on("pageerror", (error: Error) => errors.push(`returning:${error.message}`));
  const destination = "/dashboard/tidligere-assistenter";
  await returning.goto(`${ui}/login?redirectTo=${encodeURIComponent(destination)}`);
  await returning.getByLabel("E-post", { exact: true }).fill(person.email);
  await returning.getByLabel("Passord", { exact: true }).fill(person.password);
  await returning.getByRole("button", { name: "Logg inn", exact: true }).click();
  await returning.waitForURL(/\/dashboard\/tidligere-assistenter$/);
  const form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await form.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(admissionPeriodId);
  await form.getByRole("combobox", { name: "Studieår" }).selectOption("2");
  await form.getByLabel("Mandag").check();
  await form.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk");
  await form.getByRole("button", { name: "Registrer for semesteret" }).click();
  await assertStatus(form, "Registreringen er lagret.");
  await returning.reload();
  const reloaded = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await expectValue(reloaded.getByRole("combobox", { name: "Studieår" }), "2");
  await expectValue(reloaded.getByRole("combobox", { name: "Språk" }), "Norsk og engelsk");
  await reloaded.getByRole("combobox", { name: "Studieår" }).selectOption("3");
  await reloaded.getByRole("combobox", { name: "Språk" }).selectOption("Engelsk");
  await reloaded.getByRole("button", { name: "Lagre endringer" }).click();
  await assertStatus(reloaded, "Registreringen er lagret.");
  await returning.reload();
  await expectValue(returning.getByRole("combobox", { name: "Studieår" }), "3");
  await expectValue(returning.getByRole("combobox", { name: "Språk" }), "Engelsk");
  await auditPage(returning, "returning-registration");
  const registrations = await pool.query("SELECT revision,year_of_study,language FROM public.admission_returning_registrations WHERE person_id=$1 ORDER BY revision", [person.personId]);
  assert.deepEqual(registrations.rows, [
    { revision: 1, year_of_study: 2, language: "Norsk og engelsk" },
    { revision: 2, year_of_study: 3, language: "Engelsk" },
  ]);
  const pendingOutbox = await pool.query("SELECT count(*)::int AS count FROM public.admission_application_outbox WHERE origin='ReturningAssistant' AND status='Pending'");
  assert.equal(pendingOutbox.rows[0].count, 6);
  const session = await pool.query('SELECT count(*)::int AS count FROM auth.session WHERE "userId"=$1', [person.personId]);
  assert.equal(session.rows[0].count, 1);
  await pool.query('DELETE FROM auth.session WHERE "userId"=$1', [person.personId]);
  const replay = await context.request.post(`${api}/api/returning-assistant/registrations`, {
    headers: { "content-type": "application/json", "idempotency-key": "returning-browser-registration-0104-replay", origin: ui },
    data: { commandId: "returning-browser-registration-0104-replay", admissionPeriodId, expectedRevision: 2, yearOfStudy: 3, mondayUnavailable: true, tuesdayUnavailable: false, wednesdayUnavailable: false, thursdayUnavailable: false, fridayUnavailable: false, positionWeeks: 4, preferredGroup: "all", language: "Engelsk", preferredSchool: null, teamInterest: false, teamIds: [] },
  });
  assert.equal(replay.status(), 401);
  await page.goto(`${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${encodeURIComponent(admissionPeriodId)}`);
  await page.getByRole("heading", { level: 1, name: "Fullførte intervjuer" }).waitFor();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).getByText("Tilbakevendende").waitFor();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).getByText("Ja").waitFor();
  await page.reload();
  await page.getByRole("row").filter({ hasText: "Rita Tilbake" }).waitFor();
  await auditPage(page, "returning-report");
  await page.screenshot({ path: join(artifacts, "returning-report.png"), fullPage: true });
  await returning.close();
  await context.close();
  await page.goto(`${ui}/dashboard/intervjuer`);
};

const assertStatus = async (form: Locator, expected: string) => {
  await form.getByRole("status").filter({ hasText: expected }).waitFor();
};
const expectValue = async (field: Locator, expected: string) => {
  assert.equal(await field.inputValue(), expected);
};
