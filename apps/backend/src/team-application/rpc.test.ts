/**
 * Team applications over RPC and PostgreSQL: the public submission with its receipts and rate
 * limit, and the staff reads, leader-only deletion, and intake revision at the observed entity tag.
 */
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId, TeamId } from "@vektorprogrammet/domain/organization";
import { nativeRpcPath, TeamApplicationInput } from "@vektorprogrammet/rpc";
import { IdempotencyKey, isProblem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Exit, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { decodeTeamApplicationApiConfig } from "../config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const sessionPerson = (cookie: string | undefined) =>
  /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

const actorFor = (personId: string) =>
  IdentityActor.make({
    personId: PersonId.make(personId),
    sessionId: `session-${personId}`,
    expiresAt,
  });

const resolveSession = (cookie: string | undefined) => {
  const person = sessionPerson(cookie);

  return person === undefined
    ? Effect.fail(IdentitySessionNotFound.make({}))
    : Effect.succeed(actorFor(person));
};

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession,
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
  resolveSession,
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const oauth = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO organization_departments (department_id, name, short_name, email, city)
      VALUES ('rpc-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim')
    `;
    yield* sql`
      INSERT INTO organization_teams (team_id, department_id, name, email, accept_application, active)
      VALUES
        ('rpc-open', 'rpc-department', 'IT', 'it@example.invalid', true, true),
        ('rpc-closed', 'rpc-department', 'Lukket', NULL, false, true)
    `;
    yield* sql`
      INSERT INTO person_profiles (person_id, first_name, last_name)
      VALUES ('rpc-leader', 'Lea', 'Leder'), ('rpc-member', 'Mia', 'Medlem'),
        ('rpc-outsider', 'Ola', 'Utenfor')
    `;
    yield* sql`
      INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, is_team_leader)
      VALUES
        ('rpc-m-leader', 'rpc-leader', 'rpc-open', '2020-01-01', true),
        ('rpc-m-member', 'rpc-member', 'rpc-open', '2020-01-01', false),
        ('rpc-m-outsider', 'rpc-outsider', 'rpc-closed', '2020-01-01', true)
    `;
  }),
);

/** Each fixture is one backend process: its own database and its own public rate limit. */
const fixture = (environment: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const database = backendDatabase(seed);

    const backend = makeBackendTestRpc({
      config: {
        ...backendTestConfig,
        teamApplication: yield* decodeTeamApplicationApiConfig(environment),
      },
      services: Layer.mergeAll(
        TeamApplicationsLive(),
        Layer.succeed(Identity, identity),
        Layer.succeed(IdentitySnapshot, identitySnapshot),
        Layer.succeed(OAuthCredentialAuthority, oauth),
      ).pipe(Layer.provideMerge(database.layer)),
    });

    const client = yield* backend.client;

    const count = (table: string) =>
      database.run(
        Database.use((sql) =>
          sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count FROM ${table}`),
        ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
      );

    return { backend, client, count };
  });

const as = (person: string) =>
  RpcClient.withHeaders({ cookie: `better-auth.session_token=${person}` });

const application = Schema.decodeSync(TeamApplicationInput)({
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.",
  motivation: "Vil hjelpe elever.",
});

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

const team = (value: string) => TeamId.make(value);

/** The problem code of a failed call; a transport failure or a defect has none. */
const codeOf = <E>(failure: E) => (isProblem(failure) ? failure.code : "not-a-problem");

type Client = Effect.Success<ReturnType<typeof fixture>>["client"];

const submit = (
  client: Client,
  teamId: string,
  idempotencyKey: string,
  request: TeamApplicationInput = application,
) =>
  client["team-applications.submitTeamApplication"]({
    teamId: team(teamId),
    idempotencyKey: key(idempotencyKey),
    request,
  });

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const RpcDefectExit = Schema.Array(
  Schema.TaggedStruct("Exit", {
    requestId: Schema.String,
    exit: Schema.TaggedStruct("Failure", {
      cause: Schema.Array(Schema.TaggedStruct("Die", { defect: Schema.Json })),
    }),
  }),
);

describe("team application submission over RPC", () => {
  it.live("replays one key, rejects a changed request, and keeps a new key distinct", () =>
    Effect.gen(function* () {
      const { client, count } = yield* fixture();
      const first = yield* submit(client, "rpc-open", "submitA");
      const replay = yield* submit(client, "rpc-open", "submitA");

      expect(replay).toEqual(first);

      const changed = yield* submit(client, "rpc-open", "submitA", {
        ...application,
        name: "Bea",
      }).pipe(Effect.flip);

      expect(codeOf(changed)).toBe("idempotency.digest-conflict");

      const second = yield* submit(client, "rpc-open", "submitB");

      expect(second.applicationId).not.toBe(first.applicationId);
      expect(yield* count("team_applications")).toBe(2);
      expect(yield* count("team_application_outbox")).toBe(4);
      expect(yield* count("effect_queue")).toBe(4);
      expect(yield* count("native_http_idempotency_receipts")).toBe(2);
    }),
  );

  it.live("rejects closed and unknown teams without receipts", () =>
    Effect.gen(function* () {
      const { client, count } = yield* fixture();
      const closed = yield* submit(client, "rpc-closed", "closed").pipe(Effect.flip);
      const unknown = yield* submit(client, "rpc-unknown", "unknown").pipe(Effect.flip);

      expect(codeOf(closed)).toBe("team-application.intake-closed");
      expect(codeOf(unknown)).toBe("resource.not-found");
      expect(yield* count("team_applications")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);
    }),
  );

  it.live("fails an undecodable application in the RPC server, before quota and storage", () =>
    Effect.gen(function* () {
      const { backend, client, count } = yield* fixture({
        TEAM_APPLICATION_RATE_LIMIT_MAX: "1",
        TEAM_APPLICATION_RATE_LIMIT_WINDOW_MS: "90000",
      });

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(RpcRequest))(
        RpcRequest.make({
          id: "1",
          tag: "team-applications.submitTeamApplication",
          payload: {
            teamId: "rpc-open",
            idempotencyKey: key("invalid"),
            request: { ...application, fieldOfStudy: "x".repeat(46) },
          },
          headers: [],
        }),
      );

      const response = yield* backend.fetch(
        new Request(`http://native-rpc.test${nativeRpcPath}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5174" },
          body,
        }),
      );

      // The RPC server answers an undecodable payload as a defect of that request.
      const answer = yield* Schema.decodeUnknownEffect(RpcDefectExit)(
        yield* Effect.promise(() => response.json()),
      );

      expect(answer).toHaveLength(1);
      expect(yield* count("team_applications")).toBe(0);
      expect(yield* count("native_http_idempotency_receipts")).toBe(0);

      // The refused payload consumed no quota: the one submission of the window still passes.
      const stored = yield* Effect.exit(submit(client, "rpc-open", "afterInvalid"));

      expect(Exit.isSuccess(stored)).toBe(true);
    }),
  );

  it.live("counts every public submission, a replay included, against the rate limit", () =>
    Effect.gen(function* () {
      const { client, count } = yield* fixture({
        TEAM_APPLICATION_RATE_LIMIT_MAX: "2",
        TEAM_APPLICATION_RATE_LIMIT_WINDOW_MS: "90000",
      });

      yield* submit(client, "rpc-open", "limited");
      // A replay uses the window like any other submission.
      yield* submit(client, "rpc-open", "limited");

      const limited = yield* submit(client, "rpc-open", "afterLimit").pipe(Effect.flip);

      expect(codeOf(limited)).toBe("rate-limit.exceeded");
      expect(yield* count("team_applications")).toBe(1);
      expect(yield* count("native_http_idempotency_receipts")).toBe(1);
    }),
  );
});

describe("team application staff operations over RPC", () => {
  it.live("applies current team authority to reads and leader-only deletion", () =>
    Effect.gen(function* () {
      const { client, count } = yield* fixture();
      const { applicationId } = yield* submit(client, "rpc-open", "staff");

      const list = (person?: string) => {
        const call = client["team-applications.listTeamApplications"]({ teamId: team("rpc-open") });

        return person === undefined ? call : call.pipe(as(person));
      };

      expect(codeOf(yield* list().pipe(Effect.flip))).toBe("credential.missing");
      expect(codeOf(yield* list("rpc-outsider").pipe(Effect.flip))).toBe("authority.denied");
      expect(yield* list("rpc-member")).toMatchObject({
        teamId: "rpc-open",
        items: [{ applicationId, name: application.name }],
        intake: { acceptApplication: true, open: true },
        canManage: false,
      });

      const detail = yield* client["team-applications.readTeamApplication"]({
        applicationId,
      }).pipe(as("rpc-member"));

      expect(detail).toMatchObject({ ...application, canManage: false });

      const remove = (person: string, idempotencyKey: string) =>
        client["team-applications.deleteTeamApplication"]({
          applicationId,
          idempotencyKey: key(idempotencyKey),
        }).pipe(as(person));

      expect(codeOf(yield* remove("rpc-member", "memberDelete").pipe(Effect.flip))).toBe(
        "authority.denied",
      );
      expect(yield* count("team_applications")).toBe(1);

      yield* remove("rpc-leader", "leaderDelete");
      // The replay answers the stored no-content receipt.
      yield* remove("rpc-leader", "leaderDelete");

      expect(codeOf(yield* remove("rpc-leader", "leaderDeleteAgain").pipe(Effect.flip))).toBe(
        "resource.not-found",
      );
      expect(yield* count("team_applications")).toBe(0);
      expect(yield* count("team_application_audit")).toBe(1);
    }),
  );

  it.live("revises intake only at the observed entity tag and replays the result", () =>
    Effect.gen(function* () {
      const { client } = yield* fixture();

      const list = yield* client["team-applications.listTeamApplications"]({
        teamId: team("rpc-open"),
      }).pipe(as("rpc-leader"));

      const revise = (
        ifMatch: StrongETag,
        idempotencyKey: string,
        request: { readonly acceptApplication?: boolean | null } = { acceptApplication: false },
      ) =>
        client["team-applications.reviseTeamApplicationIntake"]({
          teamId: team("rpc-open"),
          idempotencyKey: key(idempotencyKey),
          ifMatch,
          request,
        }).pipe(as("rpc-leader"));

      const stale = yield* revise(
        StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
        "stale",
      ).pipe(Effect.flip);

      expect(codeOf(stale)).toBe("precondition.failed");
      expect(codeOf(yield* revise(list.intake.etag, "noChange", {}).pipe(Effect.flip))).toBe(
        "validation.no-change",
      );
      expect(
        codeOf(
          yield* revise(list.intake.etag, "deleteAccept", { acceptApplication: null }).pipe(
            Effect.flip,
          ),
        ),
      ).toBe("validation.field-not-deletable");

      const revised = yield* revise(list.intake.etag, "revise");

      expect(revised).toEqual({
        acceptApplication: false,
        deadline: null,
        open: false,
        revision: list.intake.revision + 1,
        etag: revised.etag,
      });
      expect(revised.etag).not.toBe(list.intake.etag);
      expect(yield* revise(list.intake.etag, "revise")).toEqual(revised);

      // A member reads the intake but cannot revise it.
      expect(
        codeOf(
          yield* client["team-applications.reviseTeamApplicationIntake"]({
            teamId: team("rpc-open"),
            idempotencyKey: key("memberRevise"),
            ifMatch: revised.etag,
            request: { acceptApplication: true },
          }).pipe(as("rpc-member"), Effect.flip),
        ),
      ).toBe("authority.denied");

      const intake = yield* client["team-applications.readTeamApplicationIntake"]({
        teamId: team("rpc-open"),
      });

      expect(intake).toMatchObject({ teamId: "rpc-open", open: false });

      const intakes = yield* client["team-applications.listTeamApplicationIntakes"]();

      expect(intakes.map(({ teamId, open }) => [teamId, open])).toEqual([
        ["rpc-closed", false],
        ["rpc-open", false],
      ]);

      const afterClose = yield* submit(client, "rpc-open", "afterClose").pipe(Effect.flip);

      expect(codeOf(afterClose)).toBe("team-application.intake-closed");
    }),
  );
});
