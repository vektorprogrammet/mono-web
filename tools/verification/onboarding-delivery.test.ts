import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/database";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { claimOnboarding, commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { Predicate, Effect } from "effect";
import { DatabaseTest } from "@vektorprogrammet/database/live";
import { makeControlledTestRuntime } from "../../packages/database/test/runtime.js";
import { provisionOnboardingAccount } from "../../packages/database/src/onboarding-account.js";
import {
  drainOnboardingDelivery,
  expireOnboardingSecrets,
} from "../../apps/backend/src/onboarding/delivery.js";

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

    const drain = (fetchEffect: Parameters<typeof drainOnboardingDelivery>[2]) =>
      runtime.runPromise(drainOnboardingDelivery("onboard-app-4", config, fetchEffect));

    expect(await runtime.runPromise(drainOnboardingDelivery("onboard-app-4", undefined))).toBe(
      "Pending",
    );
    expect(
      await drain(async (_, init) => {
        if (!Predicate.isString(init?.body)) throw new Error("Expected serialized delivery body");
        envelopes.push(init.body);

        return new Response(null, { status: 503 });
      }),
    ).toBe("Pending");
    expect(
      await drain(async (_, init) => {
        if (!Predicate.isString(init?.body)) throw new Error("Expected serialized delivery body");
        envelopes.push(init.body);

        return new Response(null, { status: 204 });
      }),
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
      await runtime.runPromise(
        drainOnboardingDelivery("onboard-app-5", config, async () => {
          await runtime.runPromise(
            Database.use(
              (sql) =>
                sql`UPDATE applicant_account_delivery SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id='onboard-invite-5'`,
            ),
          );

          return new Response(null, { status: 204 });
        }),
      ),
    ).toBe("BusyOrComplete");
  });
  it("expired claims fail immediately and expiry sweep erases retained delivery material", async () => {
    await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          commandOnboarding({
            departmentId: dept,
            command: {
              applicationId: PublicApplicationIdSchema.make("onboard-app-5"),
              action: "Issue",
            },
            actor,
            now: "2000-01-01T00:00:00.000Z",
            invitationId: "expired-invitation",
            token: "onboard_" + "8".repeat(64),
            digest: "8".repeat(64),
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
