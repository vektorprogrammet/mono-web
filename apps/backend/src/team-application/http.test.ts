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
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeTeamApplicationApiConfig } from "../config.js";
import { makeTeamApplicationsTestHttp } from "../test/native-http.js";

const expiresAt = DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z"));

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
) => Promise<Response>;

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
    decodeTeamApplicationApiConfig(environment),
    Layer.mergeAll(
      database.layer,
      TeamApplicationsLive.pipe(Layer.provide(database.layer)),
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
const decoded = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  response: Response,
  schema: S,
): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(await response.json(), { onExcessProperty: "error" });

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
  it("replays one key, rejects a changed request, and keeps a new key distinct", async () => {
    const { request, count } = fixture();
    const first = await submit(request, "http-open", "submitA");
    const firstBody = await first.text();

    const confirmation = Schema.decodeSync(Schema.fromJsonString(TeamApplicationConfirmation))(
      firstBody,
    );

    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toBe(
      `/api/team-applications/${confirmation.applicationId}`,
    );

    const replay = await submit(request, "http-open", "submitA");

    expect(replay.status).toBe(201);
    await expect(replay.text()).resolves.toBe(firstBody);

    const changed = await submit(request, "http-open", "submitA", { ...application, name: "Bea" });

    expect(changed.status).toBe(409);
    expect((await decoded(changed, TeamApplicationsSubmitProblem)).code).toBe(
      "idempotency.digest-conflict",
    );

    const second = await submit(request, "http-open", "submitB");

    expect(second.status).toBe(201);
    expect((await decoded(second, TeamApplicationConfirmation)).applicationId).not.toBe(
      confirmation.applicationId,
    );
    await expect(count("team_applications")).resolves.toBe(2);
    await expect(count("team_application_outbox")).resolves.toBe(4);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(2);
  });

  it("rejects closed and unknown teams and invalid fields without receipts", async () => {
    const { request, count } = fixture();
    const closed = await submit(request, "http-closed", "closed");
    const unknown = await submit(request, "http-unknown", "unknown");

    const invalid = await submit(request, "http-open", "invalid", {
      ...application,
      fieldOfStudy: "x".repeat(46),
    });

    expect(closed.status).toBe(409);
    expect((await decoded(closed, TeamApplicationsSubmitProblem)).code).toBe(
      "team-application.intake-closed",
    );
    expect(unknown.status).toBe(404);
    expect((await decoded(unknown, TeamApplicationsSubmitProblem)).code).toBe("resource.not-found");
    expect(invalid.status).toBe(422);
    expect(await decoded(invalid, TeamApplicationsSubmitProblem)).toMatchObject({
      code: "validation.failed",
      validation: { errors: [{ pointer: "/fieldOfStudy", code: "invalid" }] },
    });

    await expect(count("team_applications")).resolves.toBe(0);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(0);
  });

  it("counts every public submission before reading its body", async () => {
    const { request, count } = fixture({
      TEAM_APPLICATION_RATE_LIMIT_MAX: "2",
      TEAM_APPLICATION_RATE_LIMIT_WINDOW_MS: "90000",
    });

    expect((await submit(request, "http-open", "limited")).status).toBe(201);
    // A replay uses the window like any other submission.
    expect((await submit(request, "http-open", "limited")).status).toBe(201);

    // Over the limit, even an unreadable body is refused before parsing.
    const limited = await request("/api/teams/http-open/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key("overLimit") },
      body: "{",
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
    expect((await decoded(limited, TeamApplicationsSubmitProblem)).code).toBe(
      "rate-limit.exceeded",
    );
    expect((await submit(request, "http-open", "afterLimit")).status).toBe(429);
    await expect(count("team_applications")).resolves.toBe(1);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(1);
  });
});

describe("team application staff routes over HTTP", () => {
  it("applies current team authority to reads and leader-only deletion", async () => {
    const { request, count } = fixture();

    const { applicationId } = await decoded(
      await submit(request, "http-open", "staff"),
      TeamApplicationConfirmation,
    );

    const anonymous = await request("/api/teams/http-open/applications");

    const outsider = await request("/api/teams/http-open/applications", {
      person: "http-outsider",
    });

    const member = await request("/api/teams/http-open/applications", { person: "http-member" });

    expect(anonymous.status).toBe(401);
    // The security middleware declares credential problems for every staff route.
    expect((await decoded(anonymous, SessionUnauthorizedProblem)).code).toBe("credential.missing");
    expect(outsider.status).toBe(403);
    expect((await decoded(outsider, TeamApplicationsStaffReadProblem)).code).toBe(
      "authority.denied",
    );
    expect(member.status).toBe(200);
    expect(await decoded(member, TeamApplicationListResponse)).toMatchObject({
      teamId: "http-open",
      items: [{ applicationId, name: application.name }],
      intake: { acceptApplication: true, open: true },
      canManage: false,
    });

    const detail = await request(`/api/team-applications/${applicationId}`, {
      person: "http-member",
    });

    expect(detail.status).toBe(200);
    expect(await decoded(detail, TeamApplicationResource)).toMatchObject({
      ...application,
      canManage: false,
    });

    const remove = (person: string, idempotencyKey: string) =>
      request(`/api/team-applications/${applicationId}`, {
        method: "DELETE",
        person,
        headers: { "idempotency-key": key(idempotencyKey) },
      });

    const memberDelete = await remove("http-member", "memberDelete");

    expect(memberDelete.status).toBe(403);
    expect((await decoded(memberDelete, TeamApplicationsDeleteProblem)).code).toBe(
      "authority.denied",
    );
    await expect(count("team_applications")).resolves.toBe(1);
    expect((await remove("http-leader", "leaderDelete")).status).toBe(204);
    expect((await remove("http-leader", "leaderDelete")).status).toBe(204);

    const deletedAgain = await remove("http-leader", "leaderDeleteAgain");

    expect(deletedAgain.status).toBe(404);
    expect((await decoded(deletedAgain, TeamApplicationsDeleteProblem)).code).toBe(
      "resource.not-found",
    );
    await expect(count("team_applications")).resolves.toBe(0);
    await expect(count("team_application_audit")).resolves.toBe(1);
  });

  it("revises intake only at the observed entity tag and replays the result", async () => {
    const { request } = fixture();

    const list = await decoded(
      await request("/api/teams/http-open/applications", { person: "http-leader" }),
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

    const stale = await revise('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"', "stale");

    expect(stale.status).toBe(412);
    expect((await decoded(stale, TeamApplicationsReviseIntakeProblem)).code).toBe(
      "precondition.failed",
    );

    const revised = await revise(list.intake.etag, "revise");
    const body = await revised.text();

    expect(revised.status).toBe(200);
    expect(Schema.decodeSync(Schema.fromJsonString(TeamApplicationIntakeResource))(body)).toEqual({
      acceptApplication: false,
      deadline: null,
      open: false,
      revision: list.intake.revision + 1,
      etag: revised.headers.get("etag"),
    });

    const replay = await revise(list.intake.etag, "revise");

    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe(body);

    const intake = await request("/api/teams/http-open/application-intake");

    expect(await decoded(intake, PublicTeamApplicationIntake)).toMatchObject({
      teamId: "http-open",
      open: false,
    });

    const afterClose = await submit(request, "http-open", "afterClose");

    expect(afterClose.status).toBe(409);
    expect((await decoded(afterClose, TeamApplicationsSubmitProblem)).code).toBe(
      "team-application.intake-closed",
    );
  });
});
