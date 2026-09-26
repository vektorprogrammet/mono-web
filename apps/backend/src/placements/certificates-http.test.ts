/**
 * Days served and certificates over HTTP on PostgreSQL (docs/specs/certificates-days-served.md):
 * the confirmation precondition, denial of everyone but the department's issuers, the replay of
 * one issue key, authority checked before a replay, a commit failure recovered in the same
 * request, and text that the certificate font cannot print.
 */
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  CertificatePreviewResource,
  CertificateScopes,
  CertificatesConfirmProblem,
  CertificatesIssueProblem,
  CertificatesReadProblem,
  DaysServedEntryResource,
  DaysServedListResponse,
} from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { makeCertificatesTestHttp } from "../test/native-http.js";

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

const department = "cert-http-trondheim";

const spring = "cert-http-spring";

const person = {
  leader: "cert-http-leader",
  coordinator: "cert-http-coordinator",
  outsider: "cert-http-outsider",
  ada: "cert-http-ada",
  unprintable: "cert-http-li",
} as const;

/**
 * One independent department with a Styret leader, a Skolekoordinering member who confirms days
 * served by delegation, and a team member without either capability. Ada and Wei have accepted
 * legacy totals from the spring at Lade; Wei's family name is written in a script that the
 * certificate font does not cover.
 */
const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
      (${person.leader},'Siri','Styreleder'), (${person.coordinator},'Kari','Koordinator'),
      (${person.outsider},'Ola','Utenfor'), (${person.ada},'Ada','Assistent'),
      (${person.unprintable},'Wei','李')`;
    yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
      SELECT person_id, first_name, person_id || '@example.invalid', true
      FROM person_profiles WHERE person_id LIKE 'cert-http-%'`;
    yield* sql`INSERT INTO organization_departments
      (department_id,name,short_name,email,city,independent) VALUES
      (${department},'Trondheim','TRD','trd@example.invalid','Trondheim',true)`;
    yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind,team_scope) VALUES
      ('cert-http-styret',${department},'Styret','DepartmentBoard','HomeDepartment'),
      ('cert-http-skolekoordinering',${department},'Skolekoordinering','Team','HomeDepartment'),
      ('cert-http-it',${department},'IT','Team','HomeDepartment')`;
    yield* sql`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,position_name,start_at,is_team_leader) VALUES
      ('cert-http-m-leader',${person.leader},'cert-http-styret','Styreleder','2020-01-01',true),
      ('cert-http-m-coordinator',${person.coordinator},'cert-http-skolekoordinering',NULL,'2020-01-01',false),
      ('cert-http-m-outsider',${person.outsider},'cert-http-it',NULL,'2020-01-01',false)`;
    yield* sql`INSERT INTO organization_delegations
      (delegation_id,name,team_id,capability,area,area_department_id,holders,start_at) VALUES
      (${`delegation-${"e".repeat(64)}`},'Dager tjenestegjort','cert-http-skolekoordinering',
        'placements.days-served','Department',${department},'AllMembers','2020-01-01T00:00:00Z')`;
    yield* sql`INSERT INTO admission_period_semesters (semester_id,start_at,end_at) VALUES
      (${spring},'2026-01-01T00:00:00Z','2026-08-01T00:00:00Z')`;
    yield* sql`INSERT INTO schools_directory_schools
      (school_id,name,contact_person,email,phone,language,active) OVERRIDING SYSTEM VALUE VALUES
      (9201,'Lade skole','Kontakt','lade@example.invalid','12345678','Norwegian',true)`;
    yield* sql`INSERT INTO schools_directory_departments (school_id,department_id) VALUES
      (9201,${department})`;

    const people = "b1".padStart(64, "0");
    const service = "b2".padStart(64, "0");

    yield* sql`INSERT INTO person_cohort_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${people},'cert-http-synthetic','cert-http-people','test','test',${people},2)`;
    yield* sql`INSERT INTO person_cohort_occurrences (snapshot_key,occurrence_id,disposition,reason) VALUES
      (${people},'cert-http-person-ada','Accepted','LinkedExistingPerson'),
      (${people},'cert-http-person-li','Accepted','LinkedExistingPerson')`;
    yield* sql`INSERT INTO person_cohort_imports
      (source_repository,source_user_id,person_id,mapping_action,source_digest,evidence_ref,snapshot_key,occurrence_id) VALUES
      ('cert-http-synthetic','cert-http-source-ada',${person.ada},'LinkExistingPerson',${people},'synthetic',${people},'cert-http-person-ada'),
      ('cert-http-synthetic','cert-http-source-li',${person.unprintable},'LinkExistingPerson',${people},'synthetic',${people},'cert-http-person-li')`;
    yield* sql`INSERT INTO historical_service_snapshots
      (snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count)
      VALUES (${service},'cert-http-synthetic','cert-http-service','test','test',${service},2)`;
    yield* sql`INSERT INTO historical_service_occurrences (snapshot_key,occurrence_id,disposition,reason) VALUES
      (${service},'cert-http-ada-spring','Accepted','Imported'),
      (${service},'cert-http-li-spring','Accepted','Imported')`;
    yield* sql`INSERT INTO assistant_service_history
      (source_repository,source_history_id,source_user_id,person_id,department_id,semester_id,school_id,day,workdays,block,source_digest,evidence_ref,snapshot_key,occurrence_id) VALUES
      ('cert-http-synthetic','cert-http-ada-spring','cert-http-source-ada',${person.ada},${department},${spring},9201,'Monday',6,'1',${service},'synthetic',${service},'cert-http-ada-spring'),
      ('cert-http-synthetic','cert-http-li-spring','cert-http-source-li',${person.unprintable},${department},${spring},9201,'Friday',3,'1',${service},'synthetic',${service},'cert-http-li-spring')`;
  }),
);

type TestRequest = (
  pathname: string,
  init?: RequestInit & { readonly person?: string },
) => Effect.Effect<Response>;

/** Each fixture is one backend process with its own database. */
const fixture = () => {
  const database = backendDatabase(seed);

  const http = makeCertificatesTestHttp(
    Layer.mergeAll(
      database.layer,
      PlacementsLive.pipe(Layer.provide(database.layer)),
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

  const count = (table: string, personId: string) =>
    database.run(
      Database.use((sql) =>
        sql.unsafe<{ readonly count: number }>(
          `SELECT count(*)::integer AS count FROM ${table} WHERE person_id = $1`,
          [personId],
        ),
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    );

  return { database, request, count };
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

const bytes = (response: Response) =>
  Effect.promise(() => response.arrayBuffer()).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const daysServedPath = `/api/departments/${department}/semesters/${spring}/days-served`;

const certificatePath = (personId: string) =>
  `/api/departments/${department}/certificates/${personId}`;

const confirm = (
  request: TestRequest,
  input: { readonly personId: string; readonly ifMatch: string; readonly key: string },
  total: number,
) =>
  request(`${daysServedPath}/${input.personId}`, {
    method: "POST",
    person: person.leader,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key(input.key),
      "if-match": input.ifMatch,
    },
    body: JSON.stringify({ total }),
  });

const issue = (
  request: TestRequest,
  input: {
    readonly issuer: string;
    readonly personId: string;
    readonly ifMatch: string;
    readonly key: string;
  },
) =>
  request(`${certificatePath(input.personId)}/issues`, {
    method: "POST",
    person: input.issuer,
    headers: { "idempotency-key": key(input.key), "if-match": input.ifMatch },
  });

/** The leader reads the assistant's entry and confirms the calculated count. */
const confirmCalculated = (request: TestRequest, personId: string) =>
  Effect.gen(function* () {
    const list = yield* decoded(
      yield* request(daysServedPath, { person: person.leader }),
      DaysServedListResponse,
    );

    const entry = list.items.find((item) => item.personId === personId);

    expect(entry).toBeDefined();

    const confirmed = yield* confirm(
      request,
      { personId, ifMatch: entry?.etag ?? "", key: "calculated" },
      entry?.calculated ?? 0,
    );

    expect(confirmed.status).toBe(200);
  });

/** The certificate as the leader previews it, with the tag that an issue repeats. */
const preview = (request: TestRequest, personId: string) =>
  Effect.gen(function* () {
    const response = yield* request(certificatePath(personId), { person: person.leader });

    expect(response.status).toBe(200);

    return yield* decoded(response, CertificatePreviewResource);
  });

describe("certificate scopes over HTTP", () => {
  it.live("grants the scope read to either capability and denies everyone else", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();
      const leader = yield* request("/api/certificate-scopes", { person: person.leader });

      const coordinator = yield* request("/api/certificate-scopes", {
        person: person.coordinator,
      });

      const outsider = yield* request("/api/certificate-scopes", { person: person.outsider });

      expect(leader.status).toBe(200);
      expect((yield* decoded(leader, CertificateScopes)).departments).toEqual([
        {
          departmentId: department,
          name: "Trondheim",
          confirmDaysServed: true,
          issueCertificates: true,
        },
      ]);
      expect(coordinator.status).toBe(200);
      expect((yield* decoded(coordinator, CertificateScopes)).departments).toEqual([
        {
          departmentId: department,
          name: "Trondheim",
          confirmDaysServed: true,
          issueCertificates: false,
        },
      ]);
      expect(outsider.status).toBe(403);
      expect((yield* decoded(outsider, CertificatesReadProblem)).code).toBe("authority.denied");

      // The delegated capability confirms days served and issues nothing.
      expect((yield* request(daysServedPath, { person: person.coordinator })).status).toBe(200);

      yield* confirmCalculated(request, person.ada);

      const { etag } = yield* preview(request, person.ada);

      const denied = yield* issue(request, {
        issuer: person.coordinator,
        personId: person.ada,
        ifMatch: etag,
        key: "coordinator",
      });

      expect(denied.status).toBe(403);
      expect(yield* count("certificate_issues", person.ada)).toBe(0);
    }),
  );
});

describe("days served over HTTP", () => {
  it.live("confirms at the observed tag, refuses a stale one, and reads back the result", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();

      const before = yield* decoded(
        yield* request(daysServedPath, { person: person.leader }),
        DaysServedListResponse,
      );

      const ada = before.items.find((item) => item.personId === person.ada);

      expect(ada).toMatchObject({ calculated: 6, revision: 0, confirmation: null });

      const observed = ada?.etag ?? "";

      const confirmed = yield* confirm(
        request,
        { personId: person.ada, ifMatch: observed, key: "first" },
        6,
      );

      expect(confirmed.status).toBe(200);

      const entry = yield* decoded(confirmed, DaysServedEntryResource);

      expect(entry).toMatchObject({
        revision: 1,
        confirmation: { revision: 1, total: 6, calculated: 6, confirmedBy: person.leader },
      });
      expect(confirmed.headers.get("etag")).toBe(entry.etag);
      expect(entry.etag).not.toBe(observed);

      // The tag of the first read is stale now: the adjustment writes nothing.
      const stale = yield* confirm(
        request,
        { personId: person.ada, ifMatch: observed, key: "stale" },
        4,
      );

      expect(stale.status).toBe(412);
      expect((yield* decoded(stale, CertificatesConfirmProblem)).code).toBe("precondition.failed");
      expect(yield* count("days_served_confirmations", person.ada)).toBe(1);

      const adjusted = yield* confirm(
        request,
        { personId: person.ada, ifMatch: entry.etag, key: "adjust" },
        4,
      );

      expect(adjusted.status).toBe(200);

      const after = yield* decoded(
        yield* request(daysServedPath, { person: person.leader }),
        DaysServedListResponse,
      );

      // The correction reads back as the next revision; the other assistant is unchanged.
      expect(after.items.map((item) => [item.personId, item.confirmation?.total ?? null])).toEqual([
        [person.ada, 4],
        [person.unprintable, null],
      ]);
      expect(yield* count("days_served_confirmations", person.ada)).toBe(2);
    }),
  );
});

describe("certificates over HTTP", () => {
  it.live("denies the outsider and the assistant, and records no issue", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();

      yield* confirmCalculated(request, person.ada);

      const { etag } = yield* preview(request, person.ada);

      const outsiderList = yield* request(`/api/departments/${department}/certificates`, {
        person: person.outsider,
      });

      expect(outsiderList.status).toBe(403);
      expect((yield* decoded(outsiderList, CertificatesReadProblem)).code).toBe("authority.denied");

      for (const [issuer, attempt] of [
        [person.outsider, "outsider"],
        [person.ada, "own"],
      ] as const) {
        const denied = yield* issue(request, {
          issuer,
          personId: person.ada,
          ifMatch: etag,
          key: attempt,
        });

        expect(denied.status).toBe(403);
        expect((yield* decoded(denied, CertificatesIssueProblem)).code).toBe("authority.denied");
      }

      // The assistant cannot read their own certificate either.
      const own = yield* request(certificatePath(person.ada), { person: person.ada });

      expect(own.status).toBe(403);
      expect((yield* decoded(own, CertificatesReadProblem)).code).toBe("authority.denied");
      expect(yield* count("certificate_issues", person.ada)).toBe(0);
    }),
  );

  it.live(
    "replays one issue key with the same bytes, records a new key, and checks authority first",
    () =>
      Effect.gen(function* () {
        const { database, request, count } = fixture();

        yield* confirmCalculated(request, person.ada);

        const certificate = yield* preview(request, person.ada);

        expect(certificate.content?.semesters.map((semester) => semester.days)).toEqual([6]);

        const first = yield* issue(request, {
          issuer: person.leader,
          personId: person.ada,
          ifMatch: certificate.etag,
          key: "issue",
        });

        expect(first.status).toBe(200);
        expect(first.headers.get("content-type")).toBe("application/pdf");
        expect(first.headers.get("etag")).toBe(certificate.etag);
        expect(first.headers.get("content-disposition")).toBeNull();

        const document = yield* bytes(first);

        expect(new TextDecoder().decode(document.subarray(0, 5))).toBe("%PDF-");

        const replay = yield* issue(request, {
          issuer: person.leader,
          personId: person.ada,
          ifMatch: certificate.etag,
          key: "issue",
        });

        expect(replay.status).toBe(200);
        expect(yield* bytes(replay)).toEqual(document);
        expect(yield* count("certificate_issues", person.ada)).toBe(1);

        const second = yield* issue(request, {
          issuer: person.leader,
          personId: person.ada,
          ifMatch: certificate.etag,
          key: "second",
        });

        expect(second.status).toBe(200);

        const hashes = yield* database.run(
          Database.use(
            (sql) => sql<{ readonly contentSha256: string }>`
              SELECT content_sha256 AS "contentSha256" FROM certificate_issues
              WHERE person_id = ${person.ada} ORDER BY issued_at, issue_id`,
          ),
        );

        // Two downloads of unchanged confirmed data: two records with one content hash.
        expect(hashes.map((row) => row.contentSha256)).toEqual([
          certificate.contentSha256,
          certificate.contentSha256,
        ]);

        // The seat ends: the stored response of the first key does not replay.
        yield* database.run(
          Database.use(
            (sql) => sql`UPDATE organization_memberships
              SET end_at = date_trunc('milliseconds', now(), 'UTC')
              WHERE membership_id = 'cert-http-m-leader'`,
          ),
        );

        const revoked = yield* issue(request, {
          issuer: person.leader,
          personId: person.ada,
          ifMatch: certificate.etag,
          key: "issue",
        });

        expect(revoked.status).toBe(403);
        expect((yield* decoded(revoked, CertificatesIssueProblem)).code).toBe("authority.denied");
        expect(yield* count("certificate_issues", person.ada)).toBe(2);
      }),
  );

  it.live("recovers a serialization failure at commit within the same request", () =>
    Effect.gen(function* () {
      const { database, request, count } = fixture();

      yield* confirmCalculated(request, person.ada);

      const certificate = yield* preview(request, person.ada);

      // The first commit that records an issue fails with SQLSTATE 40001. The sequence is not
      // rolled back with it, so the retried transaction commits.
      yield* database.run(
        Database.use((sql) =>
          Effect.gen(function* () {
            yield* sql`CREATE SEQUENCE certificate_issue_commit_attempts`;
            yield* sql`CREATE FUNCTION fail_first_certificate_issue_commit() RETURNS trigger
              LANGUAGE plpgsql AS $$
              BEGIN
                IF nextval('certificate_issue_commit_attempts') = 1 THEN
                  RAISE EXCEPTION 'first certificate issue commit fails' USING ERRCODE = '40001';
                END IF;
                RETURN NULL;
              END $$`;
            yield* sql`CREATE CONSTRAINT TRIGGER fail_first_certificate_issue_commit
              AFTER INSERT ON public.certificate_issues DEFERRABLE INITIALLY DEFERRED
              FOR EACH ROW EXECUTE FUNCTION fail_first_certificate_issue_commit()`;
          }),
        ),
      );

      const issued = yield* issue(request, {
        issuer: person.leader,
        personId: person.ada,
        ifMatch: certificate.etag,
        key: "commit-fault",
      });

      expect(issued.status).toBe(200);
      expect(new TextDecoder().decode((yield* bytes(issued)).subarray(0, 5))).toBe("%PDF-");

      const attempts = yield* database.run(
        Database.use(
          (sql) => sql<{ readonly attempts: number }>`
            SELECT last_value::integer AS attempts FROM certificate_issue_commit_attempts`,
        ),
      );

      expect(attempts).toEqual([{ attempts: 2 }]);
      expect(yield* count("certificate_issues", person.ada)).toBe(1);
    }),
  );

  it.live("refuses a name that no certificate glyph covers and records nothing", () =>
    Effect.gen(function* () {
      const { request, count } = fixture();

      yield* confirmCalculated(request, person.unprintable);

      const certificate = yield* preview(request, person.unprintable);

      const refused = yield* issue(request, {
        issuer: person.leader,
        personId: person.unprintable,
        ifMatch: certificate.etag,
        key: "unprintable",
      });

      expect(refused.status).toBe(422);
      expect((yield* decoded(refused, CertificatesIssueProblem)).code).toBe(
        "certificate.unprintable",
      );
      expect(yield* count("certificate_issues", person.unprintable)).toBe(0);
    }),
  );
});
