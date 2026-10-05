import { describe, expect, it } from "@effect/vitest";
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { observePostgresStatements } from "@vektorprogrammet/database/test-support/observe-postgres";
import { IdentityActor } from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
} from "@vektorprogrammet/domain/recruitment";
import { NativeProblem } from "@vektorprogrammet/http-api/http-semantics";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestHttp } from "../test/native-http.js";
import { TestPlatform } from "../test/platform.js";
import { maintainRecruitmentHttp } from "./maintenance-http.js";
import { recruitmentGuards } from "./http.js";

const personId = PersonId.make("maintenance-conflict-admin");

const command = RecruitmentMaintenanceCommand.cases.CreateQuestionnaire.make({
  commandId: "maintenance-conflict-command",
  name: "Conflict questionnaire",
  reason: "Exercise transaction custody",
  active: true,
  questions: [
    {
      questionId: "conflict-question",
      ordinal: 0,
      prompt: "Why volunteer?",
      helpText: null,
      kind: "text",
      alternatives: [],
    },
  ],
});

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES (${personId},'Test','Administrator')`;
    yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES (${personId},'Test Administrator','maintenance-admin@example.invalid',true)`;
    yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at) VALUES ('maintenance-conflict-grant',${personId},'2020-01-01')`;
  }),
);

const identity = Layer.succeed(
  IdentitySnapshot,
  IdentitySnapshot.of({
    resolveSession: () =>
      Effect.succeed(
        new IdentityActor({
          personId,
          sessionId: "maintenance-session",
          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
        }),
      ),
    revokeCurrentSession: () => Effect.die("unexpected session mutation"),
    revokeSession: () => Effect.die("unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected session mutation"),
    revokeAllSessions: () => Effect.die("unexpected session mutation"),
  }),
);

const domain = RecruitmentLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(Layer.provideMerge(OrganizationLive)),
  ),
);

const request = (body: string) =>
  new Request("http://backend.test/api/recruitment/maintenance/commands", {
    method: "POST",
    headers: {
      cookie: "better-auth.session_token=maintenance-session",
      origin: "http://127.0.0.1:5174",
      "content-type": "application/json",
      "idempotency-key": command.commandId,
    },
    body,
  });

const persisted = Database.use(
  (sql) => sql`
  SELECT
    (SELECT count(*)::integer FROM recruitment_interview_schemas) AS questionnaires,
    (SELECT count(*)::integer FROM recruitment_interview_schema_questions) AS questions,
    (SELECT count(*)::integer FROM recruitment_questionnaire_history) AS audit,
    (SELECT count(*)::integer FROM recruitment_maintenance_command_receipts) AS "domainReceipts",
    (SELECT count(*)::integer FROM native_http_idempotency_receipts) AS "httpReceipts"
`,
);

const empty = { questionnaires: 0, questions: 0, audit: 0, domainReceipts: 0, httpReceipts: 0 };

// A nontransactional sequence records attempts even when PostgreSQL rolls back.
// The SQL error passes through the installed driver and production maintenance wrapper.
const installFault = (code: "40001" | "40P01" | "08006", failures: number) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE SEQUENCE maintenance_conflict_attempts`;
      yield* sql.unsafe(`CREATE FUNCTION maintenance_conflict_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('maintenance_conflict_attempts') <= ${failures} THEN
        RAISE EXCEPTION 'maintenance transaction fault' USING ERRCODE = '${code}';
      END IF;
      RETURN NEW;
    END $$`);
      yield* sql`CREATE TRIGGER maintenance_conflict_fault BEFORE INSERT ON recruitment_questionnaire_history FOR EACH ROW EXECUTE FUNCTION maintenance_conflict_fault()`;
    }),
  );

for (const code of ["40001", "40P01"] as const) {
  describe(`maintenance wrapped PostgreSQL ${code}`, () => {
    for (const failures of [1, 2]) {
      it.live(
        failures === 1
          ? `retries wrapped ${code} once then commits one questionnaire and all receipts`
          : `exhausts wrapped ${code} after exactly one retry as 409 transaction.conflict without writes`,
        () =>
          Effect.gen(function* () {
            const database = backendDatabase(seed);

            const services = Layer.mergeAll(
              identity,
              domain.pipe(Layer.provideMerge(database.layer)),
            );

            const http = makeBackendTestHttp(backendTestConfig, services, {
              handler: () => Effect.succeed(new Response(null, { status: 404 })),
              recordTrustedOriginRejection: () => Effect.void,
            });

            yield* database.run(installFault(code, failures));

            const body = yield* Schema.encodeEffect(
              Schema.fromJsonString(RecruitmentMaintenanceCommand),
            )(command);

            const response = yield* http.fetch(request(body));

            const [attempts] = yield* database.run(
              Database.use(
                (sql) =>
                  sql`SELECT last_value::integer AS attempts FROM maintenance_conflict_attempts`,
              ),
            );

            const state = yield* database.run(persisted);
            expect(attempts).toEqual({ attempts: 2 });
            expect(state).toEqual([
              failures === 1
                ? { questionnaires: 1, questions: 1, audit: 1, domainReceipts: 1, httpReceipts: 1 }
                : empty,
            ]);

            if (failures === 2) {
              const problem = yield* Schema.decodeEffect(Schema.fromJsonString(NativeProblem))(
                yield* Effect.promise(() => response.text()),
              );

              expect({ status: response.status, code: problem.code }).toEqual({
                status: 409,
                code: "transaction.conflict",
              });
            } else {
              expect(response.status).toBe(200);
              const bytes = yield* Effect.promise(() => response.text());

              const result = yield* Schema.decodeEffect(
                Schema.fromJsonString(RecruitmentMaintenanceResult),
              )(bytes);

              expect(Schema.is(RecruitmentMaintenanceResult.cases.QuestionnaireSaved)(result)).toBe(
                true,
              );

              const saved = yield* Schema.decodeUnknownEffect(
                RecruitmentMaintenanceResult.cases.QuestionnaireSaved,
              )(result);

              expect(saved.revision).toBe(0);
              const replay = yield* http.fetch(request(body));
              expect(replay.status).toBe(200);
              expect(yield* Effect.promise(() => replay.text())).toBe(bytes);
              expect(yield* database.run(persisted)).toEqual(state);
              expect(
                yield* database.run(
                  Database.use(
                    (sql) =>
                      sql`SELECT last_value::integer AS attempts FROM maintenance_conflict_attempts`,
                  ),
                ),
              ).toEqual([attempts]);
            }
          }),
      );
    }
  });
}

it.live("keeps an ordinary wrapped PostgreSQL outage as 503 without retry or durable writes", () =>
  Effect.gen(function* () {
    const database = backendDatabase(seed);

    const http = makeBackendTestHttp(
      backendTestConfig,
      Layer.mergeAll(identity, domain.pipe(Layer.provideMerge(database.layer))),
      {
        handler: () => Effect.succeed(new Response(null, { status: 404 })),
        recordTrustedOriginRejection: () => Effect.void,
      },
    );

    yield* database.run(installFault("08006", 2));

    const response = yield* http.fetch(
      request(
        yield* Schema.encodeEffect(Schema.fromJsonString(RecruitmentMaintenanceCommand))(command),
      ),
    );

    const problem = yield* Schema.decodeEffect(Schema.fromJsonString(NativeProblem))(
      yield* Effect.promise(() => response.text()),
    );

    expect({ status: response.status, code: problem.code }).toEqual({
      status: 503,
      code: "recruitment.unavailable",
    });
    expect(yield* database.run(persisted)).toEqual([empty]);
    expect(
      yield* database.run(
        Database.use(
          (sql) => sql`SELECT last_value::integer AS attempts FROM maintenance_conflict_attempts`,
        ),
      ),
    ).toEqual([{ attempts: 1 }]);
  }),
);

it.live(
  "interrupts maintenance after audit insertion and rolls back questionnaire, audit and both receipts",
  () =>
    Effect.gen(function* () {
      const database = backendDatabase(seed);
      const inserted = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const observed = Layer.effect(
        Database,
        Database.use((sql) =>
          Effect.succeed(
            observePostgresStatements(sql, (execution, text) => {
              if (!text.startsWith("INSERT INTO public.recruitment_questionnaire_history"))
                return execution;

              return execution.pipe(
                Effect.tap(() => Deferred.succeed(inserted, undefined)),
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(released, undefined)),
              );
            }),
          ),
        ),
      ).pipe(Layer.provide(database.layer));

      const services = Layer.mergeAll(
        TestPlatform,
        identity,
        Layer.mock(OAuthCredentialAuthority, {}),
        domain.pipe(Layer.provideMerge(observed)),
      );

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(RecruitmentMaintenanceCommand))(
        command,
      );

      const fiber = yield* maintainRecruitmentHttp(
        request(body),
        recruitmentGuards["recruitment.maintainRecruitment"],
      ).pipe(Effect.provide(services), Effect.forkChild);

      yield* Deferred.await(inserted);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(released);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(yield* database.run(persisted)).toEqual([empty]);
    }),
);
