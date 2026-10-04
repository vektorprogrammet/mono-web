import { assert, describe, it } from "@effect/vitest";
import { Database } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  deliverNextRecruitmentInvitationResponse,
  RecruitmentLive,
} from "@vektorprogrammet/database/recruitment";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import {
  observePostgresStatements,
  type PostgresStatementObserver,
} from "@vektorprogrammet/database/test-support/observe-postgres";
import type { Admissions } from "@vektorprogrammet/domain/admissions";
import { AdmissionPeriodActorSchema } from "@vektorprogrammet/domain/admission-period";
import {
  makeRecordingNotificationGateway,
  NotificationGateway,
} from "@vektorprogrammet/domain/notification";
import { DepartmentId, PersonId, type Organization } from "@vektorprogrammet/domain/organization";
import type { Profile } from "@vektorprogrammet/domain/profile";
import {
  Recruitment,
  RecruitmentActorSchema,
  RecruitmentCancellationCommandId,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationId,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationTransition,
  RecruitmentNotificationDeliveryError,
  RecruitmentScheduleCommandId,
  type RecruitmentInvitationResponseOutboxRequest,
} from "@vektorprogrammet/domain/recruitment";
import { InvitationResponseObservation, NativeProblem } from "@vektorprogrammet/http-api";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { backendDatabase } from "../../test/database.js";
import { makeRecruitmentTestHttp } from "../test/native-http.js";

const now = "2031-09-15T12:00:00.000Z";

const cancelledAt = "2031-09-15T12:02:00.000Z";

const afterCancellation = "2031-09-15T12:03:00.000Z";

const departmentId = DepartmentId.make("cancel-department");

const interviewerPersonId = PersonId.make("cancel-interviewer");

const interviewId = RecruitmentInterviewId.make("cancel-interview");

const capability = RecruitmentInvitationCapabilitySchema.make(
  "cancelled-regression".padEnd(43, "_"),
);

const replacementCapability = RecruitmentInvitationCapabilitySchema.make(
  "replacement-regression".padEnd(43, "_"),
);

const unknownCapability = RecruitmentInvitationCapabilitySchema.make(
  "unknown-regression".padEnd(43, "_"),
);

const newTimeMessage = RecruitmentInvitationResponseMessageSchema.make(
  "Please offer another afternoon.",
);

const actor = RecruitmentActorSchema.cases.Member.make({
  personId: interviewerPersonId,
  departmentId,
  active: true,
});

const leader = AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
  personId: PersonId.make("cancel-leader"),
  departmentId,
  active: true,
});

const domain = RecruitmentLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AdmissionsLive, ProfileLive).pipe(Layer.provideMerge(OrganizationLive)),
  ),
);

type DomainServices = Database | Recruitment | Admissions | Profile | Organization;

// A command result means committed facts, audit and outbox, not provider completion.
const schedule = (replacement = false) =>
  Recruitment.use((recruitment) =>
    recruitment.scheduleInterview(
      {
        commandId: RecruitmentScheduleCommandId.make(
          replacement ? "cancel-rebooking" : "cancel-schedule",
        ),
        interviewId,
        expectedRevision: replacement ? 1 : 0,
        scheduledAt: replacement ? "2031-09-22T10:00:00.000Z" : "2031-09-20T10:00:00.000Z",
        room: "A-101",
        campus: "Main Campus",
        mapLink: "https://maps.example.invalid/interview",
        message: "Welcome to your interview.",
      },
      {
        actor: leader,
        now,
        invitationId: RecruitmentInvitationId.make(
          replacement ? "cancel-replacement" : "cancel-invitation",
        ),
        responseCapability: replacement ? replacementCapability : capability,
      },
    ),
  );

const cancel = Recruitment.use((recruitment) =>
  recruitment.cancelInterview(
    {
      commandId: RecruitmentCancellationCommandId.make("cancel-command"),
      interviewId,
      expectedRevision: 1,
    },
    { actor, now: cancelledAt },
  ),
);

const requestNewTime = Recruitment.use((recruitment) =>
  recruitment.requestNewInvitationTime(capability, { message: newTimeMessage }, { now }),
);

// Reuse the migrated per-test PostgreSQL engine and the existing real service layers.
const seed = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES (${departmentId}, 'Cancellation')`;
  yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('cancel-semester', '2031-08-01', '2032-01-01')`;
  yield* sql`INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id) VALUES ('cancel-period', ${departmentId}, 'cancel-semester', '2031-09-01', '2031-10-01', 'cancel-period-created')`;
  yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name) VALUES ('cancel-field', ${departmentId}, 'Computer Science')`;
  yield* sql`INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study) VALUES ('cancel-applicant', 'cancel-applicant@example.invalid', 'cancel-applicant@example.invalid', 'Ada', 'Applicant', '90000000', 1, 'cancel-field', 2)`;
  yield* sql`INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at) VALUES ('cancel-application', 'cancel-applicant', 'cancel-period', ${departmentId}, 'cancel-field', 2, '2031-09-10')`;
  yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city) VALUES (${departmentId}, 'Cancellation', 'CAN', 'cancel-department@example.invalid', 'Bergen')`;
  yield* sql`INSERT INTO organization_teams (team_id, department_id, name) VALUES ('cancel-team', ${departmentId}, 'Cancellation team')`;
  yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${leader.personId}, 'Lise', 'Leader'), (${interviewerPersonId}, 'Ivar', 'Interviewer')`;
  yield* sql`INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, position_id, is_team_leader) VALUES ('cancel-leader-membership', ${leader.personId}, 'cancel-team', '2031-01-01', 'leader', TRUE), ('cancel-interviewer-membership', ${interviewerPersonId}, 'cancel-team', '2031-01-01', 'assistant', FALSE)`;
  yield* sql`INSERT INTO person_contact_profiles (person_id, email, phone) VALUES (${interviewerPersonId}, 'cancel-interviewer@example.invalid', '91111111')`;
  yield* sql`INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count) VALUES ('cancel-schema', 'Cancellation interview', 0)`;
  yield* sql`INSERT INTO recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at, revision) VALUES (${interviewId}, 'cancel-application', ${departmentId}, ${interviewerPersonId}, 'cancel-schema', ${leader.personId}, '2031-09-15', 0)`;
  yield* schedule();
}).pipe(Effect.provide(domain, { local: true }), Effect.asVoid);

const decodeState = Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.JsonObject }));
// Compare complete persisted rows, including immutable envelopes and claim/evidence fields.

const durableState = Database.use(
  (sql) => sql`
  SELECT jsonb_build_object(
    'interviews', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY interview_id) FROM recruitment_interviews stored),
    'schedules', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY schedule_revision) FROM recruitment_interview_schedules stored),
    'invitations', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY invitation_id) FROM recruitment_invitations stored),
    'responseAudit', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY invitation_id) FROM recruitment_invitation_response_audit stored),
    'responseReceipts', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY command_id) FROM recruitment_invitation_response_command_receipts stored),
    'responseOutbox', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY effect_id) FROM recruitment_invitation_response_outbox stored),
    'invitationOutbox', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY effect_id) FROM recruitment_invitation_outbox stored),
    'cancellations', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY interview_id) FROM recruitment_interview_cancellations stored),
    'lifecycleReceipts', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY command_id) FROM recruitment_interview_lifecycle_command_receipts stored),
    'lifecycleAudit', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY command_id) FROM recruitment_interview_lifecycle_audit stored),
    'scheduleReceipts', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY command_id) FROM recruitment_schedule_command_receipts stored),
    'scheduleAudit', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY command_id) FROM recruitment_schedule_audit stored),
    'httpReceipts', (SELECT jsonb_agg(to_jsonb(stored) ORDER BY identity_sha256) FROM native_http_idempotency_receipts stored)
  ) AS state
`,
).pipe(
  Effect.flatMap((rows) => decodeState(rows[0])),
  Effect.map(({ state }) => state),
);

const decodeConnection = Schema.decodeUnknownEffect(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
    database: Schema.String,
    username: Schema.String,
  }),
);

const decodePid = Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Int }));

const decodeBlocking = Schema.decodeUnknownEffect(Schema.Struct({ blocked: Schema.Boolean }));

const decodeProblem = Schema.decodeUnknownEffect(NativeProblem);

const decodeObservation = Schema.decodeUnknownEffect(InvitationResponseObservation);

const fixture = () => {
  const database = backendDatabase(seed);

  const run = <A, E>(effect: Effect.Effect<A, E, DomainServices>) =>
    database.run(effect.pipe(Effect.provide(domain, { local: true })));

  const request = (selectedCapability = capability, observe?: PostgresStatementObserver) => {
    const databaseLayer =
      observe === undefined
        ? database.layer
        : Layer.effect(
            Database,
            Effect.map(Database, (sql) => observePostgresStatements(sql, observe)),
          ).pipe(Layer.provide(database.layer));

    const http = makeRecruitmentTestHttp(
      {
        config: {
          maxBodyBytes: 65_536,
          now: () => afterCancellation,
          nextInterviewId: () => RecruitmentInterviewId.make("cancel-unexpected-interview"),
          nextInvitationId: () => RecruitmentInvitationId.make("cancel-unexpected-invitation"),
          nextResponseCapability: () => "unexpected".padEnd(43, "_"),
        },
        resolveActor: () => Effect.die("unexpected person authority on invitation route"),
      },
      domain.pipe(Layer.provideMerge(databaseLayer)),
    );

    return (action?: string, etag?: string) => {
      const headers = new Headers({ "x-recruitment-invitation-capability": selectedCapability });

      if (action !== undefined) {
        headers.set("origin", "http://127.0.0.1:5174");
        headers.set("content-type", "application/json");

        if (etag !== undefined) headers.set("if-match", etag);
      }

      const init: RequestInit = { method: action === undefined ? "GET" : "POST", headers };

      if (action !== undefined)
        init.body = action === "confirm" ? "{}" : JSON.stringify({ message: newTimeMessage });

      return http.fetch(
        new Request(
          `http://backend.test/api/recruitment/invitation-response${action === undefined ? "" : `:${action}`}`,
          init,
        ),
      );
    };
  };
  // The additional single-connection pool belongs to the effect that provides its layer.

  const competitor = Effect.gen(function* () {
    const rows = yield* database.run(
      Database.use(
        (sql) => sql`
      SELECT current_setting('unix_socket_directories') AS host,
        current_setting('port')::integer AS port, current_database() AS database, current_user AS username
    `,
      ),
    );

    const connection = yield* decodeConnection(rows[0]);

    return domain.pipe(
      Layer.provideMerge(
        DatabaseRuntimeLive({ ...connection, maxConnections: 1 }).pipe(Layer.orDie),
      ),
    );
  });

  return { database, run, request, competitor };
};

const typedOutcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "Succeeded" }));

const bearerOutcomes = Effect.gen(function* () {
  const recruitment = yield* Recruitment;

  return {
    snapshot: yield* typedOutcome(recruitment.readInvitationSnapshot(capability)),
    read: yield* typedOutcome(recruitment.readInvitationResponse(capability)),
    confirm: yield* typedOutcome(
      recruitment.confirmInvitation(capability, { now: afterCancellation }),
    ),
    reject: yield* typedOutcome(
      recruitment.rejectInvitation(
        capability,
        { message: newTimeMessage },
        { now: afterCancellation },
      ),
    ),
    requestNewTime: yield* typedOutcome(
      recruitment.requestNewInvitationTime(
        capability,
        { message: newTimeMessage },
        { now: afterCancellation },
      ),
    ),
    transition: yield* typedOutcome(
      recruitment.transitionInvitation({
        capability,
        transition: RecruitmentInvitationTransition.Confirm(),
        now: afterCancellation,
      }),
    ),
  };
});

const concealedOutcomes = {
  snapshot: "RecruitmentInvitationNotFound",
  read: "RecruitmentInvitationNotFound",
  confirm: "RecruitmentInvitationNotFound",
  reject: "RecruitmentInvitationNotFound",
  requestNewTime: "RecruitmentInvitationNotFound",
  transition: "RecruitmentInvitationNotFound",
};

const failedGateway = Layer.succeed(
  NotificationGateway,
  NotificationGateway.of({
    deliverInterviewInvitation: () => Effect.die("unexpected invitation delivery"),
    deliverInterviewCompletionReceipt: () => Effect.die("unexpected completion delivery"),
    deliverInterviewInvitationResponse: (request) =>
      Effect.fail(
        new RecruitmentNotificationDeliveryError({
          effectId: request.effectId,
          message: "Synthetic provider refusal",
        }),
      ),
  }),
);

// Two real SQL sessions. The cancellation's facts remain uncommitted until PostgreSQL
// reports that the response is blocked by that session, not merely until a fiber starts.
const cancellationRace = Effect.fnUntraced(function* (interrupt: boolean) {
  const f = fixture();
  const competing = yield* f.competitor;
  const pidRows = yield* f.database.run(Database.use((sql) => sql`SELECT pg_backend_pid() AS pid`));
  const { pid } = yield* decodePid(pidRows[0]);
  const held = yield* Deferred.make<Schema.JsonObject>();
  const blocked = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();

  yield* Effect.gen(function* () {
    const cancellation = yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* cancel;
          yield* Deferred.succeed(held, yield* durableState);

          const waiting =
            yield* sql`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${pid})) AS blocked`.pipe(
              Effect.flatMap((rows) => decodeBlocking(rows[0])),
              Effect.map(({ blocked: isBlocked }) => isBlocked),
              Effect.repeat({ until: (isBlocked) => isBlocked, times: 400 }),
            );

          assert.isTrue(waiting, "response never waited on the cancellation's PostgreSQL lock");
          yield* Deferred.succeed(blocked, undefined);
          yield* Deferred.await(release);
        }),
      ),
    ).pipe(Effect.provide(competing, { local: true }), Effect.forkChild);

    const before = yield* Deferred.await(held);

    const response = yield* f
      .run(
        Recruitment.use((recruitment) =>
          typedOutcome(recruitment.confirmInvitation(capability, { now: afterCancellation })),
        ),
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(blocked);

    if (interrupt) {
      // Interruption is requested while the lock is held; release it so the SQL
      // driver's rollback can finish even if its wire query is not cancellable.
      const stop = yield* Effect.forkChild(Fiber.interrupt(response), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stop);
      const exit = yield* Fiber.await(response);
      assert.isTrue(Exit.isFailure(exit));

      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
    } else {
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(response), "RecruitmentInvitationNotFound");
    }

    yield* Fiber.join(cancellation);
    assert.deepStrictEqual(yield* f.database.run(durableState), before);
    // A fresh statement on both sessions proves no transaction/connection remains held.
    yield* f.database.run(Database.use((sql) => sql.health));
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
});

describe("R1 cancelled invitation custody and R8 committing authority", () => {
  it.live(
    "R1 cancelled capability refuses every domain read and response without changing durable rows",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run(cancel);
        const before = yield* f.database.run(durableState);
        const outcomes = yield* f.run(bearerOutcomes);
        const after = yield* f.database.run(durableState);
        assert.deepStrictEqual(outcomes, concealedOutcomes);
        assert.deepStrictEqual(after, before);
      }),
  );

  it.live(
    "R1 cancelled capability is concealed on GET, confirm, reject and new-time HTTP routes",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const request = f.request();
        const initial = yield* request();
        assert.strictEqual(initial.status, 200);
        const etag = initial.headers.get("etag");
        assert.isNotNull(etag);
        const validator = etag ?? "";
        yield* f.run(cancel);
        const before = yield* f.database.run(durableState);
        const outcomes = [];
        const expected = [];

        for (const action of [undefined, "confirm", "reject", "request-new-time"]) {
          const missing = yield* f.request(unknownCapability)(action, validator);
          const missingBody = yield* decodeProblem(yield* Effect.promise(() => missing.json()));
          assert.strictEqual(missing.status, 404);
          assert.strictEqual(missingBody.code, "resource.not-found");
          expected.push({ status: missing.status, body: missingBody });
          const response = yield* request(action, validator);
          // Successful mutations are bodyless by contract. Reads and errors are decoded.

          const body =
            response.status === 204
              ? null
              : yield* (response.status === 200 ? decodeObservation : decodeProblem)(
                  yield* Effect.promise(() => response.json()),
                );

          outcomes.push({ action, status: response.status, body });
        }

        const after = yield* f.database.run(durableState);
        assert.deepStrictEqual(
          outcomes.map(({ status, body }) => ({ status, body })),
          expected,
        );
        assert.deepStrictEqual(after, before);
      }),
  );

  for (const status of ["Pending", "Failed"] as const) {
    it.live(
      `R1 cancelled ${status} response notice starts no provider attempt and preserves its envelope`,
      () =>
        Effect.gen(function* () {
          const f = fixture();
          yield* f.run(requestNewTime);

          if (status === "Failed") {
            const failed = yield* f.run(
              deliverNextRecruitmentInvitationResponse("cancel-first-attempt", now).pipe(
                Effect.provide(failedGateway),
              ),
            );

            assert.strictEqual(failed._tag, "Failed");
          }

          yield* f.run(cancel);
          const before = yield* f.database.run(durableState);
          const gateway = makeRecordingNotificationGateway(afterCancellation);

          const delivery = yield* f.run(
            deliverNextRecruitmentInvitationResponse(
              "cancel-forbidden-attempt",
              afterCancellation,
            ).pipe(Effect.provide(gateway.layer)),
          );

          const after = yield* f.database.run(durableState);
          assert.strictEqual(delivery._tag, "Idle");
          assert.deepStrictEqual(gateway.responseRequests, []);
          assert.deepStrictEqual(after, before);
        }),
    );
  }

  it.live(
    "R1 cancellation committed while response waits wins the two-connection race",
    () => cancellationRace(false),
    30_000,
  );
  it.live(
    "R1 interrupting the lock-waiting response rolls back and releases its connection",
    () => cancellationRace(true),
    30_000,
  );

  it.live(
    "R1 supersession preserves the old response notice while a rebooked invitation remains healthy",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run(requestNewTime);
        yield* f.run(schedule(true));
        const before = yield* f.database.run(durableState);
        assert.deepStrictEqual(yield* f.run(bearerOutcomes), concealedOutcomes);
        const gateway = makeRecordingNotificationGateway(afterCancellation);

        const skipped = yield* f.run(
          deliverNextRecruitmentInvitationResponse("superseded-claim", afterCancellation).pipe(
            Effect.provide(gateway.layer),
          ),
        );

        assert.strictEqual(skipped._tag, "Idle");
        assert.deepStrictEqual(yield* f.database.run(durableState), before);

        const current = yield* f.run(
          Recruitment.use((recruitment) =>
            recruitment.readInvitationSnapshot(replacementCapability),
          ),
        );

        assert.strictEqual(current.source.responseState, "Pending");
        assert.strictEqual(current.source.scheduleRevision, 2);
        yield* f.run(
          Recruitment.use((recruitment) =>
            recruitment.requestNewInvitationTime(
              replacementCapability,
              { message: newTimeMessage },
              { now: afterCancellation },
            ),
          ),
        );

        const delivered = yield* f.run(
          deliverNextRecruitmentInvitationResponse("replacement-claim", afterCancellation).pipe(
            Effect.provide(gateway.layer),
          ),
        );

        assert.strictEqual(delivered._tag, "Delivered");
        assert.deepStrictEqual(
          gateway.responseRequests.map(({ invitationId }) => invitationId),
          ["cancel-replacement"],
        );

        const drained = yield* f.run(
          deliverNextRecruitmentInvitationResponse("replacement-drained", afterCancellation).pipe(
            Effect.provide(gateway.layer),
          ),
        );

        assert.strictEqual(drained._tag, "Idle");
        assert.strictEqual(gateway.responseRequests.length, 1);
      }),
  );

  it.live(
    "R8 invitation mutation resolves its capability inside the committing SQL transaction",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const initial = yield* f.request()();
        assert.strictEqual(initial.status, 200);
        const etag = initial.headers.get("etag");
        assert.isNotNull(etag);
        const observations: boolean[] = [];

        const transactionService = yield* f.database.run(
          Database.use((sql) => Effect.succeed(sql.transactionService)),
        );

        const observe: PostgresStatementObserver = (execution, text) =>
          Effect.gen(function* () {
            // Select the existing capability snapshot seam; observe live transaction
            // context at execution, never assert source text or emulate the query.
            if (text.includes('AS "capabilitySha256"')) {
              observations.push(Option.isSome(yield* Effect.serviceOption(transactionService)));
            }

            return yield* execution;
          });

        const response = yield* f.request(capability, observe)("confirm", etag ?? "");
        assert.strictEqual(response.status, 204);
        const accepted = yield* f.request()();
        const observation = yield* decodeObservation(yield* Effect.promise(() => accepted.json()));
        assert.strictEqual(observation.responseState, "Accepted");
        assert.isAtLeast(observations.length, 2);
        assert.deepStrictEqual(
          observations,
          observations.map(() => true),
        );
      }),
  );

  it.live(
    "R1 response-first race preserves the response but cancellation closes its queued notice",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const competing = yield* f.competitor;
        const held = yield* Deferred.make<Schema.JsonObject>();
        const cancelPid = yield* Deferred.make<number>();
        const blocked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        yield* Effect.gen(function* () {
          const response = yield* f
            .run(
              Database.use((sql) =>
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* requestNewTime;
                    yield* Deferred.succeed(held, yield* durableState);

                    const pid = yield* Deferred.await(cancelPid);

                    const waiting =
                      yield* sql`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${pid})) AS blocked`.pipe(
                        Effect.flatMap((rows) => decodeBlocking(rows[0])),
                        Effect.map(({ blocked: isBlocked }) => isBlocked),
                        Effect.repeat({ until: (isBlocked) => isBlocked, times: 400 }),
                      );

                    assert.isTrue(
                      waiting,
                      "cancellation never waited on the response's PostgreSQL lock",
                    );
                    yield* Deferred.succeed(blocked, undefined);
                    yield* Deferred.await(release);
                  }),
                ),
              ),
            )
            .pipe(Effect.forkChild);

          const before = yield* Deferred.await(held);

          const cancellation = yield* Effect.gen(function* () {
            const rows = yield* Database.use((sql) => sql`SELECT pg_backend_pid() AS pid`);
            const { pid } = yield* decodePid(rows[0]);

            yield* Deferred.succeed(cancelPid, pid);

            return yield* cancel;
          }).pipe(Effect.provide(competing, { local: true }), Effect.forkChild);

          yield* Deferred.await(blocked);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(response);
          yield* Fiber.join(cancellation);

          const after = yield* f.database.run(durableState);

          for (const key of [
            "schedules",
            "invitations",
            "responseAudit",
            "responseOutbox",
            "invitationOutbox",
            "scheduleReceipts",
            "scheduleAudit",
          ]) {
            assert.deepStrictEqual(after[key], before[key]);
          }

          const gateway = makeRecordingNotificationGateway(afterCancellation);

          const delivery = yield* f.run(
            deliverNextRecruitmentInvitationResponse(
              "response-first-claim",
              afterCancellation,
            ).pipe(Effect.provide(gateway.layer)),
          );

          assert.strictEqual(delivery._tag, "Idle");
          assert.deepStrictEqual(gateway.responseRequests, []);
          assert.deepStrictEqual(yield* f.database.run(durableState), after);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
    30_000,
  );

  it.live(
    "R1 cancellation during a real response claim cannot start a later provider attempt",
    () =>
      Effect.gen(function* () {
        const f = fixture();

        yield* f.run(requestNewTime);

        const before = yield* f.database.run(durableState);
        const competing = yield* f.competitor;
        const claimed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const cancelPid = yield* Deferred.make<number>();
        const gateway = makeRecordingNotificationGateway(afterCancellation);
        const providerStartedAfterCancellation: boolean[] = [];

        let paused = false;

        const gatewayLayer = Layer.effect(
          NotificationGateway,
          Effect.gen(function* () {
            const native = yield* NotificationGateway;
            const monitor = yield* Database;

            return NotificationGateway.of({
              ...native,
              deliverInterviewInvitationResponse: Effect.fnUntraced(function* (
                request: RecruitmentInvitationResponseOutboxRequest,
              ) {
                // A broken test observer is a defect, not a provider outcome.
                const { blocked: isCancelled } =
                  yield* monitor`SELECT EXISTS (SELECT 1 FROM recruitment_interview_cancellations WHERE interview_id = ${interviewId}) AS blocked`.pipe(
                    Effect.flatMap((rows) => decodeBlocking(rows[0])),
                    Effect.orDie,
                  );

                providerStartedAfterCancellation.push(isCancelled);

                return yield* native.deliverInterviewInvitationResponse(request);
              }),
            });
          }),
        ).pipe(Layer.provide(Layer.mergeAll(gateway.layer, competing)));

        const observe: PostgresStatementObserver = (execution, _text, parameters) =>
          Effect.gen(function* () {
            const value = yield* execution;

            // The claim id is bound only by the real claim UPDATE. Pause after that
            // statement, before canonical envelope validation and provider dispatch.
            if (!paused && parameters.includes("invalidation-claim")) {
              paused = true;
              yield* Deferred.succeed(claimed, undefined);
              yield* Deferred.await(resume);
            }

            return value;
          });

        const decodeOrder = Schema.decodeUnknownEffect(
          Schema.Struct({ committed: Schema.Boolean, blocked: Schema.Boolean }),
        );

        yield* Effect.gen(function* () {
          const worker = yield* f.database
            .run(
              Effect.gen(function* () {
                const sql = yield* Database;

                return yield* deliverNextRecruitmentInvitationResponse(
                  "invalidation-claim",
                  now,
                ).pipe(
                  Effect.provide(domain, { local: true }),
                  Effect.provideService(Database, observePostgresStatements(sql, observe)),
                  Effect.provide(gatewayLayer),
                );
              }),
            )
            .pipe(Effect.forkChild);

          yield* Deferred.await(claimed);

          const cancellation = yield* Effect.gen(function* () {
            const rows = yield* Database.use((sql) => sql`SELECT pg_backend_pid() AS pid`);
            const { pid } = yield* decodePid(rows[0]);

            yield* Deferred.succeed(cancelPid, pid);
            yield* cancel;
          }).pipe(Effect.provide(competing, { local: true }), Effect.forkChild);

          const pid = yield* Deferred.await(cancelPid);
          // A separately scoped, single-connection observer distinguishes genuine
          // cancellation-first from a future claim fence that lawfully wins first.

          const order = yield* Database.use((sql) =>
            sql`
          SELECT EXISTS (SELECT 1 FROM recruitment_interview_cancellations WHERE interview_id = ${interviewId}) AS committed,
            cardinality(pg_blocking_pids(${pid})) > 0 AS blocked
        `.pipe(
              Effect.flatMap((rows) => decodeOrder(rows[0])),
              Effect.repeat({
                until: (current) => current.committed || current.blocked,
                times: 400,
              }),
            ),
          ).pipe(Effect.provide(competing, { local: true }));

          assert.isTrue(order.committed || order.blocked, "no observable claim/cancellation order");

          if (order.committed) yield* Fiber.join(cancellation);

          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(worker);
          yield* Fiber.join(cancellation);

          assert.deepStrictEqual(
            providerStartedAfterCancellation,
            providerStartedAfterCancellation.map(() => false),
          );

          if (order.committed) assert.deepStrictEqual(gateway.responseRequests, []);

          const after = yield* f.database.run(durableState);

          assert.deepStrictEqual(after.responseAudit, before.responseAudit);
          assert.deepStrictEqual(after.invitations, before.invitations);
        }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      }),
    30_000,
  );
});
