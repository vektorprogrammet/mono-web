import { IdentitySnapshot, OAuthCredentialAuthority, Database } from "@vektorprogrammet/database";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  PublicTeamApplicationIntake,
  SessionUnauthorizedProblem,
  TeamApplicationConfirmation,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
  TeamApplicationsDeleteProblem,
  TeamApplicationsReviseIntakeProblem,
  TeamApplicationsStaffReadProblem,
  TeamApplicationsSubmitProblem,
} from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeTeamApplicationApiConfig } from "../config.js";
import { makeTeamApplicationsTestHttp } from "../test/native-http.js";

const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const sessionPerson = (cookie: string | undefined) =>
  /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

const actorFor = (personId: string) =>
  new IdentityActor({
    personId: PersonId.make(personId),
    sessionId: `session-${personId}`,
    expiresAt,
  });

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookie) => {
    const person = sessionPerson(cookie);

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(actorFor(person));
  },
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const person = sessionPerson(cookie);

    return person === undefined
      ? Effect.fail(new IdentitySessionNotFound())
      : Effect.succeed(actorFor(person));
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const oauth = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

type TestRequest = (
  pathname: string,
  init?: RequestInit & { readonly person?: string },
) => Effect.Effect<Response>;

/** Each fixture is one backend process: its own database and its own public rate limit. */
const fixture = (environment: Readonly<Record<string, string>> = {}) => {
  const database = backendDatabase(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city)
          VALUES ('http-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim')
        `;
        yield* sql`
          INSERT INTO organization_teams (team_id, department_id, name, email, accept_application, active)
          VALUES
            ('http-open', 'http-department', 'IT', 'it@example.invalid', true, true),
            ('http-closed', 'http-department', 'Lukket', NULL, false, true)
        `;
        yield* sql`
          INSERT INTO person_profiles (person_id, first_name, last_name)
          VALUES ('http-leader', 'Lea', 'Leder'), ('http-member', 'Mia', 'Medlem'),
            ('http-outsider', 'Ola', 'Utenfor')
        `;
        yield* sql`
          INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, is_team_leader)
          VALUES
            ('http-m-leader', 'http-leader', 'http-open', '2020-01-01', true),
            ('http-m-member', 'http-member', 'http-open', '2020-01-01', false),
            ('http-m-outsider', 'http-outsider', 'http-closed', '2020-01-01', true)
        `;
      }),
    ),
  );

  const http = makeTeamApplicationsTestHttp(
    Effect.runSync(decodeTeamApplicationApiConfig(environment)),
    Layer.mergeAll(
      database.layer,
      TeamApplicationsLive().pipe(Layer.provide(database.layer)),
      Layer.succeed(Identity, identity),
      Layer.succeed(IdentitySnapshot, identitySnapshot),
      Layer.succeed(OAuthCredentialAuthority, oauth),
    ),
  );

  const request: TestRequest = (pathname, init = {}) => {
    const headers = new Headers(init.headers);

    if (init.person !== undefined) {
      headers.set("cookie", `better-auth.session_token=${init.person}`);
    }

    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", "http://127.0.0.1:5174");
    }

    return http.fetch(new Request(`http://backend.test${pathname}`, { ...init, headers }));
  };

  const count = (table: string) =>
    database.run(
      Database.use((sql) =>
        sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count FROM ${table}`),
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    );

  return { request, count };
};

const application = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.",
  motivation: "Vil hjelpe elever.",
};

const key = (value: string) => value.padEnd(22, "0");

/** Decodes a response body through its declared contract schema. */
const decoded = <S extends Schema.ConstraintDecoder<unknown, never>>(
  response: Response,
  schema: S,
) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }),
    ),
  );

const submit = (
  request: TestRequest,
  team: string,
  idempotencyKey: string,
  body: Readonly<Record<string, string>> = application,
) =>
  request(`/api/teams/${team}/applications`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key(idempotencyKey) },
    body: JSON.stringify(body),
  });

describe("team application submission over HTTP", () => {
  it.live("replays one key, rejects a changed request, and keeps a new key distinct", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();
      const first = yield* submit(request, "http-open", "submitA");
      const firstBody = yield* Effect.promise(() => first.text());

      const confirmation = yield* Schema.decodeEffect(
        Schema.fromJsonString(TeamApplicationConfirmation),
      )(firstBody);

      expect(first.status).toBe(201);
      expect(first.headers.get("location")).toBe(
        `/api/team-applications/${confirmation.applicationId}`,
      );

      const replay = yield* submit(request, "http-open", "submitA");

      expect(replay.status).toBe(201);
      expect(yield* Effect.promise(() => replay.text())).toBe(firstBody);

      const changed = yield* submit(request, "http-open", "submitA", {
        ...application,
        name: "Bea",
      });

      expect(changed.status).toBe(409);
      expect((yield* decoded(changed, TeamApplicationsSubmitProblem)).code).toBe(
        "idempotency.digest-conflict",
      );

      const second = yield* submit(request, "http-open", "submitB");

      expect(second.status).toBe(201);
      expect((yield* decoded(second, TeamApplicationConfirmation)).applicationId).not.toBe(
        confirmation.applicationId,
      );
      expect(yield* count("team_applications")).toBe(2);
      expect(yield* count("team_application_outbox")).toBe(4);
      expect(yield* count("effect_queue")).toBe(4);
      expect(yield* count("native_http_idempotency_receipts")).toBe(2);
    }),
  );

  it.live("rejects closed and unknown teams and invalid fields without receipts", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();
      const closed = yield* submit(request, "http-closed", "closed");
      const unknown = yield* submit(request, "http-unknown", "unknown");

      const invalid = yield* submit(request, "http-open", "invalid", {
        ...application,
        fieldOfStudy: "x".repeat(46),
      });

      expect(closed.status).toBe(409);
      expect((yield* decoded(closed, TeamApplicationsSubmitProblem)).code).toBe(
        "team-application.intake-closed",
      );
      expect(unknown.status).toBe(404);
      expect((yield* decoded(unknown, TeamApplicationsSubmitProblem)).code).toBe(
        "resource.not-found",
      );
      expect(invalid.status).toBe(422);
      expect(yield* decoded(invalid, TeamApplicationsSubmitProblem)).toMatchObject({
        code: "validation.failed",
        validation: { errors: [{ pointer: "/fieldOfStudy", code: "invalid" }] },
      });

      expect(yield* count("team_applications")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("counts every public submission before reading its body", () =>
    Effect.gen(function* () {
      const { request, count } = fixture({
        TEAM_APPLICATION_RATE_LIMIT_MAX: "2",
        TEAM_APPLICATION_RATE_LIMIT_WINDOW_MS: "90000",
      });

      expect((yield* submit(request, "http-open", "limited")).status).toBe(201);
      // A replay uses the window like any other submission.
      expect((yield* submit(request, "http-open", "limited")).status).toBe(201);

      // Over the limit, even an unreadable body is refused before parsing.
      const limited = yield* request("/api/teams/http-open/applications", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("overLimit") },
        body: "{",
      });

      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("90");
      expect((yield* decoded(limited, TeamApplicationsSubmitProblem)).code).toBe(
        "rate-limit.exceeded",
      );
      expect((yield* submit(request, "http-open", "afterLimit")).status).toBe(429);
      expect(yield* count("team_applications")).toBe(1);
      expect(yield* count("native_http_idempotency_receipts")).toBe(1);
    }),
  );
});

describe("team application staff routes over HTTP", () => {
  it.live("applies current team authority to reads and leader-only deletion", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();

      const { applicationId } = yield* decoded(
        yield* submit(request, "http-open", "staff"),
        TeamApplicationConfirmation,
      );

      const anonymous = yield* request("/api/teams/http-open/applications");

      const outsider = yield* request("/api/teams/http-open/applications", {
        person: "http-outsider",
      });

      const member = yield* request("/api/teams/http-open/applications", { person: "http-member" });

      expect(anonymous.status).toBe(401);
      // The security middleware declares credential problems for every staff route.
      expect((yield* decoded(anonymous, SessionUnauthorizedProblem)).code).toBe(
        "credential.missing",
      );
      expect(outsider.status).toBe(403);
      expect((yield* decoded(outsider, TeamApplicationsStaffReadProblem)).code).toBe(
        "authority.denied",
      );
      expect(member.status).toBe(200);
      expect(yield* decoded(member, TeamApplicationListResponse)).toMatchObject({
        teamId: "http-open",
        items: [{ applicationId, name: application.name }],
        intake: { acceptApplication: true, open: true },
        canManage: false,
      });

      const detail = yield* request(`/api/team-applications/${applicationId}`, {
        person: "http-member",
      });

      expect(detail.status).toBe(200);
      expect(yield* decoded(detail, TeamApplicationResource)).toMatchObject({
        ...application,
        canManage: false,
      });

      const remove = (person: string, idempotencyKey: string) =>
        request(`/api/team-applications/${applicationId}`, {
          method: "DELETE",
          person,
          headers: { "idempotency-key": key(idempotencyKey) },
        });

      const memberDelete = yield* remove("http-member", "memberDelete");

      expect(memberDelete.status).toBe(403);
      expect((yield* decoded(memberDelete, TeamApplicationsDeleteProblem)).code).toBe(
        "authority.denied",
      );
      expect(yield* count("team_applications")).toBe(1);
      expect((yield* remove("http-leader", "leaderDelete")).status).toBe(204);
      expect((yield* remove("http-leader", "leaderDelete")).status).toBe(204);

      const deletedAgain = yield* remove("http-leader", "leaderDeleteAgain");

      expect(deletedAgain.status).toBe(404);
      expect((yield* decoded(deletedAgain, TeamApplicationsDeleteProblem)).code).toBe(
        "resource.not-found",
      );
      expect(yield* count("team_applications")).toBe(0);
      expect(yield* count("team_application_audit")).toBe(1);
    }),
  );

  it.live("revises intake only at the observed entity tag and replays the result", () =>
    Effect.gen(function* () {
      const { request } = fixture();

      const list = yield* decoded(
        yield* request("/api/teams/http-open/applications", { person: "http-leader" }),
        TeamApplicationListResponse,
      );

      const revise = (ifMatch: string, idempotencyKey: string) =>
        request("/api/teams/http-open/application-intake", {
          method: "PATCH",
          person: "http-leader",
          headers: {
            "content-type": "application/merge-patch+json",
            "idempotency-key": key(idempotencyKey),
            "if-match": ifMatch,
          },
          body: JSON.stringify({ acceptApplication: false }),
        });

      const stale = yield* revise('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"', "stale");

      expect(stale.status).toBe(412);
      expect((yield* decoded(stale, TeamApplicationsReviseIntakeProblem)).code).toBe(
        "precondition.failed",
      );

      const revised = yield* revise(list.intake.etag, "revise");
      const body = yield* Effect.promise(() => revised.text());

      expect(revised.status).toBe(200);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(TeamApplicationIntakeResource))(body),
      ).toEqual({
        acceptApplication: false,
        deadline: null,
        open: false,
        revision: list.intake.revision + 1,
        etag: revised.headers.get("etag"),
      });

      const replay = yield* revise(list.intake.etag, "revise");

      expect(replay.status).toBe(200);
      expect(yield* Effect.promise(() => replay.text())).toBe(body);

      const intake = yield* request("/api/teams/http-open/application-intake");

      expect(yield* decoded(intake, PublicTeamApplicationIntake)).toMatchObject({
        teamId: "http-open",
        open: false,
      });

      const afterClose = yield* submit(request, "http-open", "afterClose");

      expect(afterClose.status).toBe(409);
      expect((yield* decoded(afterClose, TeamApplicationsSubmitProblem)).code).toBe(
        "team-application.intake-closed",
      );
    }),
  );
});
