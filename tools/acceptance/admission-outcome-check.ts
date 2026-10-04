/**
 * Admission outcomes: real local API and browser acceptance (spec 0027).
 * Owns a disposable PostgreSQL cluster, the native identity seed, the backend, credentials and a
 * token-protected loopback mailbox that receives the outcome worker's HTTP mail delivery.
 * With --browser, a child runs the production dashboard and Playwright against the same backend;
 * this parent independently observes PostgreSQL, the outbox rows and the encoded mailbox.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Predicate, Schema, Struct } from "effect";
import { OutcomeMailEnvelope } from "../../packages/domain/src/admissions/template.js";
import { AdmissionOutcomeScope } from "../../packages/domain/src/admissions/outcome.js";
import { PublicApplicationIdSchema } from "../../packages/domain/src/application/schema.js";
import { HtmlMailDeliveryRequest } from "../../packages/domain/src/mail.js";
import {
  IdempotencyIfMatchHeaders,
  isProblem,
  NativeProblem,
  problemBody,
} from "../../packages/http-api/src/http-semantics.js";
import { createPromiseClient } from "../../packages/sdk/src/promise.js";
import { admissionJourneyClock } from "../e2e/journey-clock.ts";
import { localBackendEnvironment } from "../e2e/local-backend-environment.ts";
import {
  type DisposablePostgres,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "../postgres/index.ts";
import { stopOwnedProcess } from "./owned-process.js";

const root = new URL("../../", import.meta.url).pathname;

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Client } = requireDatabase("pg");

const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });

const revision = run("git", ["rev-parse", "HEAD"]).trim();

assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed clean artifact");

const artifacts = await mkdtemp(join(tmpdir(), "vektor-admission-outcomes-"));

const children: ChildProcess[] = [];

const outputs: string[] = [];

const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => outputs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => outputs.push(String(chunk)));

  return child;
};

const waitFor = async (condition: () => boolean | Promise<boolean>, gate: string, polls = 300) => {
  for (let poll = 0; !(await condition()); poll += 1) {
    assert.ok(poll < polls, `timed out: ${gate}`);
    await sleep(100);
  }
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** One message that the mailbox accepted, with the number of requests that carried it. */
interface Delivered {
  readonly message: HtmlMailDeliveryRequest;
  attempts: number;
}

const mailboxToken = randomBytes(24).toString("hex");

const mailSender = "outcomes@example.invalid";

const delivered = new Map<string, Delivered>();

/** Requests that the mailbox refused: only the probe of the token check may appear. */
const refusedMail: string[] = [];

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const mailbox = createServer((request: IncomingMessage, response: ServerResponse) => {
  const refuse = (status: number, reason: string) => {
    refusedMail.push(reason);
    response.writeHead(status).end();
  };

  if (request.headers.authorization !== `Bearer ${mailboxToken}`) {
    refuse(401, "unauthorized");

    return;
  }

  if (request.method === "GET") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify([...delivered.values()].map((entry) => entry.message)));

    return;
  }

  readBody(request).then(
    (text) => {
      try {
        // Strict: exactly deliveryId, sender, recipient, subject, text and html.
        const message = Schema.decodeSync(Schema.fromJsonString(HtmlMailDeliveryRequest), {
          onExcessProperty: "error",
        })(text);

        if (request.headers["idempotency-key"] !== message.deliveryId) {
          refuse(400, "idempotency-key differs from the delivery ID");

          return;
        }

        const known = delivered.get(message.deliveryId);

        if (known) known.attempts += 1;
        else delivered.set(message.deliveryId, { message, attempts: 1 });
        response.writeHead(200, { "content-type": "application/json" }).end('{"acknowledged":true}');
      } catch {
        refuse(400, "body is not the strict HTML mail request");
      }
    },
    () => refuse(400, "unreadable body"),
  );
});

let postgres: DisposablePostgres | undefined;

let database: InstanceType<typeof Client>;

let evidence: Schema.JsonObject | undefined;

let summary:
  | { apiGates: number; browserGates: number; receiptCount: number; mailCount: number }
  | undefined;

try {
  const [pgPort, backendPort, dashboardPort, mailboxPort] = await reserveLoopbackPorts(4);
  postgres = await startDisposablePostgres({ port: pgPort });
  const postgresUrl = postgres.url;
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  database = client;

  await new Promise<void>((resolve, reject) => {
    mailbox.once("error", reject);
    mailbox.listen(mailboxPort, "127.0.0.1", resolve);
  });

  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const mailboxUrl = `http://127.0.0.1:${mailboxPort}/mail`;
  const deliveryPollMilliseconds = 200;

  const environment = {
    ...process.env,
    ...localBackendEnvironment({
      backendOrigin,
      dashboardOrigin,
      postgresUrl,
      betterAuthSecret: randomBytes(32).toString("hex"),
    }),
    JOURNEY_SEED_PG_URL: postgresUrl,
    ADMISSIONS_OUTCOME_DELIVERY_MODE: "http",
    ADMISSIONS_OUTCOME_DELIVERY_POLL_MS: String(deliveryPollMilliseconds),
    MAIL_DELIVERY_URL: mailboxUrl,
    MAIL_DELIVERY_TOKEN: mailboxToken,
    MAIL_DELIVERY_TIMEOUT_MS: "2000",
    MAIL_SENDER: mailSender,
  };

  for (const key of Object.keys(environment))
    if (
      key.startsWith("CONTACT_") ||
      (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
    )
      Reflect.deleteProperty(environment, key);
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);

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
    coordinator: {
      email: "kari.koordinator@example.invalid",
      password: "journey-secret-0123456789abcdef",
    },
  };

  const coordinatorPersonId = "journey-outcome-coordinator";

  run(
    "bun",
    ["run", "--cwd", "packages/database", "identity:seed"],
    {
      ...environment,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify([
        {
          personId: coordinatorPersonId,
          firstName: "Kari",
          lastName: "Koordinator",
          email: persons.coordinator.email,
          password: persons.coordinator.password,
        },
      ]),
    },
    120_000,
  );

  // The seed's department and open period hold the API cases; a historical period of the
  // same department holds the browser cases, so neither run can change the other's facts.
  const departmentId = "department-native-journey-0049",
    openSemesterId = "semester-native-journey-0049",
    openPeriodId = "admission-period-native-journey-0049",
    fieldOfStudyId = "field-native-journey-0049",
    historicalSemesterId = "semester-historical-outcomes",
    historicalPeriodId = "period-historical-outcomes",
    previousSemesterId = "semester-previous-outcomes",
    noPeriodSemesterId = "semester-no-period-outcomes",
    otherDepartmentId = "department-other-outcomes",
    coordinationTeamId = "team-coordination-outcomes",
    otherTeamId = "team-other-outcomes",
    decisionTeamId = "team-decision-outcomes",
    interviewSchemaId = "interview-schema-outcomes",
    interviewerPersonId = "journey-rec-interviewer-a-0049",
    leaderPersonId = "journey-rec-leader-0049";

  const journeyClock = admissionJourneyClock();

  await database.query(`INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at) VALUES ('${historicalSemesterId}','2024-01-01','2024-07-01'),('${noPeriodSemesterId}','2023-01-01','2023-07-01'),('${previousSemesterId}','2023-08-01','2023-12-31');
 INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES ('${historicalPeriodId}','${departmentId}','${historicalSemesterId}','2024-01-01','2024-06-01',0,'fixture-admission-outcomes');
 INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision) VALUES ('${otherDepartmentId}','Annen avdeling','Annen','annen@example.invalid','Annen',true,0);
 INSERT INTO public.organization_teams(team_id,department_id,name,active,revision) VALUES ('${otherTeamId}','${otherDepartmentId}','Skolekoordinering',true,0),('${coordinationTeamId}','${departmentId}','Skolekoordinering',true,0),('${decisionTeamId}','${departmentId}','Rekruttering utfall',true,0);
 UPDATE public.organization_memberships SET team_id='${otherTeamId}',is_team_leader=true WHERE person_id='journey-rec-interviewer-b-0049';
 INSERT INTO public.organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader) VALUES ('membership-coordinator-outcomes','${coordinatorPersonId}','${coordinationTeamId}','2020-01-01',true),('membership-decision-outcomes','${leaderPersonId}','${decisionTeamId}','2020-01-01',true);
 INSERT INTO public.recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES ('${interviewSchemaId}','Intervju',0,true,0);`);

  // Rekruttering decides Kanskje and returning outcomes; Skolekoordinering announces. Each is an
  // explicit delegation of leaders, never inferred from a team name or the board seat.
  const delegation = (name: string, team: string, capability: string, department: string) =>
    `('delegation-${digest(`${name}-${department}`)}','${name}','${team}','${capability}','Department','${department}','LeadersOnly','2020-01-01')`;

  await database.query(
    `INSERT INTO public.organization_delegations(delegation_id,name,team_id,capability,area,area_department_id,holders,start_at) VALUES ${[
      delegation("Rekruttering avgjor utfall", decisionTeamId, "admissions.outcomes", departmentId),
      delegation(
        "Skolekoordinering fordeler assistenter",
        coordinationTeamId,
        "placements.coordinate",
        departmentId,
      ),
      delegation(
        "Skolekoordinering fordeler assistenter",
        otherTeamId,
        "placements.coordinate",
        otherDepartmentId,
      ),
    ].join(",")}`,
  );

  const schoolName = "Alfa skole";

  const schoolId = (
    await database.query(
      `INSERT INTO public.schools_directory_schools(name,contact_person,email,phone,language,active) VALUES ($1,'Kontakt','alfa@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`,
      [schoolName],
    )
  ).rows[0].schoolId;

  await database.query(
    "INSERT INTO public.schools_directory_departments(school_id,department_id) VALUES ($1,$2)",
    [schoolId, departmentId],
  );

  type Recommendation = "Ja" | "Kanskje" | "Nei" | "Returning";

  interface Seeded {
    readonly key: string;
    readonly applicationId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly recommendation: Recommendation;
    readonly placed: boolean;
  }

  /** A fully linked applicant in one admission period, with the interview facts of `recommendation`. */
  const seedApplicant = async (
    scope: { periodId: string; semesterId: string; submittedAt: string },
    spec: {
      key: string;
      firstName: string;
      lastName: string;
      recommendation: Recommendation;
      placement?: "Monday" | "Tuesday";
    },
  ): Promise<Seeded> => {
    const { key, firstName, lastName, recommendation, placement } = spec;
    const applicationId = `application-${key}-outcomes`;
    const applicantId = `applicant-${key}-outcomes`;
    const personId = `person-${key}-outcomes`;
    const email = `${key}.outcomes@example.invalid`;
    const query = (text: string, values: ReadonlyArray<unknown>) => database.query(text, values);

    await query("INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES ($1,$2,$3)", [
      personId,
      firstName,
      lastName,
    ]);
    await query(
      "INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES ($1,$2,$2,$3,$4,'12345678',0,$5,2)",
      [applicantId, email, firstName, lastName, fieldOfStudyId],
    );
    await query(
      "INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES ($1,$2,$3,$4,$5,2,$6)",
      [applicationId, applicantId, scope.periodId, departmentId, fieldOfStudyId, scope.submittedAt],
    );
    await query(
      "INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES ($1,$2,$3,$4,date_trunc('milliseconds', date_add(now(), interval '1 year', 'UTC'), 'UTC'),'Claimed',$5,'2024-01-03')",
      [`invitation-${key}-outcomes`, applicationId, applicantId, digest(`token-${key}`), leaderPersonId],
    );
    await query(
      "INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES ($1,$2,'2024-01-04',$3)",
      [applicantId, personId, `invitation-${key}-outcomes`],
    );
    await query(
      "INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES ($1,$2,'Active',1)",
      [personId, departmentId],
    );

    if (recommendation === "Returning") {
      const previous = `placement-${digest(`${key}-previous`)}`;
      await query(
        "INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES ($1,$2,$3,$4,$5,'Friday',4,'1',false,2)",
        [previous, personId, departmentId, previousSemesterId, schoolId],
      );
      await query(
        "INSERT INTO public.admission_returning_registrations(registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,2,false,false,false,false,false,4,'all','Norsk',NULL,false,'[]'::jsonb,'2024-01-02')",
        [
          `returning-registration-${digest(key)}`,
          applicationId,
          applicantId,
          personId,
          previous,
          departmentId,
          scope.semesterId,
          scope.periodId,
          `register-${key}-outcomes`,
        ],
      );
    } else {
      await query(
        "INSERT INTO public.recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES ($1,$2,$3,$4,$5,$4,'2024-01-05',1)",
        [`interview-${key}-outcomes`, applicationId, departmentId, interviewerPersonId, interviewSchemaId],
      );
      await query(
        "INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES ($1,'[]'::jsonb,7,8,9,$2,'2024-01-06',2,$3)",
        [`interview-${key}-outcomes`, interviewerPersonId, recommendation],
      );
    }

    if (placement !== undefined)
      await query(
        "INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES ($1,$2,$3,$4,$5,$6,4,'1',true,1)",
        [`placement-${digest(`${key}-current`)}`, personId, departmentId, scope.semesterId, schoolId, placement],
      );

    return { key, applicationId, firstName, lastName, email, recommendation, placed: placement !== undefined };
  };

  /** A first name that is markup: it must reach the mail as escaped text, never as an element. */
  const markupName = "<img src=x onerror=alert(1)>";

  const historicalScope = {
    periodId: historicalPeriodId,
    semesterId: historicalSemesterId,
    submittedAt: "2024-01-02",
  };

  const openScope = {
    periodId: openPeriodId,
    semesterId: openSemesterId,
    submittedAt: journeyClock.fromNow(-7),
  };

  // The browser's applicants: an interviewed Ja and Nei with and without a placement, a Kanskje
  // that Rekruttering decides, one that nobody decides, and a returning assistant.
  const browserApplicants: Record<string, Seeded> = {};

  for (const spec of [
    { key: "maybe", firstName: "Maja", lastName: "Kanskje", recommendation: "Kanskje" },
    { key: "undecided", firstName: "Ulla", lastName: "Ubesluttet", recommendation: "Kanskje" },
    { key: "returning", firstName: "Rita", lastName: "Returnerer", recommendation: "Returning" },
    { key: "jaFree", firstName: "Jorunn", lastName: "Ja", recommendation: "Ja" },
    { key: "jaPlaced", firstName: "Jonas", lastName: "Plassert", recommendation: "Ja", placement: "Monday" },
    { key: "jaPlacedLate", firstName: "Jens", lastName: "Plassert", recommendation: "Ja", placement: "Tuesday" },
    { key: "neiFree", firstName: "Nina", lastName: "Nei", recommendation: "Nei" },
    { key: "neiPlaced", firstName: "Nils", lastName: "Nei", recommendation: "Nei", placement: "Monday" },
    { key: "markup", firstName: markupName, lastName: "Markup", recommendation: "Nei" },
  ] as const)
    browserApplicants[spec.key] = await seedApplicant(historicalScope, spec);

  const api = {
    maybe: await seedApplicant(openScope, {
      key: "apiMaybe",
      firstName: "Mette",
      lastName: "Maybe",
      recommendation: "Kanskje",
    }),
    ja: await seedApplicant(openScope, {
      key: "apiJa",
      firstName: "Jan",
      lastName: "Jasen",
      recommendation: "Ja",
    }),
    undecided: await seedApplicant(openScope, {
      key: "apiUndecided",
      firstName: "Una",
      lastName: "Undecided",
      recommendation: "Kanskje",
    }),
    neiPlaced: await seedApplicant(openScope, {
      key: "apiNeiPlaced",
      firstName: "Nora",
      lastName: "Placed",
      recommendation: "Nei",
      placement: "Monday",
    }),
  };

  start("bun", ["run", "--cwd", "apps/backend", "start"], environment);

  for (let n = 0; ; n++) {
    try {
      if ((await fetch(`${backendOrigin}/health`)).ok) break;
    } catch {}

    if (n > 150) throw Error("backend startup failed");
    await sleep(200);
  }

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
    other = await login(persons.otherDepartment),
    coordinator = await login(persons.coordinator);

  // `key` null sends no Idempotency-Key, as a read-only preview needs none.
  const request = async (
    path: string,
    cookie?: string,
    body?: Schema.Json,
    etag?: string,
    key: string | null = randomBytes(18).toString("base64url"),
    method: "GET" | "POST" | "PUT" = body === undefined ? "GET" : "POST",
  ) => {
    const nativeHeaders = new Headers();
    nativeHeaders.set("origin", dashboardOrigin);

    if (cookie) {
      nativeHeaders.set("cookie", cookie);
    }

    if (!(body === undefined)) {
      nativeHeaders.set("content-type", "application/json");

      if (key !== null) nativeHeaders.set("idempotency-key", key);

      if (etag) {
        nativeHeaders.set("if-match", etag);
      }
    }

    const requestBody: Pick<RequestInit, "body"> =
      body === undefined ? {} : { body: JSON.stringify(body) };

    return fetch(`${backendOrigin}${path}`, { method, headers: nativeHeaders, ...requestBody });
  };

  const read = async (path: string, cookie = leader) => {
    const response = await request(path, cookie);
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);

    return response.json();
  };

  const expectProblem = async (
    response: Response,
    status: number | ReadonlyArray<number>,
    code: string | RegExp,
    gate: string,
  ) => {
    const body = await response.text();
    const statuses = Predicate.isNumber(status) ? [status] : status;
    assert.ok(statuses.includes(response.status), `${gate}: ${response.status} ${body}`);
    const problemCode = JSON.parse(body).code;

    if (Predicate.isString(code)) assert.equal(problemCode, code, gate);
    else assert.match(problemCode, code, gate);
  };

  const outcomeHistory = async (applicationId: string) =>
    (
      await database.query(
        `SELECT revision, outcome, decided_by_person_id AS "decidedBy" FROM public.admission_application_outcomes WHERE application_id=$1 ORDER BY revision`,
        [applicationId],
      )
    ).rows;

  const scopeOutcomes = async (periodId: string) =>
    (
      await database.query(
        "SELECT outcome.* FROM public.admission_application_outcomes outcome INNER JOIN public.admission_applications application ON application.application_id=outcome.application_id WHERE application.admission_period_id=$1 ORDER BY outcome.application_id, outcome.revision",
        [periodId],
      )
    ).rows;

  const outboxRows = async (periodId?: string) =>
    (
      await database.query(
        `SELECT outbox.application_id AS "applicationId", outbox.effect_id AS "effectId", outbox.payload_json AS payload FROM public.admission_outcome_outbox outbox INNER JOIN public.admission_applications application ON application.application_id=outbox.application_id WHERE $1::text IS NULL OR application.admission_period_id=$1 ORDER BY outbox.application_id, outbox.effect_id`,
        [periodId ?? null],
      )
    ).rows;

  const envelopesOf = async (applicationId: string) =>
    (await outboxRows()).filter((row: { applicationId: string }) => row.applicationId === applicationId);

  const strictEnvelope = (payload: typeof OutcomeMailEnvelope.Encoded) =>
    Schema.decodeSync(OutcomeMailEnvelope, { onExcessProperty: "error" })(payload);

  const gates: string[] = [];
  const scopesPath = "/api/admission-outcomes/scopes";

  const scopeDepartments = async (cookie: string) => {
    const response = await request(scopesPath, cookie);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const scopes = await response.json();

    return scopes.departments.map((item: { departmentId: string }) => item.departmentId);
  };

  const boardPath = (semesterId: string) =>
    `/api/admission-outcomes?${new URLSearchParams({ departmentId, semesterId }).toString()}`;

  const sdk = createPromiseClient(backendOrigin, { cookie: leader, origin: dashboardOrigin });
  const leaderScopes = await read(scopesPath);
  assert.deepEqual(await scopeDepartments(leader), [departmentId]);
  assert.ok(
    [historicalSemesterId, openSemesterId, noPeriodSemesterId].every((semesterId) =>
      leaderScopes.semesters.some((item: { semesterId: string }) => item.semesterId === semesterId),
    ),
  );
  assert.deepEqual(await scopeDepartments(member), [departmentId]);
  assert.deepEqual(await scopeDepartments(other), [otherDepartmentId]);
  assert.deepEqual(await scopeDepartments(coordinator), [departmentId]);
  assert.deepEqual(
    (await sdk.admissionOutcomes.listScopes()).body.departments.map((item) => item.departmentId),
    [departmentId],
  );
  await database.query(
    `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES ('membership-other-outcomes','${leaderPersonId}','${otherTeamId}',NULL,'2020-01-01',NULL,NULL,false,false,0)`,
  );
  assert.deepEqual(
    await scopeDepartments(leader),
    [otherDepartmentId, departmentId],
    "every department membership is evaluated",
  );
  gates.push("scopes list only the departments each person may read, from every membership");

  const submission = {
    departmentId,
    firstName: "Anne",
    lastName: "API",
    phone: "90011223",
    email: "anne.api@example.invalid",
    gender: 1,
    fieldOfStudyId,
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
  };

  const submitted = await request("/api/applications", undefined, submission);
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const applicationId = (await submitted.json()).applicationId;
  assert.ok(Predicate.isString(applicationId));

  const scopeQuery = Schema.decodeSync(AdmissionOutcomeScope)({
    departmentId,
    semesterId: openSemesterId,
  });

  const board = await read(boardPath(openSemesterId));
  assert.equal(board._tag, "Decide");
  assert.equal(board.admissionPeriodId, openPeriodId);

  const periodApplications = (
    await database.query(
      "SELECT application_id FROM public.admission_applications WHERE admission_period_id=$1 ORDER BY application_id",
      [openPeriodId],
    )
  ).rows.map((row: { application_id: string }) => row.application_id);

  assert.deepEqual(
    periodApplications,
    [
      applicationId,
      "application-native-journey-0049",
      ...Object.values(api).map((seeded) => seeded.applicationId),
    ].toSorted(),
  );
  assert.deepEqual(
    board.entries.map((entry: { applicationId: string }) => entry.applicationId).toSorted(),
    periodApplications,
    "admission management sees every application of the period",
  );

  const entryOf = (entries: ReadonlyArray<{ applicationId: string }>, id: string) =>
    entries.find((entry) => entry.applicationId === id);

  const initial = entryOf(board.entries, applicationId);

  assert.deepEqual(
    {
      firstName: initial.firstName,
      lastName: initial.lastName,
      email: initial.email,
      phone: initial.phone,
      yearOfStudy: initial.yearOfStudy,
      basis: initial.basis,
      outcome: initial.outcome,
      revision: initial.revision,
    },
    {
      firstName: "Anne",
      lastName: "API",
      email: submission.email,
      phone: submission.phone,
      yearOfStudy: 3,
      basis: "Unreviewed",
      outcome: null,
      revision: 0,
    },
  );
  assert.equal((await sdk.admissionOutcomes.readOutcomes({ query: scopeQuery })).body._tag, "Decide");
  const itemOf = (id: string) => `/api/admission-outcomes/${id}`;
  const decideOf = (id: string) => `${itemOf(id)}:decide`;
  const announceOf = (id: string) => `${itemOf(id)}:announce`;

  const itemResponse = await request(itemOf(applicationId), leader);
  assert.equal(itemResponse.status, 200, await itemResponse.clone().text());
  assert.equal(itemResponse.headers.get("cache-control"), "private, no-store");
  const unreviewedItem = await itemResponse.json();
  assert.equal(itemResponse.headers.get("etag"), unreviewedItem.etag);
  assert.equal(unreviewedItem.etag, initial.etag);
  gates.push("admission management reads every application of the period with its version");

  await expectProblem(
    await request(decideOf(applicationId), leader, { outcome: "Admitted" }, unreviewedItem.etag),
    422,
    "admission-outcome.unreviewed",
    "an application without an interview or a returning registration has nothing to decide",
  );
  assert.deepEqual(await outcomeHistory(applicationId), []);

  const maybeId = api.maybe.applicationId;
  const maybeItem = await read(itemOf(maybeId));
  assert.equal(maybeItem.basis, "Kanskje");

  await expectProblem(
    await request(decideOf(maybeId), leader, { outcome: "Admitted" }),
    428,
    "precondition.required",
    "missing If-Match",
  );

  const invalidCommands: ReadonlyArray<Schema.Json> = [
    {},
    { outcome: "Maybe" },
    { outcome: null },
    { outcome: "Substitute" },
    { outcome: "Admitted", departmentId },
  ];

  for (const invalid of invalidCommands)
    await expectProblem(
      await request(decideOf(maybeId), leader, invalid, maybeItem.etag),
      422,
      "validation.failed",
      `invalid ${JSON.stringify(invalid)}`,
    );
  assert.deepEqual(await outcomeHistory(maybeId), [], "rejected commands record nothing");
  gates.push(
    "a missing version (428), an unreviewed application and invalid outcomes, Substitute included (422), record nothing",
  );

  const key = randomBytes(18).toString("base64url");
  const admitted = await request(decideOf(maybeId), leader, { outcome: "Admitted" }, maybeItem.etag, key);
  assert.equal(admitted.status, 200, await admitted.clone().text());
  const decision = await admitted.json();
  assert.equal(admitted.headers.get("etag"), decision.etag);
  assert.notEqual(decision.etag, maybeItem.etag);
  assert.equal(decision.outcome, "Admitted");
  assert.equal(decision.revision, 1);
  const admittedHistory = [{ revision: 1, outcome: "Admitted", decidedBy: leaderPersonId }];
  assert.deepEqual(await outcomeHistory(maybeId), admittedHistory);
  assert.deepEqual(await envelopesOf(maybeId), [], "deciding queues no mail");
  const replay = await request(decideOf(maybeId), leader, { outcome: "Admitted" }, maybeItem.etag, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), decision, "an exact replay answers the stored result");
  assert.deepEqual(await outcomeHistory(maybeId), admittedHistory, "a replay adds no revision");
  await expectProblem(
    await request(decideOf(maybeId), leader, { outcome: "Rejected" }, maybeItem.etag, key),
    409,
    "idempotency.digest-conflict",
    "another command under a used key",
  );
  const again = await request(decideOf(maybeId), leader, { outcome: "Admitted" }, decision.etag);
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual(await again.json(), decision, "deciding the current outcome again changes nothing");
  assert.deepEqual(await outcomeHistory(maybeId), admittedHistory);
  gates.push(
    "Admitted is decided once with If-Match and Idempotency-Key; replay and a repeated outcome add no revision and queue no mail",
  );

  await expectProblem(
    await request(decideOf(maybeId), leader, { outcome: "Rejected" }, maybeItem.etag),
    412,
    "precondition.failed",
    "stale version",
  );

  const staleCommand = {
    params: { applicationId: PublicApplicationIdSchema.make(maybeId) },
    headers: Schema.decodeSync(IdempotencyIfMatchHeaders)({
      "if-match": maybeItem.etag,
      "idempotency-key": randomBytes(18).toString("base64url"),
    }),
    payload: { outcome: "Rejected" as const },
  };

  for (const attempt of ["initial stale decision", "unchanged rejected retry"]) {
    await assert.rejects(sdk.admissionOutcomes.decideOutcome(staleCommand), (error) => {
      assert.ok(isProblem(error), attempt);
      const problem = Schema.decodeUnknownSync(NativeProblem)(problemBody(error));
      assert.equal(problem.code, "precondition.failed", attempt);
      assert.equal(problem.status, 412, attempt);

      return true;
    });
  }

  assert.deepEqual(await outcomeHistory(maybeId), admittedHistory);
  gates.push("a stale version is refused (412), also on an unchanged SDK retry, and records nothing");

  // A derived outcome cannot be decided by hand: Ja is Admitted and Nei is Rejected.
  const jaId = api.ja.applicationId;
  const jaItem = await read(itemOf(jaId));
  assert.equal(jaItem.basis, "Ja");
  await expectProblem(
    await request(decideOf(jaId), leader, { outcome: "Rejected" }, jaItem.etag),
    422,
    "admission-outcome.derived",
    "no override of Ja",
  );
  assert.deepEqual(await outcomeHistory(jaId), []);
  gates.push("an interviewed Ja or Nei cannot be decided by hand (422 derived)");

  // Members hold neither decide nor announce authority: no member list of anyone.
  await expectProblem(await request(boardPath(openSemesterId), member), 403, "authority.denied", "member board");
  await expectProblem(await request(itemOf(maybeId), member), 403, "authority.denied", "member single read");
  await expectProblem(
    await request(decideOf(maybeId), member, { outcome: "Rejected" }, decision.etag),
    403,
    "authority.denied",
    "member decision",
  );
  await expectProblem(
    await request(announceOf(maybeId), member, {}, decision.etag),
    403,
    "authority.denied",
    "member announcement",
  );
  await assert.rejects(
    createPromiseClient(backendOrigin, {
      cookie: member,
      origin: dashboardOrigin,
    }).admissionOutcomes.readOutcomes({ query: scopeQuery }),
    (error) => isProblem(error),
  );
  gates.push("a member reads, decides and announces nothing (403): no on-call or member list exists");

  for (const path of [boardPath(openSemesterId), itemOf(maybeId)])
    await expectProblem(await request(path, other), 403, "authority.denied", `other department ${path}`);
  await expectProblem(
    await request(decideOf(maybeId), other, { outcome: "Rejected" }, decision.etag),
    403,
    "authority.denied",
    "other department decision",
  );
  await expectProblem(
    await request(announceOf(maybeId), other, {}, decision.etag),
    403,
    "authority.denied",
    "another department's coordinator announcement",
  );

  for (const path of [scopesPath, boardPath(openSemesterId), itemOf(maybeId)])
    assert.equal((await request(path)).status, 401, `anonymous ${path}`);

  for (const [path, body] of [
    [decideOf(maybeId), { outcome: "Rejected" }],
    [announceOf(maybeId), {}],
  ] as const)
    assert.equal((await request(path, undefined, body, decision.etag)).status, 401, `anonymous ${path}`);
  assert.deepEqual(await outcomeHistory(maybeId), admittedHistory);
  assert.deepEqual(await outboxRows(), [], "denials queue no mail");
  gates.push(
    "another department (403, also its coordinator) and anonymous callers (401) read, decide and announce nothing",
  );

  await database.query(
    `INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-outcomes','journey-rec-interviewer-b-0049','2020-01-01',NULL,0)`,
  );
  assert.equal(
    (await read(boardPath(openSemesterId), other))._tag,
    "Decide",
    "an active global administrator decides in every department",
  );

  // The global default templates are read and previewed by the administrator only.
  const templates = "/api/admission-outcomes/templates";
  const globalRead = await request(templates, other);
  assert.equal(globalRead.status, 200, await globalRead.clone().text());
  assert.equal(globalRead.headers.get("cache-control"), "private, no-store");
  assert.match(globalRead.headers.get("etag") ?? "", /^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
  const globalSet = await globalRead.json();
  assert.equal(globalSet.departmentId, null);
  assert.deepEqual(
    globalSet.templates.map((entry: { kind: string; provenance: string }) => [entry.kind, entry.provenance]).toSorted(),
    [
      ["AdmittedPlacementPending", "Global"],
      ["AdmittedWithSchool", "Global"],
      ["Rejected", "Global"],
    ],
  );
  assert.ok(!JSON.stringify(globalSet).includes("@example.invalid"), "no contact data in a template set");

  const text = (value: string) => ({ type: "text", text: value });
  const placeholder = (name: string) => ({ type: "placeholder", attrs: { name } });
  const paragraph = (...content: ReadonlyArray<Schema.Json>) => ({ type: "paragraph", content });

  type Draft = { readonly subject: Schema.Json; readonly body: Schema.Json };

  const draftFor = (kind: string, extra: ReadonlyArray<Schema.Json> = []): Draft => ({
    subject: [
      text("Opptaksresultat - "),
      placeholder("departmentName"),
      text(", "),
      placeholder("semesterName"),
      text(": Egendefinert"),
    ],
    body: {
      version: 1,
      type: "doc",
      content: [
        paragraph(text("Hei "), placeholder("firstName"), text(",")),
        paragraph(
          text("Egendefinert tekst for "),
          placeholder("departmentName"),
          text(" "),
          placeholder("semesterName"),
          text("."),
        ),
        ...(kind === "AdmittedWithSchool"
          ? [paragraph(text("Skole: "), placeholder("schoolName"), text("."))]
          : []),
        ...extra,
      ],
    },
  });

  const sample = { firstName: markupName, departmentName: "Trondheim", semesterName: "Var 2032" };

  const withSample = (draft: Draft, values: Schema.Json = sample) => ({ ...draft, sample: values });

  const preview = await request(`${templates}/Rejected:preview`, other, withSample(draftFor("Rejected")), undefined, null);
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.equal(preview.headers.get("cache-control"), "private, no-store");

  const previewed = Schema.decodeUnknownSync(
    Schema.Struct({ subject: Schema.String, html: Schema.String, text: Schema.String }),
  )(await preview.json());

  assert.ok(previewed.html.includes("&lt;img") && !previewed.html.includes("<img"), "markup stays text");
  assert.ok(previewed.subject.includes("Trondheim") && previewed.text.includes("Egendefinert tekst"));
  gates.push("the administrator reads the global default templates and previews with escaped values");

  await database.query("DELETE FROM public.organization_global_administrator_grants WHERE grant_id='admin-outcomes'");
  assert.equal((await request(boardPath(openSemesterId), other)).status, 403);
  gates.push("an active global administrator decides in every department");

  const concurrent = await Promise.all([
    request(decideOf(maybeId), leader, { outcome: "Rejected" }, decision.etag),
    request(decideOf(maybeId), leader, { outcome: "Rejected" }, decision.etag),
  ]);

  const statuses = concurrent.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1, `concurrent decisions ${statuses.join(",")}`);
  assert.ok(
    statuses.some((status) => status === 409 || status === 412),
    `concurrent rejection ${statuses.join(",")}`,
  );

  const rejectedHistory = [...admittedHistory, { revision: 2, outcome: "Rejected", decidedBy: leaderPersonId }];

  assert.deepEqual(await outcomeHistory(maybeId), rejectedHistory);
  assert.equal(entryOf((await read(boardPath(openSemesterId))).entries, maybeId)?.outcome, "Rejected");
  gates.push("of two concurrent decisions on one version exactly one applies");

  await database.query(
    `UPDATE public.organization_memberships SET is_suspended=true WHERE person_id='${leaderPersonId}'`,
  );
  await expectProblem(
    await request(decideOf(maybeId), leader, { outcome: "Admitted" }, maybeItem.etag, key),
    403,
    "authority.denied",
    "revoked authority cannot replay a stored result",
  );
  await expectProblem(
    await request(boardPath(openSemesterId), leader),
    403,
    "authority.denied",
    "revoked authority cannot read",
  );
  await database.query(
    `UPDATE public.organization_memberships SET is_suspended=false WHERE person_id='${leaderPersonId}'`,
  );
  gates.push("revoked authority cannot replay a stored result or read");

  const noPeriodBoard = await read(boardPath(noPeriodSemesterId));
  assert.equal(noPeriodBoard._tag, "Decide");
  assert.equal(noPeriodBoard.admissionPeriodId, null);
  assert.deepEqual(noPeriodBoard.entries, []);
  await expectProblem(
    await request(boardPath(noPeriodSemesterId), member),
    403,
    "authority.denied",
    "member of a scope without a period",
  );
  await expectProblem(
    await request(boardPath("semester-missing-outcomes"), leader),
    422,
    "scope.invalid",
    "unknown semester",
  );
  gates.push("a scope without an admission period is empty with admissionPeriodId null; an unknown semester is invalid");

  // The coordinator announces: a minimal projection with no e-mail or phone.
  const coordinatorBoard = await read(boardPath(openSemesterId), coordinator);
  assert.equal(coordinatorBoard._tag, "Announce");
  const projection = JSON.stringify(coordinatorBoard);
  assert.ok(!projection.includes("example.invalid") && !projection.includes("12345678"), "no contact data");
  assert.ok(
    Object.values(api).every((seeded) => entryOf(coordinatorBoard.entries, seeded.applicationId)),
    "the coordinator sees every application to announce",
  );

  const announceEtag = async (id: string) =>
    entryOf((await read(boardPath(openSemesterId), coordinator)).entries, id)!.etag;

  const staleEtag = `"vkr2.${"A".repeat(43)}"`;

  const jaEtag = await announceEtag(jaId);
  await expectProblem(
    await request(announceOf(jaId), coordinator, {}, staleEtag),
    412,
    "precondition.failed",
    "stale announcement",
  );
  assert.deepEqual(await outboxRows(), []);
  assert.deepEqual(await outcomeHistory(jaId), []);

  // The commit of the response receipt fails: outcome and envelope roll back together.
  await database.query(
    `CREATE OR REPLACE FUNCTION reject_native_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt commit rejected'; END $$;
     CREATE CONSTRAINT TRIGGER reject_native_receipt_commit AFTER INSERT ON public.native_http_idempotency_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_native_receipt_commit()`,
  );
  const rollbackKey = randomBytes(18).toString("base64url");
  await expectProblem(
    await request(announceOf(jaId), coordinator, {}, jaEtag, rollbackKey),
    503,
    "idempotency.unavailable",
    "a receipt that cannot commit",
  );
  assert.deepEqual(await outcomeHistory(jaId), []);
  assert.deepEqual(await outboxRows(), []);
  await database.query("DROP TRIGGER reject_native_receipt_commit ON public.native_http_idempotency_receipts");
  gates.push(
    "denial, a stale version (412) and a receipt that cannot commit (503) announce nothing and queue no mail",
  );

  const announceKey = randomBytes(18).toString("base64url");
  const announcedJa = await request(announceOf(jaId), coordinator, {}, jaEtag, rollbackKey);
  assert.equal(announcedJa.status, 200, await announcedJa.clone().text());
  assert.equal(announcedJa.headers.get("cache-control"), "private, no-store");
  const announcedBody = await announcedJa.json();
  assert.equal(announcedBody.outcome, "Admitted");
  assert.equal(announcedBody.state, "OutcomeAnnounced");
  assert.equal(announcedBody.placed, false);
  assert.deepEqual(await outcomeHistory(jaId), [{ revision: 1, outcome: "Admitted", decidedBy: null }]);
  const jaMail = await envelopesOf(jaId);
  assert.equal(jaMail.length, 1, "one announcement queues one envelope");
  assert.equal(strictEnvelope(jaMail[0].payload).deliveryId, jaMail[0].effectId);
  const replayed = await request(announceOf(jaId), coordinator, {}, jaEtag, rollbackKey);
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), announcedBody, "a replay answers the first answer");
  assert.deepEqual(await envelopesOf(jaId), jaMail, "a replay queues no second envelope");
  await expectProblem(
    await request(announceOf(jaId), coordinator, {}, await announceEtag(jaId), announceKey),
    409,
    "admission-outcome.final",
    "a second announcement",
  );
  assert.deepEqual(await envelopesOf(jaId), jaMail);
  await assert.rejects(
    database.query(
      "UPDATE public.admission_outcome_outbox SET payload_json = jsonb_set(payload_json, '{subject}', '\"rewritten\"'::jsonb) WHERE application_id=$1",
      [jaId],
    ),
  );
  assert.deepEqual(await envelopesOf(jaId), jaMail, "a queued envelope cannot be rewritten");
  await expectProblem(
    await request(decideOf(jaId), leader, { outcome: "Admitted" }, announcedBody.etag),
    [409, 422],
    /^admission-outcome\./u,
    "an announced outcome is not decided again",
  );
  gates.push(
    "Ja is announced as Admitted once without a decision: one final envelope, an exact replay and a second announcement add none",
  );

  // Refusals leave no outcome and no mail.
  await expectProblem(
    await request(announceOf(api.undecided.applicationId), coordinator, {}, await announceEtag(api.undecided.applicationId)),
    409,
    "admission-outcome.undecided",
    "an undecided Kanskje",
  );
  await expectProblem(
    await request(announceOf(api.neiPlaced.applicationId), coordinator, {}, await announceEtag(api.neiPlaced.applicationId)),
    409,
    "admission-outcome.placement-active",
    "Rejected with an active placement",
  );

  for (const refused of [api.undecided, api.neiPlaced]) {
    assert.deepEqual(await outcomeHistory(refused.applicationId), []);
    assert.deepEqual(await envelopesOf(refused.applicationId), []);
  }

  gates.push("an undecided Kanskje and a Rejected outcome with an active placement are refused and queue no mail");

  // Of two concurrent announcements on one version, exactly one applies and queues one envelope.
  const maybeAnnounceEtag = await announceEtag(maybeId);

  const raced = await Promise.all([
    request(announceOf(maybeId), coordinator, {}, maybeAnnounceEtag),
    request(announceOf(maybeId), coordinator, {}, maybeAnnounceEtag),
  ]);

  const racedStatuses = raced.map((response) => response.status);
  assert.equal(racedStatuses.filter((status) => status === 200).length, 1, `concurrent announcements ${racedStatuses.join(",")}`);
  assert.ok(racedStatuses.some((status) => status === 409 || status === 412), `refused announcement ${racedStatuses.join(",")}`);
  assert.equal((await envelopesOf(maybeId)).length, 1, "one winner queues one envelope");
  assert.deepEqual(await outcomeHistory(maybeId), rejectedHistory, "announcing a decided Kanskje appends no outcome");
  gates.push("of two concurrent announcements exactly one applies and queues one envelope");

  // Templates: department authority, and nothing changes in this department.
  const departmentTemplates = `${templates}?departmentId=${departmentId}`;
  const otherTemplates = `${templates}?departmentId=${otherDepartmentId}`;
  const ownRead = await request(departmentTemplates, coordinator);
  assert.equal(ownRead.status, 200, await ownRead.clone().text());
  const ownEtag = ownRead.headers.get("etag")!;
  const ownSet = await ownRead.json();
  assert.ok(ownSet.templates.every((entry: { provenance: string }) => entry.provenance === "Global"));

  for (const [person, cookie] of [
    ["member", member],
    ["other department coordinator", other],
  ] as const)
    await expectProblem(await request(departmentTemplates, cookie), 403, "authority.denied", `${person} reads`);

  assert.equal((await request(departmentTemplates)).status, 401);
  await expectProblem(await request(templates, coordinator), 403, "authority.denied", "coordinator reads global");
  await expectProblem(
    await request(`${templates}/Rejected`, coordinator, draftFor("Rejected"), ownEtag, undefined, "PUT"),
    403,
    "authority.denied",
    "coordinator edits global",
  );
  await expectProblem(
    await request(`${otherTemplates.replace("?", "/Rejected?")}`, coordinator, draftFor("Rejected"), ownEtag, undefined, "PUT"),
    403,
    "authority.denied",
    "a coordinator edits another department's template",
  );
  await expectProblem(
    await request(`${departmentTemplates.replace("?", "/Rejected?")}`, other, draftFor("Rejected"), ownEtag, undefined, "PUT"),
    403,
    "authority.denied",
    "another department's coordinator edits this department's template",
  );
  await expectProblem(
    await request(`${templates}/Rejected:preview${`?departmentId=${departmentId}`}`, member, withSample(draftFor("Rejected")), undefined, null),
    403,
    "authority.denied",
    "a member previews",
  );

  const unsafeDrafts: ReadonlyArray<{ name: string; kind: string; draft: Draft }> = [
    { name: "script node", kind: "Rejected", draft: draftFor("Rejected", [{ type: "script", content: [text("alert(1)")] }]) },
    { name: "author html node", kind: "Rejected", draft: draftFor("Rejected", [{ type: "html", attrs: { value: "<b>x</b>" } }]) },
    {
      name: "event handler attribute",
      kind: "Rejected",
      draft: draftFor("Rejected", [{ type: "paragraph", attrs: { onerror: "alert(1)" }, content: [text("x")] }]),
    },
    {
      name: "javascript link",
      kind: "Rejected",
      draft: draftFor("Rejected", [
        paragraph({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }),
      ]),
    },
    {
      name: "image node",
      kind: "Rejected",
      draft: draftFor("Rejected", [{ type: "image", attrs: { src: "https://example.invalid/x.png" } }]),
    },
    {
      name: "mdx esm import",
      kind: "Rejected",
      draft: draftFor("Rejected", [{ type: "mdxjsEsm", value: "import x from 'y'" }]),
    },
    {
      name: "placeholder of another variant",
      kind: "Rejected",
      draft: draftFor("Rejected", [paragraph(placeholder("schoolName"))]),
    },
    {
      name: "missing required placeholders",
      kind: "Rejected",
      draft: { subject: [text("Opptaksresultat: Avslag")], body: { version: 1, type: "doc", content: [paragraph(text("Hei"))] } },
    },
  ];

  for (const [index, { name, kind, draft }] of unsafeDrafts.entries()) {
    const unsafePreview = await request(`${templates}/${kind}:preview?departmentId=${departmentId}`, coordinator, withSample(draft), undefined, null);
    assert.equal(unsafePreview.status, 422, `preview ${name}: ${await unsafePreview.clone().text()}`);
    await expectProblem(unsafePreview, 422, "admission-outcome.template-invalid", `preview ${name}`);
    await expectProblem(
      await request(`${templates}/${kind}?departmentId=${departmentId}`, coordinator, draft, ownEtag, `template-unsafe-${index}`.padEnd(22, "0"), "PUT"),
      422,
      "admission-outcome.template-invalid",
      `save ${name}`,
    );
  }

  const unchanged = await request(departmentTemplates, coordinator);
  assert.equal(unchanged.headers.get("etag"), ownEtag, "refused drafts change no template");
  assert.ok(!(await unchanged.text()).includes("alert(1)"));

  // Another department's coordinator edits that department's own template, a scope this journey owns.
  const otherRead = await request(otherTemplates, other);
  assert.equal(otherRead.status, 200, await otherRead.clone().text());

  const otherSave = await request(
    `${templates}/Rejected?departmentId=${otherDepartmentId}`,
    other,
    draftFor("Rejected"),
    otherRead.headers.get("etag")!,
    undefined,
    "PUT",
  );

  assert.equal(otherSave.status, 200, await otherSave.clone().text());

  const otherSet = await otherSave.json();
  assert.equal(
    otherSet.templates.find((entry: { kind: string }) => entry.kind === "Rejected").provenance,
    "Department",
  );
  assert.equal(
    (await request(departmentTemplates, coordinator).then((response) => response.headers.get("etag"))),
    ownEtag,
    "an edit in one department leaves another's templates alone",
  );
  gates.push(
    "template editing is scoped: members, other departments, a coordinator on global and unsafe or unbalanced drafts (422) are refused and change nothing",
  );

  for (const statement of [
    "UPDATE public.admission_application_outcomes SET outcome='Admitted' WHERE application_id=$1",
    "DELETE FROM public.admission_application_outcomes WHERE application_id=$1",
  ])
    await assert.rejects(database.query(statement, [maybeId]), (error) => {
      assert.ok(Predicate.hasProperty(error, "message"), statement);
      assert.match(String(error.message), /append-only/u, statement);

      return true;
    });
  assert.deepEqual(await outcomeHistory(maybeId), rejectedHistory);

  const receiptsOf = async (operation: string) =>
    (
      await database.query(
        "SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts WHERE operation_id=$1",
        [operation],
      )
    ).rows[0].count;

  const receiptCount = await receiptsOf("admissionOutcomes.decideOutcome");

  // Receipts: the first Admitted, the repeated Admitted under a new key, and the concurrent winner.
  assert.equal(receiptCount, 3, "only executed decisions keep a receipt, not replays or refusals");
  assert.equal(
    await receiptsOf("admissionOutcomes.announceOutcome"),
    2,
    "only the two executed announcements keep a receipt: not the rollback, replay or refusals",
  );
  gates.push("the outcome history is append-only and only executed commands keep a receipt");

  // The outcome worker delivers each queued envelope, once, to the token-protected mailbox.
  const mailboxProbe = await fetch(mailboxUrl, { method: "POST", body: "{}" });
  assert.equal(mailboxProbe.status, 401, "the loopback mailbox refuses a call without its token");

  const assertMailboxMatchesOutbox = async (gate: string) => {
    const rows = await outboxRows();
    await waitFor(() => delivered.size >= rows.length, `${gate}: mailbox receives every envelope`);
    assert.equal(delivered.size, rows.length, `${gate}: the mailbox holds exactly the queued envelopes`);

    for (const row of rows) {
      const envelope = strictEnvelope(row.payload);
      const entry = delivered.get(row.effectId);
      assert.ok(entry, `${gate}: ${row.effectId} delivered`);
      assert.equal(entry.attempts, 1, `${gate}: one delivery request`);
      assert.deepEqual(
        {
          deliveryId: entry.message.deliveryId,
          sender: entry.message.sender,
          recipient: entry.message.recipient,
          subject: entry.message.subject,
          html: entry.message.html,
          text: entry.message.text,
        },
        { ...envelope, sender: mailSender },
        `${gate}: the mailbox holds the queued bytes`,
      );
    }
  };

  await assertMailboxMatchesOutbox("api");

  const departmentNames = (
    await database.query(
      "SELECT name FROM public.organization_departments WHERE department_id=$1 UNION SELECT name FROM public.admission_period_departments WHERE department_id=$1",
      [departmentId],
    )
  ).rows.map((row: { name: string }) => row.name);

  /** The department of a subject: it is one of the names that the system stores for it. */
  const subjectParts = (subject: string, semesterId: string) => {
    const match = new RegExp(`^(.+), ${semesterId}: (.+)$`, "u").exec(subject.replace(/^[^,]*? [–-] /u, ""));
    assert.ok(match, `subject names department and semester: ${subject}`);
    assert.ok(departmentNames.includes(match[1]!), `subject names a stored department name: ${subject}`);

    return { departmentName: match[1]!, tail: match[2]! };
  };

  type Variant = "AdmittedWithSchool" | "AdmittedPlacementPending" | "Rejected";

  /** The approved default copy of spec 0027 for one applicant, in subject, text and HTML. */
  const assertDefaultCopy = (
    message: HtmlMailDeliveryRequest,
    seeded: Seeded,
    semesterId: string,
    variant: Variant,
  ) => {
    const rejected = variant === "Rejected";
    const { departmentName } = subjectParts(message.subject, semesterId);

    assert.equal(message.recipient, seeded.email, "the submitted application's email");
    assert.equal(
      message.subject,
      `Opptaksresultat – ${departmentName}, ${semesterId}: ${rejected ? "Avslag" : "Tatt opp"}`,
    );

    for (const line of [
      `Hei ${seeded.firstName},`,
      rejected
        ? `Utfall: Avslag. Du fikk dessverre ikke plass i Vektorprogrammet i ${departmentName} for ${semesterId}.`
        : `Utfall: Tatt opp. Du er tatt opp som assistent i Vektorprogrammet i ${departmentName} for ${semesterId}.`,
      ...(variant === "AdmittedWithSchool" ? [`Skole: ${schoolName}.`] : []),
      ...(variant === "AdmittedPlacementPending" ? ["Skoleplassering kommer."] : []),
      "Vennlig hilsen",
      "Vektorprogrammet",
    ])
      assert.ok(message.text.includes(line), `${seeded.key}: text has "${line}"`);

    assert.ok(message.html.includes("<html"), "HTML mail");

    for (const fragment of [departmentName, semesterId, rejected ? "Avslag" : "Tatt opp"])
      assert.ok(message.html.includes(fragment), `${seeded.key}: HTML has ${fragment}`);

    assert.equal(message.html.includes(schoolName), variant === "AdmittedWithSchool");
    assert.equal(message.text.includes(schoolName), variant === "AdmittedWithSchool");

    if (rejected) assert.ok(!message.text.includes("Skole"));

    for (const field of [message.subject, message.text, message.html])
      assert.ok(!/\{(firstName|departmentName|semesterName|schoolName)\}/u.test(field), "placeholders are filled");
  };

  assertDefaultCopy(delivered.get(jaMail[0].effectId)!.message, api.ja, openSemesterId, "AdmittedPlacementPending");
  const maybeMail = (await envelopesOf(maybeId))[0];
  assertDefaultCopy(delivered.get(maybeMail.effectId)!.message, api.maybe, openSemesterId, "Rejected");
  gates.push(
    "the token-protected loopback mailbox received one strict subject/html/text mail per announcement, equal to the queued outbox bytes, with the approved default copy",
  );

  const manifest = {
    revision,
    backendOrigin,
    dashboardOrigin,
    artifacts,
    departmentId,
    semesterId: historicalSemesterId,
    noPeriodSemesterId,
    leaderPersonId,
    applicants: Object.fromEntries(
      Object.entries(browserApplicants).map(([name, seeded]) => [
        name,
        { applicationId: seeded.applicationId, name: `${seeded.firstName} ${seeded.lastName}` },
      ]),
    ),
    persons,
  };

  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const openScopeBefore = await scopeOutcomes(openPeriodId);
  const openOutboxBefore = await outboxRows(openPeriodId);
  let browserEvidence: Schema.JsonObject | null = null;

  if (process.argv.includes("--browser")) {
    run(
      "bun",
      ["apps/dashboard/e2e/run-real-native-admission-outcomes.mjs"],
      {
        ...environment,
        ADMISSION_OUTCOME_JOURNEY_MANIFEST: manifestPath,
      },
      600_000,
    );
    browserEvidence = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject))(
      await readFile(join(artifacts, "browser-evidence.json"), "utf8"),
    );
    assert.equal(browserEvidence.passed, true);
    assert.equal(browserEvidence.revision, revision);

    const announcements = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          key: Schema.String,
          kind: Schema.Literals(["AdmittedWithSchool", "AdmittedPlacementPending", "Rejected"]),
          template: Schema.Literals(["default", "custom"]),
        }),
      ),
    )(browserEvidence.announcements);

    const history = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Array(Schema.Unknown)))(
      browserEvidence.finalHistory,
    );

    for (const key of ["maybe", "returning"])
      assert.deepEqual(
        await outcomeHistory(browserApplicants[key]!.applicationId),
        history[key],
        `browser decisions of ${key} independently observed in PostgreSQL`,
      );

    // Ja and Nei derive their outcome at the announcement: one revision with no human decider.
    for (const [key, outcome] of [
      ["jaFree", "Admitted"],
      ["jaPlaced", "Admitted"],
      ["jaPlacedLate", "Admitted"],
      ["neiFree", "Rejected"],
      ["markup", "Rejected"],
    ] as const)
      assert.deepEqual(
        await outcomeHistory(browserApplicants[key]!.applicationId),
        [{ revision: 1, outcome, decidedBy: null }],
        `${key} is final after its announcement`,
      );

    for (const key of ["undecided", "neiPlaced"])
      assert.deepEqual(
        await outcomeHistory(browserApplicants[key]!.applicationId),
        [],
        `${key} keeps no outcome`,
      );
    assert.deepEqual(
      await scopeOutcomes(openPeriodId),
      openScopeBefore,
      "browser commands do not change another semester",
    );
    assert.deepEqual(await outboxRows(openPeriodId), openOutboxBefore, "browser commands queue no mail elsewhere");

    const announced = (
      await database.query(
        "SELECT application_id AS \"applicationId\", announced_by_person_id AS \"announcedBy\" FROM public.admission_outcome_announcements WHERE application_id = ANY($1) ORDER BY application_id",
        [Object.values(browserApplicants).map((seeded) => seeded.applicationId)],
      )
    ).rows;

    assert.deepEqual(
      announced,
      announcements
        .map(({ key }) => ({
          applicationId: browserApplicants[key]!.applicationId,
          announcedBy: coordinatorPersonId,
        }))
        .toSorted((left, right) => left.applicationId.localeCompare(right.applicationId)),
      "exactly the announced applications are final, by the coordinator",
    );

    const browserRows = await outboxRows(historicalPeriodId);
    assert.deepEqual(
      browserRows.map((row: { applicationId: string }) => row.applicationId).toSorted(),
      announcements.map(({ key }) => browserApplicants[key]!.applicationId).toSorted(),
      "one envelope per announced application, none for a refusal, a stale tab or a decision",
    );

    await assertMailboxMatchesOutbox("browser");

    // Default copy for the three variants, before any template was edited.
    for (const { key, kind } of announcements.filter(({ template }) => template === "default")) {
      const seeded = browserApplicants[key]!;
      const [envelope] = await envelopesOf(seeded.applicationId);
      const mail = delivered.get(envelope.effectId)!.message;

      assertDefaultCopy(mail, seeded, historicalSemesterId, kind);
    }

    // Custom copy: each mail is exactly what the server renders from the saved department template.
    const departmentSet = await read(`${templates}?departmentId=${departmentId}`, coordinator);

    const labels = {
      AdmittedWithSchool: "med skole",
      AdmittedPlacementPending: "venter",
      Rejected: "avslag",
    } as const;

    for (const kind of ["AdmittedWithSchool", "AdmittedPlacementPending", "Rejected"] as const) {
      const entry = departmentSet.templates.find((candidate: { kind: string }) => candidate.kind === kind);
      assert.equal(entry.provenance, "Department", `${kind} is the coordinator's department template`);
    }

    for (const { key, kind } of announcements.filter(({ template }) => template === "custom")) {
      const seeded = browserApplicants[key]!;
      const mail = delivered.get((await envelopesOf(seeded.applicationId))[0].effectId)!.message;
      const entry = departmentSet.templates.find((candidate: { kind: string }) => candidate.kind === kind);
      const { departmentName } = subjectParts(mail.subject, historicalSemesterId);

      const common = {
        firstName: seeded.firstName,
        departmentName,
        semesterName: historicalSemesterId,
      };

      const values = kind === "AdmittedWithSchool" ? { ...common, schoolName } : common;

      const rendered = await request(
        `${templates}/${kind}:preview?departmentId=${departmentId}`,
        coordinator,
        { subject: entry.subject, body: entry.body, sample: values },
        undefined,
        null,
      );

      assert.equal(rendered.status, 200, await rendered.clone().text());
      assert.deepEqual(
        { subject: mail.subject, html: mail.html, text: mail.text },
        await rendered.json(),
        `${key}: the sent mail equals the server preview of the saved template`,
      );
      assert.equal(mail.recipient, seeded.email);
      assert.equal(mail.subject, `Opptaksresultat - ${departmentName}, ${historicalSemesterId}: Egendefinert ${labels[kind]}`);
      assert.ok(mail.text.includes(`Hei ${seeded.firstName},`), `${key}: custom text`);
      assert.ok(mail.text.includes("Hilsen oss") && /<(strong|b)[\s>]/u.test(mail.html), "bold mark renders");

      if (kind === "AdmittedWithSchool") assert.ok(mail.text.includes(`Skole: ${schoolName}.`));

      if (key === "markup")
        assert.ok(mail.html.includes("&lt;img") && !mail.html.includes("<img"), "markup is escaped text");
    }

    // Nothing else arrives: the mailbox is quiet after the last delivery and every request was strict.
    await sleep(deliveryPollMilliseconds * 5);
    await assertMailboxMatchesOutbox("quiescent");
    gates.push(
      "after the browser journey the mailbox holds exactly one mail per announcement: default copy for each variant, then the saved department templates byte-equal to the server preview",
    );
  }

  assert.deepEqual(refusedMail, ["unauthorized"], "the mailbox refused only the token probe");

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
    mailCount: delivered.size,
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
    mailCount: delivered.size,
  };
} catch (error) {
  process.stderr.write(outputs.join("").slice(-12000));
  throw error;
} finally {
  if (database) await database.end();

  for (const child of children.reverse()) await stopOwnedProcess(child);
  mailbox.closeAllConnections();
  await new Promise<void>((resolve) => {
    mailbox.close(() => resolve());
  });
  await postgres?.stop();
  await rm(join(artifacts, "manifest.json"), { force: true });

  if (evidence && summary) {
    const evidencePath = join(artifacts, "evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify(
        Struct.assign(evidence, {
          cleanup:
            "owned processes and loopback mailbox exited; disposable PostgreSQL and credential manifest removed",
        }),
        null,
        2,
      ),
    );
    process.stdout.write(`${JSON.stringify({ passed: true, evidencePath, ...summary })}\n`);
  }
}
