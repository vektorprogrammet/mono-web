import type { RecruitmentInvitationDeliveryResult } from "../../packages/database/src/recruitment/outbox.js";
import { isNativeRpcPath, nativeRpcPath } from "../../packages/rpc/src/api.js";
import { IdempotencyKey, NativeProblem } from "../../packages/rpc/src/problem.js";
import { nativeScriptClient } from "../../packages/rpc/src/script-client.js";
import {
  RecruitmentInterviewResource,
  ScheduleInterviewResponse,
  FinalizeInterviewResponse,
} from "../../packages/rpc/src/v2-schemas.js";
import {
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInvitationResponseObservationSchema,
} from "../../packages/domain/src/recruitment/schema.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Browser, Locator, Page, Route } from "@playwright/test";
import { AdmissionFieldOfStudyId } from "../../packages/domain/src/admission-period/schema.js";
import { publicApplicationCommandDigest } from "../../packages/domain/src/application/digest.js";
import { ReturningAssistantRegistrationInputSchema } from "../../packages/domain/src/application/returning.js";
import {
  SubmitPublicApplicationCommandSchema,
  PublicApplicationCommandIdSchema,
  PublicApplicationEmailSchema,
  PublicApplicationGenderSchema,
  PublicApplicationNameSchema,
  PublicApplicationPhoneSchema,
  PublicApplicationYearOfStudySchema,
} from "../../packages/domain/src/application/schema.js";
import { DepartmentId } from "../../packages/domain/src/organization/schema.js";
import {
  type Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Match,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { AcceptanceCommandFailed } from "./acceptance-process.ts";
import { indentedJsonText } from "./acceptance-process.ts";
import { committed, firstSetCookie, jsonText, step, thrownBy } from "./journey-step.ts";
import { admissionJourneyClock } from "../e2e/journey-clock.ts";
import { replacedFetch } from "../../apps/dashboard/e2e/native-rpc-ledger.ts";

/** Runs a command to completion and answers its standard output. */
export type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
) => Effect.Effect<
  string,
  AcceptanceCommandFailed | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
>;

/** A statement of the returning seed that failed, named by its label. */
class ReturningSeedFailed extends Data.TaggedError("ReturningSeedFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** A browser action of the returning journey that failed, with the evidence of its phase written. */
class ReturningBrowserActionFailed extends Data.TaggedError("ReturningBrowserActionFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The name of a thrown error. */
const errorName = (error: Error): string => error.name;

const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The value of a JSON text, decoded through Schema. */
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** One RPC request on the JSON wire, as a browser sends it without the typed client. */
const WireRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

/** The one answer of a request that succeeded. */
const WireSuccess = Schema.Tuple([
  Schema.TaggedStruct("Exit", { exit: Schema.TaggedStruct("Success", { value: Schema.Unknown }) }),
]);

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

const originalPublicCommand =
  SubmitPublicApplicationCommandSchema.cases.SubmitPublicApplication.make({
    commandId: PublicApplicationCommandIdSchema.make(originalPublicCommandId),
    departmentId: DepartmentId.make(departmentId),
    firstName: PublicApplicationNameSchema.make("Rita"),
    lastName: PublicApplicationNameSchema.make("Tilbake"),
    phone: PublicApplicationPhoneSchema.make("90000104"),
    email: PublicApplicationEmailSchema.make("rita.returning@example.invalid"),
    gender: PublicApplicationGenderSchema.make(0),
    fieldOfStudyId: AdmissionFieldOfStudyId.make(fieldOfStudyId),
    yearOfStudy: PublicApplicationYearOfStudySchema.make(2),
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

const originalPublicCommandDigest = publicApplicationCommandDigest(originalPublicCommand);

const placementId = `placement-${"f".repeat(64)}`;

const teamId = "team-native-conduct-0063";

const foreignDepartmentId = "department-returning-foreign-0104";

const foreignTeamId = "team-returning-foreign-0104";

// The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the
// current time. The conduct seed derives its semester, period, and interviews from the same
// instant, so every instant below stays coherent with those windows.
const { fromNow: fromJourneyNow } = admissionJourneyClock();

// The next semester and period open one day after the conduct period opens and stay open
// after it ends.
const nextPeriodStartAt = fromJourneyNow(-29);

const nextPeriodEndAt = fromJourneyNow(90);

// A closed period ends after it starts and before the run.
const nextPeriodClosedEndAt = fromJourneyNow(-28);

const conductPeriodClosedEndAt = fromJourneyNow(-8);

// The original application was submitted in the conduct period, then interviewed, and its
// applicant account was claimed afterwards.
const applicationSubmittedAt = fromJourneyNow(-21);

const interviewAssignedAt = fromJourneyNow(-20);

const interviewFinalizedAt = fromJourneyNow(-19);

const accountClaimIssuedAt = fromJourneyNow(-14);

const accountLinkedAt = fromJourneyNow(-13);

const accountClaimExpiresAt = fromJourneyNow(120);

const placementCreatedAt = fromJourneyNow(-57);

// The backend rejects a schedule at or before its clock.
const nextInterviewScheduledAt = fromJourneyNow(7);

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

/**
 * One recruitment RPC as the page's browser context would send it: with the context's cookies and
 * the dashboard origin, answered as the HTTP response of the route that the RPC replaced.
 */
const pageRpc = (
  page: Page,
  input: {
    readonly api: string;
    readonly ui: string;
    readonly tag: string;
    readonly payload: Schema.Json;
  },
) =>
  page
    .context()
    .cookies(input.api)
    .then((cookies) =>
      replacedFetch({
        origin: input.api,
        tag: input.tag,
        payload: input.payload,
        headers: {
          origin: input.ui,
          cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
        },
      }),
    )
    .then((response) =>
      response.text().then((text) => ({
        status: () => response.status,
        headers: () => Object.fromEntries(response.headers),
        text: () => Promise.resolve(text),
      })),
    );

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

export const seedReturningAssistant = Effect.fnUntraced(function* ({
  pool,
  run,
  env,
  root,
}: {
  readonly pool: Pool;
  readonly run: RunCommand;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly root: string;
}) {
  const path = yield* Path.Path;

  yield* run(
    "bun",
    ["run", "identity:seed"],
    {
      ...env,
      IDENTITY_SEED_PG_URL: env.JOURNEY_SEED_PG_URL,
      NATIVE_IDENTITY_TRUSTED_ORIGINS: env.NATIVE_IDENTITY_TRUSTED_ORIGINS,
      IDENTITY_SEED_PERSONS: yield* jsonText([person, ...negativeProbePersons]),
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    },
    path.join(root, "packages/database"),
  );

  yield* Effect.acquireUseRelease(
    step(() => pool.connect()),
    (client: PoolClient) => {
      const seedQuery = (label: string, text: string, values?: unknown[]) =>
        step(() => (values === undefined ? client.query(text) : client.query(text, values))).pipe(
          Effect.mapError(
            (failed) =>
              new ReturningSeedFailed({
                message: `returning seed ${label}: ${failed.cause instanceof Error ? failed.cause.message : String(failed.cause)}`,
                cause: failed.cause,
              }),
          ),
        );

      return committed(
        client,
        Effect.gen(function* () {
          yield* seedQuery(
            "next semester",
            `INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at,revision)
       VALUES($1,$2,$3,0)
       ON CONFLICT (semester_id) DO NOTHING`,
            [nextSemesterId, nextPeriodStartAt, nextPeriodEndAt],
          );
          yield* seedQuery(
            "next admission period",
            `INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id)
       VALUES($1,$2,$3,$4,$5,0,'returning-next-period-seed-0104')
       ON CONFLICT (admission_period_id) DO NOTHING`,
            [
              nextAdmissionPeriodId,
              departmentId,
              nextSemesterId,
              nextPeriodStartAt,
              nextPeriodEndAt,
            ],
          );
          yield* seedQuery(
            "historical department",
            `INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision)
       VALUES($1,'Returning History','RH','returning-history@example.invalid','History City',true,0)
       ON CONFLICT (department_id) DO NOTHING`,
            [historicalDepartmentId],
          );
          yield* seedQuery(
            "foreign department",
            `INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision)
       VALUES($1,'Returning Foreign','RF','returning-foreign@example.invalid','Foreign City',true,0)
       ON CONFLICT (department_id) DO NOTHING`,
            [foreignDepartmentId],
          );
          yield* seedQuery(
            "foreign team",
            `INSERT INTO public.organization_teams(team_id,department_id,name)
       VALUES($1,$2,'Returning Foreign Team')
       ON CONFLICT (team_id) DO NOTHING`,
            [foreignTeamId, foreignDepartmentId],
          );
          yield* seedQuery(
            "historical semester",
            `INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at,revision)
       VALUES($1,'2025-01-01T00:00:00Z','2025-06-30T23:59:59.999Z',0)
       ON CONFLICT (semester_id) DO NOTHING`,
            [historicalSemesterId],
          );
          yield* seedQuery(
            "volunteer affiliation",
            `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
            [person.personId, departmentId],
          );
          yield* seedQuery(
            "volunteer affiliation audit",
            `INSERT INTO public.organization_volunteer_affiliation_audit(person_id,department_id,revision,action,actor_person_id,occurred_at)
       VALUES($1,$2,1,'Establish','journey-conduct-leader-0063','2026-01-04T00:00:00Z') ON CONFLICT DO NOTHING`,
            [person.personId, departmentId],
          );
          yield* seedQuery(
            "applicant",
            `INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest)
       VALUES($1,'rita.returning@example.invalid','rita.returning@example.invalid','Rita','Tilbake','90000104',0,$2,2,$3) ON CONFLICT DO NOTHING`,
            [applicantId, fieldOfStudyId, originalActivationDigest],
          );
          yield* seedQuery(
            "application",
            `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
       VALUES($1,$2,$3,$4,$5,2,$6,0) ON CONFLICT DO NOTHING`,
            [
              applicationId,
              applicantId,
              admissionPeriodId,
              departmentId,
              fieldOfStudyId,
              applicationSubmittedAt,
            ],
          );
          yield* seedQuery(
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
         $11::text,$12
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
              applicationSubmittedAt,
            ],
          );
          yield* seedQuery(
            "original public audit",
            `INSERT INTO public.admission_application_audit(
         command_id,application_id,applicant_id,action,application_revision,occurred_at
       ) VALUES($1,$2,$3,'PublicApplicationSubmitted',0,$4)
       ON CONFLICT DO NOTHING`,
            [originalPublicCommandId, applicationId, applicantId, applicationSubmittedAt],
          );
          yield* seedQuery(
            "invitation",
            `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
       VALUES($1,$2,$3,$4,$5,'Claimed','journey-conduct-leader-0063',$6) ON CONFLICT DO NOTHING`,
            [
              invitationId,
              applicationId,
              applicantId,
              createHash("sha256").update(invitationId).digest("hex"),
              accountClaimExpiresAt,
              accountClaimIssuedAt,
            ],
          );
          yield* seedQuery(
            "account link",
            `INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [applicantId, person.personId, accountLinkedAt, invitationId],
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
            yield* seedQuery(
              `negative applicant ${index}`,
              `INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study,activation_digest)
         VALUES($1,$2,$2,'Negative','Probe','9000010${index}',0,$3,2,NULL) ON CONFLICT DO NOTHING`,
              [negative.applicantId, negative.email, negative.field],
            );
            yield* seedQuery(
              `negative application ${index}`,
              `INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
         VALUES($1,$2,$3,$4,$5,2,$6,0) ON CONFLICT DO NOTHING`,
              [
                negative.applicationId,
                negative.applicantId,
                admissionPeriodId,
                departmentId,
                negative.field,
                applicationSubmittedAt,
              ],
            );
            const negativeInvitation = `invitation-returning-negative-${index}-0104`;
            yield* seedQuery(
              `negative invitation ${index}`,
              `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
         VALUES($1,$2,$3,$4,$5,'Claimed','journey-conduct-leader-0063',$6) ON CONFLICT DO NOTHING`,
              [
                negativeInvitation,
                negative.applicationId,
                negative.applicantId,
                createHash("sha256").update(negativeInvitation).digest("hex"),
                accountClaimExpiresAt,
                accountClaimIssuedAt,
              ],
            );
            yield* seedQuery(
              `negative account link ${index}`,
              `INSERT INTO public.applicant_account_links(applicant_id,person_id,linked_at,invitation_id)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [negative.applicantId, negative.personId, accountLinkedAt, negativeInvitation],
            );
          }

          yield* seedQuery(
            "no-placement affiliation",
            `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
            [negativeProbePersons[0].personId, departmentId],
          );
          yield* seedQuery(
            "invalid-study affiliation",
            `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Active',1) ON CONFLICT DO NOTHING`,
            [negativeProbePersons[3].personId, departmentId],
          );
          yield* seedQuery(
            "school",
            `INSERT INTO public.schools_directory_schools(name,contact_person,email,phone,language,active,revision)
       VALUES('Returning School','School Contact','school-returning@example.invalid','+47 900000106','Norwegian',true,0) ON CONFLICT DO NOTHING`,
          );

          const school = yield* seedQuery(
            "school lookup",
            "SELECT school_id FROM public.schools_directory_schools WHERE name='Returning School'",
          );

          assert.equal(school.rows.length, 1);
          yield* seedQuery(
            "school department",
            "INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
            [school.rows[0].school_id, departmentId],
          );
          yield* seedQuery(
            "historical school department",
            "INSERT INTO public.schools_directory_departments(school_id,department_id,revision) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
            [school.rows[0].school_id, historicalDepartmentId],
          );
          yield* seedQuery(
            "historical volunteer affiliation",
            `INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision)
       VALUES($1,$2,'Inactive',1) ON CONFLICT DO NOTHING`,
            [person.personId, historicalDepartmentId],
          );
          yield* seedQuery(
            "historical placement",
            `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Tuesday',4,'1',false,2) ON CONFLICT DO NOTHING`,
            [
              `placement-${"0".repeat(64)}`,
              person.personId,
              historicalDepartmentId,
              historicalSemesterId,
              school.rows[0].school_id,
            ],
          );
          yield* seedQuery(
            "placement",
            `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Monday',4,'1',true,1) ON CONFLICT DO NOTHING`,
            [placementId, person.personId, departmentId, semesterId, school.rows[0].school_id],
          );
          yield* seedQuery(
            "invalid-study placement",
            `INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision)
       VALUES($1,$2,$3,$4,$5,'Monday',4,'1',true,1) ON CONFLICT DO NOTHING`,
            [
              `placement-${"b".repeat(64)}`,
              negativeProbePersons[3].personId,
              departmentId,
              semesterId,
              school.rows[0].school_id,
            ],
          );
          yield* seedQuery(
            "placement audit",
            `INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot)
       VALUES($1::text,1,$2::text,$6,'Create',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Monday','workdays',4,'block','1','active',true,'revision',1)) ON CONFLICT DO NOTHING`,
            [
              placementId,
              person.personId,
              departmentId,
              semesterId,
              school.rows[0].school_id,
              placementCreatedAt,
            ],
          );
          yield* seedQuery(
            "historical placement audit",
            `INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot)
       VALUES
       ($1,1,'journey-conduct-leader-0063','2025-01-04T00:00:00Z','Create',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Tuesday','workdays',4,'block','1','active',true,'revision',1)),
       ($1,2,'journey-conduct-leader-0063','2025-06-30T00:00:00Z','Remove',jsonb_build_object('placementId',$1::text,'personId',$2::text,'departmentId',$3::text,'semesterId',$4::text,'schoolId',$5::text,'day','Tuesday','workdays',4,'block','1','active',false,'revision',2))
       ON CONFLICT DO NOTHING`,
            [
              `placement-${"0".repeat(64)}`,
              person.personId,
              historicalDepartmentId,
              historicalSemesterId,
              school.rows[0].school_id,
            ],
          );
          yield* seedQuery(
            "interview",
            `INSERT INTO public.recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision)
       VALUES('interview-returning-0104',$1,$2,'journey-returning-assistant-0104','interview-schema-native-conduct-0063','journey-conduct-leader-0063',$3,1) ON CONFLICT DO NOTHING`,
            [applicationId, departmentId, interviewAssignedAt],
          );
          yield* seedQuery(
            "question snapshots",
            `INSERT INTO public.recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,help_text,kind,alternatives)
       SELECT 'interview-returning-0104',question_id,ordinal,prompt,help_text,kind,alternatives
       FROM public.recruitment_interview_schema_questions
       WHERE interview_schema_id='interview-schema-native-conduct-0063'
       ON CONFLICT DO NOTHING`,
          );
          yield* seedQuery(
            "interview conduct",
            `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation)
       VALUES('interview-returning-0104','[]'::jsonb,8,8,8,'journey-conduct-leader-0063',$1,1,'Ja') ON CONFLICT DO NOTHING`,
            [interviewFinalizedAt],
          );
        }),
      );
    },
    (client) => Effect.sync(() => client.release()),
  );

  const counts = yield* step(() =>
    pool.query(
      `SELECT (SELECT count(*)::int FROM public.applicant_account_links WHERE person_id=$1) links,
            (SELECT count(*)::int FROM public.assistant_placements WHERE person_id=$1) placements,
            (SELECT count(*)::int FROM public.organization_departments WHERE department_id=$2) foreign_departments,
            (SELECT count(*)::int FROM public.organization_teams WHERE team_id=$3 AND department_id=$2) foreign_teams`,
      [person.personId, foreignDepartmentId, foreignTeamId],
    ),
  );

  assert.deepEqual(counts.rows[0], {
    links: 1,
    placements: 2,
    foreign_departments: 1,
    foreign_teams: 1,
  });
});

export const runReturningAssistantBrowserJourney = Effect.fnUntraced(function* <
  AuditError,
  DeliveryError,
>({
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
  readonly auditPage: (page: Page, state: string) => Effect.Effect<unknown, AuditError>;
  readonly errors: string[];
  readonly stage?: (name: string) => void;
  readonly coordinatorEmail: string;
  readonly coordinatorPassword: string;
  readonly readInvitationCapability?: (interviewId: string) => string | undefined;
  readonly deliverRecruitmentInvitation?: (
    claimId: string,
  ) => Effect.Effect<RecruitmentInvitationDeliveryResult, DeliveryError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trace: Array<Schema.JsonObject> = [];

  /** Writes the journey trace, indented by two spaces as the evidence files are. */
  const writeTrace = Effect.gen(function* () {
    yield* fs.writeFileString(
      path.join(artifacts, "returning-registration-trace.json"),
      yield* indentedJsonText(trace),
    );
  });

  yield* Effect.gen(function* () {
    stage?.("returning:browser.newContext");
    const context = yield* step(() => browser.newContext());
    const responses: string[] = [];
    stage?.("returning:browser.newPage");
    const returning = yield* step(() => context.newPage());
    returning.on("request", (request) => {
      const url = new URL(request.url());

      if (
        url.pathname.includes("/dashboard/tidligere-assistenter") ||
        isNativeRpcPath(url.pathname) ||
        url.pathname.includes("/api/auth/")
      ) {
        responses.push(`request ${request.method()} ${url.pathname}`);
      }
    });
    returning.on("framenavigated", (frame) => {
      if (frame === returning.mainFrame())
        responses.push(`navigation ${new URL(frame.url()).pathname}`);
    });
    returning.on("response", (response) => {
      const url = new URL(response.url());

      if (
        !url.pathname.includes("/dashboard/tidligere-assistenter") &&
        !isNativeRpcPath(url.pathname) &&
        !url.pathname.includes("/api/auth/")
      )
        return;

      const note = (code: string) =>
        responses.push(`response ${response.status()} ${url.pathname} code=${code}`);

      if (!url.pathname.endsWith(".data")) {
        note("unknown");

        return;
      }

      return response
        .text()
        .catch(() => "")
        .then((body) => {
          const value = decodeJsonOption(body);

          note(
            Option.isSome(value) &&
              Predicate.isObjectOrArray(value.value) &&
              "code" in value.value &&
              Predicate.isString(value.value.code)
              ? value.value.code
              : "unknown",
          );
        });
    });
    returning.on("pageerror", (error: Error) => errors.push(`returning:${error.message}`));

    const captureReturningFailure = Effect.fnUntraced(function* (
      phase: string,
      failure: Cause.Cause<unknown>,
    ) {
      const cause = thrownBy(failure);
      const markup = yield* step(() => returning.content().catch(() => "<unavailable>"));
      yield* fs.writeFileString(
        path.join(artifacts, `returning-${phase}-failure.html`),
        markup.replaceAll(person.email, "[redacted]"),
      );
      yield* step(() =>
        returning.screenshot({
          path: path.join(artifacts, `returning-${phase}-failure.png`),
          fullPage: true,
        }),
      );
      const kind = cause.name;
      const causeMessage = cause.message;
      yield* writeTrace;

      return yield* new ReturningBrowserActionFailed({
        message: `returning ${phase} failed phase=browser-action kind=${kind} cause=${causeMessage} url=${returning.url()} responses=${responses.join(" | ")}`,
        cause,
      });
    });

    /** Runs a browser action; its failure is captured as the evidence of the phase, then fails. */
    const capturedAs =
      (phase: string) =>
      <A, E, R>(action: Effect.Effect<A, E, R>) =>
        action.pipe(Effect.catchCause((failure) => captureReturningFailure(phase, failure)));

    returning.on("request", (request) => {
      const url = new URL(request.url());

      if (
        request.method() === "POST" &&
        url.pathname.startsWith("/dashboard/tidligere-assistenter")
      ) {
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

    yield* Effect.gen(function* () {
      yield* step(() =>
        returning.goto(`${ui}/login?redirectTo=${encodeURIComponent(destination)}`),
      );
      yield* step(() => returning.getByLabel("E-post", { exact: true }).fill(person.email));
      yield* step(() => returning.getByLabel("Passord", { exact: true }).fill(person.password));
      yield* step(() =>
        returning
          .getByRole("button", { name: "Logg inn", exact: true })
          .click({ noWaitAfter: true }),
      );
      yield* step(() => returning.waitForURL(/\/dashboard\/tidligere-assistenter$/));
    }).pipe(capturedAs("login"));

    const cookieHeader = (yield* step(() => context.cookies()))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    const native = nativeScriptClient(api);

    /** The browser context's current session, sent from the dashboard origin. */
    const sessionHeaders = Effect.fnUntraced(function* () {
      return {
        cookie: (yield* step(() => context.cookies()))
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; "),
        origin: ui,
      };
    });

    const readOptions = (headers: Readonly<Record<string, string>>) =>
      native.call(headers, (client) => client["admissions.readReturningAssistantOptions"]());

    /** Registers as the browser context's person; the request decodes through the contract. */
    const register = Effect.fnUntraced(function* (
      idempotencyKey: string,
      data: typeof ReturningAssistantRegistrationInputSchema.Encoded,
    ) {
      const request = yield* Schema.decodeEffect(ReturningAssistantRegistrationInputSchema)(data);

      const headers = yield* sessionHeaders();

      return yield* step(() =>
        native.call(headers, (client) =>
          client["admissions.registerReturningAssistant"]({
            idempotencyKey: IdempotencyKey.make(idempotencyKey),
            request,
          }),
        ),
      );
    });

    const optionsAnswer = yield* step(() => readOptions({ origin: ui, cookie: cookieHeader }));

    const waitForDashboardAction = Effect.fnUntraced(function* <E, R>(
      periodId: string,
      trigger: () => Effect.Effect<void, E, R>,
    ) {
      const responsePromise = returning.waitForResponse(
        (response) => {
          const url = new URL(response.url());

          if (
            response.request().method() !== "POST" ||
            !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(
              url.pathname,
            )
          )
            return false;
          const body = new URLSearchParams(response.request().postData() ?? "");

          return body.get("admissionPeriodId") === periodId;
        },
        { timeout: 30_000 },
      );

      yield* trigger();
      const response = yield* step(() => responsePromise);
      yield* step(() => response.finished());
      assert.equal(response.status(), 200);
      const body = new URLSearchParams(response.request().postData() ?? "");

      return {
        phase: "dashboard-post",
        form: [...body.entries()],
        admissionPeriodId: body.get("admissionPeriodId"),
        expectedRevision: body.get("expectedRevision"),
        commandId: body.get("commandId"),
      };
    });

    const waitForActionReady = Effect.fnUntraced(function* (form: Locator) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (yield* step(() => form.locator('button[type="submit"]').isEnabled())) === true &&
          (yield* step(() => form.getAttribute("data-pending"))) === "false"
        )
          return;
        yield* Effect.sleep("100 millis");
      }

      throw new Error("returning form did not become ready for action");
    });

    responses.push(`context.request options ${optionsAnswer.status}`);

    const negativeMutationSnapshot = Effect.fnUntraced(function* (personId: string) {
      return (yield* step(() =>
        pool.query(
          `SELECT
         (SELECT count(*)::int FROM public.applicant_account_links WHERE person_id=$1) AS links,
         (SELECT count(*)::int FROM public.admission_applications a JOIN public.applicant_account_links l USING(applicant_id) WHERE l.person_id=$1) AS applications,
         (SELECT count(*)::int FROM public.admission_returning_registrations WHERE person_id=$1) AS registrations`,
          [personId],
        ),
      )).rows[0];
    });

    const probeNegativeOptions = Effect.fnUntraced(function* (
      gate: string,
      probePerson: (typeof negativeProbePersons)[number],
      expectedStatus: number,
    ) {
      const signInRequest = HttpClientRequest.post(`${api}/api/auth/sign-in/email`).pipe(
        HttpClientRequest.setHeaders({ origin: ui }),
        HttpClientRequest.bodyText(
          yield* jsonText({ email: probePerson.email, password: probePerson.password }),
          "application/json",
        ),
      );

      let signIn = yield* HttpClient.execute(signInRequest);

      for (let retry = 0; signIn.status === 429 && retry < 30; retry += 1) {
        yield* Effect.sleep("1 second");
        signIn = yield* HttpClient.execute(signInRequest);
      }

      assert.equal(signIn.status, 200, `${gate} sign-in`);
      const cookie = firstSetCookie(signIn);
      assert.ok(cookie, `${gate} session cookie`);
      const before = yield* negativeMutationSnapshot(probePerson.personId);

      const answer = yield* step(() => readOptions({ origin: ui, cookie }));
      const body = yield* jsonText(answer);
      assert.equal(answer.status, expectedStatus, `${gate} status body=${body}`);
      const after = yield* negativeMutationSnapshot(probePerson.personId);

      if ((yield* jsonText(after)) !== (yield* jsonText(before)))
        throw new Error(
          `${gate} must not mutate before=${yield* jsonText(before)} after=${yield* jsonText(after)}`,
        );
      trace.push({ phase: "negative-gate", gate, status: answer.status, body });
    });

    yield* probeNegativeOptions("no-placement-despite-affiliation", negativeProbePersons[0], 404);
    yield* probeNegativeOptions("missing-applicant-person-link", negativeProbePersons[1], 404);
    yield* probeNegativeOptions("multiple-applicant-person-links", negativeProbePersons[2], 409);
    yield* step(() =>
      pool.query(
        "UPDATE public.admission_period_fields_of_study SET active=false WHERE field_of_study_id=$1",
        [fieldOfStudyId],
      ),
    );

    yield* probeNegativeOptions("inactive-study-mapping", negativeProbePersons[3], 409).pipe(
      Effect.ensuring(
        step(() =>
          pool.query(
            "UPDATE public.admission_period_fields_of_study SET active=true WHERE field_of_study_id=$1",
            [fieldOfStudyId],
          ),
        ).pipe(Effect.orDie),
      ),
    );

    const mappingKey = yield* step(() =>
      pool.query(
        `SELECT to_jsonb(array_agg(a.attname::text ORDER BY k.ordinality)) AS columns
     FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
     WHERE i.indrelid='public.admission_period_fields_of_study'::regclass AND i.indisprimary
     GROUP BY i.indexrelid`,
      ),
    );

    const expectedMappingKey = [{ columns: ["field_of_study_id"] }];

    if ((yield* jsonText(mappingKey.rows)) !== (yield* jsonText(expectedMappingKey)))
      throw new Error(
        `ambiguous-study-mapping structural key mismatch actual=${yield* jsonText(mappingKey.rows)} expected=${yield* jsonText(expectedMappingKey)}`,
      );
    trace.push({
      phase: "negative-gate",
      gate: "ambiguous-study-mapping-structural-primary-key",
      status: "proven",
    });

    // The browser calls the RPC with its own session cookie, across origins, as CORS admits it.
    const browserOptions = yield* step(() =>
      returning.evaluate(
        // Playwright serializes this callback and runs it in the browser page, whose fetch the
        // probe exercises; no Effect service reaches that runtime.
        ({ endpoint, message }) =>
          // oxlint-disable-next-line effecttsgo/global-fetch -- EX-0016: the callback runs in the browser page, where the probe exercises the page's own fetch.
          fetch(endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
          }).then((response) =>
            response.json().then((answer) => ({ status: response.status, answer })),
          ),
        {
          endpoint: `${api}${nativeRpcPath}`,
          message: WireRequest.make({
            id: "1",
            tag: "admissions.readReturningAssistantOptions",
            payload: null,
            headers: [],
          }),
        },
      ),
    );

    assert.equal(browserOptions.status, 200);
    // Decoding fails unless the answer is one successful exit.
    yield* Schema.decodeUnknownEffect(WireSuccess)(browserOptions.answer);
    trace.push({ phase: "options-probe", status: browserOptions.status });

    const originalCustody = yield* step(() =>
      pool.query(
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
      ),
    );

    assert.equal(originalCustody.rows.length, 1);

    const originalCustodyRow = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        activation_digest: Schema.String,
        public_receipts: Schema.Array(Schema.Json),
        public_audit: Schema.Array(Schema.Json),
      }),
    )(originalCustody.rows[0]);

    assert.notEqual(originalCustodyRow.activation_digest, null);
    assert.notEqual(originalCustodyRow.activation_digest, "");
    assert.ok(originalCustodyRow.public_receipts.length > 0);
    assert.ok(originalCustodyRow.public_audit.length > 0);
    let form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    stage?.("returning:form");

    yield* Effect.gen(function* () {
      yield* step(() =>
        form.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(nextAdmissionPeriodId),
      );
      yield* step(() => form.getByRole("combobox", { name: "Studieår" }).selectOption("4"));
      yield* step(() => form.getByLabel("Mandag", { exact: true }).check());
      yield* step(() => form.getByLabel("Torsdag", { exact: true }).check());
      yield* step(() => form.getByRole("combobox", { name: "Stillingslengde" }).selectOption("8"));
      yield* step(() =>
        form.getByRole("combobox", { name: "Semesterblokk" }).selectOption("block-1"),
      );
      yield* step(() =>
        form.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk"),
      );
      yield* step(() =>
        form.getByLabel("Ønsket skole (valgfritt)", { exact: true }).fill("Returning School"),
      );
      yield* step(() =>
        form.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).check(),
      );
      yield* step(() => form.locator(`input[name="teamIds"][value="${teamId}"]`).check());
    }).pipe(capturedAs("form"));

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

    const anonymousBefore = yield* negativeMutationSnapshot(person.personId);

    const anonymous = yield* step(() => readOptions({ origin: ui }));

    assert.equal(anonymous.status, 401);
    assert.deepEqual(yield* negativeMutationSnapshot(person.personId), anonymousBefore);
    trace.push({ phase: "negative-gate", gate: "anonymous-options", status: anonymous.status });

    const foreignTeam = yield* step(() =>
      pool.query(
        "SELECT team_id FROM public.organization_teams WHERE department_id<>$1 ORDER BY team_id LIMIT 1",
        [departmentId],
      ),
    );

    assert.equal(foreignTeam.rows.length, 1);
    const wrongTeamBefore = yield* negativeMutationSnapshot(person.personId);

    const wrongTeam = yield* register("returning-wrong-team-0104", {
      ...firstPayload,
      commandId: "returning-wrong-team-0104",
      teamInterest: true,
      teamIds: [foreignTeam.rows[0].team_id],
    });

    assert.ok(!wrongTeam.ok);
    assert.equal(wrongTeam.status, 403);
    assert.equal(wrongTeam.code, "returning.team-scope-denied");
    assert.deepEqual(yield* negativeMutationSnapshot(person.personId), wrongTeamBefore);
    trace.push({
      phase: "negative-gate",
      gate: "cross-department-team",
      status: wrongTeam.status,
      code: wrongTeam.code,
    });
    // The route handler below settles these; the journey awaits them as steps.
    const firstActionSettled = Promise.withResolvers<void>();
    const secondActionSettled = Promise.withResolvers<void>();

    const intercept = (route: Route): Promise<void> => {
      if (route.request().method() !== "POST") return route.continue();

      interceptedActions += 1;
      const formData = new URLSearchParams(route.request().postData() ?? "");
      const commandKey = formData.get("commandId");
      const expectedRevision = formData.get("expectedRevision");
      const phase = droppedResponse ? "retry" : "first";
      stage?.(`returning:mutation:${phase}:request`);

      return route.fetch({ timeout: 30_000 }).then((response) => {
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

          return response
            .body()
            .then(() => route.abort("failed"))
            .then(() => firstActionSettled.resolve());
        }

        if (commandKey !== firstCommandKey || expectedRevision !== firstExpectedRevision)
          routeFailure = "retry payload identity changed";

        if (status < 200 || status >= 300) routeFailure = `retry action status ${status}`;

        return route.fulfill({ response }).then(() => secondActionSettled.resolve());
      });
    };

    yield* step(() =>
      returning.route("**/dashboard/tidligere-assistenter*", (route) =>
        Promise.resolve()
          .then(() => intercept(route))
          .catch((cause: unknown) => {
            routeFailure = `intercepted ${interceptedActions === 1 ? "first" : "retry"} action failed`;
            (interceptedActions === 1 ? firstActionSettled : secondActionSettled).reject(cause);
          }),
      ),
    );
    stage?.("returning:mutation");
    let firstCommittedRow: unknown;

    yield* Effect.gen(function* () {
      stage?.("returning:mutation:first:click");
      yield* step(() => submit.click());
      stage?.("returning:mutation:first:await");
      yield* step(() => firstActionSettled.promise);
      stage?.("returning:mutation:first:settled");

      const firstCommittedBeforeRetry = yield* step(() =>
        pool.query(
          `SELECT *
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision`,
          [person.personId, nextAdmissionPeriodId],
        ),
      );

      assert.ok(firstCommandKey);
      assert.equal(firstCommittedBeforeRetry.rows.length, 1);
      firstCommittedRow = firstCommittedBeforeRetry.rows[0];
      trace.push({ phase: "first-before-retry", sqlCommitted: firstCommittedBeforeRetry.rows });
      stage?.("returning:mutation:recovery");
      const recovery = returning.getByRole("button", { name: "Prøv igjen", exact: true });

      const hasRecoveryControl = yield* step(() =>
        recovery
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      );

      const firstRequest = trace.find((entry) => entry.phase === "first");
      assert.ok(firstRequest && Array.isArray(firstRequest.form));

      const assertRecoveredIntent = Effect.fnUntraced(function* () {
        let lastError: unknown;

        for (let attempt = 0; attempt < 50; attempt += 1) {
          const outcome = yield* Effect.exit(
            Effect.gen(function* () {
              const restoredEntries = yield* step(() =>
                form.evaluate((node) => {
                  if (!(node instanceof HTMLFormElement))
                    throw new Error("Expected the returning-assistant form");

                  return [...new FormData(node)].map(([name, value]) => [name, String(value)]);
                }, undefined),
              );

              if ((yield* jsonText(restoredEntries)) !== (yield* jsonText(firstRequest.form)))
                throw new Error(
                  `recovered form intent mismatch actual=${yield* jsonText(restoredEntries)} expected=${yield* jsonText(firstRequest.form)}`,
                );

              const recoveredCommandId = yield* step(() =>
                form.locator('input[name="commandId"]').inputValue(),
              );

              if (recoveredCommandId !== firstCommandKey)
                throw new Error(
                  `recovered command id mismatch actual=${recoveredCommandId} expected=${firstCommandKey}`,
                );

              const recoveredRevision = yield* step(() =>
                form.locator('input[name="expectedRevision"]').inputValue(),
              );

              if (recoveredRevision !== firstExpectedRevision)
                throw new Error(
                  `recovered base revision mismatch actual=${recoveredRevision} expected=${firstExpectedRevision}`,
                );
            }),
          );

          if (Exit.isSuccess(outcome)) return;
          lastError = thrownBy(outcome.cause);
          yield* Effect.sleep("100 millis");
        }

        throw lastError;
      });

      if (hasRecoveryControl === true) yield* step(() => recovery.click());
      form = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
      yield* step(() => form.waitFor({ state: "visible" }));
      submit = form.locator('button[type="submit"]');
      yield* step(() => submit.waitFor({ state: "visible" }));
      assert.equal(yield* step(() => submit.isEnabled()), true);
      assert.equal(yield* step(() => form.getAttribute("data-pending")), "false");
      yield* assertRecoveredIntent();
      stage?.("returning:retry");
      stage?.("returning:mutation:retry:click");
      yield* step(() => submit.click());
      stage?.("returning:mutation:retry:await");
      yield* step(() => secondActionSettled.promise);
    }).pipe(capturedAs("submit"));

    assert.equal(interceptedActions, 2);
    assert.equal(droppedResponse, true);
    assert.equal(routeFailure, undefined);

    const captureCommitted = Effect.fnUntraced(function* (phase: string, periodId: string) {
      const committed = yield* step(() =>
        pool.query(
          `SELECT *
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision`,
          [person.personId, periodId],
        ),
      );

      trace.push({ phase, sqlCommitted: committed.rows });
      yield* writeTrace;
    });

    const afterRetryCommitted = yield* step(() =>
      pool.query(
        `SELECT *
     FROM public.admission_returning_registrations
     WHERE person_id=$1 AND admission_period_id=$2
     ORDER BY revision`,
        [person.personId, nextAdmissionPeriodId],
      ),
    );

    assert.equal(afterRetryCommitted.rows.length, 1);
    assert.deepEqual(afterRetryCommitted.rows[0], firstCommittedRow);
    yield* step(() => returning.unroute("**/dashboard/tidligere-assistenter*"));
    yield* step(() => returning.reload());
    const reloaded = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    yield* expectValue(
      reloaded.getByRole("combobox", { name: "Opptaksperiode" }),
      nextAdmissionPeriodId,
    );
    yield* expectValue(reloaded.getByRole("combobox", { name: "Studieår" }), "4");
    yield* expectValue(reloaded.getByRole("combobox", { name: "Stillingslengde" }), "8");
    yield* expectValue(reloaded.getByRole("combobox", { name: "Semesterblokk" }), "block-1");
    yield* expectValue(reloaded.getByRole("combobox", { name: "Språk" }), "Norsk og engelsk");
    assert.equal(
      yield* step(() => reloaded.getByLabel("Mandag", { exact: true }).isChecked()),
      true,
    );
    assert.equal(
      yield* step(() => reloaded.getByLabel("Torsdag", { exact: true }).isChecked()),
      true,
    );
    assert.equal(
      yield* step(() =>
        reloaded.getByLabel("Ønsket skole (valgfritt)", { exact: true }).inputValue(),
      ),
      "Returning School",
    );
    yield* step(() =>
      reloaded.getByRole("combobox", { name: "Opptaksperiode" }).selectOption(admissionPeriodId),
    );
    yield* step(() =>
      returning.waitForURL(
        new RegExp(`/dashboard/tidligere-assistenter\\?admissionPeriodId=${admissionPeriodId}$`),
      ),
    );

    for (
      let attempt = 0;
      attempt < 100 &&
      (yield* step(() =>
        reloaded.getByRole("combobox", { name: "Opptaksperiode" }).isEnabled(),
      )) !== true;
      attempt += 1
    )
      yield* Effect.sleep("100 millis");
    yield* step(() => reloaded.getByRole("combobox", { name: "Studieår" }).selectOption("2"));
    yield* step(() => reloaded.getByLabel("Torsdag", { exact: true }).uncheck());
    yield* step(() =>
      reloaded.getByRole("combobox", { name: "Stillingslengde" }).selectOption("4"),
    );
    yield* step(() =>
      reloaded.getByRole("combobox", { name: "Semesterblokk" }).selectOption("all"),
    );
    yield* step(() =>
      reloaded.getByRole("combobox", { name: "Språk" }).selectOption("Norsk og engelsk"),
    );
    yield* step(() => reloaded.getByLabel("Ønsket skole (valgfritt)", { exact: true }).fill(""));
    yield* step(() =>
      reloaded.getByLabel("Jeg er interessert i teamarbeid", { exact: true }).uncheck(),
    );
    yield* step(() => reloaded.locator(`input[name="teamIds"][value="${teamId}"]`).uncheck());

    const nativePost = yield* waitForDashboardAction(
      admissionPeriodId,
      Effect.fnUntraced(function* () {
        yield* waitForActionReady(reloaded);
        yield* step(() => reloaded.locator('button[type="submit"]').click());
      }),
    );

    assert.equal(nativePost.admissionPeriodId, admissionPeriodId);
    assert.equal(nativePost.expectedRevision, "0");

    yield* assertStatus(reloaded, "Registreringen er lagret.").pipe(
      capturedAs("existing-registration-status"),
    );

    yield* captureCommitted("existing-period-after-registration", admissionPeriodId);

    yield* step(() => returning.reload());
    const existing = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    yield* expectValue(
      existing.getByRole("combobox", { name: "Opptaksperiode" }),
      admissionPeriodId,
    );
    yield* expectValue(existing.getByRole("combobox", { name: "Studieår" }), "2");
    yield* expectValue(existing.getByRole("combobox", { name: "Stillingslengde" }), "4");
    yield* expectValue(existing.getByRole("combobox", { name: "Semesterblokk" }), "all");
    yield* expectValue(existing.getByRole("combobox", { name: "Språk" }), "Norsk og engelsk");
    yield* step(() => existing.getByRole("combobox", { name: "Studieår" }).selectOption("3"));
    yield* step(() => existing.getByRole("combobox", { name: "Språk" }).selectOption("Engelsk"));

    const updatePost = yield* waitForDashboardAction(
      admissionPeriodId,
      Effect.fnUntraced(function* () {
        yield* waitForActionReady(existing);
        yield* step(() => existing.getByRole("button", { name: "Lagre endringer" }).click());
      }),
    );

    assert.equal(updatePost.admissionPeriodId, admissionPeriodId);
    assert.equal(updatePost.expectedRevision, "1");

    yield* assertStatus(existing, "Registreringen er lagret.").pipe(capturedAs("update-status"));

    yield* captureCommitted("existing-period-after-update", admissionPeriodId);
    yield* step(() => returning.reload());
    const updated = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
    yield* expectValue(
      updated.getByRole("combobox", { name: "Opptaksperiode" }),
      admissionPeriodId,
    );
    stage?.("returning:period-history");
    const periodSelector = updated.getByRole("combobox", { name: "Opptaksperiode" });

    const waitForPeriodUrl = Effect.fnUntraced(function* (periodId: string) {
      yield* step(() =>
        returning.waitForURL(
          new RegExp(`/dashboard/tidligere-assistenter\\?admissionPeriodId=${periodId}$`),
        ),
      );
    });

    const waitForPeriodForm = Effect.fnUntraced(function* (periodId: string) {
      let actual = "";

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = returning.getByRole("form", {
          name: "Registrer som tidligere assistent",
        });

        const selector = candidate.getByRole("combobox", { name: "Opptaksperiode" });
        actual = yield* step(() => selector.inputValue());

        if (actual === periodId && (yield* step(() => selector.isEnabled())) === true)
          return candidate;
        yield* Effect.sleep("100 millis");
      }

      throw new Error(
        `period form did not settle actual=${yield* jsonText(actual)} expected=${yield* jsonText(periodId)}`,
      );
    });

    yield* step(() => periodSelector.selectOption(nextAdmissionPeriodId));
    yield* waitForPeriodUrl(nextAdmissionPeriodId);
    let periodForm = yield* waitForPeriodForm(nextAdmissionPeriodId);
    yield* expectValue(
      periodForm.getByRole("combobox", { name: "Opptaksperiode" }),
      nextAdmissionPeriodId,
    );
    yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Stillingslengde" }), "8");
    yield* step(() => periodSelector.selectOption(admissionPeriodId));
    yield* waitForPeriodUrl(admissionPeriodId);
    periodForm = yield* waitForPeriodForm(admissionPeriodId);
    yield* expectValue(
      periodForm.getByRole("combobox", { name: "Opptaksperiode" }),
      admissionPeriodId,
    );
    yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "3");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Språk" }), "Engelsk");
    yield* step(() => returning.goBack());
    yield* waitForPeriodUrl(nextAdmissionPeriodId);
    periodForm = yield* waitForPeriodForm(nextAdmissionPeriodId);
    yield* expectValue(
      periodForm.getByRole("combobox", { name: "Opptaksperiode" }),
      nextAdmissionPeriodId,
    );
    yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
    yield* step(() => returning.goForward());
    yield* waitForPeriodUrl(admissionPeriodId);
    periodForm = yield* waitForPeriodForm(admissionPeriodId);
    yield* expectValue(
      periodForm.getByRole("combobox", { name: "Opptaksperiode" }),
      admissionPeriodId,
    );
    yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
    yield* step(() => periodSelector.selectOption(nextAdmissionPeriodId));
    yield* waitForPeriodUrl(nextAdmissionPeriodId);
    periodForm = yield* waitForPeriodForm(nextAdmissionPeriodId);
    yield* expectValue(
      periodForm.getByRole("combobox", { name: "Opptaksperiode" }),
      nextAdmissionPeriodId,
    );
    yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "1");
    yield* expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "4");
    stage?.("returning:registration-conflict");
    assert.equal(
      yield* step(() => periodForm.locator('input[name="expectedRevision"]').inputValue()),
      "1",
    );
    assert.equal(yield* step(() => periodForm.locator('input[name="commandId"]').inputValue()), "");
    yield* step(() => periodForm.getByRole("combobox", { name: "Studieår" }).selectOption("5"));
    const staleStorageState = yield* step(() => context.storageState());
    const staleContext = yield* step(() => browser.newContext({ storageState: staleStorageState }));
    const staleReturning = yield* step(() => staleContext.newPage());

    yield* Effect.gen(function* () {
      yield* step(() =>
        staleReturning.goto(
          `${ui}/dashboard/tidligere-assistenter?admissionPeriodId=${encodeURIComponent(nextAdmissionPeriodId)}`,
        ),
      );

      const staleForm = staleReturning.getByRole("form", {
        name: "Registrer som tidligere assistent",
      });

      yield* step(() => staleForm.waitFor({ state: "visible" }));
      assert.equal(
        yield* step(() => staleForm.locator('input[name="expectedRevision"]').inputValue()),
        "1",
      );
      yield* step(() => staleForm.getByRole("combobox", { name: "Studieår" }).selectOption("5"));

      const staleSaveResponsePromise = staleReturning.waitForResponse(
        (response) => {
          const url = new URL(response.url());

          if (
            response.request().method() !== "POST" ||
            !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(
              url.pathname,
            )
          )
            return false;

          return (
            new URLSearchParams(response.request().postData() ?? "").get("admissionPeriodId") ===
            nextAdmissionPeriodId
          );
        },
        { timeout: 30_000 },
      );

      yield* step(() => staleForm.getByRole("button", { name: "Lagre endringer" }).click());
      const staleSaveResponse = yield* step(() => staleSaveResponsePromise);
      yield* step(() => staleSaveResponse.finished());
      assert.equal(staleSaveResponse.status(), 200);
      const staleSavePost = new URLSearchParams(staleSaveResponse.request().postData() ?? "");
      assert.equal(staleSavePost.get("expectedRevision"), "1");
      assert.ok(Predicate.isString(staleSavePost.get("commandId")));
      assert.notEqual(staleSavePost.get("commandId"), "");

      const afterStaleSave = yield* step(() =>
        pool.query(
          `SELECT revision,year_of_study
       FROM public.admission_returning_registrations
       WHERE person_id=$1 AND admission_period_id=$2
       ORDER BY revision DESC
       LIMIT 1`,
          [person.personId, nextAdmissionPeriodId],
        ),
      );

      assert.deepEqual(afterStaleSave.rows, [{ revision: 2, year_of_study: 5 }]);

      const staleDraftResponsePromise = returning.waitForResponse(
        (response) => {
          const url = new URL(response.url());

          if (
            response.request().method() !== "POST" ||
            !["/dashboard/tidligere-assistenter", "/dashboard/tidligere-assistenter.data"].includes(
              url.pathname,
            )
          )
            return false;

          return (
            new URLSearchParams(response.request().postData() ?? "").get("admissionPeriodId") ===
            nextAdmissionPeriodId
          );
        },
        { timeout: 30_000 },
      );

      yield* waitForActionReady(periodForm);
      yield* step(() => periodForm.getByRole("button", { name: "Lagre endringer" }).click());
      const staleDraftResponse = yield* step(() => staleDraftResponsePromise);
      yield* step(() => staleDraftResponse.finished());
      assert.equal(staleDraftResponse.status(), 412);
      const staleDraftPost = new URLSearchParams(staleDraftResponse.request().postData() ?? "");
      const staleDraftCommandId = staleDraftPost.get("commandId");
      assert.equal(staleDraftPost.get("expectedRevision"), "1");
      assert.ok(Predicate.isString(staleDraftCommandId));
      assert.notEqual(staleDraftCommandId, "");
      assert.notEqual(staleDraftCommandId, staleSavePost.get("commandId"));
      yield* step(() =>
        periodForm.getByRole("alert").filter({ hasText: "Alternativene er endret." }).waitFor(),
      );
      assert.equal(
        yield* step(() => periodForm.locator('input[name="expectedRevision"]').inputValue()),
        "1",
      );
      assert.equal(
        yield* step(() => periodForm.getByRole("combobox", { name: "Studieår" }).inputValue()),
        "5",
      );
      assert.equal(
        yield* step(() => periodForm.locator('input[name="commandId"]').inputValue()),
        staleDraftCommandId,
      );
      trace.push({
        phase: "negative-gate",
        gate: "returning-stale-draft",
        status: 412,
        expectedRevision: staleDraftPost.get("expectedRevision"),
        commandId: staleDraftPost.get("commandId"),
        draftYearOfStudy: yield* step(() =>
          periodForm.getByRole("combobox", { name: "Studieår" }).inputValue(),
        ),
      });
      yield* step(() => periodForm.getByRole("button", { name: "Forkast lagret utkast" }).click());
      yield* step(() => returning.waitForLoadState("domcontentloaded"));
      periodForm = returning.getByRole("form", { name: "Registrer som tidligere assistent" });
      yield* step(() => periodForm.waitFor({ state: "visible" }));
      yield* expectValue(periodForm.locator('input[name="expectedRevision"]'), "2");
      yield* expectValue(periodForm.getByRole("combobox", { name: "Studieår" }), "5");

      const recoveredCommandId = yield* step(() =>
        periodForm.locator('input[name="commandId"]').inputValue(),
      );

      assert.equal(recoveredCommandId, "");

      const recoveredPost = yield* waitForDashboardAction(
        nextAdmissionPeriodId,
        Effect.fnUntraced(function* () {
          yield* waitForActionReady(periodForm);
          yield* step(() => periodForm.getByRole("button", { name: "Lagre endringer" }).click());
        }),
      );

      assert.equal(recoveredPost.expectedRevision, "2");
      assert.notEqual(recoveredPost.commandId, staleDraftPost.get("commandId"));
      yield* assertStatus(periodForm, "Registreringen er lagret.");
    }).pipe(
      Effect.ensuring(
        step(() => staleReturning.close()).pipe(
          Effect.andThen(step(() => staleContext.close())),
          Effect.orDie,
        ),
      ),
    );

    const nextPeriodRevision = yield* step(() =>
      pool.query(
        `SELECT revision,year_of_study
     FROM public.admission_returning_registrations
     WHERE person_id=$1 AND admission_period_id=$2
     ORDER BY revision DESC
     LIMIT 1`,
        [person.personId, nextAdmissionPeriodId],
      ),
    );

    assert.deepEqual(nextPeriodRevision.rows, [{ revision: 3, year_of_study: 5 }]);
    // Audit the settled form. The status appears while the fetcher still revalidates, so the
    // submit button is disabled and then fades in; Axe must not read its colors mid-transition.
    yield* waitForActionReady(periodForm);
    yield* step(() =>
      periodForm
        .locator('button[type="submit"]')
        .evaluate((button) =>
          Promise.all(button.getAnimations().map((animation) => animation.finished)),
        ),
    );
    yield* auditPage(returning, "returning-registration");

    const finalCustody = yield* step(() =>
      pool.query(
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
      ),
    );

    const finalCustodyRow = finalCustody.rows[0];
    assert.ok(finalCustodyRow);
    assert.equal(finalCustodyRow.activation_digest, originalActivationDigest);
    assert.ok(
      (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Json))(
        finalCustodyRow.public_receipts,
      )).length > 0,
    );
    assert.ok(
      (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Json))(finalCustodyRow.public_audit))
        .length > 0,
    );
    assert.deepEqual(finalCustody.rows, originalCustody.rows);
    trace.push({
      phase: "negative-gate",
      gate: "preserved-original-receipt-activation-conduct",
      status: "observed",
    });

    const nextInterviews = yield* step(() =>
      pool.query(
        `SELECT count(*)::int AS count
     FROM public.recruitment_interviews interview
     JOIN public.admission_applications application USING(application_id)
     WHERE application.admission_period_id=$1`,
        [nextAdmissionPeriodId],
      ),
    );

    assert.deepEqual(nextInterviews.rows, [{ count: 0 }]);
    trace.push({ phase: "negative-gate", gate: "new-period-no-new-interview", status: "observed" });

    const ordinaryConduct = yield* step(() =>
      pool.query(
        `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-native-conduct-a-0063'`,
      ),
    );

    if (ordinaryConduct.rows.length === 0) {
      yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));
      yield* step(() =>
        page.getByRole("heading", { name: "Planlegg intervjuer", exact: true }).waitFor(),
      );
      const ordinaryCard = page.getByRole("article").filter({ hasText: "Sofie Gjennomfører" });
      yield* step(() =>
        ordinaryCard.getByRole("button", { name: "Åpne intervju", exact: true }).click(),
      );
      yield* step(() =>
        page
          .getByRole("heading", { name: "Intervju med Sofie Gjennomfører", exact: true })
          .waitFor(),
      );
      yield* step(() =>
        page
          .locator("#question-interview-schema-native-conduct-0063-q0")
          .fill("Jeg vil forklare matematikk tydelig."),
      );
      yield* step(() =>
        page.locator("#question-interview-schema-native-conduct-0063-q1-1").check(),
      );
      yield* step(() =>
        page.locator("#question-interview-schema-native-conduct-0063-q2-0").check(),
      );
      yield* step(() =>
        page.locator("#question-interview-schema-native-conduct-0063-q3-0").check(),
      );

      for (const axis of ["explanatoryPower", "roleModel", "suitability"])
        yield* step(() => page.locator(`#score-${axis}`).selectOption("8"));
      yield* step(() => page.locator("#interviewer-recommendation").selectOption("Ja"));
      yield* step(() =>
        page.getByRole("button", { name: "Fullfør intervju", exact: true }).click(),
      );
      yield* step(() =>
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Fullfør intervju", exact: true })
          .press("Enter"),
      );
      yield* step(() => page.getByText("Intervjuet er fullført.", { exact: true }).waitFor());
      yield* step(() => page.reload());
    }

    const ordinaryAfter = yield* step(() =>
      pool.query(
        `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-native-conduct-a-0063'`,
      ),
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

    // Both writes expect revision 2. The registration transaction takes the person's lock, so
    // the first request to take it commits revision 3 and the second fails its precondition.
    // Which request comes first varies by runner, so revision 3 holds the winner's preferences.
    const concurrentRevisions = [
      {
        idempotencyKey: "returning-concurrent-a-0104",
        payload: {
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
      },
      {
        idempotencyKey: "returning-concurrent-b-0104",
        payload: {
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
      },
    ] as const;

    const concurrentDetails = yield* Effect.all(
      concurrentRevisions.map(({ idempotencyKey, payload }) =>
        register(idempotencyKey, payload).pipe(
          Effect.map((answer) => ({ idempotencyKey, payload, status: answer.status, answer })),
        ),
      ),
      { concurrency: "unbounded" },
    );

    assert.deepEqual(
      concurrentDetails.map(({ status }) => status).sort((left, right) => left - right),
      [200, 412],
      yield* jsonText(concurrentDetails),
    );

    const concurrentWinner = concurrentDetails.find(({ status }) => status === 200);
    const concurrentLoser = concurrentDetails.find(({ status }) => status === 412);
    assert.ok(concurrentWinner?.answer.ok);
    assert.ok(concurrentLoser && !concurrentLoser.answer.ok);

    const concurrentRegistration = concurrentWinner.answer.value;

    assert.equal(concurrentRegistration.observation.revision, 3);
    assert.equal(concurrentRegistration.replayed, false);
    assert.equal(concurrentLoser.answer.code, "returning.revision-conflict");
    trace.push({
      phase: "concurrent-revision",
      winner: concurrentWinner.idempotencyKey,
      loser: concurrentLoser.idempotencyKey,
    });

    const concurrentRows = yield* step(() =>
      pool.query(
        "SELECT revision FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2 ORDER BY revision",
        [person.personId, admissionPeriodId],
      ),
    );

    assert.deepEqual(concurrentRows.rows, [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);

    const { payload: won } = concurrentWinner;

    const concurrentRevisionRow = {
      admission_period_id: admissionPeriodId,
      revision: 3,
      year_of_study: won.yearOfStudy,
      monday_unavailable: won.mondayUnavailable,
      tuesday_unavailable: won.tuesdayUnavailable,
      wednesday_unavailable: won.wednesdayUnavailable,
      thursday_unavailable: won.thursdayUnavailable,
      friday_unavailable: won.fridayUnavailable,
      position_weeks: won.positionWeeks,
      preferred_group: won.preferredGroup,
      language: won.language,
      preferred_school: won.preferredSchool,
      team_interest: won.teamInterest,
      team_ids: won.teamIds,
    };

    stage?.("returning:next-period-assignment");

    const nextApplication = yield* step(() =>
      pool.query(
        `SELECT application_id
     FROM public.admission_applications
     WHERE applicant_id=$1 AND admission_period_id=$2`,
        [applicantId, nextAdmissionPeriodId],
      ),
    );

    const nextApplicationId = yield* Schema.decodeUnknownEffect(Schema.String)(
      nextApplication.rows[0].application_id,
    );

    const assignmentActorContextBefore = yield* step(() =>
      pool.query(
        `SELECT
         membership.membership_id,
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
        ["journey-conduct-leader-0063"],
      ),
    );

    const assignmentPeriodContextBefore = yield* step(() =>
      pool.query(
        `SELECT
         p.admission_period_id,
         p.department_id,
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
      ),
    );

    assert.equal(nextApplication.rows.length, 1);

    const assignmentPayload = {
      interviewerPersonId: "journey-conduct-leader-0063",
      interviewSchemaId: "interview-schema-native-conduct-0063",
    };

    const assign = (assignmentPage: Page, idempotencyKey: string) =>
      pageRpc(assignmentPage, {
        api,
        ui,
        tag: "recruitment.createApplicationInterview",
        payload: { applicationId: nextApplicationId, idempotencyKey, request: assignmentPayload },
      });

    const ambiguousAssignment = yield* step(() =>
      assign(page, "returning-next-assignment-ambiguous-0104"),
    );

    const ambiguousBodyText = yield* step(() => ambiguousAssignment.text());
    trace.push({
      phase: "assignment-response",
      status: ambiguousAssignment.status(),
      body: ambiguousBodyText,
      actorContextBefore: assignmentActorContextBefore.rows,
      periodContextBefore: assignmentPeriodContextBefore.rows,
    });
    assert.equal(ambiguousAssignment.status(), 403, ambiguousBodyText);

    const ambiguousBody = yield* Schema.decodeUnknownEffect(NativeProblem)(
      yield* decodeJsonText(ambiguousBodyText),
    );

    assert.equal(ambiguousBody.code, "authority.denied");

    const assignmentPeriodContext = yield* step(() =>
      pool.query(
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
      ),
    );

    trace.push({
      phase: "negative-gate",
      gate: "next-assignment-requires-one-open-period",
      status: 403,
      problemCode: ambiguousBody.code,
      problemStatus: ambiguousBody.status,
      body: ambiguousBodyText,
      actorContextBefore: assignmentActorContextBefore.rows,
      periodContextBefore: assignmentPeriodContextBefore.rows,
      source:
        "assignmentInTransaction currentPeriod scope check (packages/database/src/recruitment/postgres.ts:850-857) maps RecruitmentScopeDenied to authority.denied (apps/backend/src/recruitment/http.ts:251-255)",
      periodContext: assignmentPeriodContext.rows,
    });
    // Model the legitimate semester transition: the old period ends at a valid
    // instant and remains closed while the next period becomes authoritative.
    yield* step(() =>
      pool.query("UPDATE public.admission_periods SET end_at=$1 WHERE admission_period_id=$2", [
        conductPeriodClosedEndAt,
        admissionPeriodId,
      ]),
    );

    const postClosePeriodContext = yield* step(() =>
      pool.query(
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
      ),
    );

    assert.deepEqual(
      postClosePeriodContext.rows.map(
        (row: { admission_period_id: string; eligible_now: boolean }) => ({
          admission_period_id: row.admission_period_id,
          eligible_now: row.eligible_now,
        }),
      ),
      [
        { admission_period_id: admissionPeriodId, eligible_now: false },
        { admission_period_id: nextAdmissionPeriodId, eligible_now: true },
      ],
    );

    // Department administration (O8-11): an active, unsuspended leadership of the department's
    // board (Styret) while the department is independent. An ordinary team leader acts only
    // within its own team.
    const resolvedCoordinator = yield* step(() =>
      pool.query(
        `SELECT
       membership.person_id,
       membership.team_id,
       membership.is_team_leader,
       membership.is_suspended,
       team.department_id,
       team.kind AS team_kind,
       team.active AS team_active,
       department.independent AS department_independent,
       department.active AS department_active
     FROM public.organization_memberships membership
     JOIN public.organization_teams team USING (team_id)
     JOIN public.organization_departments department USING (department_id)
     WHERE membership.person_id=$1
       AND membership.start_at <= statement_timestamp()
       AND (membership.end_at IS NULL OR statement_timestamp() < membership.end_at)
       AND membership.is_team_leader
       AND NOT membership.is_suspended
       AND team.kind = 'DepartmentBoard'
       AND team.active
       AND department.independent
       AND department.active
     ORDER BY membership.membership_id`,
        ["report-coordinator-0103"],
      ),
    );

    assert.deepEqual(resolvedCoordinator.rows, [
      {
        person_id: "report-coordinator-0103",
        team_id: teamId,
        is_team_leader: true,
        is_suspended: false,
        department_id: departmentId,
        team_kind: "DepartmentBoard",
        team_active: true,
        department_independent: true,
        department_active: true,
      },
    ]);
    trace.push({
      phase: "assignment-authority-resolved",
      coordinatorPersonId: "report-coordinator-0103",
      coordinatorEmail,
      coordinatorRole: "DepartmentAdministrator",
      assignedInterviewerPersonId: assignmentPayload.interviewerPersonId,
      coordinatorContext: resolvedCoordinator.rows,
      postClosePeriodContext: postClosePeriodContext.rows,
    });
    const assignmentCommandId = "returning-next-assignment-0104";
    const coordinatorContext = yield* step(() => browser.newContext());
    let assignmentStatus!: number;
    let assignmentBodyText!: string;
    let assignmentETag!: string;
    let nextInterviewId!: string;

    yield* Effect.gen(function* () {
      stage?.("returning:next-period-assignment:coordinator-login");
      const coordinatorPage = yield* step(() => coordinatorContext.newPage());
      yield* step(() => coordinatorPage.goto(`${ui}/login`));
      yield* step(() =>
        coordinatorPage.getByLabel("E-post", { exact: true }).fill(coordinatorEmail),
      );
      yield* step(() =>
        coordinatorPage.getByLabel("Passord", { exact: true }).fill(coordinatorPassword),
      );
      yield* step(() =>
        coordinatorPage.getByRole("button", { name: "Logg inn", exact: true }).click(),
      );
      yield* step(() => coordinatorPage.waitForURL(/\/dashboard\/?$/));

      const assignmentResponse = yield* step(() => assign(coordinatorPage, assignmentCommandId));

      assignmentStatus = assignmentResponse.status();
      assignmentBodyText = yield* step(() => assignmentResponse.text());
      assignmentETag = assignmentResponse.headers()["etag"] ?? "";

      // An RPC command answers 200; the 201 was an HTTP transport fact.
      if (assignmentStatus !== 200) {
        const assignmentActorContext = yield* step(() =>
          pool.query(
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
          ),
        );

        trace.push({
          phase: "assignment-failure",
          status: assignmentStatus,
          body: assignmentBodyText,
          source:
            "assignment preflight reads target actor/interviewer eligibility in apps/backend/src/recruitment/http.ts:1008-1052; domain assignment then checks current period and live membership in packages/database/src/recruitment/postgres.ts:843-931",
          actorContext: assignmentActorContext.rows,
        });
        throw new Error(`next assignment failed ${assignmentStatus} ${assignmentBodyText}`);
      }

      const assignmentBody = yield* Schema.decodeUnknownEffect(RecruitmentInterviewResource)(
        yield* decodeJsonText(assignmentBodyText),
      );

      assert.equal(assignmentBody.applicationId, nextApplicationId);
      assert.ok(Predicate.isString(assignmentBody.interviewId));
      nextInterviewId = assignmentBody.interviewId!;

      const assignmentRow = yield* step(() =>
        pool.query(
          `SELECT interview_id,application_id,interviewer_person_id,revision
       FROM public.recruitment_interviews
       WHERE interview_id=$1`,
          [nextInterviewId],
        ),
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

      const scheduleResponse = yield* step(() =>
        pageRpc(coordinatorPage, {
          api,
          ui,
          tag: "recruitment.scheduleInterview",
          payload: {
            interviewId: nextInterviewId,
            idempotencyKey: "returning-next-schedule-0104",
            ifMatch: assignedETag,
            request: {
              scheduledAt: nextInterviewScheduledAt,
              room: "Returning Room 0104",
              campus: "Gløshaugen",
              mapLink: "https://maps.example.invalid/returning-next-0104",
              message: "Vi ser frem til intervjuet.",
            },
          },
        }),
      );

      const scheduleBodyText = yield* step(() => scheduleResponse.text());

      if (scheduleResponse.status() !== 200) {
        throw new Error(
          `next interview schedule failed ${scheduleResponse.status()} ${scheduleBodyText}`,
        );
      }

      const scheduleBody = yield* Schema.decodeUnknownEffect(ScheduleInterviewResponse)(
        yield* decodeJsonText(scheduleBodyText),
      );

      assert.equal(scheduleBody.interviewId, nextInterviewId);
      assert.equal(scheduleBody.responseState, "Pending");
      assert.equal(scheduleBody.notificationState, "Pending");
      assert.equal(scheduleBody.schedule.scheduleRevision, 1);
      assert.equal(scheduleBody.schedule.scheduledAt, nextInterviewScheduledAt);
      trace.push({
        phase: "returning:native-schedule",
        actorPersonId: "report-coordinator-0103",
        interviewId: nextInterviewId,
        assignmentETag: assignedETag,
        scheduleStatus: scheduleResponse.status(),
        scheduledAt: scheduleBody.schedule.scheduledAt,
        responseState: scheduleBody.responseState,
      });
    }).pipe(Effect.ensuring(step(() => coordinatorContext.close()).pipe(Effect.orDie)));

    const deliverRecruitmentInvitationOnce = deliverRecruitmentInvitation;
    assert.ok(deliverRecruitmentInvitationOnce);
    stage?.("returning:next-period-invitation-delivery");

    const delivery = yield* deliverRecruitmentInvitationOnce(
      "returning-next-invitation-delivery-0104",
    );

    assert.equal(delivery._tag, "Delivered");

    if (!Predicate.isTagged(delivery, "Delivered") || delivery.claim === undefined)
      throw new Error(`next invitation delivery did not complete: ${delivery._tag}`);

    const deliveredInvitationOutbox = yield* step(() =>
      pool.query(
        "SELECT status,attempts FROM public.recruitment_invitation_outbox WHERE effect_id=$1",
        [delivery.claim.effectId],
      ),
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

      if (invitationCapability === undefined) yield* Effect.sleep("250 millis");
    }

    assert.ok(invitationCapability);
    stage?.("returning:next-period-invitation");

    // The invitee presents only the capability, in the payload. The staff page's session cookie
    // would be a second credential, so these requests go through fetch, which keeps no cookie jar.
    const readInvitation = () =>
      replacedFetch({
        origin: api,
        tag: "recruitment.readInvitationResponse",
        payload: { capability: invitationCapability },
        headers: { origin: ui },
      });

    const invitationPendingResponse = yield* step(() => readInvitation());

    const invitationPendingText = yield* step(() => invitationPendingResponse.text());

    if (invitationPendingResponse.status !== 200) {
      throw new Error(
        `next invitation read failed ${invitationPendingResponse.status} ${invitationPendingText}`,
      );
    }

    const invitationPending = yield* Schema.decodeUnknownEffect(
      RecruitmentInvitationResponseObservationSchema,
    )(yield* decodeJsonText(invitationPendingText));

    const invitationETag = invitationPendingResponse.headers.get("etag");
    assert.ok(invitationETag);
    assert.deepEqual(invitationPending, {
      scheduledAt: nextInterviewScheduledAt,
      room: "Returning Room 0104",
      campus: "Gløshaugen",
      responseState: "Pending",
      responseMessage: null,
    });

    const invitationConfirmResponse = yield* step(() =>
      replacedFetch({
        origin: api,
        tag: "recruitment.confirmInvitation",
        payload: { capability: invitationCapability, ifMatch: invitationETag },
        headers: { origin: ui },
      }),
    );

    const invitationConfirmText = yield* step(() => invitationConfirmResponse.text());

    // The confirmation answers the invitation's new tag with 200, where HTTP answered 204.
    if (invitationConfirmResponse.status !== 200) {
      throw new Error(
        `next invitation confirmation failed ${invitationConfirmResponse.status} ${invitationConfirmText}`,
      );
    }

    const invitationAcceptedResponse = yield* step(() => readInvitation());

    assert.equal(invitationAcceptedResponse.status, 200);

    const invitationAccepted = yield* Schema.decodeUnknownEffect(
      RecruitmentInvitationResponseObservationSchema,
    )(yield* decodeJsonText(yield* step(() => invitationAcceptedResponse.text())));

    assert.deepEqual(invitationAccepted, {
      scheduledAt: nextInterviewScheduledAt,
      room: "Returning Room 0104",
      campus: "Gløshaugen",
      responseState: "Accepted",
      responseMessage: null,
    });
    trace.push({
      phase: "returning:native-invitation-accepted",
      interviewId: nextInterviewId,
      responseState: invitationAccepted.responseState,
      confirmStatus: invitationConfirmResponse.status,
    });
    stage?.("returning:next-period-finalization");

    const readConduct = () =>
      pageRpc(page, {
        api,
        ui,
        tag: "recruitment.readInterviewConduct",
        payload: { interviewId: nextInterviewId },
      });

    const conductResponse = yield* step(() => readConduct());

    assert.equal(conductResponse.status(), 200);
    const conductETag = conductResponse.headers()["etag"];
    assert.ok(conductETag);

    const conductBefore = yield* Schema.decodeUnknownEffect(
      RecruitmentInterviewConductObservationSchema,
    )(yield* decodeJsonText(yield* step(() => conductResponse.text())));

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
      answer: Match.value(question.kind).pipe(
        Match.when("text", () => "Jeg vil utvikle læringsopplegg sammen med andre." as const),
        Match.when("check", () => ["Samarbeid"]),
        Match.when("list", () => "Teknologi" as const),
        Match.orElse(() => "Praksis" as const),
      ),
    }));

    const finalizeKey = "returning-native-finalize-0104";

    const finalizeResponse = yield* step(() =>
      pageRpc(page, {
        api,
        ui,
        tag: "recruitment.finalizeInterview",
        payload: {
          interviewId: nextInterviewId,
          idempotencyKey: finalizeKey,
          ifMatch: conductETag,
          request: {
            answers: finalizeAnswers,
            score: { explanatoryPower: 9, roleModel: 9, suitability: 9 },
            recommendation: "Kanskje",
          },
        },
      }),
    );

    const finalizeBodyText = yield* step(() => finalizeResponse.text());

    if (finalizeResponse.status() !== 200) {
      throw new Error(
        `native finalization failed ${finalizeResponse.status()} ${finalizeBodyText}`,
      );
    }

    const finalizeBody = yield* Schema.decodeUnknownEffect(FinalizeInterviewResponse)(
      yield* decodeJsonText(finalizeBodyText),
    );

    assert.equal(finalizeBody.interviewId, nextInterviewId);
    assert.match(finalizeBody.finalizedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(finalizeBody.completionState, "Completed");
    assert.equal(finalizeBody.cancellationState, "NotCancelled");

    const conductAfterResponse = yield* step(() => readConduct());

    assert.equal(conductAfterResponse.status(), 200);

    const conductAfter = yield* Schema.decodeUnknownEffect(
      RecruitmentInterviewConductObservationSchema,
    )(yield* decodeJsonText(yield* step(() => conductAfterResponse.text())));

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

    const finalizedConduct = yield* step(() =>
      pool.query(
        `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id=$1`,
        [nextInterviewId],
      ),
    );

    assert.deepEqual(finalizedConduct.rows, [
      { recommendation: "Kanskje", explanatory_power: 9, role_model: 9, suitability: 9 },
    ]);

    const preservedConduct = yield* step(() =>
      pool.query(
        `SELECT c.recommendation,c.explanatory_power,c.role_model,c.suitability
     FROM public.recruitment_interview_conducts c
     WHERE c.interview_id='interview-returning-0104'`,
      ),
    );

    assert.deepEqual(preservedConduct.rows, [
      { recommendation: "Ja", explanatory_power: 8, role_model: 8, suitability: 8 },
    ]);

    const registrations = yield* step(() =>
      pool.query(
        "SELECT admission_period_id,revision,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids FROM public.admission_returning_registrations WHERE person_id=$1 ORDER BY admission_period_id,revision",
        [person.personId],
      ),
    );

    assert.deepEqual(registrations.rows, [
      {
        admission_period_id: admissionPeriodId,
        revision: 1,
        year_of_study: 2,
        monday_unavailable: false,
        tuesday_unavailable: false,
        wednesday_unavailable: false,
        thursday_unavailable: false,
        friday_unavailable: false,
        position_weeks: 4,
        preferred_group: "all",
        language: "Norsk og engelsk",
        preferred_school: null,
        team_interest: false,
        team_ids: [],
      },
      {
        admission_period_id: admissionPeriodId,
        revision: 2,
        year_of_study: 3,
        monday_unavailable: false,
        tuesday_unavailable: false,
        wednesday_unavailable: false,
        thursday_unavailable: false,
        friday_unavailable: false,
        position_weeks: 4,
        preferred_group: "all",
        language: "Engelsk",
        preferred_school: null,
        team_interest: false,
        team_ids: [],
      },
      concurrentRevisionRow,
      {
        admission_period_id: nextAdmissionPeriodId,
        revision: 1,
        year_of_study: 4,
        monday_unavailable: true,
        tuesday_unavailable: false,
        wednesday_unavailable: false,
        thursday_unavailable: true,
        friday_unavailable: false,
        position_weeks: 8,
        preferred_group: "block-1",
        language: "Norsk og engelsk",
        preferred_school: "Returning School",
        team_interest: true,
        team_ids: [teamId],
      },
      {
        admission_period_id: nextAdmissionPeriodId,
        revision: 2,
        year_of_study: 5,
        monday_unavailable: true,
        tuesday_unavailable: false,
        wednesday_unavailable: false,
        thursday_unavailable: true,
        friday_unavailable: false,
        position_weeks: 8,
        preferred_group: "block-1",
        language: "Norsk og engelsk",
        preferred_school: "Returning School",
        team_interest: true,
        team_ids: [teamId],
      },
      {
        admission_period_id: nextAdmissionPeriodId,
        revision: 3,
        year_of_study: 5,
        monday_unavailable: true,
        tuesday_unavailable: false,
        wednesday_unavailable: false,
        thursday_unavailable: true,
        friday_unavailable: false,
        position_weeks: 8,
        preferred_group: "block-1",
        language: "Norsk og engelsk",
        preferred_school: "Returning School",
        team_interest: true,
        team_ids: [teamId],
      },
    ]);

    const provenance = yield* step(() =>
      pool.query(
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
      ),
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
    trace.push({
      phase: "negative-gate",
      gate: "retained-inactive-cross-department-placement",
      status: "observed",
    });
    assert.ok(firstCommandKey);
    assert.ok(firstExpectedRevision !== undefined);

    const firstReplayPayload = {
      commandId: firstCommandKey,
      ...firstPayload,
      expectedRevision: Number(firstExpectedRevision),
    };

    const nextRevisionBeforeReplay = yield* step(() =>
      pool.query(
        "SELECT count(*)::int AS count FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2",
        [person.personId, nextAdmissionPeriodId],
      ),
    );

    const replayKey = firstCommandKey;
    const exactReplay = yield* register(replayKey, firstReplayPayload);

    assert.equal(exactReplay.status, 200);

    const nextRevisionAfterReplay = yield* step(() =>
      pool.query(
        "SELECT count(*)::int AS count FROM public.admission_returning_registrations WHERE person_id=$1 AND admission_period_id=$2",
        [person.personId, nextAdmissionPeriodId],
      ),
    );

    assert.deepEqual(nextRevisionAfterReplay.rows, nextRevisionBeforeReplay.rows);
    const closedBefore = yield* negativeMutationSnapshot(person.personId);
    yield* step(() =>
      pool.query("UPDATE public.admission_periods SET end_at=$1 WHERE admission_period_id=$2", [
        nextPeriodClosedEndAt,
        nextAdmissionPeriodId,
      ]),
    );

    yield* Effect.gen(function* () {
      const closedReplay = yield* register(replayKey, firstReplayPayload);

      assert.equal(closedReplay.status, 409);
      assert.deepEqual(yield* negativeMutationSnapshot(person.personId), closedBefore);
      trace.push({ phase: "negative-gate", gate: "closed-period", status: closedReplay.status });
    }).pipe(
      Effect.ensuring(
        step(() =>
          pool.query("UPDATE public.admission_periods SET end_at=$1 WHERE admission_period_id=$2", [
            nextPeriodEndAt,
            nextAdmissionPeriodId,
          ]),
        ).pipe(Effect.orDie),
      ),
    );

    const returningOutbox = yield* step(() =>
      pool.query(
        "SELECT effect_id,status,attempts FROM public.admission_application_outbox WHERE origin='ReturningAssistant' ORDER BY effect_id",
      ),
    );

    assert.equal(returningOutbox.rows.length, 18);
    const revokedBefore = yield* negativeMutationSnapshot(person.personId);

    const session = yield* step(() =>
      pool.query('SELECT count(*)::int AS count FROM auth.session WHERE "userId"=$1', [
        person.personId,
      ]),
    );

    assert.equal(session.rows[0].count, 1);
    yield* step(() => pool.query('DELETE FROM auth.session WHERE "userId"=$1', [person.personId]));

    const revokedReplay = yield* register(replayKey, firstReplayPayload);

    assert.equal(revokedReplay.status, 401);
    yield* step(() => native.dispose());
    assert.deepEqual(yield* negativeMutationSnapshot(person.personId), revokedBefore);
    trace.push({
      phase: "negative-gate",
      gate: "stale-revoked-auth",
      status: revokedReplay.status,
    });
    stage?.("returning:report");
    const reportContext = yield* step(() => browser.newContext());
    const reportPage = yield* step(() => reportContext.newPage());

    yield* Effect.gen(function* () {
      yield* step(() => reportPage.goto(`${ui}/login`));
      yield* step(() => reportPage.getByLabel("E-post", { exact: true }).fill(coordinatorEmail));
      yield* step(() =>
        reportPage.getByLabel("Passord", { exact: true }).fill(coordinatorPassword),
      );
      yield* step(() => reportPage.getByRole("button", { name: "Logg inn", exact: true }).click());
      yield* step(() => reportPage.waitForURL(/\/dashboard\/?$/));

      const reportRows = Effect.fnUntraced(function* (periodId: string) {
        yield* step(() =>
          reportPage.goto(
            `${ui}/dashboard/intervjuer/rapport?admissionPeriodId=${encodeURIComponent(periodId)}`,
          ),
        );
        yield* step(() =>
          reportPage.getByRole("heading", { level: 1, name: "Fullførte intervjuer" }).waitFor(),
        );

        return yield* step(() =>
          reportPage
            .locator("tbody tr")
            .evaluateAll((rows) =>
              rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
            ),
        );
      });

      const currentReportRows = yield* reportRows(admissionPeriodId);
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
      assert.equal(
        currentReportRows.some((row) => row.includes("Olav Konflikt")),
        false,
      );
      yield* step(() => reportPage.reload());
      assert.equal(
        (yield* step(() =>
          reportPage
            .locator("tbody tr")
            .evaluateAll((rows) =>
              rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
            ),
        )).find((row) => row.includes("Rita Tilbake")),
        currentRita,
      );
      yield* auditPage(reportPage, "returning-report-existing-period");
      yield* step(() =>
        reportPage.screenshot({
          path: path.join(artifacts, "returning-report-existing-period.png"),
          fullPage: true,
        }),
      );
      const nextReportRows = yield* reportRows(nextAdmissionPeriodId);
      assert.equal(nextReportRows.length, 1);
      const nextRita = nextReportRows[0]!;
      assert.match(nextRita, /Rita Tilbake/u);
      assert.match(nextRita, /Tilbakevendende/u);
      assert.match(nextRita, /Kanskje/u);
      assert.match(nextRita, /9/u);
      assert.match(nextRita, /27/u);
      yield* step(() => reportPage.reload());

      const reloadedNextRows = yield* step(() =>
        reportPage
          .locator("tbody tr")
          .evaluateAll((rows) =>
            rows.map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim()),
          ),
      );

      assert.deepEqual(reloadedNextRows, nextReportRows);
      yield* auditPage(reportPage, "returning-report-next-period-finalized");
      yield* step(() =>
        reportPage.screenshot({
          path: path.join(artifacts, "returning-report-next-period-finalized.png"),
          fullPage: true,
        }),
      );
    }).pipe(Effect.ensuring(step(() => reportContext.close()).pipe(Effect.orDie)));
  }).pipe(
    // Retain the complete journey trace on both successful helper return and
    // failure, before the outer report/effect gates can run or fail.
    Effect.ensuring(writeTrace.pipe(Effect.orDie)),
  );

  return { trace };
});

export const runReturningAssistantLoginProbe = Effect.fnUntraced(function* ({
  browser,
  pool,
  ui,
  artifacts,
}: {
  readonly browser: Browser;
  readonly pool: Pool;
  readonly ui: string;
  readonly artifacts: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* step(() => browser.newContext());
  const probe = yield* step(() => context.newPage());
  const events: string[] = [];

  const dbSnapshot = Effect.fnUntraced(function* (label: string) {
    return {
      label,
      activity: (yield* step(() =>
        pool.query(
          `SELECT pid,state,wait_event_type,wait_event,left(query,240) AS query
         FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
         ORDER BY pid`,
        ),
      )).rows,
      locks: (yield* step(() =>
        pool.query(
          `SELECT a.pid,l.locktype,l.mode,l.granted,left(a.query,240) AS query
         FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
         WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
         ORDER BY a.pid,l.locktype,l.mode`,
        ),
      )).rows,
    };
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
  const before = yield* dbSnapshot("before-login");
  yield* step(() =>
    probe.goto(`${ui}/login?redirectTo=${encodeURIComponent("/dashboard/tidligere-assistenter")}`),
  );
  yield* step(() => probe.getByLabel("E-post", { exact: true }).fill(person.email));
  yield* step(() => probe.getByLabel("Passord", { exact: true }).fill(person.password));
  yield* step(() =>
    probe.screenshot({ path: path.join(artifacts, "returning-login-before.png"), fullPage: true }),
  );
  let click = "not-started";

  const clickOutcome = yield* Effect.exit(
    step(() =>
      probe.getByRole("button", { name: "Logg inn", exact: true }).click({
        timeout: 10_000,
        noWaitAfter: true,
      }),
    ),
  );

  click = Exit.isSuccess(clickOutcome)
    ? "resolved"
    : `error:${clickOutcome.cause.pipe(thrownBy, errorName)}`;

  const afterClick = yield* dbSnapshot("after-click");
  let navigation = "not-started";

  const navigationOutcome = yield* Effect.exit(
    step(() => probe.waitForURL(/\/dashboard\/tidligere-assistenter$/, { timeout: 10_000 })),
  );

  navigation = Exit.isSuccess(navigationOutcome)
    ? "dashboard"
    : `error:${navigationOutcome.cause.pipe(thrownBy, errorName)}`;

  const afterNavigation = yield* dbSnapshot("after-navigation");
  yield* step(() =>
    probe.screenshot({ path: path.join(artifacts, "returning-login-after.png"), fullPage: true }),
  );
  const html = yield* step(() => probe.content().catch(() => "<unavailable>"));
  yield* fs.writeFileString(
    path.join(artifacts, "returning-login-probe.html"),
    html.replaceAll(person.email, "[redacted]").replaceAll(person.password, "[redacted]"),
  );

  const result = {
    click,
    navigation,
    events,
    before,
    afterClick,
    afterNavigation,
    url: probe.url(),
  };

  yield* fs.writeFileString(
    path.join(artifacts, "returning-login-probe.json"),
    yield* indentedJsonText(result),
  );
  yield* step(() => context.close());

  return result;
});

const assertStatus = Effect.fnUntraced(function* (form: Locator, expected: string) {
  yield* step(() => form.getByRole("status").filter({ hasText: expected }).waitFor());
});

const expectValue = Effect.fnUntraced(function* (field: Locator, expected: string) {
  const actual = yield* step(() => field.inputValue());

  if (actual !== expected) {
    throw new Error(
      `field value mismatch actual=${yield* jsonText(actual)} expected=${yield* jsonText(expected)}`,
    );
  }
});
