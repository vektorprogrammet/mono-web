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
  TeamApplicationConfirmation,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
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
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookie) => {
    const person = sessionPerson(cookie);

    if (person === undefined) throw new IdentitySessionNotFound();

    return actorFor(person);
  },
  readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
  listSessions: () => Promise.reject(new Error("unexpected session list")),
  revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
  revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
  recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
  signOut: async () => ({ setCookies: [] }),
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
  resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

type TestRequest = (
  pathname: string,
  init?: RequestInit & { readonly person?: string },
) => Promise<Response>;

const fixture = () => {
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

    const confirmation = Schema.decodeUnknownSync(
      Schema.fromJsonString(TeamApplicationConfirmation),
    )(firstBody);

    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toBe(
      `/api/team-applications/${confirmation.applicationId}`,
    );

    const replay = await submit(request, "http-open", "submitA");

    expect(replay.status).toBe(201);
    await expect(replay.text()).resolves.toBe(firstBody);

    const changed = await submit(request, "http-open", "submitA", { ...application, name: "Bea" });

    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({ code: "idempotency.digest-conflict" });

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
    await expect(closed.json()).resolves.toMatchObject({ code: "team-application.intake-closed" });
    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(422);

    await expect(invalid.json()).resolves.toMatchObject({
      code: "validation.failed",
      validation: { errors: [{ pointer: "/fieldOfStudy", code: "invalid" }] },
    });

    await expect(count("team_applications")).resolves.toBe(0);
    await expect(count("native_http_idempotency_receipts")).resolves.toBe(0);
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
    expect(outsider.status).toBe(403);
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

    expect((await remove("http-member", "memberDelete")).status).toBe(403);
    await expect(count("team_applications")).resolves.toBe(1);
    expect((await remove("http-leader", "leaderDelete")).status).toBe(204);
    expect((await remove("http-leader", "leaderDelete")).status).toBe(204);
    expect((await remove("http-leader", "leaderDeleteAgain")).status).toBe(404);
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

    const revised = await revise(list.intake.etag, "revise");
    const body = await revised.text();

    expect(revised.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(TeamApplicationIntakeResource))(body),
    ).toEqual({
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
    expect((await submit(request, "http-open", "afterClose")).status).toBe(409);
  });
});
