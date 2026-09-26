import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  PlacementBoardResource,
  PlacementDraftResource,
  PlacementProblem,
} from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
import { makeBackendTestHttp } from "../test/native-http.js";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "placement-draft-http-test-secret-32-chars",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
} as const;

const departmentId = "draft-department";

const semesterId = "draft-semester";

const scope = new URLSearchParams({ departmentId, semesterId }).toString();

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface Registration {
  readonly person: string;
  readonly revision: number;
  readonly unavailable: ReadonlyArray<"monday" | "tuesday" | "wednesday" | "thursday" | "friday">;
  readonly positionWeeks: 4 | 8;
  readonly preferredGroup: "all" | "block-1" | "block-2";
}

/**
 * Alpha has a capacity plan of one place per block on Monday, which bounds its demand of two;
 * its active placement fills Monday block 1. Beta has no plan, so demand alone bounds it.
 * Availability comes from returning registrations; the latest revision counts.
 */
const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${departmentId},'Trondheim','TRD','draft@example.invalid','Trondheim')`;
    yield* sql`INSERT INTO organization_teams(team_id,department_id,name) VALUES('draft-team',${departmentId},'Skolekoordinering')`;
    yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${departmentId},'Trondheim')`;
    yield* sql`INSERT INTO admission_period_semesters VALUES('draft-previous','2031-08-01T00:00:00Z','2031-12-31T00:00:00Z'),(${semesterId},'2032-01-01T00:00:00Z','2032-06-30T00:00:00Z')`;
    yield* sql`INSERT INTO admission_periods VALUES('draft-period',${departmentId},${semesterId},'2031-11-01T00:00:00Z','2031-12-01T00:00:00Z',0,'draft-seed')`;
    yield* sql`INSERT INTO admission_period_fields_of_study VALUES('draft-field',${departmentId},'Matematikk',true)`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('coordinator','Kari','Koordinator'),('berit','Berit','Assistent'),('carl','Carl','Assistent'),('dina','Dina','Assistent'),('erik','Erik','Assistent'),('pia','Pia','Assistent'),('petter','Petter','Assistent')`;
    yield* sql`INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,position_id,is_team_leader) VALUES('draft-leader','coordinator','draft-team','2020-01-01T00:00:00Z','leader',true)`;
    yield* sql`INSERT INTO organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES('berit',${departmentId},'Active',1),('carl',${departmentId},'Active',1),('dina',${departmentId},'Active',1),('erik',${departmentId},'Active',1),('pia',${departmentId},'Active',1),('petter',${departmentId},'Pending',1)`;

    const schools = yield* sql<{
      readonly schoolId: number;
    }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Alpha skole','Kontakt','alpha@example.invalid','12345678','Norwegian',true),('Beta skole','Kontakt','beta@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

    const [alpha, beta] = schools
      .map((school) => school.schoolId)
      .sort((left, right) => left - right);

    yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${alpha!},${departmentId}),(${beta!},${departmentId})`;
    yield* sql`INSERT INTO schools_capacity_plans(school_id,department_id,semester_id,monday,tuesday,wednesday,thursday,friday) VALUES(${alpha!},${departmentId},${semesterId},1,0,0,0,0)`;
    yield* sql`INSERT INTO school_service_demand(department_id,semester_id,school_id,day,block,required_volunteers,revision) VALUES(${departmentId},${semesterId},${alpha!},'Monday','1',2,1),(${departmentId},${semesterId},${alpha!},'Monday','2',2,1),(${departmentId},${semesterId},${alpha!},'Wednesday','1',1,1),(${departmentId},${semesterId},${beta!},'Tuesday','1',1,1),(${departmentId},${semesterId},${beta!},'Tuesday','2',1,1)`;
    yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${`placement-${digest("pia-current")}`},'pia',${departmentId},${semesterId},${alpha!},'Monday',4,'1',true,1)`;

    const registrations: ReadonlyArray<Registration> = [
      // Carl's first registration had Monday off; the later revision counts.
      {
        person: "carl",
        revision: 1,
        unavailable: ["monday", "tuesday"],
        positionWeeks: 4,
        preferredGroup: "all",
      },
      {
        person: "carl",
        revision: 2,
        unavailable: ["tuesday", "wednesday", "thursday"],
        positionWeeks: 4,
        preferredGroup: "all",
      },
      {
        person: "berit",
        revision: 1,
        unavailable: ["monday", "wednesday", "thursday", "friday"],
        positionWeeks: 4,
        preferredGroup: "block-2",
      },
      // Both blocks on Monday need one school with room in both; Alpha has one place left in block 2 only.
      {
        person: "dina",
        revision: 1,
        unavailable: ["tuesday", "wednesday", "thursday", "friday"],
        positionWeeks: 8,
        preferredGroup: "block-1",
      },
      { person: "petter", revision: 1, unavailable: [], positionWeeks: 4, preferredGroup: "all" },
    ];

    for (const person of ["carl", "berit", "dina", "petter"]) {
      yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES(${`applicant-${person}`},${`${person}@example.invalid`},${`${person}@example.invalid`},${person},'Assistent','12345678',0,'draft-field',2)`;
      yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${`application-${person}`},${`applicant-${person}`},'draft-period',${departmentId},'draft-field',2,'2031-11-02T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES(${`invitation-${person}`},${`application-${person}`},${`applicant-${person}`},${digest(`token-${person}`)},'2032-01-01T00:00:00Z','Claimed','coordinator','2031-11-03T00:00:00Z')`;
      yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES(${`applicant-${person}`},${person},'2031-11-04T00:00:00Z',${`invitation-${person}`})`;
      yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${`placement-${digest(`${person}-previous`)}`},${person},${departmentId},'draft-previous',${beta!},'Friday',4,'1',false,2)`;
    }

    for (const registration of registrations) {
      const unavailable = (day: Registration["unavailable"][number]) =>
        registration.unavailable.includes(day);

      yield* sql`INSERT INTO admission_returning_registrations(registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,team_ids,registered_at) VALUES(${`returning-registration-${digest(`${registration.person}-${registration.revision}`)}`},${`application-${registration.person}`},${`applicant-${registration.person}`},${registration.person},${`placement-${digest(`${registration.person}-previous`)}`},${departmentId},${semesterId},'draft-period',${registration.revision},${`register-${registration.person}-${registration.revision}`},2,${unavailable("monday")},${unavailable("tuesday")},${unavailable("wednesday")},${unavailable("thursday")},${unavailable("friday")},${registration.positionWeeks},${registration.preferredGroup},'Norsk',NULL,false,'[]'::jsonb,${`2031-11-1${registration.revision}T00:00:00Z`})`;
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
        expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
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
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookie: string | undefined) => {
    const actor = sessionActor(cookie);

    if (actor === undefined) throw new IdentitySessionNotFound();

    return actor;
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

const fixture = () => {
  const database = backendDatabase(seed);

  const http = makeBackendTestHttp(
    decodeBackendConfig(environment),
    Layer.mergeAll(
      PlacementsLive,
      OrganizationLive,
      Layer.succeed(IdentitySnapshot, identitySnapshot),
      Layer.succeed(Identity, identity),
    ).pipe(Layer.provideMerge(database.layer)),
    {
      handle: async () => new Response(null, { status: 404 }),
      recordTrustedOriginRejection: async () => undefined,
    },
  );

  const request = (path: string, init: RequestInit = {}, personId = "coordinator") => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `better-auth.session_token=${personId}`);

    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", "http://127.0.0.1:5174");
    }

    return http.fetch(new Request(`http://backend.test${path}`, { ...init, headers }));
  };

  return { request };
};

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  response: Response,
) =>
  response
    .json()
    .then((body) => Schema.decodeUnknownSync(schema)(body, { onExcessProperty: "error" }));

describe("placement drafts over HTTP and PostgreSQL", () => {
  it("drafts open demand within capacity for unplaced active assistants", async () => {
    const { request } = fixture();
    const response = await request(`/api/placements/draft?${scope}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const draft = await decodeStrict(PlacementDraftResource, response);

    const board = await decodeStrict(
      PlacementBoardResource,
      await request(`/api/placements?${scope}`),
    );

    expect(draft.boardEtag).toBe(board.etag);
    expect(draft.openPlaces).toBe(3);
    expect(draft.filledPlaces).toBe(2);
    expect(
      draft.placements.map(({ personId, schoolName, day, block, workdays }) => [
        personId,
        schoolName,
        day,
        block,
        workdays,
      ]),
    ).toEqual([
      ["carl", "Alpha skole", "Monday", "2", 4],
      ["berit", "Beta skole", "Tuesday", "2", 4],
    ]);
    expect(draft.unplaced.map(({ personId, reason }) => [personId, reason])).toEqual([
      ["dina", "NoOpenPlace"],
      ["erik", "NoAvailability"],
    ]);
    expect(
      draft.openSlots.map(({ schoolName, day, block, places }) => [schoolName, day, block, places]),
    ).toEqual([["Beta skole", "Tuesday", "1", 1]]);

    // Nothing is stored, and the same board gives the same draft.
    const again = await request(`/api/placements/draft?${scope}`);

    expect(await again.json()).toEqual(draft);
  });

  it("applies through the placement commands, after which only the unfilled rest remains", async () => {
    const { request } = fixture();

    const draft = await decodeStrict(
      PlacementDraftResource,
      await request(`/api/placements/draft?${scope}`),
    );

    let etag = draft.boardEtag;

    for (const placement of draft.placements) {
      const response = await request(`/api/placements?${scope}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": etag,
          "idempotency-key": `apply-draft-${placement.personId}`.padEnd(22, "0"),
        },
        body: JSON.stringify({
          action: "Create",
          personId: placement.personId,
          schoolId: placement.schoolId,
          day: placement.day,
          workdays: placement.workdays,
          block: placement.block,
        }),
      });

      expect(response.status).toBe(200);
      etag = (await decodeStrict(PlacementBoardResource, response)).etag;
    }

    const after = await decodeStrict(
      PlacementDraftResource,
      await request(`/api/placements/draft?${scope}`),
    );

    expect(after.boardEtag).toBe(etag);
    expect(after.placements).toEqual([]);
    expect(after.filledPlaces).toBe(0);
    expect(after.openPlaces).toBe(1);
    expect(after.unplaced.map(({ personId }) => personId)).toEqual(["dina", "erik"]);
  });

  it("serves drafts to scoped coordinators for a known semester only", async () => {
    const { request } = fixture();
    const assistant = await request(`/api/placements/draft?${scope}`, {}, "berit");

    expect(assistant.status).toBe(403);
    await expect(decodeStrict(PlacementProblem, assistant)).resolves.toMatchObject({
      code: "authority.denied",
    });

    const unknown = await request(
      `/api/placements/draft?${new URLSearchParams({ departmentId, semesterId: "draft-unknown" })}`,
    );

    expect(unknown.status).toBe(422);
    await expect(decodeStrict(PlacementProblem, unknown)).resolves.toMatchObject({
      code: "scope.invalid",
    });
  });
});
