import { administratorDepartmentReach } from "@vektorprogrammet/domain/organization/authority-fixtures";
import { randomBytes } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Database } from "@vektorprogrammet/database";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { claimOnboarding, commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { Crypto, DateTime, Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { DatabaseTestLive } from "@vektorprogrammet/database/test-support/platform";
import { provisionOnboardingAccount } from "@vektorprogrammet/database/onboarding-account";
import {
  drainOnboardingDelivery,
  expireOnboardingSecrets,
} from "@vektorprogrammet/backend/onboarding/delivery";

const dept = DepartmentId.make("onboarding-dept");

const actor = PersonId.make("onboarding-leader");

const coordinator = administratorDepartmentReach("onboarding-leader", "admissions.outcomes", dept);

// The drain draws its claim identity from Crypto; no digest belongs to this lifecycle.
const testCrypto = Crypto.make({ randomBytes, digest: () => Effect.die("unexpected digest") });

const now = DateTime.formatIso(DateTime.nowUnsafe());

const setup = Database.use((sql) =>
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
);

const issue = (i: number) =>
  Database.use((sql) =>
    sql.withTransaction(
      commandOnboarding({
        coordinator,
        command: {
          applicationId: PublicApplicationIdSchema.make("onboard-app-" + i),
          action: "Issue",
        },
        now,
        invitationId: "onboard-invite-" + i,
        token: "onboard_" + String(i).repeat(64),
        digest: String(i).repeat(64),
      }),
    ),
  );

const claim = (i: number, personId: string, provision = provisionOnboardingAccount) =>
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

const OnboardingTestLive = Layer.effectDiscard(setup).pipe(Layer.provideMerge(DatabaseTestLive()));

layer(OnboardingTestLive, { excludeTestServices: true, timeout: "15 seconds" })(
  "onboarding delivery lifecycle",
  (it) => {
    it.effect(
      "retains immutable envelope through failure, clears secret on ACK and reports lost custody accurately",
      () =>
        Effect.gen(function* () {
          const database = yield* Database;
          yield* issue(4);
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
            drainOnboardingDelivery(applicationId, deliveryConfig).pipe(
              Effect.provideService(HttpClient.HttpClient, HttpClient.make(respond)),
              Effect.provideService(Crypto.Crypto, testCrypto),
            );

          const answer = (request: HttpClientRequest.HttpClientRequest, status: number) => {
            if (!Predicate.isTagged(request.body, "Uint8Array"))
              throw new Error("Expected a JSON body");
            envelopes.push(new TextDecoder().decode(request.body.body));

            return HttpClientResponse.fromWeb(request, new Response(null, { status }));
          };

          expect(
            yield* drain("onboard-app-4", undefined, () => Effect.die("unexpected delivery")),
          ).toBe("Pending");
          expect(
            yield* drain("onboard-app-4", config, (request) =>
              Effect.sync(() => answer(request, 503)),
            ),
          ).toBe("Pending");
          expect(
            yield* drain("onboard-app-4", config, (request) =>
              Effect.sync(() => answer(request, 204)),
            ),
          ).toBe("Delivered");
          expect(envelopes[0]).toBe(envelopes[1]);

          const rows =
            yield* database`SELECT state,secret,envelope FROM applicant_account_delivery WHERE invitation_id='onboard-invite-4'`;

          expect(rows[0]).toEqual({ state: "Delivered", secret: null, envelope: null });
          yield* issue(5);
          expect(
            yield* drain("onboard-app-5", config, (request) =>
              database`UPDATE applicant_account_delivery SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id='onboard-invite-5'`.pipe(
                Effect.orDie,
                Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
              ),
            ),
          ).toBe("BusyOrComplete");
        }),
    );
    it.effect(
      "expired claims fail immediately and expiry sweep erases retained delivery material",
      () =>
        Effect.gen(function* () {
          const database = yield* Database;
          yield* Database.use((sql) =>
            sql.withTransaction(
              commandOnboarding({
                coordinator,
                command: {
                  applicationId: PublicApplicationIdSchema.make("onboard-app-5"),
                  action: "Issue",
                },
                now: "2000-01-01T00:00:00.000Z",
                invitationId: "expired-invitation",
                token: "onboard_" + "8".repeat(64),
                digest: "8".repeat(64),
              }),
            ),
          );
          expect(yield* Effect.flip(claim(8, "expired-person"))).toMatchObject({
            code: "onboarding.claim-invalid",
          });
          yield* expireOnboardingSecrets;

          const rows =
            yield* database`SELECT state,secret,envelope FROM applicant_account_delivery WHERE invitation_id='expired-invitation'`;

          expect(rows[0]).toEqual({ state: "Cancelled", secret: null, envelope: null });
        }),
    );
  },
);
