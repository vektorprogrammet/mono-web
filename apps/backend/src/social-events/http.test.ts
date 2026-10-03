import { describe, expect, it } from "@effect/vitest";
import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { SocialEventsLive } from "@vektorprogrammet/database/social-events";
import { IdentityActor } from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { CreateSocialEventRequest, SocialEventResource } from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestHttp } from "../test/native-http.js";

const database = backendDatabase();

const personId = PersonId.make("social-event-retry-member");

const session = new IdentityActor({
  personId,
  sessionId: "social-event-retry-session",
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
});

const http = makeBackendTestHttp(
  backendTestConfig,
  Layer.mergeAll(
    database.layer,
    SocialEventsLive.pipe(Layer.provide(database.layer)),
    Layer.succeed(
      IdentitySnapshot,
      IdentitySnapshot.of({
        resolveSession: () => Effect.succeed(session),
        revokeCurrentSession: () => Effect.die("unexpected session mutation"),
        revokeSession: () => Effect.die("unexpected session mutation"),
        revokeOtherSessions: () => Effect.die("unexpected session mutation"),
        revokeAllSessions: () => Effect.die("unexpected session mutation"),
      }),
    ),
  ),
  {
    handler: () => Effect.succeed(new Response(null, { status: 404 })),
    recordTrustedOriginRejection: () => Effect.void,
  },
);

const prepareFault = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
      VALUES ('social-event-retry-department', 'Social events', 'SOC', 'social@example.invalid', 'Trondheim')
    `;
    yield* sql`
      INSERT INTO public.organization_teams (team_id, department_id, name, email, active)
      VALUES ('social-event-retry-team', 'social-event-retry-department', 'Team', NULL, true)
    `;
    yield* sql`
      INSERT INTO public.person_profiles (person_id, first_name, last_name)
      VALUES (${personId}, 'Test', 'Member')
    `;
    yield* sql`
      INSERT INTO public.organization_memberships
        (membership_id, person_id, team_id, start_at, is_team_leader)
      VALUES ('social-event-retry-membership', ${personId}, 'social-event-retry-team', '2020-01-01', false)
    `;
    yield* sql`
      INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
      VALUES ('social-event-retry-semester', '2035-01-01', '2035-07-01')
    `;

    // nextval is nontransactional: the first INSERT fails with a real SQLSTATE 40001,
    // and the retry INSERT succeeds even though the first transaction rolls back.
    yield* sql`CREATE SEQUENCE public.social_event_retry_attempts START 1`;
    yield* sql`
      CREATE FUNCTION public.fail_first_social_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('public.social_event_retry_attempts') = 1 THEN
          RAISE EXCEPTION 'injected social-event serialization failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $$
    `;
    yield* sql`
      CREATE TRIGGER fail_first_social_event_insert
      BEFORE INSERT ON public.social_events
      FOR EACH ROW EXECUTE FUNCTION public.fail_first_social_event_insert()
    `;
  }),
);

const persisted = Database.use((sql) =>
  Effect.gen(function* () {
    const [rows] = yield* sql<{
      readonly insertAttempts: number;
      readonly events: number;
      readonly domainReceipts: number;
      readonly audit: number;
      readonly httpReceipts: number;
      readonly eventId: string | null;
    }>`
      SELECT
        (SELECT last_value::integer FROM public.social_event_retry_attempts) AS "insertAttempts",
        (SELECT count(*)::integer FROM public.social_events) AS events,
        (SELECT count(*)::integer FROM public.social_event_command_receipts) AS "domainReceipts",
        (SELECT count(*)::integer FROM public.social_event_audit) AS audit,
        (SELECT count(*)::integer FROM public.native_http_idempotency_receipts) AS "httpReceipts",
        (SELECT event_id FROM public.social_events LIMIT 1) AS "eventId"
    `;

    return rows;
  }),
);

const create = (body: string) =>
  http.fetch(
    new Request("http://backend.test/api/social-events", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=social-event-retry-session",
        origin: "http://127.0.0.1:5174",
        "content-type": "application/json",
        "idempotency-key": "social-event-serialization-retry",
      },
      body,
    }),
  );

describe("social-event create over the original HTTP and PostgreSQL receipt path", () => {
  it.live(
    "retries one SQLSTATE 40001 INSERT after rollback and commits exactly one event with all receipts",
    () =>
      Effect.gen(function* () {
        yield* database.run(prepareFault);

        const request = yield* Schema.decodeEffect(CreateSocialEventRequest)({
          departmentId: "social-event-retry-department",
          semesterId: "social-event-retry-semester",
          audience: "TeamMembers",
          title: "Team gathering",
          description: "",
          link: null,
          startAt: "2035-04-01T12:00:00.000Z",
          endAt: "2035-04-01T14:00:00.000Z",
        });

        const body = yield* Schema.encodeEffect(Schema.fromJsonString(CreateSocialEventRequest))(
          request,
        );

        const response = yield* create(body);
        const state = yield* database.run(persisted);
        expect({ status: response.status, ...state }).toEqual({
          status: 201,
          insertAttempts: 2,
          events: 1,
          domainReceipts: 1,
          audit: 1,
          httpReceipts: 1,
          eventId: expect.any(String),
        });

        const firstBody = yield* Effect.promise(() => response.text());

        const event = yield* Schema.decodeEffect(Schema.fromJsonString(SocialEventResource))(
          firstBody,
        );

        expect(event).toMatchObject({ ...request, eventId: state?.eventId, revision: 0 });
        expect(response.headers.get("location")).toBe(`/api/social-events/${event.eventId}`);
        expect(response.headers.get("etag")).toMatch(/^".+"$/u);

        const replay = yield* create(body);

        expect(replay.status).toBe(201);
        expect(yield* Effect.promise(() => replay.text())).toBe(firstBody);
        expect(yield* database.run(persisted)).toEqual(state);
      }),
  );
});
