import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
import { jsonText } from "../http-api/problem.js";
import { makeBackendTestHttp } from "../test/native-http.js";
import { vi } from "vitest";

// Every case clones a migrated real PostgreSQL database, so the default 5 seconds is too short.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Red-first checks of spec 0027 against the accepted handwritten backend (8152c389) on a real
 * PostgreSQL cluster. Every case calls the real router with a valid person session, so an
 * endpoint that does not exist yet fails as the HTTP 404 the router really answers, never as a
 * missing import. The wire shapes of the announce resource, the typed problem codes and the
 * template documents are the proposal of the spec: the `admission-outcome.` code family and the
 * `draftFor` document are the single place to adjust when the implementation fixes the names.
 * Template authority is expressed with the grants that exist at 8152c389: a global-administrator
 * grant, `placements.coordinate` for the Skolekoordinering coordinator and `admissions.outcomes`
 * for Rekruttering.
 *
 * The mail envelope is frozen as one concrete Admissions table, `public.admission_outcome_outbox`,
 * a proposed application-owned name that follows `public.team_application_outbox`: one row per
 * announced application, keyed by `application_id`, with `effect_id` as the deterministic delivery
 * ID and `payload_json` as the strict envelope `{deliveryId, recipient, subject, html, text}`
 * (the worker adds `MAIL_SENDER`). Every case first asserts the HTTP answer it requires and only
 * then reads this table by `WHERE application_id = $id`, so an absent endpoint fails as the
 * router's 404 and never as a missing relation.
 */
const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "outcome-policy-http-test-secret-32-chars",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
  MAIL_SENDER: "sender@example.invalid",
} as const;

const origin = "http://127.0.0.1:5174";

const departmentId = "outcome-department";

const otherDepartmentId = "outcome-other-department";

const semesterId = "outcome-semester";

const scope = new URLSearchParams({ departmentId, semesterId }).toString();

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** A well-formed strong entity tag that no representation ever had. */
const staleEtag = `"vkr2.${"A".repeat(43)}"`;

const strongEtag = /^"vkr2\.[A-Za-z0-9_-]{43}"$/u;

const emailOf = (key: string) => `${key}@example.invalid`;

const applicationOf = (key: string) => `application-${key}`;

interface Applicant {
  readonly key: string;
  readonly firstName: string;
  readonly recommendation: "Ja" | "Kanskje" | "Nei" | "Returning";
  readonly placement?: "Monday" | "Tuesday";
}

/** A first name that is markup: it must reach the mail as escaped text, never as an element. */
const markupName = "<img src=x onerror=alert(1)>";

/**
 * Interviewed Ja and Nei applicants, with and without an active placement in the semester, a
 * Kanskje applicant, and a returning assistant who registered without an interview.
 */
const applicants: ReadonlyArray<Applicant> = [
  { key: "ja-free", firstName: "Jorunn", recommendation: "Ja" },
  { key: "ja-placed", firstName: "Jonas", recommendation: "Ja", placement: "Monday" },
  { key: "nei-free", firstName: "Nina", recommendation: "Nei" },
  { key: "nei-placed", firstName: "Nils", recommendation: "Nei", placement: "Tuesday" },
  { key: "maybe", firstName: "Maja", recommendation: "Kanskje" },
  { key: "returning", firstName: "Rita", recommendation: "Returning" },
  { key: "markup-nei", firstName: markupName, recommendation: "Nei" },
];

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${departmentId},'Trondheim','TRD','outcome@example.invalid','Trondheim'),(${otherDepartmentId},'Oslo','OSL','other-outcome@example.invalid','Oslo')`;
    yield* sql`INSERT INTO organization_teams(team_id,department_id,name) VALUES('outcome-recruitment',${departmentId},'Rekruttering'),('outcome-coordination',${departmentId},'Skolekoordinering'),('outcome-evaluation',${departmentId},'Evaluering'),('outcome-other-coordination',${otherDepartmentId},'Skolekoordinering')`;
    yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${departmentId},'Trondheim')`;
    yield* sql`INSERT INTO admission_period_semesters VALUES('outcome-previous','2031-08-01T00:00:00Z','2031-12-31T00:00:00Z'),(${semesterId},'2032-01-01T00:00:00Z','2032-06-30T00:00:00Z')`;
    yield* sql`INSERT INTO admission_periods VALUES('outcome-period',${departmentId},${semesterId},'2031-11-01T00:00:00Z','2031-12-01T00:00:00Z',0,'outcome-seed')`;
    yield* sql`INSERT INTO admission_period_fields_of_study VALUES('outcome-field',${departmentId},'Matematikk',true)`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('recruiter','Rolf','Rekruttering'),('coordinator','Kari','Koordinator'),('member','Mia','Medlem'),('outsider','Olga','Oslo'),('admin','Ada','Admin'),('boardmember','Bjorn','Styre'),('boardleader','Berit','Styreleder')`;
    yield* sql`INSERT INTO organization_global_administrator_grants(grant_id,person_id,start_at) VALUES('outcome-admin-grant','admin','2020-01-01T00:00:00.000Z')`;

    yield* sql`INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader) VALUES('outcome-m-recruiter','recruiter','outcome-recruitment','2020-01-01T00:00:00Z',false),('outcome-m-coordinator','coordinator','outcome-coordination','2020-01-01T00:00:00Z',true),('outcome-m-member','member','outcome-evaluation','2020-01-01T00:00:00Z',false),('outcome-m-outsider','outsider','outcome-other-coordination','2020-01-01T00:00:00Z',true)`;
    // A plain national board seat: board membership alone confers no template or announce authority.
    yield* sql`INSERT INTO organization_national_boards(board_id,name) VALUES('outcome-board','Hovedstyret')`;
    yield* sql`INSERT INTO organization_memberships(membership_id,person_id,board_id,position_name,start_at,is_team_leader) VALUES('outcome-m-board','boardmember','outcome-board','Styremedlem','2020-01-01T00:00:00Z',false)`;
    // A national board leader holds neither delegation: a board leadership alone decides and announces nothing.
    yield* sql`INSERT INTO organization_memberships(membership_id,person_id,board_id,position_name,start_at,is_team_leader) VALUES('outcome-m-board-leader','boardleader','outcome-board','Styreleder','2020-01-01T00:00:00Z',true)`;
    // Rekruttering decides outcomes and Skolekoordinering coordinates placements, each by an explicit delegation.
    yield* sql`INSERT INTO organization_delegations(delegation_id,name,team_id,capability,area,area_department_id,holders,start_at) VALUES(${`delegation-${digest("outcome-decide")}`},'Rekruttering avgjor utfall','outcome-recruitment','admissions.outcomes','Department',${departmentId},'AllMembers','2020-01-01T00:00:00Z'),(${`delegation-${digest("outcome-coordinate")}`},'Skolekoordinering fordeler assistenter','outcome-coordination','placements.coordinate','Department',${departmentId},'AllMembers','2020-01-01T00:00:00Z'),(${`delegation-${digest("outcome-other-coordinate")}`},'Skolekoordinering Oslo','outcome-other-coordination','placements.coordinate','Department',${otherDepartmentId},'AllMembers','2020-01-01T00:00:00Z')`;

    const [school] = yield* sql<{
      readonly schoolId: number;
    }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Alpha skole','Kontakt','alpha@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

    yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${school!.schoolId},${departmentId})`;
    yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES('outcome-schema','Intervju',0,true,0)`;

    for (const applicant of applicants) {
      const { key, firstName } = applicant;
      yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${key},${firstName},'Soker')`;
      yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES(${`applicant-${key}`},${emailOf(key)},${emailOf(key)},${firstName},'Soker','12345678',0,'outcome-field',2)`;
      yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationOf(key)},${`applicant-${key}`},'outcome-period',${departmentId},'outcome-field',2,'2031-11-02T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES(${`invitation-${key}`},${applicationOf(key)},${`applicant-${key}`},${digest(`token-${key}`)},'2032-01-01T00:00:00Z','Claimed','coordinator','2031-11-03T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES(${`applicant-${key}`},${key},'2031-11-04T00:00:00Z',${`invitation-${key}`})`;
      yield* sql`INSERT INTO organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${key},${departmentId},'Active',1)`;

      if (applicant.recommendation !== "Returning") {
        yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES(${`interview-${key}`},${applicationOf(key)},${departmentId},'recruiter','outcome-schema','recruiter','2031-11-05T00:00:00Z',1)`;
        yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES(${`interview-${key}`},'[]'::jsonb,7,8,9,'recruiter','2031-11-06T00:00:00Z',2,${applicant.recommendation})`;
      } else {
        const previous = `placement-${digest(`${key}-previous`)}`;
        yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${previous},${key},${departmentId},'outcome-previous',${school!.schoolId},'Friday',4,'1',false,2)`;
        yield* sql`INSERT INTO admission_returning_registrations(registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at) VALUES(${`returning-registration-${digest(`${key}-1`)}`},${applicationOf(key)},${`applicant-${key}`},${key},${previous},${departmentId},${semesterId},'outcome-period',1,${`register-${key}-1`},2,false,false,false,false,false,4,'all','Norsk',NULL,false,'[]'::jsonb,'2031-11-11T00:00:00Z')`;
      }

      if (applicant.placement !== undefined) {
        yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${`placement-${digest(`${key}-current`)}`},${key},${departmentId},${semesterId},${school!.schoolId},${applicant.placement},4,'1',true,1)`;
      }
    }
  }),
);

/** Every session cookie names its person. */
const sessionActor = (cookie: string | undefined) => {
  const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

  return person === undefined
    ? undefined
    : new IdentityActor({
        personId: PersonId.make(person),
        sessionId: `session-${person}`,
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      });
};

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookie: string | undefined) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
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

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: unknown;
}

/** Reads the body once; a body that is not JSON leaves `body` undefined and `text` to report it. */
const reply = (response: Response): Effect.Effect<Reply> =>
  Effect.promise(() => response.text()).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map(
          (body): Reply => ({ status: response.status, headers: response.headers, text, body }),
        ),
      ),
    ),
  );

const decodeBody = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: Reply) =>
  Schema.decodeUnknownEffect(schema)(value.body);

type Send = (path: string, person: string, init?: RequestInit) => Effect.Effect<Reply>;

const ProblemBody = Schema.Struct({ code: Schema.String });

const EtagBody = Schema.Struct({ etag: Schema.String });

const BoardBody = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.Array(Schema.Struct({ applicationId: Schema.String, etag: Schema.String })),
  ),
});

const PreviewBody = Schema.Struct({
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
});

/** The strict envelope in `payload_json`: exactly these keys, so an extra or missing one fails. */
const Envelope = Schema.Struct({
  deliveryId: Schema.String,
  recipient: Schema.String,
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
});

/** A typed problem: one of `statuses`, `application/problem+json`, and its code. */
const refusal = (answer: Reply, statuses: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    expect(statuses, `${answer.status} ${answer.text}`).toContain(answer.status);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");

    return (yield* decodeBody(ProblemBody, answer)).code;
  });

/** The domain refusals of spec 0027 are new canonical codes of the `admission-outcome.` family. */
const outcomeCode = /^admission-outcome\.[a-z-]+$/u;

const fixture = () => {
  const database = backendDatabase(seed);

  const http = makeBackendTestHttp(
    Effect.runSync(decodeBackendConfig(environment)),
    Layer.mergeAll(
      AdmissionsLive,
      OrganizationLive,
      Layer.succeed(IdentitySnapshot, identitySnapshot),
      Layer.succeed(Identity, identity),
    ).pipe(Layer.provideMerge(database.layer)),
    {
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      recordTrustedOriginRejection: () => Effect.void,
    },
  );

  const send = (path: string, person: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `better-auth.session_token=${person}`);

    if (init.method !== undefined && init.method !== "GET") headers.set("origin", origin);

    return http
      .fetch(new Request(`http://backend.test${path}`, { ...init, headers }))
      .pipe(Effect.flatMap(reply));
  };

  const post = (path: string, person: string, body: Schema.Json, headers: Record<string, string>) =>
    Effect.flatMap(jsonText(body), (text) =>
      send(path, person, {
        method: "POST",
        body: text,
        headers: { "content-type": "application/json", ...headers },
      }),
    );

  /** A protected command: strong If-Match and an Idempotency-Key. */
  const command = (
    method: "POST" | "PUT",
    path: string,
    person: string,
    body: Schema.Json,
    etag: string,
    key: string,
  ) =>
    Effect.flatMap(jsonText(body), (text) =>
      send(path, person, {
        method,
        body: text,
        headers: {
          "content-type": "application/json",
          "if-match": etag,
          "idempotency-key": key.padEnd(22, "0"),
        },
      }),
    );

  const outcomeRoute = (key: string, suffix: ":decide" | ":record") =>
    `/api/admission-outcomes/${applicationOf(key)}${suffix}`;

  /** The decider's own read of one entry. */
  const decisionEtag = (key: string) =>
    Effect.gen(function* () {
      const read = yield* send(`/api/admission-outcomes/${applicationOf(key)}`, "recruiter");
      expect(read.status, read.text).toBe(200);

      return (yield* decodeBody(EtagBody, read)).etag;
    });

  /** The coordinator's announce projection of the board names the entry and its current ETag. */
  const announceEtag = (key: string) =>
    Effect.gen(function* () {
      const board = yield* send(`/api/admission-outcomes?${scope}`, "coordinator");
      expect(board.status, board.text).toBe(200);

      const entry = (yield* decodeBody(BoardBody, board)).entries?.find(
        (candidate) => candidate.applicationId === applicationOf(key),
      );

      expect(entry, "the coordinator's announce projection lists the application").toBeDefined();

      return entry!.etag;
    });

  const announce = (person: string, key: string, etag: string, idempotencyKey: string) =>
    command(
      "POST",
      `/api/admission-outcomes/${applicationOf(key)}:announce`,
      person,
      {},
      etag,
      idempotencyKey,
    );

  const outcomes = (key: string) =>
    database
      .run(
        Database.use(
          (sql) =>
            sql<{
              readonly outcome: string;
            }>`SELECT outcome FROM admission_application_outcomes WHERE application_id = ${applicationOf(key)} ORDER BY revision`,
        ),
      )
      .pipe(Effect.map((rows) => rows.map((row) => row.outcome)));

  /** The mail envelopes queued for one application, read only by `application_id`. */
  const envelopes = (key: string) =>
    database
      .run(
        Database.use(
          (sql) =>
            sql<{
              readonly effectId: string;
              readonly applicationId: string;
              readonly payload: unknown;
            }>`SELECT effect_id AS "effectId", application_id AS "applicationId", payload_json AS "payload" FROM public.admission_outcome_outbox WHERE application_id = ${applicationOf(key)} ORDER BY effect_id`,
        ),
      )
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(Envelope)(row.payload, { onExcessProperty: "error" }).pipe(
              Effect.map((envelope) => {
                expect(row.applicationId).toBe(applicationOf(key));
                expect(envelope.deliveryId, "the delivery ID is the effect ID").toBe(row.effectId);

                return { effectId: row.effectId, envelope };
              }),
            ),
          ),
        ),
      );

  const soleEnvelope = (key: string) =>
    Effect.map(envelopes(key), (rows) => {
      expect(rows, `exactly one envelope for ${key}`).toHaveLength(1);

      return rows[0]!;
    });

  /** The table itself refuses a rewrite of a queued envelope; the success of the UPDATE is the failure. */
  const rewriteEnvelope = (key: string) =>
    Effect.flip(
      database.run(
        Database.use(
          (sql) =>
            sql`UPDATE public.admission_outcome_outbox SET payload_json = jsonb_set(payload_json, '{subject}', '"rewritten"'::jsonb) WHERE application_id = ${applicationOf(key)}`,
        ),
      ),
    );

  /** Makes the HTTP receipt of the next command fail at commit, as in the receipt transaction tests. */
  const rejectReceiptCommits = database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE OR REPLACE FUNCTION reject_native_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt commit rejected'; END $$`;
        yield* sql`CREATE CONSTRAINT TRIGGER reject_native_receipt_commit AFTER INSERT ON public.native_http_idempotency_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_native_receipt_commit()`;
      }),
    ),
  );

  const allowReceiptCommits = database.run(
    Database.use(
      (sql) =>
        sql`DROP TRIGGER reject_native_receipt_commit ON public.native_http_idempotency_receipts`,
    ),
  );

  return {
    send,
    post,
    command,
    outcomeRoute,
    decisionEtag,
    announceEtag,
    announce,
    outcomes,
    envelopes,
    soleEnvelope,
    rewriteEnvelope,
    rejectReceiptCommits,
    allowReceiptCommits,
  };
};

describe("admission outcomes are Admitted or Rejected over HTTP and PostgreSQL", () => {
  it.live("accepts no Substitute outcome on any command route", () =>
    Effect.gen(function* () {
      const { command, outcomeRoute, decisionEtag, outcomes } = fixture();

      for (const suffix of [":record", ":decide"] as const) {
        const etag = yield* decisionEtag("maybe");

        const answer = yield* command(
          "POST",
          outcomeRoute("maybe", suffix),
          "recruiter",
          { outcome: "Substitute" },
          etag,
          `substitute-${suffix.slice(1)}`,
        );

        expect(answer.status, `${suffix} ${answer.text}`).toBeGreaterThanOrEqual(400);
        expect(answer.status, `${suffix} ${answer.text}`).toBeLessThan(500);
        expect(answer.text).not.toContain('Substitute"');
        expect(yield* outcomes("maybe")).toEqual([]);
      }
    }),
  );

  it.live("answers a Substitute command on the decide route with 422 validation.failed", () =>
    Effect.gen(function* () {
      const { command, outcomeRoute, decisionEtag } = fixture();

      const answer = yield* command(
        "POST",
        outcomeRoute("maybe", ":decide"),
        "recruiter",
        { outcome: "Substitute" },
        yield* decisionEtag("maybe"),
        "substitute-validation",
      );

      expect(yield* refusal(answer, [422])).toBe("validation.failed");
    }),
  );

  it.live("lets no route override the Ja or Nei that the interview derived", () =>
    Effect.gen(function* () {
      const { command, outcomeRoute, decisionEtag, outcomes } = fixture();

      const overrides = [
        { key: "ja-free", outcome: "Rejected" },
        { key: "nei-free", outcome: "Admitted" },
      ] as const;

      for (const override of overrides) {
        for (const suffix of [":record", ":decide"] as const) {
          const answer = yield* command(
            "POST",
            outcomeRoute(override.key, suffix),
            "recruiter",
            { outcome: override.outcome },
            yield* decisionEtag(override.key),
            `override-${override.key}-${suffix.slice(1)}`,
          );

          expect(answer.status, `${override.key} ${suffix} ${answer.text}`).toBeGreaterThanOrEqual(
            400,
          );
          expect(answer.status, `${override.key} ${suffix} ${answer.text}`).toBeLessThan(500);
          expect(yield* outcomes(override.key)).toEqual([]);
        }
      }
    }),
  );

  it.live("shows department members neither an on-call list nor applicant contact data", () =>
    Effect.gen(function* () {
      const { send } = fixture();
      const board = yield* send(`/api/admission-outcomes?${scope}`, "member");

      expect([200, 403], board.text).toContain(board.status);
      expect(board.text).not.toContain("substitutes");
      expect(board.text).not.toContain("@example.invalid");
    }),
  );

  it.live(
    "denies a national board leader who holds no Rekruttering or coordinator delegation",
    () =>
      Effect.gen(function* () {
        const { send, command, outcomeRoute, decisionEtag, outcomes } = fixture();

        const decided = yield* command(
          "POST",
          outcomeRoute("maybe", ":decide"),
          "boardleader",
          { outcome: "Admitted" },
          yield* decisionEtag("maybe"),
          "decide-board-leader",
        );

        expect(yield* refusal(decided, [403])).toBe("authority.denied");
        expect(yield* outcomes("maybe")).toEqual([]);

        const board = yield* send(`/api/admission-outcomes?${scope}`, "boardleader");

        expect(yield* refusal(board, [403])).toBe("authority.denied");
      }),
  );
});

const departmentName = "Trondheim";

const schoolName = "Alpha skole";

/** The subject that `draftFor` produces once its placeholders are filled with the seeded values. */
const customSubject = `Opptaksresultat - ${departmentName}, ${semesterId}: Egendefinert`;

type Variant = "AdmittedWithSchool" | "AdmittedPlacementPending" | "Rejected";

/** The exact approved subject of the default copy of spec 0027 (an en dash, not a hyphen). */
const defaultSubject = (variant: Variant) =>
  `Opptaksresultat – ${departmentName}, ${semesterId}: ${variant === "Rejected" ? "Avslag" : "Tatt opp"}`;

/** The approved default copy rendered for one seeded applicant, in subject, text and HTML. */
const expectDefaultEnvelope = (envelope: typeof Envelope.Type, key: string, variant: Variant) => {
  const { firstName } = applicants.find((candidate) => candidate.key === key)!;
  const rejected = variant === "Rejected";

  expect(envelope.recipient, "the submitted application's email").toBe(emailOf(key));
  expect(envelope.subject).toBe(defaultSubject(variant));

  const lines = [
    `Hei ${firstName},`,
    rejected
      ? `Utfall: Avslag. Du fikk dessverre ikke plass i Vektorprogrammet i ${departmentName} for ${semesterId}.`
      : `Utfall: Tatt opp. Du er tatt opp som assistent i Vektorprogrammet i ${departmentName} for ${semesterId}.`,
    ...(variant === "AdmittedWithSchool" ? [`Skole: ${schoolName}.`] : []),
    ...(variant === "AdmittedPlacementPending" ? ["Skoleplassering kommer."] : []),
    "Vennlig hilsen",
    "Vektorprogrammet",
  ];

  for (const line of lines) expect(envelope.text).toContain(line);

  expect(envelope.html).toContain("<html");

  for (const fragment of [firstName, departmentName, semesterId, rejected ? "Avslag" : "Tatt opp"])
    expect(envelope.html).toContain(fragment);

  if (variant === "AdmittedWithSchool") expect(envelope.html).toContain(schoolName);

  if (variant === "AdmittedPlacementPending") expect(envelope.html).toContain("Skoleplassering");

  if (variant !== "AdmittedWithSchool") {
    expect(envelope.text).not.toContain(schoolName);
    expect(envelope.html).not.toContain(schoolName);
  }

  if (rejected) expect(envelope.text).not.toContain("Skole");

  for (const field of [envelope.subject, envelope.text, envelope.html])
    expect(field).not.toMatch(/\{(firstName|departmentName|semesterName|schoolName)\}/u);
};

describe("announcing an outcome over HTTP and PostgreSQL", () => {
  it.live("reaches the protected announce endpoint and answers a stale If-Match with 412", () =>
    Effect.gen(function* () {
      const { announce, outcomes, envelopes } = fixture();
      const answer = yield* announce("coordinator", "ja-free", staleEtag, "announce-stale");

      expect(yield* refusal(answer, [412])).toBe("precondition.failed");
      expect(yield* outcomes("ja-free")).toEqual([]);
      expect(yield* envelopes("ja-free")).toEqual([]);
    }),
  );

  for (const person of ["recruiter", "member", "outsider", "boardmember", "boardleader"]) {
    it.live(`denies the announcement to ${person}, who is not the department coordinator`, () =>
      Effect.gen(function* () {
        const { announce, envelopes } = fixture();
        const answer = yield* announce(person, "ja-free", staleEtag, `announce-denied-${person}`);

        expect(yield* refusal(answer, [403])).toBe("authority.denied");
        expect(yield* envelopes("ja-free")).toEqual([]);
      }),
    );
  }

  it.live("announces Ja without a placement as Admitted, once, with one immutable envelope", () =>
    Effect.gen(function* () {
      const { announce, announceEtag, soleEnvelope, envelopes, rewriteEnvelope } = fixture();
      const etag = yield* announceEtag("ja-free");
      const first = yield* announce("coordinator", "ja-free", etag, "announce-ja-free");

      expect(first.status, first.text).toBe(200);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      expect(first.headers.get("etag")).toMatch(strongEtag);
      expect(first.text).toContain('"outcome":"Admitted"');
      expect(first.text).not.toContain("Substitute");

      // The announcement queued exactly one envelope: the placement-pending variant of the copy.
      const queued = yield* soleEnvelope("ja-free");

      expectDefaultEnvelope(queued.envelope, "ja-free", "AdmittedPlacementPending");
      expect(queued.effectId).not.toBe("");

      // The exact replay answers the first answer and queues no second envelope.
      const replay = yield* announce("coordinator", "ja-free", etag, "announce-ja-free");

      expect(replay.status, replay.text).toBe(200);
      expect(replay.text).toBe(first.text);
      expect(yield* envelopes("ja-free")).toEqual([queued]);

      // The outcome is final: another announcement with the new ETag and a new key is refused and queues nothing.
      const second = yield* announce(
        "coordinator",
        "ja-free",
        yield* announceEtag("ja-free"),
        "announce-ja-free-again",
      );

      expect(yield* refusal(second, [409, 422])).toMatch(outcomeCode);
      expect(yield* envelopes("ja-free")).toEqual([queued]);

      // The queued bytes cannot be rewritten, not even directly in the table.
      expect(yield* rewriteEnvelope("ja-free")).toBeDefined();
      expect(yield* envelopes("ja-free")).toEqual([queued]);
    }),
  );

  it.live("announces Ja with a placement as Admitted and names the school", () =>
    Effect.gen(function* () {
      const { announce, announceEtag, soleEnvelope } = fixture();

      const answer = yield* announce(
        "coordinator",
        "ja-placed",
        yield* announceEtag("ja-placed"),
        "announce-ja-placed",
      );

      expect(answer.status, answer.text).toBe(200);
      expect(answer.text).toContain('"outcome":"Admitted"');

      expectDefaultEnvelope(
        (yield* soleEnvelope("ja-placed")).envelope,
        "ja-placed",
        "AdmittedWithSchool",
      );
    }),
  );

  it.live("announces Nei without a placement as Rejected with the rejection copy", () =>
    Effect.gen(function* () {
      const { announce, announceEtag, soleEnvelope } = fixture();

      const answer = yield* announce(
        "coordinator",
        "nei-free",
        yield* announceEtag("nei-free"),
        "announce-nei-free",
      );

      expect(answer.status, answer.text).toBe(200);
      expect(answer.text).toContain('"outcome":"Rejected"');

      expectDefaultEnvelope((yield* soleEnvelope("nei-free")).envelope, "nei-free", "Rejected");
    }),
  );

  it.live("refuses a Rejected outcome while the applicant has an active placement", () =>
    Effect.gen(function* () {
      const { announce, announceEtag, outcomes, envelopes } = fixture();

      const answer = yield* announce(
        "coordinator",
        "nei-placed",
        yield* announceEtag("nei-placed"),
        "announce-nei-placed",
      );

      expect(yield* refusal(answer, [409, 422])).toMatch(outcomeCode);
      expect(yield* outcomes("nei-placed")).toEqual([]);
      expect(yield* envelopes("nei-placed")).toEqual([]);
    }),
  );

  for (const undecided of ["maybe", "returning"]) {
    it.live(`refuses to announce ${undecided} before Rekruttering decided`, () =>
      Effect.gen(function* () {
        const { announce, announceEtag, outcomes, envelopes } = fixture();

        const answer = yield* announce(
          "coordinator",
          undecided,
          yield* announceEtag(undecided),
          `announce-undecided-${undecided}`,
        );

        expect(yield* refusal(answer, [409, 422])).toMatch(outcomeCode);
        expect(yield* outcomes(undecided)).toEqual([]);
        expect(yield* envelopes(undecided)).toEqual([]);
      }),
    );
  }

  const decisions = [
    { key: "maybe", outcome: "Admitted", variant: "AdmittedPlacementPending" },
    { key: "returning", outcome: "Rejected", variant: "Rejected" },
  ] as const;

  for (const decision of decisions) {
    it.live(
      `queues no mail when Rekruttering decides ${decision.key}, and one when the coordinator announces it`,
      () =>
        Effect.gen(function* () {
          const {
            command,
            outcomeRoute,
            decisionEtag,
            announce,
            announceEtag,
            envelopes,
            soleEnvelope,
          } = fixture();

          const decided = yield* command(
            "POST",
            outcomeRoute(decision.key, ":decide"),
            "recruiter",
            { outcome: decision.outcome },
            yield* decisionEtag(decision.key),
            `decide-${decision.key}`,
          );

          expect(decided.status, decided.text).toBe(200);
          expect(decided.text).toContain(`"outcome":"${decision.outcome}"`);

          // Deciding is not announcing: no envelope exists until the coordinator announces.
          expect(yield* envelopes(decision.key)).toEqual([]);

          const answer = yield* announce(
            "coordinator",
            decision.key,
            yield* announceEtag(decision.key),
            `announce-${decision.key}`,
          );

          expect(answer.status, answer.text).toBe(200);
          expect(answer.text).toContain(`"outcome":"${decision.outcome}"`);

          expectDefaultEnvelope(
            (yield* soleEnvelope(decision.key)).envelope,
            decision.key,
            decision.variant,
          );
        }),
    );
  }

  it.live("rolls the outcome and its envelope back together when the receipt cannot commit", () =>
    Effect.gen(function* () {
      const {
        announce,
        announceEtag,
        outcomes,
        envelopes,
        soleEnvelope,
        rejectReceiptCommits,
        allowReceiptCommits,
      } = fixture();

      const etag = yield* announceEtag("ja-free");

      yield* rejectReceiptCommits;

      const failed = yield* announce("coordinator", "ja-free", etag, "announce-rollback");

      expect(yield* refusal(failed, [503])).toBe("idempotency.unavailable");
      expect(yield* outcomes("ja-free")).toEqual([]);
      expect(yield* envelopes("ja-free")).toEqual([]);

      // Nothing of the failed attempt survives: the same request now announces once.
      yield* allowReceiptCommits;

      const retried = yield* announce("coordinator", "ja-free", etag, "announce-rollback");

      expect(retried.status, retried.text).toBe(200);
      expectDefaultEnvelope(
        (yield* soleEnvelope("ja-free")).envelope,
        "ja-free",
        "AdmittedPlacementPending",
      );
    }),
  );
});

/** The proposed closed document: subject tokens and a versioned ProseMirror-compatible body. */
const text = (value: string) => ({ type: "text", text: value });

const placeholder = (name: string) => ({ type: "placeholder", attrs: { name } });

const paragraph = (...content: ReadonlyArray<Schema.Json>) => ({ type: "paragraph", content });

type Draft = {
  readonly subject: ReadonlyArray<Schema.Json>;
  readonly body: Schema.Json;
};

const draftFor = (
  variant: "AdmittedWithSchool" | "AdmittedPlacementPending" | "Rejected",
  extra: ReadonlyArray<Schema.Json> = [],
): Draft => ({
  subject: [
    text("Opptaksresultat - "),
    placeholder("departmentName"),
    text(", "),
    placeholder("semesterName"),
    text(": Egendefinert"),
  ],
  body: {
    version: 1,
    type: "doc",
    content: [
      paragraph(text("Hei "), placeholder("firstName"), text(",")),
      paragraph(
        text("Egendefinert tekst for "),
        placeholder("departmentName"),
        text(" "),
        placeholder("semesterName"),
        text("."),
      ),
      ...(variant === "AdmittedWithSchool"
        ? [paragraph(text("Skole: "), placeholder("schoolName"), text("."))]
        : []),
      ...extra,
    ],
  },
});

const unsafeDrafts: ReadonlyArray<{
  readonly name: string;
  readonly kind?: Variant;
  readonly draft: Draft;
}> = [
  {
    name: "script node",
    draft: draftFor("Rejected", [{ type: "script", content: [text("alert(1)")] }]),
  },
  {
    name: "author html node",
    draft: draftFor("Rejected", [{ type: "html", attrs: { value: "<b>x</b>" } }]),
  },
  {
    name: "event handler attribute",
    draft: draftFor("Rejected", [
      { type: "paragraph", attrs: { onerror: "alert(1)" }, content: [text("x")] },
    ]),
  },
  {
    name: "javascript link",
    draft: draftFor("Rejected", [
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
      }),
    ]),
  },
  {
    name: "arbitrary css mark",
    draft: draftFor("Rejected", [
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "textStyle", attrs: { style: "color:red" } }],
      }),
    ]),
  },
  {
    name: "image node",
    draft: draftFor("Rejected", [
      { type: "image", attrs: { src: "https://example.invalid/x.png" } },
    ]),
  },
  {
    name: "mdx jsx component",
    draft: draftFor("Rejected", [{ type: "mdxJsxFlowElement", name: "Component" }]),
  },
  {
    name: "mdx esm import",
    draft: draftFor("Rejected", [{ type: "mdxjsEsm", value: "import x from 'y'" }]),
  },
  {
    name: "placeholder of another variant",
    draft: draftFor("Rejected", [paragraph(placeholder("schoolName"))]),
  },
  {
    name: "unknown placeholder",
    draft: draftFor("Rejected", [paragraph(placeholder("recipientEmail"))]),
  },
  {
    name: "missing required placeholders",
    draft: {
      subject: [text("Opptaksresultat: Avslag")],
      body: { version: 1, type: "doc", content: [paragraph(text("Hei"))] },
    },
  },
  {
    name: "school placeholder in the placement-pending variant",
    kind: "AdmittedPlacementPending",
    draft: draftFor("AdmittedPlacementPending", [paragraph(placeholder("schoolName"))]),
  },
  {
    name: "unknown mark",
    draft: draftFor("Rejected", [
      paragraph({ type: "text", text: "x", marks: [{ type: "blink" }] }),
    ]),
  },
  {
    name: "unknown attribute on a known mark",
    draft: draftFor("Rejected", [
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "bold", attrs: { style: "color:red" } }],
      }),
    ]),
  },
  {
    name: "event handler attribute on a link",
    draft: draftFor("Rejected", [
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: "https://example.invalid/", onclick: "alert(1)" } }],
      }),
    ]),
  },
  {
    name: "data link",
    draft: draftFor("Rejected", [
      paragraph({
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: "data:text/html,<script>alert(1)</script>" } }],
      }),
    ]),
  },
  {
    name: "unknown attribute on a placeholder",
    draft: draftFor("Rejected", [
      paragraph({ type: "placeholder", attrs: { name: "firstName", onmouseover: "alert(1)" } }),
    ]),
  },
];

const templates = "/api/admission-outcomes/templates";

const sample = {
  firstName: markupName,
  departmentName: "Trondheim",
  semesterName: "Var 2032",
};

describe("outcome mail templates over HTTP and PostgreSQL", () => {
  const globalEtag = (send: Send) =>
    Effect.gen(function* () {
      const read = yield* send(templates, "admin");
      expect(read.status, read.text).toBe(200);

      const etag = read.headers.get("etag");
      expect(etag).toMatch(strongEtag);

      return { read, etag: etag! };
    });

  it.live("reads the three global default variants with the approved copy", () =>
    Effect.gen(function* () {
      const { send } = fixture();
      const { read } = yield* globalEtag(send);

      expect(read.headers.get("cache-control")).toBe("private, no-store");

      for (const kind of ["AdmittedWithSchool", "AdmittedPlacementPending", "Rejected"])
        expect(read.text).toContain(kind);

      expect(read.text).toContain("Opptaksresultat");
      expect(read.text).toContain("Avslag");
      expect(read.text).not.toContain("@example.invalid");
    }),
  );

  it.live("denies a member the department templates", () =>
    Effect.gen(function* () {
      const { send } = fixture();
      const read = yield* send(`${templates}?departmentId=${departmentId}`, "member");

      expect(yield* refusal(read, [403])).toBe("authority.denied");
    }),
  );

  it.live("previews with the server renderer, escapes values, and writes nothing", () =>
    Effect.gen(function* () {
      const { send, post } = fixture();
      const { etag } = yield* globalEtag(send);

      const preview = yield* post(
        `${templates}/Rejected:preview`,
        "admin",
        { ...draftFor("Rejected"), sample },
        {},
      );

      expect(preview.status, preview.text).toBe(200);
      expect(preview.headers.get("cache-control")).toBe("private, no-store");

      const rendered = yield* decodeBody(PreviewBody, preview);

      expect(rendered.subject).toContain("Trondheim");
      expect(rendered.html).toContain("&lt;img");
      expect(rendered.html).not.toContain("<img");
      expect(rendered.html).toContain("Egendefinert tekst");
      expect(rendered.text).toContain("Egendefinert tekst");

      expect((yield* globalEtag(send)).etag).toBe(etag);
    }),
  );

  it.live("refuses unsafe or unbalanced drafts on preview and save before any write", () =>
    Effect.gen(function* () {
      const { send, post, command } = fixture();
      const { etag } = yield* globalEtag(send);

      const department = yield* send(`${templates}?departmentId=${departmentId}`, "coordinator");

      expect(department.status, department.text).toBe(200);

      const departmentEtag = department.headers.get("etag");

      expect(departmentEtag).toMatch(strongEtag);

      for (const [index, { name, kind = "Rejected", draft }] of unsafeDrafts.entries()) {
        const preview = yield* post(
          `${templates}/${kind}:preview`,
          "admin",
          { ...draft, sample },
          {},
        );

        expect(preview.status, `preview ${name} ${preview.text}`).toBe(422);
        expect(preview.headers.get("content-type")).toBe("application/problem+json");

        const save = yield* command(
          "PUT",
          `${templates}/${kind}`,
          "admin",
          draft,
          etag,
          `template-unsafe-${index}`,
        );

        expect(save.status, `save ${name} ${save.text}`).toBe(422);
        expect(save.headers.get("content-type")).toBe("application/problem+json");

        // The delegated coordinator's department override is validated by the same Schema.
        const departmentSave = yield* command(
          "PUT",
          `${templates}/${kind}?departmentId=${departmentId}`,
          "coordinator",
          draft,
          departmentEtag!,
          `template-unsafe-department-${index}`,
        );

        expect(departmentSave.status, `department save ${name} ${departmentSave.text}`).toBe(422);
        expect(departmentSave.headers.get("content-type")).toBe("application/problem+json");
      }

      const after = yield* globalEtag(send);

      expect(after.etag).toBe(etag);
      expect(after.read.text).not.toContain("alert(1)");

      const departmentAfter = yield* send(
        `${templates}?departmentId=${departmentId}`,
        "coordinator",
      );

      expect(departmentAfter.headers.get("etag")).toBe(departmentEtag);
      expect(departmentAfter.text).not.toContain("alert(1)");
    }),
  );

  it.live("keeps global defaults and department overrides with their editors", () =>
    Effect.gen(function* () {
      const { send, command } = fixture();
      const { etag } = yield* globalEtag(send);

      const attempts = [
        { person: "coordinator", path: `${templates}/Rejected` },
        { person: "boardmember", path: `${templates}/Rejected` },
        { person: "boardleader", path: `${templates}/Rejected` },
        { person: "boardmember", path: `${templates}/Rejected?departmentId=${departmentId}` },
        { person: "boardleader", path: `${templates}/Rejected?departmentId=${departmentId}` },
        { person: "member", path: `${templates}/Rejected?departmentId=${departmentId}` },
        { person: "outsider", path: `${templates}/Rejected?departmentId=${departmentId}` },
        { person: "recruiter", path: `${templates}/Rejected?departmentId=${departmentId}` },
      ];

      for (const attempt of attempts) {
        const save = yield* command(
          "PUT",
          attempt.path,
          attempt.person,
          draftFor("Rejected"),
          etag,
          `template-denied-${attempt.person}`,
        );

        expect(yield* refusal(save, [403]), attempt.person).toBe("authority.denied");
      }

      expect((yield* globalEtag(send)).etag).toBe(etag);
    }),
  );

  it.live("saves one auditable revision, replays it exactly, and refuses a stale If-Match", () =>
    Effect.gen(function* () {
      const { send, command } = fixture();
      const { etag } = yield* globalEtag(send);

      const save = () =>
        command(
          "PUT",
          `${templates}/Rejected`,
          "admin",
          draftFor("Rejected"),
          etag,
          "template-save",
        );

      const saved = yield* save();

      expect(saved.status, saved.text).toBe(200);
      expect(saved.headers.get("etag")).toMatch(strongEtag);
      expect(saved.headers.get("etag")).not.toBe(etag);

      const replay = yield* save();

      expect(replay.status, replay.text).toBe(200);
      expect(replay.text).toBe(saved.text);

      const after = yield* globalEtag(send);

      expect(after.etag).toBe(saved.headers.get("etag"));
      expect(after.read.text).toContain("Egendefinert");

      const stale = yield* command(
        "PUT",
        `${templates}/Rejected`,
        "admin",
        draftFor("Rejected"),
        etag,
        "template-save-stale",
      );

      expect(yield* refusal(stale, [412])).toBe("precondition.failed");
    }),
  );

  it.live("lets only the department's delegated coordinator save its override", () =>
    Effect.gen(function* () {
      const { send, command } = fixture();
      const globalBefore = yield* globalEtag(send);
      const department = `${templates}?departmentId=${departmentId}`;

      const read = yield* send(department, "coordinator");

      expect(read.status, read.text).toBe(200);

      const etag = read.headers.get("etag");

      expect(etag).toMatch(strongEtag);

      // A coordinator delegated for another department, a plain national board seat, a member and
      // Rekruttering hold no authority here, even with the current ETag of the department.
      for (const person of ["outsider", "boardmember", "boardleader", "member", "recruiter"]) {
        const denied = yield* command(
          "PUT",
          `${templates}/Rejected?departmentId=${departmentId}`,
          person,
          draftFor("Rejected"),
          etag!,
          `department-template-denied-${person}`,
        );

        expect(yield* refusal(denied, [403]), person).toBe("authority.denied");
      }

      for (const person of ["outsider", "boardmember", "boardleader"]) {
        expect(yield* refusal(yield* send(department, person), [403]), person).toBe(
          "authority.denied",
        );
      }

      expect((yield* send(department, "coordinator")).headers.get("etag")).toBe(etag);

      const saved = yield* command(
        "PUT",
        `${templates}/Rejected?departmentId=${departmentId}`,
        "coordinator",
        draftFor("Rejected"),
        etag!,
        "department-template-save",
      );

      expect(saved.status, saved.text).toBe(200);
      expect(saved.headers.get("etag")).toMatch(strongEtag);
      expect(saved.headers.get("etag")).not.toBe(etag);

      // The override is the department's own: the global default and its ETag stay as they were.
      expect((yield* globalEtag(send)).etag).toBe(globalBefore.etag);
    }),
  );

  it.live("announces with the department override and leaves the global default as it was", () =>
    Effect.gen(function* () {
      const { send, command, announce, announceEtag, soleEnvelope } = fixture();
      const globalBefore = yield* globalEtag(send);

      const read = yield* send(`${templates}?departmentId=${departmentId}`, "coordinator");

      expect(read.status, read.text).toBe(200);

      const saved = yield* command(
        "PUT",
        `${templates}/Rejected?departmentId=${departmentId}`,
        "coordinator",
        draftFor("Rejected"),
        read.headers.get("etag")!,
        "department-override-for-announce",
      );

      expect(saved.status, saved.text).toBe(200);

      const answer = yield* announce(
        "coordinator",
        "nei-free",
        yield* announceEtag("nei-free"),
        "announce-with-override",
      );

      expect(answer.status, answer.text).toBe(200);

      const { envelope } = yield* soleEnvelope("nei-free");

      expect(envelope.subject).toBe(customSubject);
      expect(envelope.text).toContain(`Egendefinert tekst for ${departmentName} ${semesterId}.`);
      expect(envelope.recipient).toBe(emailOf("nei-free"));
      expect((yield* globalEtag(send)).etag).toBe(globalBefore.etag);
    }),
  );

  it.live("keeps a queued envelope byte-identical when its template is edited afterwards", () =>
    Effect.gen(function* () {
      const { send, post, command, announce, announceEtag, envelopes, soleEnvelope } = fixture();
      const { etag } = yield* globalEtag(send);
      const neiEtag = yield* announceEtag("nei-free");
      const first = yield* announce("coordinator", "nei-free", neiEtag, "announce-before-edit");

      expect(first.status, first.text).toBe(200);

      const queued = yield* soleEnvelope("nei-free");

      expectDefaultEnvelope(queued.envelope, "nei-free", "Rejected");

      const saved = yield* command(
        "PUT",
        `${templates}/Rejected`,
        "admin",
        draftFor("Rejected"),
        etag,
        "template-edit-after-announce",
      );

      expect(saved.status, saved.text).toBe(200);

      // The earlier envelope and an exact replay of its announcement keep the old bytes.
      expect(yield* envelopes("nei-free")).toEqual([queued]);

      const replay = yield* announce("coordinator", "nei-free", neiEtag, "announce-before-edit");

      expect(replay.status, replay.text).toBe(200);
      expect(replay.text).toBe(first.text);
      expect(yield* envelopes("nei-free")).toEqual([queued]);

      // A later announcement renders the saved revision, and its markup-bearing first name is text.
      const synthetic = { firstName: markupName, departmentName, semesterName: semesterId };

      const preview = yield* post(
        `${templates}/Rejected:preview`,
        "admin",
        { ...draftFor("Rejected"), sample: synthetic },
        {},
      );

      expect(preview.status, preview.text).toBe(200);

      const rendered = yield* decodeBody(PreviewBody, preview);

      const later = yield* announce(
        "coordinator",
        "markup-nei",
        yield* announceEtag("markup-nei"),
        "announce-after-edit",
      );

      expect(later.status, later.text).toBe(200);

      const { envelope } = yield* soleEnvelope("markup-nei");

      expect(envelope.recipient).toBe(emailOf("markup-nei"));
      expect(envelope.subject).toBe(customSubject);
      expect(envelope.html).toContain("&lt;img");
      expect(envelope.html).not.toContain("<img");

      // The preview returned exactly the bytes that were queued.
      expect(envelope.subject).toBe(rendered.subject);
      expect(envelope.html).toBe(rendered.html);
      expect(envelope.text).toBe(rendered.text);

      expect(yield* envelopes("nei-free")).toEqual([queued]);
    }),
  );

  it.live("sends exactly the bytes that the preview of each saved variant returned", () =>
    Effect.gen(function* () {
      const { send, post, command, announce, announceEtag, soleEnvelope } = fixture();
      let etag = (yield* globalEtag(send)).etag;

      const variants = [
        {
          key: "ja-placed",
          variant: "AdmittedWithSchool",
          sample: { firstName: "Jonas", departmentName, semesterName: semesterId, schoolName },
        },
        {
          key: "ja-free",
          variant: "AdmittedPlacementPending",
          sample: { firstName: "Jorunn", departmentName, semesterName: semesterId },
        },
        {
          key: "nei-free",
          variant: "Rejected",
          sample: { firstName: "Nina", departmentName, semesterName: semesterId },
        },
      ] as const;

      for (const { key, variant, sample: values } of variants) {
        const draft = draftFor(variant);

        const saved = yield* command(
          "PUT",
          `${templates}/${variant}`,
          "admin",
          draft,
          etag,
          `template-parity-${variant}`,
        );

        expect(saved.status, `${variant} ${saved.text}`).toBe(200);
        etag = saved.headers.get("etag")!;

        const preview = yield* post(
          `${templates}/${variant}:preview`,
          "admin",
          { ...draft, sample: values },
          {},
        );

        expect(preview.status, `${variant} ${preview.text}`).toBe(200);

        const rendered = yield* decodeBody(PreviewBody, preview);

        const sent = yield* announce(
          "coordinator",
          key,
          yield* announceEtag(key),
          `announce-parity-${variant}`,
        );

        expect(sent.status, `${variant} ${sent.text}`).toBe(200);

        const { envelope } = yield* soleEnvelope(key);

        expect(envelope.subject, variant).toBe(rendered.subject);
        expect(envelope.html, variant).toBe(rendered.html);
        expect(envelope.text, variant).toBe(rendered.text);
        expect(envelope.subject, variant).toBe(customSubject);
      }
    }),
  );
});
