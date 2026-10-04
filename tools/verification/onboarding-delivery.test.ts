import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { Instant } from "@vektorprogrammet/domain/time";
import { claimOnboarding, commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { Crypto, DateTime, Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { DatabaseTestLive } from "@vektorprogrammet/database/test-support/platform";
import { makeControlledTestRuntime } from "./controlled-test-runtime.js";
import { provisionOnboardingAccount } from "@vektorprogrammet/database/onboarding-account";
import {
  drainOnboardingDelivery,
  expireOnboardingSecrets,
} from "@vektorprogrammet/backend/onboarding/delivery";

const runtime = makeControlledTestRuntime(DatabaseTestLive());

afterAll(() => runtime.dispose());

const dept = DepartmentId.make("onboarding-dept");

const actor = PersonId.make("onboarding-leader");

// The drain draws its claim identity from Crypto; no digest belongs to this lifecycle.
const testCrypto = Crypto.make({ randomBytes, digest: () => Effect.die("unexpected digest") });

const decodeClockInstant = Schema.decodeEffect(Instant);

// SQL expiry is authoritative. A failed disposable SQL clock is a broken fixture, not a fallback.
const readSqlClock = Effect.fnUntraced(function* (sql: DatabaseOperations) {
  const rows = yield* sql<{
    now: string;
  }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;

  return yield* decodeClockInstant(rows[0]!.now);
}, Effect.orDie);

let now: string;

async function setup() {
  await runtime.runPromise(
    Database.use((sql) =>
      Effect.gen(function* () {
        const at = yield* readSqlClock(sql);
        now = DateTime.formatIso(at);
        const opensAt = DateTime.formatIso(DateTime.add(at, { days: -30 }));
        const closesAt = DateTime.formatIso(DateTime.add(at, { days: 30 }));
        yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${dept},'Onboarding')`;
        yield* sql`INSERT INTO admission_period_semesters VALUES('onboarding-semester',${opensAt},${closesAt})`;
        yield* sql`INSERT INTO admission_periods VALUES('onboarding-period',${dept},'onboarding-semester',${opensAt},${closesAt},0,'onboarding-seed')`;
        yield* sql`INSERT INTO admission_period_fields_of_study VALUES('onboarding-fos',${dept},'Math',true)`;
        yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${actor},'Cora','Coordinator')`;

        for (let i = 0; i < 7; i++) {
          yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES(${"onboard-applicant-" + i},${"applicant" + i + "@example.invalid"},${"applicant" + i + "@example.invalid"},'Ada','Applicant','12345678',0,'onboarding-fos',2)`;
          yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${"onboard-app-" + i},${"onboard-applicant-" + i},'onboarding-period',${dept},'onboarding-fos',2,${opensAt})`;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const interviewId = "onboard-interview-" + i;
              const schemaId = "onboard-schema-" + i;

              const assignedAt = DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(now), { hours: -2 }),
              );

              const scheduledAt = DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(now), { hours: -1 }),
              );

              yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count) VALUES(${schemaId},'Synthetic onboarding interview',1)`;
              yield* sql`INSERT INTO recruitment_interview_schema_questions(interview_schema_id,question_id,ordinal,prompt,kind,alternatives) VALUES(${schemaId},'explanation',0,'Explain how you would help a pupil.','text','[]'::jsonb)`;
              yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES(${interviewId},${"onboard-app-" + i},${dept},${actor},${schemaId},${actor},${assignedAt},2)`;
              yield* sql`INSERT INTO recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,kind,alternatives) SELECT ${interviewId},question_id,ordinal,prompt,kind,alternatives FROM recruitment_interview_schema_questions WHERE interview_schema_id=${schemaId}`;
              yield* sql`INSERT INTO recruitment_interview_schedules(interview_id,scheduled_at,room,campus,message,scheduled_by_person_id,committed_at,schedule_revision) VALUES(${interviewId},${scheduledAt},'A1','Synthetic campus','Welcome',${actor},${assignedAt},1)`;
              yield* sql`INSERT INTO recruitment_invitations(invitation_id,interview_id,schedule_revision,capability_sha256,response_state,response_revision,responded_at,created_at) VALUES(${interviewId + "-invitation"},${interviewId},1,repeat(md5(${interviewId}),2),'Accepted',1,${assignedAt},${assignedAt})`;
              yield* sql`INSERT INTO recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,responded_at) VALUES(${interviewId + "-invitation"},${interviewId},1,1,'Accepted',${assignedAt})`;
              yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES(${interviewId},'[{"questionId":"explanation","answer":"Work through a concrete example with the pupil."}]'::jsonb,7,8,9,${actor},${now},2,'Ja')`;
            }),
          );
        }
      }),
    ),
  );
}

const issue = (i: number) =>
  runtime.runPromise(
    Database.use((sql) =>
      sql.withTransaction(
        commandOnboarding({
          departmentId: dept,
          command: {
            applicationId: PublicApplicationIdSchema.make("onboard-app-" + i),
            action: "Issue",
          },
          actor,
          now: readSqlClock(sql),
          invitationId: "onboard-invite-" + i,
          token: "onboard_" + String(i).repeat(64),
          digest: String(i).repeat(64),
        }),
      ),
    ),
  );

const claim = (i: number, personId: string, provision = provisionOnboardingAccount) =>
  runtime.runPromise(
    claimOnboarding({
      digest: String(i).repeat(64),
      now,
      identity: {
        mode: "NewAccount",
        personId: PersonId.make(personId),
        passwordHash: "synthetic-hash",
      },
      provision,
    }),
  );

beforeAll(setup, 15000);

describe("onboarding delivery lifecycle", () => {
  it("retains immutable envelope through failure, clears secret on ACK and reports lost custody accurately", async () => {
    await issue(4);
    const envelopes: string[] = [];

    const config = {
      sender: "sender@example.invalid",
      claimUrl: new URL("http://127.0.0.1:5174/konto-aktivering"),
      transport: {
        endpoint: new URL("http://127.0.0.1:1111/mail"),
        token: "synthetic",
        deliveryTimeoutMilliseconds: 1000,
      },
    };

    const drain = (
      applicationId: string,
      deliveryConfig: typeof config | undefined,
      respond: Parameters<typeof HttpClient.make>[0],
    ) =>
      runtime.runPromise(
        drainOnboardingDelivery(applicationId, deliveryConfig).pipe(
          Effect.provideService(HttpClient.HttpClient, HttpClient.make(respond)),
          Effect.provideService(Crypto.Crypto, testCrypto),
        ),
      );

    const answer = (request: HttpClientRequest.HttpClientRequest, status: number) => {
      if (!Predicate.isTagged(request.body, "Uint8Array")) throw new Error("Expected a JSON body");
      envelopes.push(new TextDecoder().decode(request.body.body));

      return HttpClientResponse.fromWeb(request, new Response(null, { status }));
    };

    expect(await drain("onboard-app-4", undefined, () => Effect.die("unexpected delivery"))).toBe(
      "Pending",
    );
    expect(
      await drain("onboard-app-4", config, (request) => Effect.sync(() => answer(request, 503))),
    ).toBe("Pending");
    expect(
      await drain("onboard-app-4", config, (request) => Effect.sync(() => answer(request, 204))),
    ).toBe("Delivered");
    expect(envelopes[0]).toBe(envelopes[1]);

    const rows = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT state,secret,envelope FROM applicant_account_delivery WHERE invitation_id='onboard-invite-4'`,
      ),
    );

    expect(rows[0]).toEqual({ state: "Delivered", secret: null, envelope: null });
    await issue(5);
    expect(
      await drain("onboard-app-5", config, (request) =>
        Effect.promise(() =>
          runtime.runPromise(
            Database.use(
              (sql) =>
                sql`UPDATE applicant_account_delivery SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id='onboard-invite-5'`,
            ),
          ),
        ).pipe(Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))),
      ),
    ).toBe("BusyOrComplete");
  });
  it("expired claims fail immediately and expiry sweep erases retained delivery material", async () => {
    await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            // The application remains admitted now; only this immutable invitation is expired.
            yield* commandOnboarding({
              departmentId: dept,
              command: {
                applicationId: PublicApplicationIdSchema.make("onboard-app-5"),
                action: "Revoke",
              },
              actor,
              now: readSqlClock(sql),
              invitationId: "expiry-predecessor-revoke",
              token: "unused",
              digest: "unused",
            });
            yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at)
              VALUES('expired-invitation','onboard-app-5','onboard-applicant-5',${"8".repeat(64)},date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '1 second','Open',${actor},date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '24 hours 1 second')`;
            yield* sql`INSERT INTO applicant_account_delivery(invitation_id,state,recipient,secret)
              VALUES('expired-invitation','Pending','applicant5@example.invalid',${"onboard_" + "8".repeat(64)})`;
          }),
        ),
      ),
    );
    await expect(claim(8, "expired-person")).rejects.toMatchObject({
      code: "onboarding.claim-invalid",
    });
    await runtime.runPromise(expireOnboardingSecrets);

    const rows = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT state,secret,envelope FROM applicant_account_delivery WHERE invitation_id='expired-invitation'`,
      ),
    );

    expect(rows[0]).toEqual({ state: "Cancelled", secret: null, envelope: null });
  });
});
