import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Browser, Locator, Page } from "@playwright/test";
import { AdmissionFieldOfStudyId } from "../../packages/domain/src/admission-period/schema.js";
import { publicApplicationCommandDigest } from "../../packages/domain/src/application/digest.js";
import {
  PublicApplicationCommandIdSchema,
  PublicApplicationEmailSchema,
  PublicApplicationGenderSchema,
  PublicApplicationNameSchema,
  PublicApplicationPhoneSchema,
  PublicApplicationYearOfStudySchema,
} from "../../packages/domain/src/application/schema.js";
import { DepartmentId } from "../../packages/domain/src/organization/schema.js";

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
const originalPublicCommandId = "public-original-returning-0104";
const originalActivationDigest = createHash("sha256")
  .update("historical-public-activation-returning-0104")
  .digest("hex");
const originalPublicCommand = {
  _tag: "SubmitPublicApplication" as const,
  commandId: PublicApplicationCommandIdSchema.make(originalPublicCommandId),
  departmentId: DepartmentId.make(departmentId),
  firstName: PublicApplicationNameSchema.make("Rita"),
  lastName: PublicApplicationNameSchema.make("Tilbake"),
  phone: PublicApplicationPhoneSchema.make("90000104"),
  email: PublicApplicationEmailSchema.make("rita.returning@example.invalid"),
  gender: PublicApplicationGenderSchema.make(0),
  fieldOfStudyId: AdmissionFieldOfStudyId.make(fieldOfStudyId),
  yearOfStudy: PublicApplicationYearOfStudySchema.make(2),
} as const;
const originalPublicCommandDigest = publicApplicationCommandDigest(originalPublicCommand);
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
       VALUES($1,'rita.returning@example.invalid','rita.returning@example.invalid','Rita','Tilbake','90000104',0,$2,2,$3) ON CONFLICT DO NOTHING`,
      [applicantId, fieldOfStudyId, originalActivationDigest],
    );
    await seedQuery("application", 
      `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
       VALUES($1,$2,$3,$4,$5,2,'2026-08-20T10:00:00Z',0) ON CONFLICT DO NOTHING`,
      [applicationId, applicantId, admissionPeriodId, departmentId, fieldOfStudyId],
    );
    await seedQuery(
      "original public receipt",
      `INSERT INTO public.admission_application_command_receipts(
         command_id,command_sha256,command_json,observation_json,application_id,committed_at
       ) VALUES(
         $1::text,$2::text,
         jsonb_build_object(
           '_tag','SubmitPublicApplication',
           'commandId',$1::text,
           'departmentId',$3::text,
           'firstName',$4::text,
           'lastName',$5::text,
           'phone',$6::text,
           'email',$7::text,
           'gender',$8::int,
           'fieldOfStudyId',$9::text,
           'yearOfStudy',$10::int
         ),
         jsonb_build_object('_tag','Submitted','commandId',$1::text,'applicationId',$11::text),
         $11::text,'2026-08-20T10:00:00Z'
       ) ON CONFLICT DO NOTHING`,
      [
        originalPublicCommandId,
        originalPublicCommandDigest,
        departmentId,
        originalPublicCommand.firstName,
        originalPublicCommand.lastName,
        originalPublicCommand.phone,
        originalPublicCommand.email,
        originalPublicCommand.gender,
        fieldOfStudyId,
        originalPublicCommand.yearOfStudy,
        applicationId,
      ],
    );
    await seedQuery(
      "original public audit",
      `INSERT INTO public.admission_application_audit(
         command_id,application_id,applicant_id,action,application_revision,occurred_at
       ) VALUES($1,$2,$3,'PublicApplicationSubmitted',0,'2026-08-20T10:00:00Z')
       ON CONFLICT DO NOTHING`,
      [originalPublicCommandId, applicationId, applicantId],
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
  coordinatorEmail,
  coordinatorPassword,
  readInvitationCapability,
  deliverRecruitmentInvitation,
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
  readonly coordinatorEmail: string;
  readonly coordinatorPassword: string;
  readonly readInvitationCapability?: (interviewId: string) => string | undefined;
  readonly deliverRecruitmentInvitation?: (claimId: string) => Promise<{
    readonly _tag: "Delivered" | "Idle" | "Failed";
    readonly claim?: { readonly effectId: string };
  }>;
}) => {
  const trace: Array<Record<string, unknown>> = [];
  try {
  stage?.("returning:browser.newContext");
  const context = await browser.newContext();
  const responses: string[] = [];
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
  returning.on("framenavigated", (frame) => {
    if (frame === returning.mainFrame())
      responses.push(`navigation ${new URL(frame.url()).pathname}`);
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
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    await writeFile(join(artifacts, "returning-registration-trace.json"), JSON.stringify(trace, null, 2));
    throw new Error(
      `returning ${phase} failed phase=browser-action kind=${kind} cause=${causeMessage} url=${returning.url()} responses=${responses.join(" | ")}`,
      { cause },
    );
  };
  returning.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.startsWith("/dashboard/tidligere-assistenter")) {
      const body = new URLSearchParams(request.postData() ?? "");
      const row = {
        phase: "dashboard-post",
        form: [...body.entries()],
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
  const waitForDashboardAction = async (periodId: string, trigger: () => Promise<void>) => {
    const responsePromise = returning.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "POST"
          || !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(url.pathname)
        )
          return false;
        const body = new URLSearchParams(response.request().postData() ?? "");
        return body.get("admissionPeriodId") === periodId;
      },
      { timeout: 30_000 },
    );
    await trigger();
    const response = await responsePromise;
    await response.finished();
    assert.equal(response.status(), 200);
    const body = new URLSearchParams(response.request().postData() ?? "");
    return {
      phase: "dashboard-post",
      form: [...body.entries()],
      admissionPeriodId: body.get("admissionPeriodId"),
      expectedRevision: body.get("expectedRevision"),
      commandId: body.get("commandId"),
    };
  };
  const waitForActionReady = async (form: Locator) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await form.locator('button[type="submit"]').isEnabled()
        && (await form.getAttribute("data-pending")) === "false"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("returning form did not become ready for action");
  };
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
  assert.equal(browserOptions.status, 200);
  trace.push({ phase: "options-probe", status: browserOptions.status });
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
        SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.command_id)
        FROM public.admission_application_audit audit
        WHERE audit.application_id=application.application_id
      ), '[]'::jsonb) AS public_audit,
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
  const originalCustodyRow = originalCustody.rows[0] as {
    activation_digest: string;
    public_receipts: ReadonlyArray<unknown>;
    public_audit: ReadonlyArray<unknown>;
  };
  assert.notEqual(originalCustodyRow.activation_digest, null);
  assert.notEqual(originalCustodyRow.activation_digest, "");
  assert.ok(originalCustodyRow.public_receipts.length > 0);
  assert.ok(originalCustodyRow.public_audit.length > 0);
  let form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  stage?.("returning:form");
  try {
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
  let firstCommittedRow: unknown;
  try {
    stage?.("returning:mutation:first:click");
    await submit.click();
    stage?.("returning:mutation:first:await");
    await firstActionSettled;
    stage?.("returning:mutation:first:settled");
    const firstCommittedBeforeRetry = await pool.query(
      `SELECT *
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision`,
      [person.personId, nextAdmissionPeriodId],
    );
    assert.ok(firstCommandKey);
    assert.equal(firstCommittedBeforeRetry.rows.length, 1);
    firstCommittedRow = firstCommittedBeforeRetry.rows[0];
    trace.push({ phase: "first-before-retry", sqlCommitted: firstCommittedBeforeRetry.rows });
    stage?.("returning:mutation:recovery");
    const recovery = returning.getByRole("button", { name: "Prøv igjen", exact: true });
    const hasRecoveryControl = await recovery
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const firstRequest = trace.find((entry) => entry.phase === "first");
    assert.ok(firstRequest && Array.isArray(firstRequest.form));
    const assertRecoveredIntent = async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const restoredEntries = await form.evaluate(
            (node) => [...new FormData(node as HTMLFormElement)].map(([name, value]) => [name, String(value)]),
            undefined,
          );
          if (JSON.stringify(restoredEntries) !== JSON.stringify(firstRequest.form))
            throw new Error(`recovered form intent mismatch actual=${JSON.stringify(restoredEntries)} expected=${JSON.stringify(firstRequest.form)}`);
          const recoveredCommandId = await form.locator('input[name="commandId"]').inputValue();
          if (recoveredCommandId !== firstCommandKey)
            throw new Error(`recovered command id mismatch actual=${recoveredCommandId} expected=${firstCommandKey}`);
          const recoveredRevision = await form.locator('input[name="expectedRevision"]').inputValue();
          if (recoveredRevision !== firstExpectedRevision)
            throw new Error(`recovered base revision mismatch actual=${recoveredRevision} expected=${firstExpectedRevision}`);
          return;
        } catch (cause) {
          lastError = cause;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw lastError;
    };
    if (hasRecoveryControl) await recovery.click();
    form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    await form.waitFor({ state: "visible" });
    submit = form.locator('button[type="submit"]');
    await submit.waitFor({ state: "visible" });
    assert.equal(await submit.isEnabled(), true);
    assert.equal(await form.getAttribute("data-pending"), "false");
    await assertRecoveredIntent();
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
  const captureCommitted = async (phase: string, periodId: string) => {
    const committed = await pool.query(
      `SELECT *
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision`,
      [person.personId, periodId],
    );
    trace.push({ phase, sqlCommitted: committed.rows });
    await writeFile(join(artifacts, "returning-registration-trace.json"), JSON.stringify(trace, null, 2));
  };
  const afterRetryCommitted = await pool.query(
    `SELECT *
     FROM public.admission_returning_registrations
     WHERE person_id=$1 AND admission_period_id=$2
     ORDER BY revision`,
    [person.personId, nextAdmissionPeriodId],
  );
  assert.equal(afterRetryCommitted.rows.length, 1);
  assert.deepEqual(afterRetryCommitted.rows[0], firstCommittedRow);
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
  await reloaded.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(admissionPeriodId);
  await returning.waitForURL(
    new RegExp(`/dashboard/tidligere-assistenter\\?admissionPeriodId=${admissionPeriodId}$`),
  );
  for (let attempt = 0; attempt < 100 && !(await reloaded.getByRole("combobox", { name: "Opptaksperiode" }).isEnabled()); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await reloaded.getByRole("combobox", { name: "Studieår" }).selectOption("2");
  await reloaded.getByLabel("Torsdag", { exact: true }).uncheck();
  await reloaded.getByRole("combobox", { name: "Stillingslengde" }).selectOption("4");
  await reloaded.getByRole("combobox", { name: "Semesterblokk" }).selectOption("all");
  await reloaded.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk");
  await reloaded.getByLabel("Ønsket skole (valgfritt)", { exact: true }).fill("");
  await reloaded.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).uncheck();
  await reloaded.locator(`input[name="teamIds"][value="${teamId}"]`).uncheck();
  const nativePost = await waitForDashboardAction(admissionPeriodId, async () => {
    await waitForActionReady(reloaded);
    await reloaded.locator('button[type="submit"]').click();
  });
  assert.equal(nativePost.admissionPeriodId, admissionPeriodId);
  assert.equal(nativePost.expectedRevision, "0");
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
  const updatePost = await waitForDashboardAction(admissionPeriodId, async () => {
    await waitForActionReady(existing);
    await existing.getByRole("button", { name: "Lagre endringer" }).click();
  });
  assert.equal(updatePost.admissionPeriodId, admissionPeriodId);
  assert.equal(updatePost.expectedRevision, "1");
  try {
    await assertStatus(existing, "Registreringen er lagret.");
  } catch (cause) {
    await captureReturningFailure("update-status", cause);
  }
  await captureCommitted("existing-period-after-update", admissionPeriodId);
  await returning.reload();
  const updated = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
  await expectValue(updated.getByRole("combobox", { name: "Opptaksperiode" }), admissionPeriodId);
  stage?.("returning:period-history");
  const periodSelector = updated.getByRole("combobox", { name: "Opptaksperiode" });
  const waitForPeriodUrl = async (periodId: string) => {
    await returning.waitForURL(
      new RegExp(`/dashboard/tidligere-assistenter\\?admissionPeriodId=${periodId}$`),
    );
  };
  const waitForPeriodForm = async (periodId: string) => {
    let actual = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
      const selector = candidate.getByRole("combobox", { name: "Opptaksperiode" });
      actual = await selector.inputValue();
      if (actual === periodId && (await selector.isEnabled())) return candidate;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`period form did not settle actual=${JSON.stringify(actual)} expected=${JSON.stringify(periodId)}`);
  };
  await periodSelector.selectOption(nextAdmissionPeriodId);
  await waitForPeriodUrl(nextAdmissionPeriodId);
  let periodForm = await waitForPeriodForm(nextAdmissionPeriodId);
  await expectValue(periodForm.getByRole("combobox", { name: "Opptaksperiode" }), nextAdmissionPeriodId);
  await expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
  await expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
  await expectValue(periodForm.getByRole("combobox", { name: "Stillingslengde" }), "8");
  await periodSelector.selectOption(admissionPeriodId);
  await waitForPeriodUrl(admissionPeriodId);
  periodForm = await waitForPeriodForm(admissionPeriodId);
  await expectValue(periodForm.getByRole("combobox", { name: "Opptaksperiode" }), admissionPeriodId);
  await expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
  await expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "3");
  await expectValue(periodForm.getByRole("combobox", { name: "Språk" }), "Engelsk");
  await returning.goBack();
  await waitForPeriodUrl(nextAdmissionPeriodId);
  periodForm = await waitForPeriodForm(nextAdmissionPeriodId);
  await expectValue(periodForm.getByRole("combobox", { name: "Opptaksperiode" }), nextAdmissionPeriodId);
  await expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
  await expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
  await returning.goForward();
  await waitForPeriodUrl(admissionPeriodId);
  periodForm = await waitForPeriodForm(admissionPeriodId);
  await expectValue(periodForm.getByRole("combobox", { name: "Opptaksperiode" }), admissionPeriodId);
  await expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
  await periodSelector.selectOption(nextAdmissionPeriodId);
  await waitForPeriodUrl(nextAdmissionPeriodId);
  periodForm = await waitForPeriodForm(nextAdmissionPeriodId);
  await expectValue(periodForm.getByRole("combobox", { name: "Opptaksperiode" }), nextAdmissionPeriodId);
  await expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
  await expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
  stage?.("returning:registration-conflict");
  assert.equal(await periodForm.locator('input[name="expectedRevision"]').inputValue(), "1");
  assert.equal(await periodForm.locator('input[name="commandId"]').inputValue(), "");
  await periodForm.getByRole("combobox", { name: "Studieår" }).selectOption("5");
  const staleContext = await browser.newContext({ storageState: await context.storageState() });
  const staleReturning = await staleContext.newPage();
  try {
    await staleReturning.goto(
      `${ui}/dashboard/tidligere-assistenter?admissionPeriodId=${encodeURIComponent(nextAdmissionPeriodId)}`,
    );
    const staleForm = staleReturning.getByRole("form", { name: "Registrer som tidligere assistent" });
    await staleForm.waitFor({ state: "visible" });
    assert.equal(
      await staleForm.locator('input[name="expectedRevision"]').inputValue(),
      "1",
    );
    await staleForm.getByRole("combobox", { name: "Studieår" }).selectOption("5");
    const staleSaveResponsePromise = staleReturning.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "POST"
          || !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(url.pathname)
        )
          return false;
        return new URLSearchParams(response.request().postData() ?? "").get("admissionPeriodId") === nextAdmissionPeriodId;
      },
      { timeout: 30_000 },
    );
    await staleForm.getByRole("button", { name: "Lagre endringer" }).click();
    const staleSaveResponse = await staleSaveResponsePromise;
    await staleSaveResponse.finished();
    assert.equal(staleSaveResponse.status(), 200);
    const staleSavePost = new URLSearchParams(staleSaveResponse.request().postData() ?? "");
    assert.equal(staleSavePost.get("expectedRevision"), "1");
    assert.equal(typeof staleSavePost.get("commandId"), "string");
    assert.notEqual(staleSavePost.get("commandId"), "");
    const afterStaleSave = await pool.query(
      `SELECT revision,year_of_study
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision DESC
       LIMIT 1`,
      [person.personId, nextAdmissionPeriodId],
    );
    assert.deepEqual(afterStaleSave.rows, [{ revision: 2, year_of_study: 5 }]);
    const staleDraftResponsePromise = returning.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "POST"
          || !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(url.pathname)
        )
          return false;
        return new URLSearchParams(response.request().postData() ?? "").get("admissionPeriodId") === nextAdmissionPeriodId;
      },
      { timeout: 30_000 },
    );
    await waitForActionReady(periodForm);
    await periodForm.getByRole("button", { name: "Lagre endringer" }).click();
    const staleDraftResponse = await staleDraftResponsePromise;
    await staleDraftResponse.finished();
    assert.equal(staleDraftResponse.status(), 412);
    const staleDraftPost = new URLSearchParams(staleDraftResponse.request().postData() ?? "");
    const staleDraftCommandId = staleDraftPost.get("commandId");
    assert.equal(staleDraftPost.get("expectedRevision"), "1");
    assert.equal(typeof staleDraftCommandId, "string");
    assert.notEqual(staleDraftCommandId, "");
    assert.notEqual(staleDraftCommandId, staleSavePost.get("commandId"));
    await periodForm.getByRole("alert").filter({ hasText: "Alternativene er endret." }).waitFor();
    assert.equal(await periodForm.locator('input[name="expectedRevision"]').inputValue(), "1");
    assert.equal(await periodForm.getByRole("combobox", { name: "Studieår" }).inputValue(), "5");
    assert.equal(await periodForm.locator('input[name="commandId"]').inputValue(), staleDraftCommandId);
    trace.push({
      phase: "negative-gate",
      gate: "returning-stale-draft",
      status: 412,
      expectedRevision: staleDraftPost.get("expectedRevision"),
      commandId: staleDraftPost.get("commandId"),
      draftYearOfStudy: await periodForm.getByRole("combobox", { name: "Studieår" }).inputValue(),
    });
    await periodForm.getByRole("button", { name: "Forkast lagret utkast" }).click();
    await returning.waitForLoadState("domcontentloaded");
    periodForm = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    await periodForm.waitFor({ state: "visible" });
    await expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
    await expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "5");
    const recoveredCommandId = await periodForm.locator('input[name="commandId"]').inputValue();
    assert.equal(recoveredCommandId, "");
    const recoveredPost = await waitForDashboardAction(nextAdmissionPeriodId, async () => {
      await waitForActionReady(periodForm);
      await periodForm.getByRole("button", { name: "Lagre endringer" }).click();
    });
    assert.equal(recoveredPost.expectedRevision, "2");
    assert.notEqual(recoveredPost.commandId, staleDraftPost.get("commandId"));
    await assertStatus(periodForm, "Registreringen er lagret.");
  } finally {
    await staleReturning.close();
    await staleContext.close();
  }
  const nextPeriodRevision = await pool.query(
    `SELECT revision,year_of_study
     FROM public.admission_returning_registrations
     WHERE person_id=$1 AND admission_period_id=$2
     ORDER BY revision DESC
     LIMIT 1`,
    [person.personId, nextAdmissionPeriodId],
  );
  assert.deepEqual(nextPeriodRevision.rows, [{ revision: 3, year_of_study: 5 }]);
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
        SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.command_id)
        FROM public.admission_application_audit audit
        WHERE audit.application_id=application.application_id
      ), '[]'::jsonb) AS public_audit,
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
  assert.equal(finalCustody.rows[0]?.activation_digest, originalActivationDigest);
  assert.ok((finalCustody.rows[0]?.public_receipts as ReadonlyArray<unknown>).length > 0);
  assert.ok((finalCustody.rows[0]?.public_audit as ReadonlyArray<unknown>).length > 0);
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
  const ordinaryConduct = await pool.query(
    `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-native-conduct-a-0063'`,
  );
  if (ordinaryConduct.rows.length === 0) {
    await page.goto(`${ui}/dashboard/intervjuer`);
    await page.getByRole("heading", { name: "Planlegg intervjuer", exact: true }).waitFor();
    const ordinaryCard = page.getByRole("article").filter({ hasText: "Sofie Gjennomfører" });
    await ordinaryCard.getByRole("button", { name: "Åpne intervju", exact: true }).click();
    await page.getByRole("heading", { name: "Intervju med Sofie Gjennomfører", exact: true }).waitFor();
    await page.locator("#question-interview-schema-native-conduct-0063-q0").fill(
      "Jeg vil forklare matematikk tydelig.",
    );
    await page.locator("#question-interview-schema-native-conduct-0063-q1-1").check();
    await page.locator("#question-interview-schema-native-conduct-0063-q2-0").check();
    await page.locator("#question-interview-schema-native-conduct-0063-q3-0").check();
    for (const axis of ["explanatoryPower", "roleModel", "suitability"])
      await page.locator(`#score-${axis}`).selectOption("8");
    await page.locator("#interviewer-recommendation").selectOption("Ja");
    await page.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Fullfør intervju", exact: true })
      .press("Enter");
    await page.getByText("Intervjuet er fullført.", { exact: true }).waitFor();
    await page.reload();
  }
  const ordinaryAfter = await pool.query(
    `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-native-conduct-a-0063'`,
  );
  assert.deepEqual(ordinaryAfter.rows, [
    { recommendation: "Ja", explanatory_power: 8, role_model: 8, suitability: 8 },
  ]);
  trace.push({
    phase: "native-period-ordinary-conduct",
    interviewId: "interview-native-conduct-a-0063",
    recommendation: "Ja",
    total: 24,
  });
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
  const concurrentDetails = await Promise.all(
    concurrent.map(async (response) => ({ status: response.status(), body: await response.text() })),
  );
  assert.deepEqual(
    concurrentDetails.map(({ status }) => status).sort((left, right) => left - right),
    [201, 412],
    JSON.stringify(concurrentDetails),
  );
  const concurrentRows = await pool.query(
    "SELECT revision FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2 ORDER BY revision",
    [person.personId, admissionPeriodId],
  );
  assert.deepEqual(concurrentRows.rows, [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
  stage?.("returning:next-period-assignment");
  const nextApplication = await pool.query(
    `SELECT application_id
     FROM public.admission_applications
     WHERE applicant_id=$1 AND admission_period_id=$2`,
    [applicantId, nextAdmissionPeriodId],
  );
  assert.equal(nextApplication.rows.length, 1);
  const nextApplicationId = nextApplication.rows[0].application_id as string;
  const assignmentPayload = {
    interviewerPersonId: "journey-conduct-leader-0063",
    interviewSchemaId: "interview-schema-native-conduct-0063",
  };
  const assignmentPath = `${api}/api/recruitment/applications/${encodeURIComponent(nextApplicationId)}/interviews`;
  const ambiguousAssignment = await page.request.post(assignmentPath, {
    headers: {
      "content-type": "application/json",
      "idempotency-key": "returning-next-assignment-ambiguous-0104",
      origin: ui,
    },
    data: assignmentPayload,
  });
  const ambiguousBodyText = await ambiguousAssignment.text();
  assert.equal(ambiguousAssignment.status(), 403);
  const ambiguousBody = JSON.parse(ambiguousBodyText) as {
    readonly code?: unknown;
    readonly status?: unknown;
  };
  assert.equal(ambiguousBody.code, "authority.denied");
  const assignmentPeriodContext = await pool.query(
    `SELECT
       p.admission_period_id,
       p.start_at,
       p.end_at,
       s.start_at AS semester_start_at,
       s.end_at AS semester_end_at,
       p.start_at <= statement_timestamp() AND statement_timestamp() < p.end_at
         AND s.start_at <= statement_timestamp() AND statement_timestamp() < s.end_at AS eligible_now
     FROM public.admission_periods p
     JOIN public.admission_period_semesters s USING (semester_id)
     WHERE p.department_id=$1
     ORDER BY p.admission_period_id`,
    [departmentId],
  );
  trace.push({
    phase: "negative-gate",
    gate: "next-assignment-requires-one-open-period",
    status: 403,
    problemCode: ambiguousBody.code,
    problemStatus: ambiguousBody.status,
    body: ambiguousBodyText,
    source:
      "assignmentInTransaction currentPeriod scope check (packages/domain/src/recruitment/postgres.ts:850-857) maps RecruitmentScopeDenied to authority.denied (apps/backend/src/recruitment/http.ts:251-255)",
    periodContext: assignmentPeriodContext.rows,
  });
  // Model the legitimate semester transition: the old period ends at a valid
  // instant and remains closed while the next period becomes authoritative.
  await pool.query(
    "UPDATE public.admission_periods SET end_at='2026-09-12T00:00:00Z' WHERE admission_period_id=$1",
    [admissionPeriodId],
  );
  const postClosePeriodContext = await pool.query(
    `SELECT
       p.admission_period_id,
       p.start_at,
       p.end_at,
       s.start_at AS semester_start_at,
       s.end_at AS semester_end_at,
       p.start_at <= statement_timestamp() AND statement_timestamp() < p.end_at
         AND s.start_at <= statement_timestamp() AND statement_timestamp() < s.end_at AS eligible_now
     FROM public.admission_periods p
     JOIN public.admission_period_semesters s USING (semester_id)
     WHERE p.department_id=$1
     ORDER BY p.admission_period_id`,
    [departmentId],
  );
  assert.deepEqual(
    postClosePeriodContext.rows.map((row: { admission_period_id: string; eligible_now: boolean }) => ({
      admission_period_id: row.admission_period_id,
      eligible_now: row.eligible_now,
    })),
    [
      { admission_period_id: admissionPeriodId, eligible_now: false },
      { admission_period_id: nextAdmissionPeriodId, eligible_now: true },
    ],
  );
  const resolvedCoordinator = await pool.query(
    `SELECT
       membership.person_id,
       membership.team_id,
       membership.is_team_leader,
       membership.is_suspended,
       team.department_id,
       team.active AS team_active,
       department.active AS department_active
     FROM public.organization_memberships membership
     JOIN public.organization_teams team USING (team_id)
     JOIN public.organization_departments department USING (department_id)
     WHERE membership.person_id=$1
       AND membership.start_at <= statement_timestamp()
       AND (membership.end_at IS NULL OR statement_timestamp() < membership.end_at)
       AND membership.is_team_leader
       AND NOT membership.is_suspended
       AND team.active
       AND department.active
     ORDER BY membership.membership_id`,
    ["report-coordinator-0103"],
  );
  assert.deepEqual(resolvedCoordinator.rows, [
    {
      person_id: "report-coordinator-0103",
      team_id: teamId,
      is_team_leader: true,
      is_suspended: false,
      department_id: departmentId,
      team_active: true,
      department_active: true,
    },
  ]);
  trace.push({
    phase: "assignment-authority-resolved",
    coordinatorPersonId: "report-coordinator-0103",
    coordinatorEmail,
    coordinatorRole: "DepartmentLeader",
    assignedInterviewerPersonId: assignmentPayload.interviewerPersonId,
    coordinatorContext: resolvedCoordinator.rows,
    postClosePeriodContext: postClosePeriodContext.rows,
  });
  const assignmentCommandId = "returning-next-assignment-0104";
  const coordinatorContext = await browser.newContext();
  let assignmentStatus!: number;
  let assignmentBodyText!: string;
  let assignmentETag!: string;
  let nextInterviewId!: string;
  try {
    stage?.("returning:next-period-assignment:coordinator-login");
    const coordinatorPage = await coordinatorContext.newPage();
    await coordinatorPage.goto(`${ui}/login`);
    await coordinatorPage.getByLabel("E-post", { exact: true }).fill(coordinatorEmail);
    await coordinatorPage.getByLabel("Passord", { exact: true }).fill(coordinatorPassword);
    await coordinatorPage.getByRole("button", { name: "Logg inn", exact: true }).click();
    await coordinatorPage.waitForURL(/\/dashboard\/?$/);
    const assignmentResponse = await coordinatorPage.request.post(assignmentPath, {
      headers: {
        "content-type": "application/json",
        "idempotency-key": assignmentCommandId,
        origin: ui,
      },
      data: assignmentPayload,
    });
    assignmentStatus = assignmentResponse.status();
    assignmentBodyText = await assignmentResponse.text();
    assignmentETag = assignmentResponse.headers()["etag"] ?? "";
    if (assignmentStatus !== 201) {
      const assignmentActorContext = await pool.query(
        `SELECT
           membership.person_id,
           membership.team_id,
           membership.start_at,
           membership.end_at,
           membership.is_team_leader,
           membership.is_suspended,
           team.department_id,
           team.active AS team_active,
           department.active AS department_active
         FROM public.organization_memberships membership
         JOIN public.organization_teams team USING (team_id)
         JOIN public.organization_departments department USING (department_id)
         WHERE membership.person_id=$1
         ORDER BY membership.membership_id`,
        ["report-coordinator-0103"],
      );
      trace.push({
        phase: "assignment-failure",
        status: assignmentStatus,
        body: assignmentBodyText,
        source:
          "assignment preflight reads target actor/interviewer eligibility in apps/backend/src/recruitment/http.ts:1008-1052; domain assignment then checks current period and live membership in packages/domain/src/recruitment/postgres.ts:843-931",
        actorContext: assignmentActorContext.rows,
      });
      throw new Error(`next assignment failed ${assignmentStatus} ${assignmentBodyText}`);
    }
    const assignmentBody = JSON.parse(assignmentBodyText) as {
      interviewId?: string;
      applicationId?: string;
    };
    assert.equal(assignmentBody.applicationId, nextApplicationId);
    assert.equal(typeof assignmentBody.interviewId, "string");
    nextInterviewId = assignmentBody.interviewId!;
    const assignmentRow = await pool.query(
      `SELECT interview_id,application_id,interviewer_person_id,revision
       FROM public.recruitment_interviews
       WHERE interview_id=$1`,
      [nextInterviewId],
    );
    assert.deepEqual(assignmentRow.rows, [
      {
        interview_id: nextInterviewId,
        application_id: nextApplicationId,
        interviewer_person_id: "journey-conduct-leader-0063",
        revision: 0,
      },
    ]);
    stage?.("returning:next-period-schedule");
    assert.ok(assignmentETag);
    const assignedETag = assignmentETag;
    const scheduleResponse = await coordinatorPage.request.post(
      `${api}/api/recruitment/interviews/${encodeURIComponent(nextInterviewId)}:schedule`,
      {
        headers: {
          "content-type": "application/json",
          "idempotency-key": "returning-next-schedule-0104",
          "if-match": assignedETag,
          origin: ui,
        },
        data: {
          scheduledAt: "2026-09-20T10:00:00.000Z",
          room: "Returning Room 0104",
          campus: "Gløshaugen",
          mapLink: "https://maps.example.invalid/returning-next-0104",
          message: "Vi ser frem til intervjuet.",
        },
      },
    );
    const scheduleBodyText = await scheduleResponse.text();
    if (scheduleResponse.status() !== 200) {
      throw new Error(`next interview schedule failed ${scheduleResponse.status()} ${scheduleBodyText}`);
    }
    const scheduleBody = JSON.parse(scheduleBodyText) as {
      interviewId: string;
      responseState: string;
      notificationState: string;
      schedule: { scheduleRevision: number; scheduledAt: string };
    };
    assert.equal(scheduleBody.interviewId, nextInterviewId);
    assert.equal(scheduleBody.responseState, "Pending");
    assert.equal(scheduleBody.notificationState, "Pending");
    assert.equal(scheduleBody.schedule.scheduleRevision, 1);
    assert.equal(scheduleBody.schedule.scheduledAt, "2026-09-20T10:00:00.000Z");
    trace.push({
      phase: "returning:native-schedule",
      actorPersonId: "report-coordinator-0103",
      interviewId: nextInterviewId,
      assignmentETag: assignedETag,
      scheduleStatus: scheduleResponse.status(),
      scheduledAt: scheduleBody.schedule.scheduledAt,
      responseState: scheduleBody.responseState,
    });
  } finally {
    await coordinatorContext.close();
  }
  const deliverRecruitmentInvitationOnce = deliverRecruitmentInvitation;
  assert.ok(deliverRecruitmentInvitationOnce);
  stage?.("returning:next-period-invitation-delivery");
  const delivery = await deliverRecruitmentInvitationOnce("returning-next-invitation-delivery-0104");
  assert.equal(delivery._tag, "Delivered");
  if (delivery._tag !== "Delivered" || delivery.claim === undefined)
    throw new Error(`next invitation delivery did not complete: ${delivery._tag}`);
  const deliveredInvitationOutbox = await pool.query(
    "SELECT status,attempts FROM public.recruitment_invitation_outbox WHERE effect_id=$1",
    [delivery.claim.effectId],
  );
  assert.deepEqual(deliveredInvitationOutbox.rows, [{ status: "Delivered", attempts: 1 }]);
  trace.push({
    phase: "returning:native-invitation-delivered",
    interviewId: nextInterviewId,
    effectId: delivery.claim.effectId,
    deliveryStatus: delivery._tag,
    outbox: deliveredInvitationOutbox.rows,
  });
  const invitationCapabilityReader = readInvitationCapability;
  assert.ok(invitationCapabilityReader);
  let invitationCapability: string | undefined;
  for (let attempt = 0; attempt < 120 && invitationCapability === undefined; attempt += 1) {
    invitationCapability = invitationCapabilityReader(nextInterviewId);
    if (invitationCapability === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(invitationCapability);
  stage?.("returning:next-period-invitation");
  const invitationHeaders = {
    "x-recruitment-invitation-capability": invitationCapability,
    origin: ui,
  };
  const invitationPendingResponse = await page.request.get(
    `${api}/api/recruitment/invitation-response`,
    { headers: invitationHeaders },
  );
  const invitationPendingText = await invitationPendingResponse.text();
  if (invitationPendingResponse.status() !== 200) {
    throw new Error(
      `next invitation read failed ${invitationPendingResponse.status()} ${invitationPendingText}`,
    );
  }
  const invitationPending = JSON.parse(invitationPendingText) as {
    scheduledAt: string;
    room: string;
    campus: string;
    responseState: string;
    responseMessage: string | null;
  };
  const invitationETag = invitationPendingResponse.headers()["etag"];
  assert.ok(invitationETag);
  assert.deepEqual(invitationPending, {
    scheduledAt: "2026-09-20T10:00:00.000Z",
    room: "Returning Room 0104",
    campus: "Gløshaugen",
    responseState: "Pending",
    responseMessage: null,
  });
  const invitationConfirmResponse = await page.request.post(
    `${api}/api/recruitment/invitation-response:confirm`,
    {
      headers: {
        ...invitationHeaders,
        "content-type": "application/json",
        "idempotency-key": "returning-next-invitation-confirm-0104",
        "if-match": invitationETag,
      },
      data: {},
    },
  );
  const invitationConfirmText = await invitationConfirmResponse.text();
  if (invitationConfirmResponse.status() !== 204) {
    throw new Error(
      `next invitation confirmation failed ${invitationConfirmResponse.status()} ${invitationConfirmText}`,
    );
  }
  const invitationAcceptedResponse = await page.request.get(
    `${api}/api/recruitment/invitation-response`,
    { headers: invitationHeaders },
  );
  assert.equal(invitationAcceptedResponse.status(), 200);
  const invitationAccepted = JSON.parse(await invitationAcceptedResponse.text()) as {
    scheduledAt: string;
    room: string;
    campus: string;
    responseState: string;
    responseMessage: string | null;
  };
  assert.deepEqual(invitationAccepted, {
    scheduledAt: "2026-09-20T10:00:00.000Z",
    room: "Returning Room 0104",
    campus: "Gløshaugen",
    responseState: "Accepted",
    responseMessage: null,
  });
  trace.push({
    phase: "returning:native-invitation-accepted",
    interviewId: nextInterviewId,
    responseState: invitationAccepted.responseState,
    confirmStatus: invitationConfirmResponse.status(),
  });
  stage?.("returning:next-period-finalization");
  const conductPath = `${api}/api/recruitment/interviews/${encodeURIComponent(nextInterviewId)}`;
  const conductResponse = await page.request.get(conductPath, {
    headers: { origin: ui },
  });
  assert.equal(conductResponse.status(), 200);
  const conductETag = conductResponse.headers()["etag"];
  assert.ok(conductETag);
  const conductBefore = JSON.parse(await conductResponse.text()) as {
    interviewId: string;
    applicationId: string;
    invitationResponse: string;
    questions: Array<{ questionId: string; kind: string }>;
    answers: unknown[];
    score: unknown;
    recommendation: string | null;
    completionState: string;
    revision: number;
  };
  assert.equal(conductBefore.interviewId, nextInterviewId);
  assert.equal(conductBefore.applicationId, nextApplicationId);
  assert.equal(conductBefore.invitationResponse, "Accepted");
  assert.equal(conductBefore.completionState, "NotCompleted");
  assert.equal(conductBefore.revision, 1);
  assert.equal(conductBefore.answers.length, 0);
  assert.equal(conductBefore.score, null);
  assert.equal(conductBefore.recommendation, null);
  assert.equal(conductBefore.questions.length, 4);
  const finalizeAnswers = conductBefore.questions.map((question) => ({
    questionId: question.questionId,
    answer:
      question.kind === "text"
        ? "Jeg vil utvikle læringsopplegg sammen med andre."
        : question.kind === "check"
          ? ["Samarbeid"]
          : question.kind === "list"
            ? "Teknologi"
            : "Praksis",
  }));
  const finalizeKey = "returning-native-finalize-0104";
  const finalizeResponse = await page.request.post(`${conductPath}:finalize`, {
    headers: {
      "content-type": "application/json",
      "idempotency-key": finalizeKey,
      "if-match": conductETag,
      origin: ui,
    },
    data: {
      answers: finalizeAnswers,
      score: { explanatoryPower: 9, roleModel: 9, suitability: 9 },
      recommendation: "Kanskje",
    },
  });
  const finalizeBodyText = await finalizeResponse.text();
  if (finalizeResponse.status() !== 200) {
    throw new Error(`native finalization failed ${finalizeResponse.status()} ${finalizeBodyText}`);
  }
  const finalizeBody = JSON.parse(finalizeBodyText) as {
    interviewId: string;
    finalizedAt: string;
    completionState: string;
    cancellationState: string;
  };
  assert.equal(finalizeBody.interviewId, nextInterviewId);
  assert.match(finalizeBody.finalizedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(finalizeBody.completionState, "Completed");
  assert.equal(finalizeBody.cancellationState, "NotCancelled");
  const conductAfterResponse = await page.request.get(conductPath, {
    headers: { origin: ui },
  });
  assert.equal(conductAfterResponse.status(), 200);
  const conductAfter = JSON.parse(await conductAfterResponse.text()) as {
    answers: unknown[];
    score: { explanatoryPower: number; roleModel: number; suitability: number } | null;
    recommendation: string | null;
    completionState: string;
    revision: number;
  };
  assert.equal(conductAfterResponse.headers()["etag"] !== conductETag, true);
  assert.equal(conductAfter.answers.length, 4);
  assert.deepEqual(conductAfter.score, { explanatoryPower: 9, roleModel: 9, suitability: 9 });
  assert.equal(conductAfter.recommendation, "Kanskje");
  assert.equal(conductAfter.completionState, "Completed");
  assert.equal(conductAfter.revision, 2);
  trace.push({
    phase: "returning:native-finalization",
    actorPersonId: "journey-conduct-leader-0063",
    interviewerPersonId: "journey-conduct-leader-0063",
    interviewId: nextInterviewId,
    etagBefore: conductETag,
    questionSnapshotIds: conductBefore.questions.map((question) => question.questionId),
    finalizeStatus: finalizeResponse.status(),
    recommendation: "Kanskje",
    scoreTotal: 27,
  });
  const finalizedConduct = await pool.query(
    `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id=$1`,
    [nextInterviewId],
  );
  assert.deepEqual(finalizedConduct.rows, [
    { recommendation: "Kanskje", explanatory_power: 9, role_model: 9, suitability: 9 },
  ]);
  const preservedConduct = await pool.query(
    `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-returning-0104'`,
  );
  assert.deepEqual(preservedConduct.rows, [
    { recommendation: "Ja", explanatory_power: 8, role_model: 8, suitability: 8 },
  ]);
  const registrations = await pool.query("SELECT admission_period_id,revision,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids FROM public.admission_returning_registrations WHERE person_id=$1 ORDER BY admission_period_id,revision", [person.personId]);
  assert.deepEqual(registrations.rows, [
    { admission_period_id: admissionPeriodId, revision: 1, year_of_study: 2, monday_unavailable: false, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: false, friday_unavailable: false, position_weeks: 4, preferred_group: "all", language: "Norsk og engelsk", preferred_school: null, team_interest: false, team_ids: [] },
    { admission_period_id: admissionPeriodId, revision: 2, year_of_study: 3, monday_unavailable: false, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: false, friday_unavailable: false, position_weeks: 4, preferred_group: "all", language: "Engelsk", preferred_school: null, team_interest: false, team_ids: [] },
    { admission_period_id: admissionPeriodId, revision: 3, year_of_study: 4, monday_unavailable: false, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: false, friday_unavailable: false, position_weeks: 4, preferred_group: "all", language: "Engelsk", preferred_school: null, team_interest: false, team_ids: [] },
    { admission_period_id: nextAdmissionPeriodId, revision: 1, year_of_study: 4, monday_unavailable: true, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: true, friday_unavailable: false, position_weeks: 8, preferred_group: "block-1", language: "Norsk og engelsk", preferred_school: "Returning School", team_interest: true, team_ids: [teamId] },
    { admission_period_id: nextAdmissionPeriodId, revision: 2, year_of_study: 5, monday_unavailable: true, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: true, friday_unavailable: false, position_weeks: 8, preferred_group: "block-1", language: "Norsk og engelsk", preferred_school: "Returning School", team_interest: true, team_ids: [teamId] },
    { admission_period_id: nextAdmissionPeriodId, revision: 3, year_of_study: 5, monday_unavailable: true, tuesday_unavailable: false, wednesday_unavailable: false, thursday_unavailable: true, friday_unavailable: false, position_weeks: 8, preferred_group: "block-1", language: "Norsk og engelsk", preferred_school: "Returning School", team_interest: true, team_ids: [teamId] },
  ]);
  const provenance = await pool.query(
    `SELECT DISTINCT
       r.admission_period_id,
       r.department_id AS registration_department_id,
       r.semester_id AS registration_semester_id,
       p.placement_id,
       p.department_id AS placement_department_id,
       p.semester_id AS placement_semester_id
     FROM public.admission_returning_registrations r
     JOIN public.assistant_placements p ON p.placement_id=r.placement_id
     WHERE r.person_id=$1
     ORDER BY r.admission_period_id`,
    [person.personId],
  );
  assert.deepEqual(provenance.rows, [
    {
      admission_period_id: admissionPeriodId,
      registration_department_id: departmentId,
      registration_semester_id: semesterId,
      placement_id: `placement-${"0".repeat(64)}`,
      placement_department_id: historicalDepartmentId,
      placement_semester_id: historicalSemesterId,
    },
    {
      admission_period_id: nextAdmissionPeriodId,
      registration_department_id: departmentId,
      registration_semester_id: nextSemesterId,
      placement_id: `placement-${"0".repeat(64)}`,
      placement_department_id: historicalDepartmentId,
      placement_semester_id: historicalSemesterId,
    },
  ]);
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
  assert.equal(exactReplay.status(), 201);
  const nextRevisionAfterReplay = await pool.query(
    "SELECT count(*)::int AS count FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2",
    [person.personId, nextAdmissionPeriodId],
  );
  assert.deepEqual(nextRevisionAfterReplay.rows, nextRevisionBeforeReplay.rows);
  const closedBefore = await negativeMutationSnapshot(person.personId);
  await pool.query(
    "UPDATE public.admission_periods SET end_at='2026-08-03T00:00:00Z' WHERE admission_period_id=$1",
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
  const returningOutbox = await pool.query(
    "SELECT effect_id,status,attempts FROM public.admission_application_outbox WHERE origin='ReturningAssistant' ORDER BY effect_id",
  );
  assert.equal(returningOutbox.rows.length, 18);
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
  const reportContext = await browser.newContext();
  const reportPage = await reportContext.newPage();
  try {
    await reportPage.goto(`${ui}/login`);
    await reportPage.getByLabel("E-post", { exact: true }).fill(coordinatorEmail);
    await reportPage.getByLabel("Passord", { exact: true }).fill(coordinatorPassword);
    await reportPage.getByRole("button", { name: "Logg inn", exact: true }).click();
    await reportPage.waitForURL(/\/dashboard\/?$/);
    const reportRows = async (periodId: string) => {
      await reportPage.goto(
        `${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${encodeURIComponent(periodId)}`,
      );
      await reportPage.getByRole("heading", { level: 1, name: "Fullførte intervjuer" }).waitFor();
      return reportPage.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
      );
    };
    const currentReportRows = await reportRows(admissionPeriodId);
    const currentRita = currentReportRows.find((row) => row.includes("Rita Tilbake"));
    assert.ok(currentRita);
    assert.match(currentRita, /Tilbakevendende/u);
    assert.match(currentRita, /Ja/u);
    assert.match(currentRita, /8/u);
    assert.match(currentRita, /24/u);
    const currentOrdinary = currentReportRows.find((row) => row.includes("Sofie Gjennomfører"));
    assert.ok(currentOrdinary);
    assert.match(currentOrdinary, /Ukjent/u);
    assert.match(currentOrdinary, /Ja/u);
    assert.match(currentOrdinary, /8/u);
    assert.match(currentOrdinary, /24/u);
    assert.equal(currentReportRows.some((row) => row.includes("Olav Konflikt")), false);
    await reportPage.reload();
    assert.equal(
      (await reportPage.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
      )).find((row) => row.includes("Rita Tilbake")),
      currentRita,
    );
    await auditPage(reportPage, "returning-report-existing-period");
    await reportPage.screenshot({ path: join(artifacts, "returning-report-existing-period.png"), fullPage: true });
    const nextReportRows = await reportRows(nextAdmissionPeriodId);
    assert.equal(nextReportRows.length, 1);
    const nextRita = nextReportRows[0];
    assert.match(nextRita, /Rita Tilbake/u);
    assert.match(nextRita, /Tilbakevendende/u);
    assert.match(nextRita, /Kanskje/u);
    assert.match(nextRita, /9/u);
    assert.match(nextRita, /27/u);
    await reportPage.reload();
    const reloadedNextRows = await reportPage.locator("tbody tr").evaluateAll((rows) =>
      rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
    );
    assert.deepEqual(reloadedNextRows, nextReportRows);
    await auditPage(reportPage, "returning-report-next-period-finalized");
    await reportPage.screenshot({ path: join(artifacts, "returning-report-next-period-finalized.png"), fullPage: true });
  } finally {
    await reportContext.close();
  }
  } finally {
    // Retain the complete journey trace on both successful helper return and
    // failure, before the outer report/effect gates can run or fail.
    await writeFile(join(artifacts, "returning-registration-trace.json"), JSON.stringify(trace, null, 2));
  }
  return { trace };
};

export const runReturningAssistantLoginProbe = async ({
  browser,
  pool,
  ui,
  artifacts,
}: {
  readonly browser: Browser;
  readonly pool: Pool;
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
  const actual = await field.inputValue();
  if (actual !== expected) {
    throw new Error(`field value mismatch actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
};
