import { assert, describe, it } from "@effect/vitest";
import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import {
  observePostgresStatements,
  type PostgresStatementObserver,
} from "@vektorprogrammet/database/test-support/observe-postgres";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import {
  IdempotencyKey,
  NativeProblem,
  OnboardingResource,
  OnboardingApi,
  RequestSchemaErrorMiddleware,
} from "@vektorprogrammet/http-api";
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { backendDatabase } from "../../test/database.js";
import { jsonText } from "../http-api/problem.js";
import { testFetch } from "../test/native-http.js";
import { TestPlatform } from "../test/platform.js";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { NativeHttpApiMiddlewareLive } from "../http-api/transport.js";
import { OnboardingApiHandlers } from "./http.js";
import {
  drainOnboardingDelivery,
  expireOnboardingSecrets,
  type OnboardingDeliveryConfig,
} from "./delivery.js";

const makeOnboardingTestHttp = (
  options: { now?: () => string; delivery?: OnboardingDeliveryConfig },
  services: Layer.Layer<never>,
  client: HttpClient.HttpClient,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(
      HttpApi.make("external-native-api")
        .add(OnboardingApi)
        .middleware(RequestSchemaErrorMiddleware),
    ).pipe(
      Layer.provide(
        OnboardingApiHandlers(options).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

// Spec 0029 R3/R4. Real migrated PostgreSQL, real handlers, receipts and delivery claims.
// A 200 receipt proves durable acceptance only. Provider acknowledgement is a separate milestone.
const departmentId = DepartmentId.make("onboarding-policy-department");

const actor = PersonId.make("onboarding-policy-admin");

const token = `onboard_${"a".repeat(64)}`;

const digest = "a".repeat(64);

const delivery: OnboardingDeliveryConfig = {
  sender: "sender@example.invalid",
  claimUrl: new URL("http://127.0.0.1/konto-aktivering"),
  transport: {
    endpoint: new URL("http://127.0.0.1/provider"),
    token: "synthetic-provider-token",
    deliveryTimeoutMilliseconds: 30000,
  },
};

const applicationId = PublicApplicationIdSchema.make("onboarding-policy-application");

const decodePostgresInstant = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString);

// PostgreSQL owns expiry and claim age. Derive fixture and handler instants from
// that clock, not the it.effect TestClock or a fresh HTTP runtime's clock.
const postgresNow = Database.use((sql) =>
  sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant`.pipe(
    Effect.flatMap((rows) => decodePostgresInstant(rows[0]?.instant)),
  ),
);

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    const now = yield* postgresNow;
    const start = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
    const end = DateTime.formatIso(DateTime.add(now, { days: 1 }));
    // These are recognized independent departments: their classified board
    // leaders govern their own department, never the other department.
    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city,independent) VALUES(${departmentId},'Policy','POL','policy@example.invalid','Policy',true),('policy-other','Other','OTH','other@example.invalid','Other',true)`;
    yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${departmentId},'Policy')`;
    yield* sql`INSERT INTO admission_period_semesters VALUES('policy-semester',${start},${end}),('policy-other-semester',${start},${end})`;
    yield* sql`INSERT INTO admission_periods VALUES('policy-period',${departmentId},'policy-semester',${start},${end},0,'seed')`;
    yield* sql`INSERT INTO admission_period_fields_of_study VALUES('policy-field',${departmentId},'Math',true)`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${actor},'Ada','Admin'),('policy-leader','Bert','Leader'),('policy-recruiter','Cora','Recruiter'),('policy-member','Dan','Member'),('policy-outsider','Eli','Other')`;
    yield* sql`INSERT INTO organization_global_administrator_grants(grant_id,person_id,start_at) VALUES('policy-admin-grant',${actor},${start})`;
    yield* sql`INSERT INTO organization_teams(team_id,department_id,name) VALUES('policy-board',${departmentId},'Styret'),('policy-recruitment',${departmentId},'Rekruttering'),('policy-other-team','policy-other','Styret')`;
    yield* sql`INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader) VALUES('policy-leader-seat','policy-leader','policy-board',${start},true),('policy-recruiter-seat','policy-recruiter','policy-recruitment',${start},false),('policy-member-seat','policy-member','policy-board',${start},false),('policy-outsider-seat','policy-outsider','policy-other-team',${start},true)`;
    yield* sql`UPDATE organization_teams SET kind='DepartmentBoard' WHERE team_id IN ('policy-board','policy-other-team')`;
    yield* sql`INSERT INTO organization_delegations(delegation_id,name,team_id,capability,area,area_department_id,holders,start_at) VALUES(${`delegation-${digest}`},'Outcomes','policy-recruitment','admissions.outcomes','Department',${departmentId},'AllMembers',${start})`;
    yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('policy-applicant','applicant@example.invalid','applicant@example.invalid','Finn','Applicant','12345678',0,'policy-field',2)`;
    yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},'policy-applicant','policy-period',${departmentId},'policy-field',2,${start})`;
    yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES('policy-questionnaire','Questions',0,true,0)`;
  }),
);

const database = backendDatabase(seed);

const identity = Layer.mock(IdentitySnapshot, {
  resolveSession: (cookie) => {
    const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(
          new IdentityActor({
            personId: PersonId.make(person),
            sessionId: person,
            expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
          }),
        );
  },
});

const reply = Effect.fnUntraced(function* (response: Response) {
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    text: yield* Effect.promise(() => response.text()),
  };
});

const decodeResource = Schema.decodeUnknownEffect(Schema.fromJsonString(OnboardingResource));

const decodeProblem = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeProblem));

const decodeIdempotencyKey = Schema.decodeUnknownEffect(IdempotencyKey);

const decodePostgresTarget = Schema.decodeUnknownEffect(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
    database: Schema.String,
    username: Schema.String,
  }),
);

const awaitBarrier = Effect.fnUntraced(function* <A, E>(
  barrier: Deferred.Deferred<void>,
  worker: Fiber.Fiber<A, E>,
  milestone: string,
) {
  yield* Effect.raceFirst(
    Deferred.await(barrier),
    Fiber.join(worker).pipe(
      Effect.flatMap(() =>
        Effect.sync(() =>
          assert.fail(
            `Worker completed before ${milestone}; the SQL/provider barrier was not reached`,
          ),
        ),
      ),
    ),
  );
});

const fixture = Effect.fnUntraced(function* (
  options: {
    transport?: boolean;
    providerStatus?: number;
    provider?: Parameters<typeof HttpClient.make>[0];
    observer?: PostgresStatementObserver;
    now?: () => string;
  } = {},
) {
  let sql = yield* database.run(Database);

  if (options.observer !== undefined) {
    const rows =
      yield* sql`SELECT current_setting('unix_socket_directories') AS host, current_setting('port')::integer AS port, current_database() AS database, current_user AS username`;

    const target = yield* decodePostgresTarget(rows[0]);
    // The test Scope owns this pool. One lock/dispatch owner, one competing
    // request and one observation query may run; the one-connection seed pool
    // cannot exercise a PostgreSQL wait or read while dispatch is held.

    const context = yield* Layer.build(
      DatabaseRuntimeLive({ ...target, maxConnections: 3 }).pipe(Layer.orDie),
    );

    sql = Context.get(context, Database);
  }

  const instant = DateTime.formatIso(yield* database.run(postgresNow));
  let calls = 0;

  const client = HttpClient.make((...args) => {
    calls++;

    return options.provider === undefined
      ? Effect.succeed(
          HttpClientResponse.fromWeb(
            args[0],
            new Response(null, { status: options.providerStatus ?? 503 }),
          ),
        )
      : options.provider(...args);
  });

  const databaseLayer = Layer.succeed(
    Database,
    options.observer === undefined ? sql : observePostgresStatements(sql, options.observer),
  );

  const services = Layer.mergeAll(
    databaseLayer,
    identity,
    OrganizationLive.pipe(Layer.provide(databaseLayer)),
  );

  const http = makeOnboardingTestHttp(
    {
      now: options.now ?? (() => instant),
      delivery: options.transport === false ? undefined : delivery,
    },
    services,
    client,
  );

  const read = Effect.fnUntraced(function* (person = actor) {
    return yield* http
      .fetch(
        new Request(`http://backend.test/api/onboarding?departmentId=${departmentId}`, {
          headers: { cookie: `better-auth.session_token=${person}` },
        }),
      )
      .pipe(Effect.flatMap(reply));
  });

  const send = Effect.fnUntraced(function* (
    action: "Issue" | "Revoke" | "RetryDelivery",
    etag: string,
    key = "policy-command",
    person = actor,
  ) {
    const idempotencyKey = yield* decodeIdempotencyKey(`onboarding-policy-${key}`);

    return yield* http
      .fetch(
        new Request(`http://backend.test/api/onboarding?departmentId=${departmentId}`, {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5174",
            cookie: `better-auth.session_token=${person}`,
            "content-type": "application/json",
            "if-match": etag,
            "idempotency-key": idempotencyKey,
          },
          body: yield* jsonText({ applicationId, action }),
        }),
      )
      .pipe(Effect.flatMap(reply));
  });

  return { sql, client, read, send, calls: () => calls };
});

const evidence = Effect.fnUntraced(function* (
  recommendation?: "Ja" | "Nei" | "Kanskje",
  completed = true,
  cancelled = false,
) {
  yield* database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* postgresNow);
        yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES('policy-interview',${applicationId},${departmentId},${actor},'policy-questionnaire',${actor},${now},1)`;

        if (completed && recommendation !== undefined)
          yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('policy-interview','[]'::jsonb,7,8,9,${actor},${now},2,${recommendation})`;

        if (cancelled)
          yield* sql`INSERT INTO recruitment_interview_cancellations VALUES('policy-interview',${actor},${now},3)`;
      }),
    ),
  );
});

const decide = Effect.fnUntraced(function* (outcome: "Admitted" | "Rejected") {
  yield* database.run(
    Database.use(
      (sql) =>
        sql`INSERT INTO admission_application_outcomes(application_id,revision,outcome,decided_by_person_id,decided_at) VALUES(${applicationId},1,${outcome},${actor},date_trunc('milliseconds',clock_timestamp(),'UTC'))`,
    ),
  );
});

const invitation = Effect.fnUntraced(function* (
  state: "Pending" | "Claimed" | "Delivered" | "Cancelled" = "Pending",
  age = "fresh",
  terminal = "Open",
  expired = false,
) {
  yield* database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        const now = yield* postgresNow;
        const issued = DateTime.formatIso(DateTime.subtract(now, { days: 2 }));

        const expires = DateTime.formatIso(
          expired ? DateTime.subtract(now, { days: 1 }) : DateTime.add(now, { days: 1 }),
        );

        yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('policy-invitation',${applicationId},'policy-applicant',${digest},${expires},${terminal},${actor},${issued})`;
        const retained = state === "Pending" || state === "Claimed";
        yield* sql`INSERT INTO applicant_account_delivery(invitation_id,state,secret,recipient,envelope,claim_id,claimed_at) VALUES('policy-invitation',${state},${retained ? token : null},'applicant@example.invalid',${retained ? sql.json({ deliveryId: "policy-invitation", from: delivery.sender, to: "applicant@example.invalid", subject: "Invite", text: token }) : null},${state === "Claimed" ? "old-claim" : null},${state === "Claimed" ? DateTime.formatIso(DateTime.subtract(now, { seconds: age === "stale" ? 61 : 0 })) : null})`;
        yield* sql`INSERT INTO applicant_account_audit VALUES('policy-invitation:issue','policy-applicant','policy-invitation',${actor},'Issued',${issued})`;
      }),
    ),
  );
});

const snapshot = database.run(
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT jsonb_build_object('invitations',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY generation),'[]'::jsonb) FROM applicant_account_invitations i),'delivery',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY invitation_id),'[]'::jsonb) FROM applicant_account_delivery d),'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY audit_id),'[]'::jsonb) FROM applicant_account_audit a),'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY identity_sha256),'[]'::jsonb) FROM native_http_idempotency_receipts r)) AS value`;

      return yield* Schema.decodeUnknownEffect(Schema.Json)(rows[0]?.value);
    }),
  ),
);

const receipts = database.run(
  Database.use(
    (sql) =>
      sql`SELECT status, body_bytes AS body FROM native_http_idempotency_receipts WHERE operation_id='onboarding.command'`,
  ),
);

const etagOf = Effect.fnUntraced(function* (f: {
  read: () => Effect.Effect<{ status: number; text: string }>;
}) {
  const board = yield* f.read();
  assert.strictEqual(board.status, 200);

  return (yield* decodeResource(board.text)).etag;
});

describe("R3 onboarding admitted standing", () => {
  for (const scenario of [
    "unassessed",
    "preconduct",
    "cancelled",
    "Nei",
    "undecidedKanskje",
    "decidedRejected",
  ] as const) {
    it.effect(
      `Issue refuses ${scenario} without replacing prior capability, envelope or audit`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();

          if (scenario !== "unassessed")
            yield* evidence(
              scenario === "Nei"
                ? "Nei"
                : scenario === "undecidedKanskje" || scenario === "decidedRejected"
                  ? "Kanskje"
                  : "Ja",
              scenario !== "preconduct",
              scenario === "cancelled",
            );

          if (scenario === "decidedRejected") yield* decide("Rejected");
          yield* invitation();
          const etag = yield* etagOf(f);
          const before = yield* snapshot;
          const result = yield* f.send("Issue", etag);
          assert.strictEqual(result.status, 409);
          yield* decodeProblem(result.text);
          assert.deepStrictEqual(yield* snapshot, before);
          assert.strictEqual(f.calls(), 0);
        }),
      60000,
    );
  }

  for (const scenario of ["Ja", "decidedAdmitted"] as const) {
    it.effect(
      `Issue accepts ${scenario} without requiring announcement`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* evidence(scenario === "Ja" ? "Ja" : "Kanskje");

          if (scenario === "decidedAdmitted") yield* decide("Admitted");
          const result = yield* f.send("Issue", yield* etagOf(f));
          assert.strictEqual(result.status, 200);
          const board = yield* decodeResource(result.text);
          assert.strictEqual(board.items[0]?.state, "Open");
          assert.strictEqual((yield* receipts).length, 1);
        }),
      60000,
    );
  }

  it.effect(
    "board readiness and Issue use the same admitted-standing rule",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* evidence("Nei");
        const board = yield* f.read();
        const decoded = yield* decodeResource(board.text);
        // Server-owned projection of the one admission-standing rule.

        const ready = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              items: Schema.Array(
                Schema.Struct({
                  applicationId: PublicApplicationIdSchema,
                  canIssue: Schema.Boolean,
                }),
              ),
            }),
          ),
        )(board.text);

        assert.strictEqual(ready.items[0]?.canIssue, false);
        assert.strictEqual((yield* f.send("Issue", decoded.etag)).status, 409);
      }),
    60000,
  );

  for (const boundary of ["period", "semester"] as const) {
    it.effect(
      `Issue uses application own ${boundary}, not another current department period`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* evidence("Ja");
          yield* database.run(
            Database.use((sql) =>
              Effect.gen(function* () {
                const now = yield* postgresNow;
                const before = DateTime.formatIso(DateTime.subtract(now, { days: 2 }));
                const ended = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
                const after = DateTime.formatIso(DateTime.add(now, { days: 1 }));

                if (boundary === "period")
                  yield* sql`UPDATE admission_periods SET start_at=${before},end_at=${ended},revision=revision+1,last_command_id='period-ended' WHERE admission_period_id='policy-period'`;
                else
                  yield* sql`UPDATE admission_period_semesters SET start_at=${before},end_at=${ended} WHERE semester_id='policy-semester'`;
                yield* sql`INSERT INTO admission_periods VALUES('policy-current-period',${departmentId},'policy-other-semester',${ended},${after},0,'other-period')`;
              }),
            ),
          );
          const before = yield* snapshot;
          assert.strictEqual((yield* f.send("Issue", yield* etagOf(f))).status, 409);
          assert.deepStrictEqual(yield* snapshot, before);
        }),
      60000,
    );
  }

  it.effect(
    "already linked admitted applicant still refuses Issue",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* evidence("Ja");
        yield* invitation("Cancelled", "fresh", "Claimed");
        yield* database.run(
          Database.use(
            (sql) =>
              sql`INSERT INTO applicant_account_links VALUES('policy-applicant',${actor},date_trunc('milliseconds',clock_timestamp(),'UTC'),'policy-invitation')`,
          ),
        );
        const before = yield* snapshot;
        const result = yield* f.send("Issue", yield* etagOf(f));
        assert.strictEqual(result.status, 409);
        assert.strictEqual((yield* decodeProblem(result.text)).code, "onboarding.already-linked");
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    60000,
  );
});

describe("R4 retry durable acceptance", () => {
  for (const scenario of [
    "absent",
    "delivered",
    "revoked",
    "expired",
    "cancelled",
    "freshclaimed",
  ] as const) {
    it.effect(
      `RetryDelivery refuses ${scenario} before storing an accepted capsule`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* evidence("Ja");

          if (scenario !== "absent")
            yield* invitation(
              Match.value(scenario).pipe(
                Match.when("delivered", () => "Delivered" as const),
                Match.when("cancelled", () => "Cancelled" as const),
                Match.when("freshclaimed", () => "Claimed" as const),
                Match.orElse(() => "Pending" as const),
              ),
              "fresh",
              scenario === "revoked" ? "Revoked" : "Open",
              scenario === "expired",
            );
          const before = yield* snapshot;
          const result = yield* f.send("RetryDelivery", yield* etagOf(f));
          assert.strictEqual(result.status, 409);
          yield* decodeProblem(result.text);
          assert.deepStrictEqual(yield* snapshot, before);
          assert.strictEqual(f.calls(), 0);
        }),
      60000,
    );
  }

  it.effect(
    "unavailable transport refuses Pending retry before accepted capsule",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ transport: false });
        yield* evidence("Ja");
        yield* invitation();
        const before = yield* snapshot;
        const result = yield* f.send("RetryDelivery", yield* etagOf(f));
        assert.strictEqual(result.status, 503);
        yield* decodeProblem(result.text);
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    60000,
  );

  for (const state of ["Pending", "Claimed"] as const) {
    it.effect(
      `200 durably accepts ${state === "Claimed" ? "staleclaimed" : "Pending"} retry despite provider refusal`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ providerStatus: 503 });
          yield* evidence("Ja");
          yield* invitation(state, "stale");
          const etag = yield* etagOf(f);
          const first = yield* f.send("RetryDelivery", etag);
          assert.strictEqual(first.status, 200);
          yield* decodeResource(first.text);
          assert.strictEqual(f.calls(), 1);
          const stored = yield* receipts;
          assert.strictEqual(stored.length, 1);
          assert.strictEqual(stored[0]?.status, first.status);
          assert.deepStrictEqual(stored[0]?.body, new TextEncoder().encode(first.text));
          const before = yield* snapshot;
          const replay = yield* f.send("RetryDelivery", etag);
          assert.deepStrictEqual(replay, first);
          assert.strictEqual(f.calls(), 1);
          assert.deepStrictEqual(yield* snapshot, before);
          const altered = yield* f.send("Revoke", etag);
          assert.strictEqual(altered.status, 409);
          assert.strictEqual(
            (yield* decodeProblem(altered.text)).code,
            "idempotency.digest-conflict",
          );
          assert.deepStrictEqual(yield* snapshot, before);
        }),
      60000,
    );
  }

  it.effect(
    "provider acknowledgement clears secrets but never changes first response or replay",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ providerStatus: 204 });
        yield* evidence("Ja");
        yield* invitation();
        const etag = yield* etagOf(f);
        const first = yield* f.send("RetryDelivery", etag);
        assert.strictEqual(first.status, 200);

        const delivered = yield* database.run(
          Database.use(
            (sql) =>
              sql`SELECT state,secret,envelope,claim_id,claimed_at FROM applicant_account_delivery`,
          ),
        );

        assert.deepStrictEqual(delivered, [
          { state: "Delivered", secret: null, envelope: null, claim_id: null, claimed_at: null },
        ]);
        assert.deepStrictEqual(yield* f.send("RetryDelivery", etag), first);
        assert.strictEqual(f.calls(), 1);
      }),
    60000,
  );
});

describe("R3/R4 transaction lifetime and authority", () => {
  for (const boundary of ["period", "semester"] as const) {
    it.effect(
      "Issue re-evaluates " + boundary + " eligibility after a real applicant lock wait",
      () =>
        Effect.gen(function* () {
          let instant = DateTime.formatIso(yield* database.run(postgresNow));
          const waiting = yield* Deferred.make<void>();
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();

          const f = yield* fixture({
            now: () => instant,
            observer: (execution, text) =>
              text.includes("SELECT applicant_id FROM public.admission_applicants") &&
              text.includes("FOR UPDATE")
                ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(execution))
                : execution,
          });

          yield* evidence("Ja");
          const etag = yield* etagOf(f);
          const before = yield* snapshot;

          const owner = yield* Effect.forkChild(
            f.sql.withTransaction(
              Effect.gen(function* () {
                yield* f.sql`SELECT applicant_id FROM admission_applicants WHERE applicant_id='policy-applicant' FOR UPDATE`;
                yield* Deferred.succeed(acquired, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );

          yield* awaitBarrier(acquired, owner, "applicant lock acquisition");
          const command = yield* Effect.forkChild(f.send("Issue", etag));
          yield* awaitBarrier(waiting, command, "Issue applicant FOR UPDATE");

          const edge =
            boundary === "period"
              ? yield* f.sql`SELECT to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant FROM admission_periods WHERE admission_period_id='policy-period'`
              : yield* f.sql`SELECT to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant FROM admission_period_semesters WHERE semester_id='policy-semester'`;

          instant = yield* Schema.decodeUnknownEffect(Schema.String)(edge[0]?.instant);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(owner);
          assert.strictEqual((yield* Fiber.join(command)).status, 409);
          assert.deepStrictEqual(yield* snapshot, before);
        }),
      60000,
    );
  }

  it.effect(
    "Issue retry rechecks standing at the new transaction instant",
    () =>
      Effect.gen(function* () {
        let instant = DateTime.formatIso(yield* database.run(postgresNow));
        let injected = false;
        const raw = yield* database.run(Database);

        const edge =
          yield* raw`SELECT to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant FROM admission_periods WHERE admission_period_id='policy-period'`;

        const expired = yield* Schema.decodeUnknownEffect(Schema.String)(edge[0]?.instant);

        const f = yield* fixture({
          now: () => instant,
          observer: (execution, text) => {
            if (!injected && text.includes("INSERT INTO public.applicant_account_invitations")) {
              injected = true;
              instant = expired;
              // Exercise the driver's actual serialization failure and transaction retry.

              return raw`DO $$ BEGIN RAISE EXCEPTION 'eligibility retry barrier' USING ERRCODE='40001'; END $$`.pipe(
                Effect.andThen(execution),
              );
            }

            return execution;
          },
        });

        yield* evidence("Ja");
        const before = yield* snapshot;
        const result = yield* f.send("Issue", yield* etagOf(f));
        assert.isTrue(injected);
        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    60000,
  );
  it.effect(
    "initial Issue persists without transport but retry refuses",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ transport: false });
        yield* evidence("Ja");
        const issue = yield* f.send("Issue", yield* etagOf(f));
        assert.strictEqual(issue.status, 200);
        assert.strictEqual((yield* decodeResource(issue.text)).items[0]?.delivery, "Pending");
        const before = yield* snapshot;
        assert.strictEqual(
          (yield* f.send("RetryDelivery", yield* etagOf(f), "retry-unavailable")).status,
          503,
        );
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    60000,
  );

  for (const person of [
    "onboarding-policy-admin",
    "policy-leader",
    "policy-recruiter",
    "policy-member",
    "policy-outsider",
  ] as const) {
    it.effect(
      "onboarding native gate and generic outcomes reach: " + person,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ transport: false });
          yield* evidence("Ja");
          const etag = yield* etagOf(f);
          const before = yield* snapshot;
          const result = yield* f.send("Issue", etag, "authority-probe", PersonId.make(person));

          const allowed =
            person === "onboarding-policy-admin" ||
            person === "policy-leader" ||
            person === "policy-recruiter";

          assert.strictEqual(result.status, allowed ? 200 : 403);

          if (allowed) yield* decodeResource(result.text);
          else {
            assert.strictEqual((yield* decodeProblem(result.text)).code, "authority.denied");
            assert.deepStrictEqual(yield* snapshot, before);
          }
        }),
      60000,
    );
  }

  it.effect(
    "postcommit revoke racing dispatch preserves receipt and replay without provider call",
    () =>
      Effect.gen(function* () {
        const dispatch = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        let held = false;

        const f = yield* fixture({
          observer: (execution, text) => {
            if (
              !held &&
              text.includes("UPDATE public.applicant_account_delivery d SET state='Claimed'")
            ) {
              held = true;

              return Deferred.succeed(dispatch, undefined).pipe(
                Effect.andThen(Deferred.await(proceed)),
                Effect.andThen(execution),
              );
            }

            return execution;
          },
        });

        yield* evidence("Ja");
        yield* invitation();
        const etag = yield* etagOf(f);
        const retry = yield* Effect.forkChild(f.send("RetryDelivery", etag));
        yield* awaitBarrier(dispatch, retry, "postcommit delivery claim UPDATE");
        const capsule = yield* receipts;
        assert.strictEqual(capsule.length, 1);
        assert.strictEqual(capsule[0]?.status, 200);
        assert.strictEqual(
          (yield* f.send("Revoke", yield* etagOf(f), "racing-revoke")).status,
          200,
        );
        yield* Deferred.succeed(proceed, undefined);
        const first = yield* Fiber.join(retry);
        assert.strictEqual(first.status, 200);
        assert.deepStrictEqual(capsule[0]?.body, new TextEncoder().encode(first.text));
        const before = yield* snapshot;
        assert.deepStrictEqual(yield* f.send("RetryDelivery", etag), first);
        assert.deepStrictEqual(yield* snapshot, before);
        assert.strictEqual(f.calls(), 0);
      }),
    60000,
  );
  it.effect(
    "interruption before Issue commit rolls back replacement secret and audit",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* evidence("Ja");
        yield* invitation();
        const before = yield* snapshot;
        const written = yield* Deferred.make<void>();

        const work = yield* Effect.forkChild(
          database.run(
            Database.use((sql) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* commandOnboarding({
                    departmentId,
                    command: { applicationId, action: "Issue" },
                    actor,
                    now: DateTime.formatIso(yield* postgresNow),
                    invitationId: "policy-replacement",
                    token,
                    digest: "b".repeat(64),
                  });
                  yield* Deferred.succeed(written, undefined);

                  return yield* Effect.never;
                }),
              ),
            ),
          ),
        );

        yield* Deferred.await(written);
        yield* Fiber.interrupt(work);
        const exit = yield* Fiber.await(work);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
        assert.deepStrictEqual(yield* snapshot, before);
        assert.strictEqual(f.calls(), 0);
      }),
    60000,
  );
  it.effect(
    "interrupted delivery retains claim until restart cleanup erases revoked secret once",
    () =>
      Effect.gen(function* () {
        const sending = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

        const f = yield* fixture({
          provider: () =>
            Deferred.succeed(sending, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(released, undefined)),
            ),
        });

        yield* evidence("Ja");
        yield* invitation();

        const worker = yield* Effect.forkChild(
          database.run(
            drainOnboardingDelivery(applicationId, delivery).pipe(
              Effect.provideService(HttpClient.HttpClient, f.client),
              Effect.provide(TestPlatform),
            ),
          ),
        );

        yield* Effect.raceFirst(
          Deferred.await(sending),
          Fiber.join(worker).pipe(
            Effect.flatMap((result) =>
              Effect.sync(() =>
                assert.fail(`Delivery worker exited before provider dispatch: ${result}`),
              ),
            ),
          ),
        );
        yield* Fiber.interrupt(worker);
        yield* Deferred.await(released);
        const exit = yield* Fiber.await(worker);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
        assert.strictEqual(
          (yield* f.sql`SELECT state FROM applicant_account_delivery`)[0]?.state,
          "Claimed",
        );
        yield* f.sql`UPDATE applicant_account_invitations SET state='Revoked' WHERE invitation_id='policy-invitation'`;
        // Re-enter the production expiry worker after the interrupted owner closes.
        yield* database.run(expireOnboardingSecrets);

        const cleared =
          yield* f.sql`SELECT state,secret,envelope,claim_id,claimed_at FROM applicant_account_delivery`;

        assert.deepStrictEqual(cleared, [
          { state: "Cancelled", secret: null, envelope: null, claim_id: null, claimed_at: null },
        ]);
        const before = yield* snapshot;
        yield* database.run(expireOnboardingSecrets);
        assert.deepStrictEqual(yield* snapshot, before);
        assert.strictEqual(f.calls(), 1);
      }),
    60000,
  );
});

describe("R3 Returning rule stays separate", () => {
  it.effect(
    "admitted Returning registration retains account link and refuses Issue",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* invitation("Cancelled", "fresh", "Claimed");
        yield* f.sql`INSERT INTO applicant_account_links VALUES('policy-applicant',${actor},date_trunc('milliseconds',clock_timestamp(),'UTC'),'policy-invitation')`;

        const school =
          yield* f.sql`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Previous school','Contact','school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS school_id`;

        const schoolId = yield* Schema.decodeUnknownEffect(SchoolId)(school[0]?.school_id);
        yield* f.sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${departmentId})`;
        yield* f.sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${"placement-" + digest},${actor},${departmentId},'policy-other-semester',${schoolId},'Friday',4,'1',false,2)`;
        yield* f.sql`INSERT INTO admission_returning_registrations(registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at) VALUES(${"returning-registration-" + digest},${applicationId},'policy-applicant',${actor},${"placement-" + digest},${departmentId},'policy-semester','policy-period',1,'returning-policy',2,false,false,false,false,false,4,'all','Norsk',NULL,false,'[]'::jsonb,date_trunc('milliseconds',clock_timestamp(),'UTC'))`;
        yield* decide("Admitted");
        const before = yield* snapshot;
        const result = yield* f.send("Issue", yield* etagOf(f));
        assert.strictEqual(result.status, 409);
        assert.strictEqual((yield* decodeProblem(result.text)).code, "onboarding.already-linked");
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    60000,
  );
});
