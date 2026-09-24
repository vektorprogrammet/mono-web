import { afterAll, describe, expect, it } from "vitest";
import { Database } from "./service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { OnboardingFailure } from "@vektorprogrammet/domain/onboarding";
import {
  claimOnboarding,
  commandOnboarding,
  readOnboardingBoard,
} from "@vektorprogrammet/database/onboarding";
import { Effect } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";
import { provisionOnboardingAccount } from "./onboarding-account.js";

const runtime = makeControlledTestRuntime(DatabaseTest());

afterAll(() => runtime.dispose());

const dept = DepartmentId.make("onboarding-dept");

const actor = PersonId.make("onboarding-leader");

const now = new Date().toISOString();

async function setup() {
  await runtime.runPromise(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${dept},'Onboarding')`;
        yield* sql`INSERT INTO admission_period_semesters VALUES('onboarding-semester','2026-01-01','2027-01-01')`;
        yield* sql`INSERT INTO admission_periods VALUES('onboarding-period',${dept},'onboarding-semester','2026-01-01','2027-01-01',0,'onboarding-seed')`;
        yield* sql`INSERT INTO admission_period_fields_of_study VALUES('onboarding-fos',${dept},'Math',true)`;
        yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${actor},'Cora','Coordinator')`;

        for (let i = 0; i < 7; i++) {
          yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES(${"onboard-applicant-" + i},${"applicant" + i + "@example.invalid"},${"applicant" + i + "@example.invalid"},'Ada','Applicant','12345678',0,'onboarding-fos',2)`;
          yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${"onboard-app-" + i},${"onboard-applicant-" + i},'onboarding-period',${dept},'onboarding-fos',2,${now})`;
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
          now,
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

describe("applicant account authority", () => {
  it("atomically establishes new account/link, refuses reuse and leaves credentials/profile untouched when linking an existing account", async () => {
    await setup();
    await issue(0);
    await claim(0, "new-onboard-person");
    await expect(claim(0, "other-person")).rejects.toMatchObject({
      code: "onboarding.claim-invalid",
    });
    await issue(1);
    await runtime.runPromise(
      claimOnboarding({
        digest: "1".repeat(64),
        now,
        identity: { mode: "ExistingAccount", personId: PersonId.make("new-onboard-person") },
        provision: provisionOnboardingAccount,
      }),
    );

    const rows = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT (SELECT count(*)::int FROM applicant_account_links WHERE person_id='new-onboard-person') links,(SELECT count(*)::int FROM auth."account" WHERE "userId"='new-onboard-person') accounts,(SELECT email FROM auth."user" WHERE id='new-onboard-person') email,(SELECT count(*)::int FROM organization_volunteer_affiliations WHERE person_id='new-onboard-person') affiliations`,
      ),
    );

    expect(rows[0]).toEqual({
      links: 2,
      accounts: 1,
      email: "applicant0@example.invalid",
      affiliations: 0,
    });
  }, 15000);
  it("rolls back all partial writes when provision fails", async () => {
    await issue(2);

    const failed = (input: Parameters<typeof provisionOnboardingAccount>[0]) =>
      provisionOnboardingAccount(input).pipe(
        Effect.andThen(
          Effect.fail(new OnboardingFailure({ code: "onboarding.claim-invalid", status: 400 })),
        ),
      );

    await expect(claim(2, "rollback-onboard-person", failed)).rejects.toMatchObject({
      code: "onboarding.claim-invalid",
    });

    const rows = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT (SELECT count(*)::int FROM person_profiles WHERE person_id='rollback-onboard-person') people,(SELECT state FROM applicant_account_invitations WHERE invitation_id='onboard-invite-2') state`,
      ),
    );

    expect(rows[0]).toEqual({ people: 0, state: "Open" });
    await claim(2, "rollback-onboard-person");
  });
  it("refuses native email collision without changing existing credentials", async () => {
    await issue(3);
    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`UPDATE auth."user" SET email='applicant3@example.invalid' WHERE id='new-onboard-person'`,
      ),
    );
    await expect(claim(3, "collision-person")).rejects.toMatchObject({
      code: "onboarding.sign-in-required",
    });
  });
  it("reissue is ordered independently of equal timestamps and claims the proven recipient snapshot", async () => {
    await issue(6);
    await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          commandOnboarding({
            departmentId: dept,
            command: {
              applicationId: PublicApplicationIdSchema.make("onboard-app-6"),
              action: "Issue",
            },
            actor,
            now,
            invitationId: "aaa-reissued",
            token: "onboard_" + "7".repeat(64),
            digest: "7".repeat(64),
          }),
        ),
      ),
    );
    await expect(claim(6, "stale-person")).rejects.toMatchObject({
      code: "onboarding.claim-invalid",
    });
    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`UPDATE admission_applicants SET email='changed@example.invalid' WHERE applicant_id='onboard-applicant-6'`,
      ),
    );
    await claim(7, "reissued-person");

    const rows = await runtime.runPromise(
      Database.use((sql) => sql`SELECT email FROM auth."user" WHERE id='reissued-person'`),
    );

    expect(rows[0]?.email).toBe("applicant6@example.invalid");
  });
  it("revokes only the selected application even when two departments share an applicant", async () => {
    const other = DepartmentId.make("onboarding-other");
    const applicationId = PublicApplicationIdSchema.make("onboarding-other-application");
    await runtime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${other},'Other')`;
          yield* sql`INSERT INTO admission_periods VALUES('onboarding-other-period',${other},'onboarding-semester','2026-01-01','2027-01-01',0,'other-seed')`;
          yield* sql`INSERT INTO admission_period_fields_of_study VALUES('onboarding-other-fos',${other},'Other Math',true)`;
          yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},'onboard-applicant-3','onboarding-other-period',${other},'onboarding-other-fos',2,${now})`;
          yield* commandOnboarding({
            departmentId: other,
            command: { applicationId, action: "Issue" },
            actor,
            now,
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
            now,
            invitationId: "original-revoke",
            token: "unused",
            digest: "a".repeat(64),
          });
        }),
      ),
    );

    const selected = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT state FROM applicant_account_invitations WHERE invitation_id='other-invite'`,
      ),
    );

    expect(selected[0]?.state).toBe("Open");
    const board = await runtime.runPromise(readOnboardingBoard(dept));
    expect(board.items.find((item) => item.applicationId === "onboard-app-3")?.state).toBe(
      "Revoked",
    );
  });
});
