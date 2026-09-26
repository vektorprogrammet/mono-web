import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "../../packages/domain/src/shared-kernel/index.js";
import {
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
} from "../../packages/domain/src/recruitment/schema.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { createPromiseClient } from "../../packages/sdk/src/promise.js";
import { decodeApplicantProgressResponse } from "../../packages/domain/src/application/schema.js";
import type { Page } from "playwright";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {Array as Arr,  Match, Predicate, Schema } from "effect";
import { admissionJourneyClock } from "../e2e/journey-clock.ts";

export const applicantProgressUnlinkedIdentity = {
  personId: "applicant-progress-unlinked-person",
  firstName: "Una",
  lastName: "Unlinked",
  email: "unlinked.progress@example.invalid",
  password: "applicant-progress-unlinked-secret-0107",
} as const;

const personId = "journey-conduct-leader-0063";

const base = {
  applicant: "applicant-recommendation-self",
  application: "application-recommendation-self",
  interview: "interview-recommendation-self",
  schedule: "interview-recommendation-self",
  invitation: "invitation-recommendation-self",
  department: "department-native-conduct-0063",
  semester: "semester-native-conduct-0063",
  period: "admission-period-native-conduct-0063",
  field: "field-native-conduct-0063",
} as const;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the
// current time. The fixtures live in the conduct seed's semester, which is derived from the same
// instant, so the applicant-progress read always sees them as current.
const { fromNow: fromJourneyNow } = admissionJourneyClock();

// Applications are submitted at now − 20 days and their accounts are claimed at now − 14 days.
// Invitations cloned from the base interview (assigned at now − 7 days) are answered at now − 6
// days, the completed interview is finalized at now − 1 day, and every schedule lies ahead.
const accountClaimedAt = fromJourneyNow(-14);

const accountClaimExpiresAt = fromJourneyNow(120);

const respondedAt = fromJourneyNow(-6);

const finalizedAt = fromJourneyNow(-1);

const pendingAcceptedAt = fromJourneyNow(-1, 60);

const clone = async (
  client: PoolClient,
  table: string,
  predicate: string,
  values: Readonly<Schema.JsonObject>,
) => {
  await client.query(
    `INSERT INTO public.${table} SELECT (jsonb_populate_record(NULL::public.${table},to_jsonb(source)||$1::jsonb)).* FROM public.${table} source WHERE ${predicate}`,
    [JSON.stringify(values)],
  );
};

const linkApplicant = async (
  client: PoolClient,
  suffix: string,
  applicationId: string,
  applicantId: string,
) => {
  const invitationId = `applicant-progress-account-${suffix}`;
  await client.query(
    `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,$5,'Claimed',$6,$7)`,
    [
      invitationId,
      applicationId,
      applicantId,
      digest(invitationId),
      accountClaimExpiresAt,
      personId,
      accountClaimedAt,
    ],
  );
  await client.query(
    `INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES($1,$2,$3,$4)`,
    [applicantId, personId, accountClaimedAt, invitationId],
  );
};

type ProgressSeedState = "received" | "pending" | "new-time" | "rejected" | "completed";

const seedProgressState = async (client: PoolClient, state: ProgressSeedState, ordinal: number) => {
  const applicantId = `applicant-progress-${state}-0107`;
  const applicationId = `application-progress-${state}-0107`;
  const interviewId = `interview-progress-${state}-0107`;
  const invitationId = `invitation-progress-${state}-0107`;
  await clone(client, "admission_applicants", `applicant_id='${base.applicant}'`, {
    applicant_id: applicantId,
    normalized_email: `${state}.progress@example.invalid`,
    email: `${state}.progress@example.invalid`,
    first_name: state,
    last_name: "Progress",
  });
  await clone(client, "admission_applications", `application_id='${base.application}'`, {
    application_id: applicationId,
    applicant_id: applicantId,
    submitted_at: fromJourneyNow(-20, ordinal),
  });
  await linkApplicant(client, state, applicationId, applicantId);

  if (state === "received") return;

  await clone(client, "recruitment_interviews", `interview_id='${base.interview}'`, {
    interview_id: interviewId,
    application_id: applicationId,
  });
  await clone(client, "recruitment_interview_schedules", `interview_id='${base.schedule}'`, {
    interview_id: interviewId,
    scheduled_at: fromJourneyNow(ordinal - 1),
    room: `P-${ordinal}01`,
  });

  const responseState = Match.value(state).pipe(
    Match.when("pending", () => "Pending" as const),
    Match.when("new-time", () => "RequestedNewTime" as const),
    Match.when("rejected", () => "Rejected" as const),
    Match.orElse(() => "Accepted" as const),
  );

  const responded = responseState === "Pending" ? null : respondedAt;
  const responseMessage = responseState === "RequestedNewTime" ? "Trenger et nytt tidspunkt" : null;
  await clone(client, "recruitment_invitations", `invitation_id='${base.invitation}'`, {
    invitation_id: invitationId,
    interview_id: interviewId,
    capability_sha256: digest(invitationId),
    response_state: responseState,
    response_message: responseMessage,
    responded_at: responded,
    response_revision: responseState === "Pending" ? 0 : 1,
  });

  if (responseState !== "Pending") {
    await client.query(
      `INSERT INTO public.recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,response_message,responded_at) VALUES($1,$2,1,1,$3,$4,$5)`,
      [invitationId, interviewId, responseState, responseMessage, responded],
    );
  }

  if (responseState === "Rejected" || responseState === "RequestedNewTime") {
    await client.query(
      `INSERT INTO public.recruitment_invitation_response_outbox(effect_id,effect_type,invitation_id,interview_id,schedule_revision,response_revision,response_state,response_message,ordinal,payload_json,status,attempts,delivered_at) VALUES($1,'SendInterviewInvitationResponse',$2,$3,1,1,$4,$5,0,'{}'::jsonb,'Delivered',1,$6)`,
      [
        `recruitment-invitation-response:${invitationId}:1`,
        invitationId,
        interviewId,
        responseState,
        responseMessage,
        responded,
      ],
    );
  }

  if (state !== "completed") return;

  const commandId = "applicant-progress-completed-command-0107";

  const command = FinalizeInterviewCommandSchema.make({
    commandId: FinalizeInterviewCommandSchema.fields.commandId.make(commandId),
    interviewId: FinalizeInterviewCommandSchema.fields.interviewId.make(interviewId),
    expectedRevision: 1,
    answers: [],
    score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
    recommendation: "Ja",
  });

  const observation = FinalizeInterviewObservationSchema.make({
    commandId: command.commandId,
    interviewId: command.interviewId,
    interviewRevision: 2,
    finalizedAt: FinalizeInterviewObservationSchema.fields.finalizedAt.make(finalizedAt),
    completionState: "Completed",
    cancellationState: "NotCancelled",
    notificationState: "Pending",
  });

  await client.query(
    `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES($1,'[]'::jsonb,7,8,9,$2,$3,2,'Ja')`,
    [interviewId, personId, finalizedAt],
  );
  await client.query(
    `INSERT INTO public.recruitment_interview_lifecycle_command_receipts(command_id,command_sha256,command_json,observation_json,kind,interview_id,resulting_revision,committed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,'InterviewFinalized',$5,2,$6)`,
    [
      commandId,
      sha256Hex(canonicalJsonBytes(command)),
      canonicalJson(command),
      canonicalJson(observation),
      interviewId,
      finalizedAt,
    ],
  );
  await client.query(
    `INSERT INTO public.recruitment_interview_lifecycle_audit(command_id,interview_id,kind,actor_person_id,resulting_revision,occurred_at) VALUES($1,$2,'InterviewFinalized',$3,2,$4)`,
    [commandId, interviewId, personId, finalizedAt],
  );
};

const seedScopedApplication = async (
  client: PoolClient,
  suffix: "assigned" | "returning",
  activePlacement: boolean,
) => {
  const departmentId = `applicant-progress-${suffix}-department`;
  const periodId = `applicant-progress-${suffix}-period`;
  const fieldId = `applicant-progress-${suffix}-field`;
  const applicantId = `applicant-progress-${suffix}-applicant`;
  const applicationId = `applicant-progress-${suffix}-application`;
  await clone(client, "admission_period_departments", `department_id='${base.department}'`, {
    department_id: departmentId,
    name: `Progress ${suffix}`,
  });
  await clone(client, "organization_departments", `department_id='${base.department}'`, {
    department_id: departmentId,
    name: `Progress ${suffix}`,
    short_name: `P-${suffix}`,
    email: `${suffix}.department@example.invalid`,
    native_creation_command_id: null,
  });
  await clone(client, "admission_periods", `admission_period_id='${base.period}'`, {
    admission_period_id: periodId,
    department_id: departmentId,
    last_command_id: `applicant-progress-${suffix}-period-seed`,
  });
  await clone(client, "admission_period_fields_of_study", `field_of_study_id='${base.field}'`, {
    field_of_study_id: fieldId,
    department_id: departmentId,
    name: `Progress ${suffix} study`,
  });
  await clone(client, "admission_applicants", `applicant_id='${base.applicant}'`, {
    applicant_id: applicantId,
    normalized_email: `${suffix}.scoped.progress@example.invalid`,
    email: `${suffix}.scoped.progress@example.invalid`,
    field_of_study_id: fieldId,
  });
  await clone(client, "admission_applications", `application_id='${base.application}'`, {
    application_id: applicationId,
    applicant_id: applicantId,
    admission_period_id: periodId,
    department_id: departmentId,
    field_of_study_id: fieldId,
    submitted_at: fromJourneyNow(-20, suffix === "assigned" ? 10 : 11),
  });
  await linkApplicant(client, suffix, applicationId, applicantId);
  await client.query(
    `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES($1,$2,$3,1)`,
    [personId, departmentId, suffix === "returning" ? "Inactive" : "Active"],
  );

  const school = await client.query(
    `INSERT INTO public.schools_directory_schools(name,contact_person,email,phone,language,active,revision) VALUES($1,'Synthetic Contact',$2,'90000000','Norwegian',true,0) RETURNING school_id`,
    [`Progress ${suffix} school`, `${suffix}.school@example.invalid`],
  );

  const schoolId = school.rows[0].school_id;
  await client.query(
    `INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0)`,
    [schoolId, departmentId],
  );
  const placementId = `placement-${digest(`applicant-progress-${suffix}-placement`)}`;
  await client.query(
    `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES($1,$2,$3,$4,$5,'Monday',4,'1',$6,1)`,
    [placementId, personId, departmentId, base.semester, schoolId, activePlacement],
  );

  if (suffix === "returning") {
    await client.query(
      `INSERT INTO public.admission_returning_registrations(registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,3,false,false,false,false,false,4,'all','Norsk',NULL,false,'[]'::jsonb,$10)`,
      [
        `returning-registration-${digest("applicant-progress-returning-registration")}`,
        applicationId,
        applicantId,
        personId,
        placementId,
        departmentId,
        base.semester,
        periodId,
        "applicant-progress-returning-command",
        accountClaimedAt,
      ],
    );
  }
};

export const seedApplicantProgress0107 = async (pool: Pool) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await seedProgressState(client, "received", 1);
    await seedProgressState(client, "pending", 2);
    await seedProgressState(client, "new-time", 3);
    await seedProgressState(client, "rejected", 4);
    await seedProgressState(client, "completed", 5);
    await seedScopedApplication(client, "assigned", true);
    await seedScopedApplication(client, "returning", false);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
};

const forbidden = /email|phone|recommendation|answers|capability|interviewer|score/iu;

const assertNoForbiddenKeys = (value: Schema.Json): void => {
  if (Arr.isArray<Schema.Json>(value)) {
    for (const item of value) assertNoForbiddenKeys(item);

    return;
  }

  if (value === null || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) return;

  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.test(key), false, `forbidden applicant-progress field ${key}`);
    assertNoForbiddenKeys(child);
  }
};

export const runApplicantProgress0107 = async (input: {
  readonly pool: Pool;
  readonly page: Page;
  readonly cookie: string;
  readonly api: string;
  readonly ui: string;
  readonly artifacts: string;
  readonly errors: string[];
  readonly audit: (page: Page) => Promise<ReadonlyArray<unknown>>;
}) => {
  const request = (path: string, cookie = input.cookie) =>
    fetch(`${input.api}${path}`, { headers: { cookie, origin: input.ui } });

  assert.equal((await fetch(`${input.api}/api/applicant-progress`)).status, 401);
  assert.equal((await request("/api/applicant-progress?applicationId=other")).status, 400);
  const response = await request("/api/applicant-progress");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const unlinkedSignIn = await fetch(`${input.api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: input.ui, "content-type": "application/json" },
    body: JSON.stringify({
      email: applicantProgressUnlinkedIdentity.email,
      password: applicantProgressUnlinkedIdentity.password,
    }),
  });

  assert.equal(unlinkedSignIn.status, 200);
  const unlinkedCookie = unlinkedSignIn.headers.get("set-cookie")?.split(";")[0];
  assert.ok(unlinkedCookie);
  const unlinkedResponse = await request("/api/applicant-progress", unlinkedCookie);
  assert.equal(unlinkedResponse.status, 200);
  assert.deepEqual(decodeApplicantProgressResponse(await unlinkedResponse.json()).applications, []);

  const expiredSessions = await input.pool.query(
    `UPDATE auth.session SET "expiresAt"=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-interval '1 minute' WHERE "userId"=$1`,
    [applicantProgressUnlinkedIdentity.personId],
  );

  assert.ok((expiredSessions.rowCount ?? 0) >= 1);
  assert.equal((await request("/api/applicant-progress", unlinkedCookie)).status, 401);
  const body = decodeApplicantProgressResponse(await response.json());
  const tags = body.applications.map((application) => application.progress._tag);
  const observedStates = new Set(tags);

  const readCompletedApplicationState = async () => {
    const current = decodeApplicantProgressResponse(
      await (await request("/api/applicant-progress")).json(),
    );

    const application = current.applications.find(
      (candidate) => candidate.applicationId === "application-progress-completed-0107",
    );

    assert.ok(application, "completed applicant-progress fixture is missing");
    observedStates.add(application.progress._tag);

    return application.progress._tag;
  };

  const sdk = createPromiseClient(input.api, { cookie: input.cookie, origin: input.ui });

  const readSdk = async () => {
    try {
      return await sdk.admissions.readApplicantProgress();
    } catch (cause) {
      throw new Error(`applicant progress SDK failed: ${inspect(cause, { depth: 10 })}`, { cause });
    }
  };

  const sdkResponse = await readSdk();
  const sdkBody = decodeApplicantProgressResponse(sdkResponse.body);
  assert.equal(sdkBody.personId, body.personId);
  assert.deepEqual(sdkBody.applications, body.applications);

  for (const tag of [
    "ApplicationReceived",
    "InvitedToInterview",
    "InterviewAccepted",
    "AwaitingNewInterviewTime",
    "Cancelled",
    "InterviewCompleted",
    "ReturningRegistrationCompleted",
    "AssignedToSchool",
  ] as const) {
    assert.ok(tags.includes(tag), `missing applicant progress state ${tag}`);
  }

  for (let index = 1; index < body.applications.length; index += 1) {
    const previous = body.applications[index - 1];
    const current = body.applications[index];
    assert.ok(previous);
    assert.ok(current);
    assert.ok(
      previous.submittedAt > current.submittedAt ||
        (previous.submittedAt === current.submittedAt &&
          previous.applicationId.localeCompare(current.applicationId) <= 0),
      "applicant progress is not in deterministic newest-first order",
    );
  }

  assertNoForbiddenKeys(body);

  await input.page.goto(`${input.ui}/dashboard/soknad`);
  await input.page.getByRole("heading", { name: "Min søknad", exact: true }).waitFor();
  const renderedText = await input.page.locator("body").innerText();

  for (const title of [
    "Søknaden er mottatt",
    "Du er invitert til intervju",
    "Intervjuet er avtalt",
    "Du har bedt om et nytt intervjutidspunkt",
    "Rekrutteringsløpet er avsluttet",
    "Intervjuet er fullført",
    "Registreringen er fullført",
    "Du har fått skoletildeling",
  ] as const) {
    assert.ok(
      (await input.page.getByRole("heading", { name: title, exact: true }).count()) >= 1,
      `missing rendered applicant-progress heading ${title}: ${renderedText}`,
    );
  }

  assert.equal(await input.page.getByText("P-201", { exact: true }).count(), 1);
  assert.equal(forbidden.test(renderedText), false);
  const violations = await input.audit(input.page);
  assert.deepEqual(violations, []);
  const mapLink = input.page.getByRole("link", { name: "Åpne kart", exact: true }).first();
  await mapLink.focus();
  assert.equal(
    await mapLink.evaluate((element) => element.ownerDocument.activeElement === element),
    true,
  );
  await input.page.screenshot({
    path: join(input.artifacts, "applicant-progress-desktop.png"),
    fullPage: true,
  });
  await input.page.setViewportSize({ width: 390, height: 844 });
  await input.page.screenshot({
    path: join(input.artifacts, "applicant-progress-mobile.png"),
    fullPage: true,
  });

  const completedCard = input.page.getByRole("article").filter({
    has: input.page.getByRole("heading", { name: "Intervjuet er fullført", exact: true }),
  });

  const handoffLink = completedCard.getByRole("link", {
    name: "Åpne assistentoversikten",
    exact: true,
  });

  await handoffLink.focus();
  assert.equal(
    await handoffLink.evaluate((element) => element.ownerDocument.activeElement === element),
    true,
  );
  await handoffLink.click();
  await input.page.waitForURL((url) => url.pathname.endsWith("/dashboard/assistenter"));
  assert.equal(
    new URL(input.page.url()).searchParams.get("departmentId"),
    "department-native-conduct-0063",
  );
  assert.equal(
    new URL(input.page.url()).searchParams.get("semesterId"),
    "semester-native-conduct-0063",
  );
  assert.equal(
    await input.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    true,
  );

  const ownAffiliation = input.page.getByRole("form", {
    name: "Min tilknytning",
    exact: true,
  });

  await ownAffiliation.getByRole("button", { name: "Be om tilknytning", exact: true }).click();
  await ownAffiliation
    .getByRole("status")
    .getByText("Endringen er lagret.", { exact: true })
    .waitFor();
  await input.page.goto(`${input.ui}/dashboard/soknad`);
  await input.page.getByRole("heading", { name: "Tilknytning er søkt", exact: true }).waitFor();
  assert.equal(await readCompletedApplicationState(), "AffiliationPending");

  await input.page.setViewportSize({ width: 1280, height: 900 });
  await input.page.goto(
    `${input.ui}/dashboard/assistenter?${new URLSearchParams({
      departmentId: "department-native-conduct-0063",
      semesterId: "semester-native-conduct-0063",
    }).toString()}`,
  );

  const approveAffiliation = input.page.getByRole("button", {
    name: "Godkjenn tilknytning",
    exact: true,
  });

  await approveAffiliation.click();
  await input.page.getByText("Endringen er lagret.", { exact: true }).waitFor();
  await input.page.goto(`${input.ui}/dashboard/soknad`);
  await input.page
    .getByRole("heading", { name: "Du er tilknyttet avdelingen", exact: true })
    .waitFor();
  assert.equal(await readCompletedApplicationState(), "AffiliationActive");

  const client = await input.pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.recruitment_invitations SET response_state='Accepted',response_message=NULL,responded_at=$1,response_revision=1 WHERE invitation_id='invitation-progress-pending-0107'`,
      [pendingAcceptedAt],
    );
    await client.query(
      `INSERT INTO public.recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,response_message,responded_at) VALUES('invitation-progress-pending-0107','interview-progress-pending-0107',1,1,'Accepted',NULL,$1)`,
      [pendingAcceptedAt],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }

  await input.page.reload();
  assert.equal(
    await input.page
      .getByRole("heading", { name: "Du er invitert til intervju", exact: true })
      .count(),
    0,
  );
  assert.ok(
    (await input.page
      .getByRole("heading", { name: "Intervjuet er avtalt", exact: true })
      .count()) >= 2,
  );

  await input.page.goto(
    `${input.ui}/dashboard/assistenter?${new URLSearchParams({
      departmentId: "department-native-conduct-0063",
      semesterId: "semester-native-conduct-0063",
    }).toString()}`,
  );

  const placement = input.page.getByRole("form", {
    name: "Ny skoleplassering",
    exact: true,
  });

  await placement.getByRole("combobox", { name: "Frivillig", exact: true }).selectOption(personId);
  await placement
    .getByRole("combobox", { name: "Skole", exact: true })
    .selectOption({ label: "Applicant handoff school" });
  await placement.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Monday");
  await placement.getByLabel("Antall undervisningsdager").fill("4");
  await placement.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("1");
  await placement.getByRole("button", { name: "Opprett plassering", exact: true }).click();
  await placement.getByRole("status").getByText("Endringen er lagret.", { exact: true }).waitFor();
  await input.page.goto(`${input.ui}/dashboard/soknad`);
  assert.ok(
    (await input.page
      .getByRole("heading", { name: "Du har fått skoletildeling", exact: true })
      .count()) >= 1,
  );
  assert.equal(await readCompletedApplicationState(), "AssignedToSchool");
  assert.deepEqual(await input.audit(input.page), []);

  const signOut = await fetch(`${input.api}/api/auth/sign-out`, {
    method: "POST",
    headers: { cookie: input.cookie, origin: input.ui },
  });

  assert.equal(signOut.status, 200);
  assert.equal((await request("/api/applicant-progress")).status, 401);
  assert.deepEqual(input.errors, []);
  await writeFile(
    join(input.artifacts, "applicant-progress-targeted-evidence.json"),
    `${JSON.stringify(
      {
        states: [...observedStates].sort(),
        applicationCount: body.applications.length,
        accessibilityViolations: violations.length,
        sourceReload: "Pending->Accepted",
      },
      null,
      2,
    )}\n`,
  );

  return {
    states: [...observedStates].sort(),
    applicationCount: body.applications.length,
    accessibilityViolations: violations.length,
    sourceReload: "Pending->Accepted",
  };
};
