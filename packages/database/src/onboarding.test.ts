import { expect, layer } from "@effect/vitest";
import { Database, type DatabaseOperations } from "./service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { OnboardingFailure } from "@vektorprogrammet/domain/onboarding";
import { Instant } from "@vektorprogrammet/domain/time";
import {
  claimOnboarding,
  commandOnboarding,
  readOnboardingBoard,
} from "@vektorprogrammet/database/onboarding";
import { DateTime, Effect, Schema } from "effect";
import { DatabaseTestLive } from "./test-support/platform.js";
import { provisionOnboardingAccount } from "./onboarding-account.js";

const dept = DepartmentId.make("onboarding-dept");

const actor = PersonId.make("onboarding-leader");

const decodeClockInstant = Schema.decodeEffect(Instant);

// SQL expiry is authoritative. A failed disposable SQL clock is a broken fixture, not a fallback.
const readSqlClock = Effect.fnUntraced(function* (sql: DatabaseOperations) {
  const rows = yield* sql<{
    now: string;
  }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;

  return yield* decodeClockInstant(rows[0]!.now);
}, Effect.orDie);

const currentInstant = Database.use(readSqlClock).pipe(Effect.map(DateTime.formatIso));

const seedCompletedInterview = Effect.fnUntraced(function* (
  applicationId: string,
  departmentId: DepartmentId,
  now: string,
) {
  const sql = yield* Database;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const interviewId = applicationId + "-interview";
      const schemaId = applicationId + "-schema";
      const assignedAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: -2 }));
      const scheduledAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: -1 }));
      yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count) VALUES(${schemaId},'Synthetic onboarding interview',1)`;
      yield* sql`INSERT INTO recruitment_interview_schema_questions(interview_schema_id,question_id,ordinal,prompt,kind,alternatives) VALUES(${schemaId},'explanation',0,'Explain how you would help a pupil.','text','[]'::jsonb)`;
      yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES(${interviewId},${applicationId},${departmentId},${actor},${schemaId},${actor},${assignedAt},2)`;
      yield* sql`INSERT INTO recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,kind,alternatives) SELECT ${interviewId},question_id,ordinal,prompt,kind,alternatives FROM recruitment_interview_schema_questions WHERE interview_schema_id=${schemaId}`;
      yield* sql`INSERT INTO recruitment_interview_schedules(interview_id,scheduled_at,room,campus,message,scheduled_by_person_id,committed_at,schedule_revision) VALUES(${interviewId},${scheduledAt},'A1','Synthetic campus','Welcome',${actor},${assignedAt},1)`;
      yield* sql`INSERT INTO recruitment_invitations(invitation_id,interview_id,schedule_revision,capability_sha256,response_state,response_revision,responded_at,created_at) VALUES(${interviewId + "-invitation"},${interviewId},1,repeat(md5(${interviewId}),2),'Accepted',1,${assignedAt},${assignedAt})`;
      yield* sql`INSERT INTO recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,responded_at) VALUES(${interviewId + "-invitation"},${interviewId},1,1,'Accepted',${assignedAt})`;
      yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES(${interviewId},'[{"questionId":"explanation","answer":"Work through a concrete example with the pupil."}]'::jsonb,7,8,9,${actor},${now},2,'Ja')`;
    }),
  );
});

const setup = (now: string) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe(now);
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

        if (i === 0) {
          expect((yield* Effect.flip(issue(i)))._tag).toBe("OnboardingNotAdmitted");
        }

        yield* seedCompletedInterview("onboard-app-" + i, dept, now);
      }
    }),
  );

const issue = (i: number, clock?: Effect.Effect<Instant>) =>
  Database.use((sql) =>
    sql.withTransaction(
      commandOnboarding({
        departmentId: dept,
        command: {
          applicationId: PublicApplicationIdSchema.make("onboard-app-" + i),
          action: "Issue",
        },
        actor,
        now: clock ?? readSqlClock(sql),
        invitationId: "onboard-invite-" + i,
        token: "onboard_" + String(i).repeat(64),
        digest: String(i).repeat(64),
      }),
    ),
  );

const claim = (i: number, personId: string, now: string, provision = provisionOnboardingAccount) =>
  claimOnboarding({
    digest: String(i).repeat(64),
    now,
    identity: {
      mode: "NewAccount",
      personId: PersonId.make(personId),
      passwordHash: "synthetic-hash",
    },
    provision,
  });

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "15 seconds" })(
  "applicant account authority",
  (it) => {
    it.effect(
      "atomically establishes new account/link, refuses reuse and leaves credentials/profile untouched when linking an existing account",
      () =>
        Effect.gen(function* () {
          const now = yield* currentInstant;

          yield* setup(now);
          yield* issue(0);
          yield* claim(0, "new-onboard-person", now);
          expect(yield* Effect.flip(claim(0, "other-person", now))).toMatchObject({
            code: "onboarding.claim-invalid",
          });
          yield* issue(1);
          yield* claimOnboarding({
            digest: "1".repeat(64),
            now,
            identity: { mode: "ExistingAccount", personId: PersonId.make("new-onboard-person") },
            provision: provisionOnboardingAccount,
          });

          const rows = yield* Database.use(
            (sql) =>
              sql`SELECT (SELECT count(*)::int FROM applicant_account_links WHERE person_id='new-onboard-person') links,(SELECT count(*)::int FROM auth."account" WHERE "userId"='new-onboard-person') accounts,(SELECT email FROM auth."user" WHERE id='new-onboard-person') email,(SELECT count(*)::int FROM organization_volunteer_affiliations WHERE person_id='new-onboard-person') affiliations`,
          );

          expect(rows[0]).toEqual({
            links: 2,
            accounts: 1,
            email: "applicant0@example.invalid",
            affiliations: 0,
          });
        }),
      15000,
    );
    it.effect("rolls back all partial writes when provision fails", () =>
      Effect.gen(function* () {
        const now = yield* currentInstant;

        yield* issue(2);

        const failed = (input: Parameters<typeof provisionOnboardingAccount>[0]) =>
          provisionOnboardingAccount(input).pipe(
            Effect.andThen(
              Effect.fail(new OnboardingFailure({ code: "onboarding.claim-invalid", status: 400 })),
            ),
          );

        expect(yield* Effect.flip(claim(2, "rollback-onboard-person", now, failed))).toMatchObject({
          code: "onboarding.claim-invalid",
        });

        const rows = yield* Database.use(
          (sql) =>
            sql`SELECT (SELECT count(*)::int FROM person_profiles WHERE person_id='rollback-onboard-person') people,(SELECT state FROM applicant_account_invitations WHERE invitation_id='onboard-invite-2') state`,
        );

        expect(rows[0]).toEqual({ people: 0, state: "Open" });
        yield* claim(2, "rollback-onboard-person", now);
      }),
    );
    it.effect("refuses native email collision without changing existing credentials", () =>
      Effect.gen(function* () {
        const now = yield* currentInstant;

        yield* issue(3);
        yield* Database.use(
          (sql) =>
            sql`UPDATE auth."user" SET email='applicant3@example.invalid' WHERE id='new-onboard-person'`,
        );
        expect(yield* Effect.flip(claim(3, "collision-person", now))).toMatchObject({
          code: "onboarding.sign-in-required",
        });
      }),
    );
    it.effect(
      "reissue is ordered independently of equal timestamps and claims the proven recipient snapshot",
      () =>
        Effect.gen(function* () {
          const clock = { now: yield* currentInstant };
          const now = clock.now;

          // Read the owned mutable clock only when the fenced command asks for it.
          const invitationClock = Effect.sync(() => clock.now).pipe(
            Effect.flatMap(decodeClockInstant),
            Effect.orDie,
          );

          yield* issue(6, invitationClock);
          yield* Database.use((sql) =>
            sql.withTransaction(
              commandOnboarding({
                departmentId: dept,
                command: {
                  applicationId: PublicApplicationIdSchema.make("onboard-app-6"),
                  action: "Issue",
                },
                actor,
                now: invitationClock,
                invitationId: "aaa-reissued",
                token: "onboard_" + "7".repeat(64),
                digest: "7".repeat(64),
              }),
            ),
          );

          const ordering = yield* Database.use(
            (sql) => sql`SELECT
            min(issued_at)=max(issued_at) AS equal_timestamps,
            max(generation) FILTER (WHERE invitation_id='aaa-reissued') > max(generation) FILTER (WHERE invitation_id='onboard-invite-6') AS reissue_is_later
            FROM applicant_account_invitations WHERE invitation_id IN ('onboard-invite-6','aaa-reissued')`,
          );

          expect(ordering).toEqual([{ equal_timestamps: true, reissue_is_later: true }]);
          expect(yield* Effect.flip(claim(6, "stale-person", now))).toMatchObject({
            code: "onboarding.claim-invalid",
          });

          const statementBefore = yield* Database.use(
            (sql) =>
              sql`SELECT * FROM admission_applicants WHERE applicant_id='onboard-applicant-6'`,
          );

          const recipientBefore = yield* Database.use(
            (sql) =>
              sql`SELECT invitation_id,recipient FROM applicant_account_delivery WHERE invitation_id IN ('onboard-invite-6','aaa-reissued') ORDER BY invitation_id`,
          );

          const refusal = yield* Effect.flip(
            Database.use((sql) =>
              sql.withTransaction(
                sql`UPDATE admission_applicants SET email='changed@example.invalid' WHERE applicant_id='onboard-applicant-6'`,
              ),
            ),
          );

          expect(refusal._tag).toBe("SqlError");
          expect(refusal.reason._tag).toBe("ConstraintError");
          expect(
            yield* Database.use(
              (sql) =>
                sql`SELECT * FROM admission_applicants WHERE applicant_id='onboard-applicant-6'`,
            ),
          ).toEqual(statementBefore);
          expect(
            yield* Database.use(
              (sql) =>
                sql`SELECT invitation_id,recipient FROM applicant_account_delivery WHERE invitation_id IN ('onboard-invite-6','aaa-reissued') ORDER BY invitation_id`,
            ),
          ).toEqual(recipientBefore);
          yield* claim(7, "reissued-person", now);

          const rows = yield* Database.use(
            (sql) => sql`SELECT email FROM auth."user" WHERE id='reissued-person'`,
          );

          expect(rows[0]?.email).toBe("applicant6@example.invalid");
        }),
    );
    it.effect(
      "revokes only the selected application even when two departments share an applicant",
      () =>
        Effect.gen(function* () {
          const now = yield* currentInstant;
          const other = DepartmentId.make("onboarding-other");
          const applicationId = PublicApplicationIdSchema.make("onboarding-other-application");
          yield* Database.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${other},'Other')`;
                yield* sql`INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) SELECT 'onboarding-other-period',${other},semester_id,start_at,end_at,'other-seed' FROM admission_periods WHERE admission_period_id='onboarding-period'`;
                yield* sql`INSERT INTO admission_period_fields_of_study VALUES('onboarding-other-fos',${other},'Other Math',true)`;
                yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) SELECT ${applicationId},'onboard-applicant-3',admission_period_id,department_id,'onboarding-other-fos',2,start_at FROM admission_periods WHERE admission_period_id='onboarding-other-period'`;
                yield* seedCompletedInterview(applicationId, other, now);
                yield* commandOnboarding({
                  departmentId: other,
                  command: { applicationId, action: "Issue" },
                  actor,
                  now: readSqlClock(sql),
                  invitationId: "other-invite",
                  token: "onboard_" + "9".repeat(64),
                  digest: "9".repeat(64),
                });
                yield* commandOnboarding({
                  departmentId: dept,
                  command: {
                    applicationId: PublicApplicationIdSchema.make("onboard-app-3"),
                    action: "Revoke",
                  },
                  actor,
                  now: readSqlClock(sql),
                  invitationId: "original-revoke",
                  token: "unused",
                  digest: "a".repeat(64),
                });
              }),
            ),
          );

          const selected = yield* Database.use(
            (sql) =>
              sql`SELECT state FROM applicant_account_invitations WHERE invitation_id='other-invite'`,
          );

          expect(selected[0]?.state).toBe("Open");
          const board = yield* readOnboardingBoard(dept);
          expect(board.items.find((item) => item.applicationId === "onboard-app-3")?.state).toBe(
            "Revoked",
          );
        }),
    );
  },
);
