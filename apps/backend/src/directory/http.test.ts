import { backendDatabase } from "../../test/database.js";
import { PeopleDirectoryResponse } from "@vektorprogrammet/http-api";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";

import { SocialEvents } from "@vektorprogrammet/domain/social-events";
import {
  MembershipId,
  TeamId,
  DepartmentId,
  Organization,
  PersonId,
  accumulateOrganizationDirectoryFacts,
  type OrganizationDirectoryFacts,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
  PersonContactProfile,
  PersonProfile,
  Profile,
  ProfileContactNotFound,
  type DirectoryEntry,
  type ProfileOperations,
} from "@vektorprogrammet/domain/profile";
import { Schema, DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { decodeBackendConfig } from "../config.js";
import { makeBackendTestHttp as backendHttpHandler } from "../test/native-http.js";

const token = "better-auth.session_token";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "router-test-secret-with-at-least-32-characters!",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
} as const;

const config = Effect.runSync(decodeBackendConfig(environment));

const instant = "2031-09-15T12:00:00.000Z";

const departmentA = DepartmentId.make("department-a");

const departmentB = DepartmentId.make("department-b");

interface SeededMembership {
  readonly personId: string;
  readonly departmentId: DepartmentId;
  /** Membership interval covers the captured instant when true. */
  readonly active: boolean;
  /** Leads the board of the (independent) department. */
  readonly boardLeader: boolean;
}

interface SeededGrant {
  readonly personId: string;
  readonly status: "Active" | "Inactive";
}

/** Canonical directory population shared by every scenario unless replaced. */
const directoryPeople = [
  {
    personId: PersonId.make("person-leader-a"),
    firstName: "Active",
    lastName: "Leader",
    email: "leader-a@example.invalid",
    phone: "90000001",
  },
  {
    personId: PersonId.make("person-multi-department"),
    firstName: "Multi",
    lastName: "Department",
    email: "multi@example.invalid",
    phone: "90000002",
  },
  {
    personId: PersonId.make("person-ended-membership"),
    firstName: "Ended",
    lastName: "Membership",
    email: "ended@example.invalid",
    phone: "90000003",
  },
];

let people: Array<{
  personId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}> = [];

let membershipsByPerson = new Map<string, Array<SeededMembership>>([]);

let grantsByPerson: Record<string, SeededGrant | undefined> = {};

let missingContactFor: string | undefined;

let callerProjection: {
  globalAdministrator: "Active" | "Inactive" | "Absent";
} | null = null;

const database = backendDatabase();

/** Profile stub: canonical names joined to canonical contacts, paged. */
const profile: ProfileOperations = {
  readProfiles: (personIds) =>
    Effect.succeed(
      personIds.map(
        (personId) =>
          new PersonProfile({ personId, firstName: "First", lastName: "Last", revision: 0 }),
      ),
    ),
  readContacts: (personIds) =>
    Effect.succeed(
      personIds.map(
        (personId) =>
          new PersonContactProfile({
            personId,
            email: `${personId}@example.invalid`,
            phone: "90000000",
            revision: 0,
          }),
      ),
    ),
  readOwnProfile: (personId) =>
    Effect.succeed({
      personId,
      firstName: "First",
      lastName: "Last",
      email: `${personId}@example.invalid`,
      phone: "90000000",
      nameRevision: 0,
      contactRevision: 0,
    }),
  updateOwnProfile: () => Effect.die("unexpected updateOwnProfile"),
  readDirectoryPage: ({ limit, cursor }) =>
    Effect.gen(function* () {
      const sorted = [...people].sort((left, right) => {
        const byLastName = left.lastName.localeCompare(right.lastName);

        if (byLastName !== 0) return byLastName;
        const byFirstName = left.firstName.localeCompare(right.firstName);

        if (byFirstName !== 0) return byFirstName;

        return left.personId.localeCompare(right.personId);
      });

      let offset = 0;

      if (cursor !== undefined) {
        const tuple = yield* decodeDirectoryCursor(cursor);

        const found = sorted.findIndex(
          (person) =>
            person.lastName === tuple.lastName &&
            person.firstName === tuple.firstName &&
            person.personId === tuple.personId,
        );

        if (found < 0)
          return yield* new ProfileContactNotFound({ personId: PersonId.make(tuple.personId) });
        offset = found + 1;
      }

      const page = sorted.slice(offset, offset + limit);
      const entries: Array<DirectoryEntry> = [];

      for (const person of page) {
        if (missingContactFor === person.personId || !person.email) {
          return yield* new ProfileContactNotFound({
            personId: PersonId.make(person.personId),
          });
        }

        entries.push({
          personId: PersonId.make(person.personId),
          firstName: person.firstName,
          lastName: person.lastName,
          email: person.email,
          phone: person.phone,
        });
      }

      const last = entries[entries.length - 1];

      return {
        entries,
        nextCursor:
          last !== undefined && offset + entries.length < sorted.length
            ? encodeDirectoryCursor(last)
            : undefined,
      };
    }).pipe(Effect.mapError((cause) => cause)),
};

/** Organization stub: caller projection plus the frozen membership law. */
const organization = {
  listDepartments: Effect.succeed([]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: () => {
    if (callerProjection === null) throw new Error("no caller projection configured");

    return Effect.succeed({
      personId: PersonId.make("person-caller"),
      evaluatedAt: instant,
      globalAdministrator: callerProjection.globalAdministrator,
      memberships: (membershipsByPerson.get("person-caller") ?? []).map((seed) => ({
        membershipId: MembershipId.make(`membership-${seed.departmentId}-${seed.personId}`),
        teamId: TeamId.make(
          seed.boardLeader ? `styret-${seed.departmentId}` : `team-${seed.departmentId}`,
        ),
        departmentId: DepartmentId.make(seed.departmentId),
        active: seed.active,
        unitLeader: seed.boardLeader,
        unitKind: seed.boardLeader ? "DepartmentBoard" : "Team",
        teamScope: "HomeDepartment",
        departmentIndependent: true,
      })),
      nationalBoardSeats: [],
      delegations: [],
    });
  },
  deriveDirectoryFacts: (
    personIds: ReadonlyArray<string>,
    evaluatedAt: string,
  ): Effect.Effect<OrganizationDirectoryFacts> =>
    Effect.sync(() => {
      const memberships = personIds.flatMap((personId) => {
        const seeds = membershipsByPerson.get(personId) ?? [];

        return seeds.map((seed) => ({
          personId: PersonId.make(personId),
          departmentId: DepartmentId.make(seed.departmentId),
          // The stub resolves canonical names the way the PostgreSQL
          // interpreter's team->department join does.
          departmentName: `Name of ${seed.departmentId}`,
          active: seed.active,
        }));
      });

      const grants = personIds.flatMap((personId) => {
        const grant = grantsByPerson[personId];

        return grant
          ? [{ personId: PersonId.make(personId), globalAdministrator: grant.status }]
          : [];
      });

      const facts = new Map(
        accumulateOrganizationDirectoryFacts({
          personIds: personIds.map((personId) => PersonId.make(personId)),
          instant: evaluatedAt,
          memberships,
          grants,
        }),
      );

      for (const personId of personIds) {
        if (!facts.has(PersonId.make(personId))) {
          facts.set(PersonId.make(personId), {
            departments: [],
            departmentNames: [],
            isActive: false,
            globalAdministrator: "Absent",
          });
        }
      }

      return facts;
    }),
} satisfies Partial<OrganizationOperations>;

const resetScenario = () => {
  people = [...directoryPeople];
  membershipsByPerson = new Map<string, Array<SeededMembership>>([
    [
      "person-leader-a",
      [
        {
          personId: PersonId.make("person-leader-a"),
          departmentId: DepartmentId.make(departmentA),
          active: true,
          boardLeader: true,
        },
      ],
    ],
    [
      "person-multi-department",
      [
        {
          personId: PersonId.make("person-multi-department"),
          departmentId: DepartmentId.make(departmentA),
          active: true,
          boardLeader: false,
        },
        {
          personId: PersonId.make("person-multi-department"),
          departmentId: DepartmentId.make(departmentB),
          active: true,
          boardLeader: false,
        },
      ],
    ],
    [
      "person-ended-membership",
      [
        {
          personId: PersonId.make("person-ended-membership"),
          departmentId: DepartmentId.make(departmentA),
          active: false,
          boardLeader: false,
        },
      ],
    ],
  ]);
  grantsByPerson = {};
  missingContactFor = undefined;
  // Caller defaults to an active global administrator viewing everything.
  callerProjection = { globalAdministrator: "Active" };
};

resetScenario();

const socialEvents = SocialEvents.of({
  readSnapshotInstant: Effect.die("unexpected social-event read"),
  readScope: () => Effect.die("unexpected social-event read"),
  readList: () => Effect.die("unexpected social-event read"),
  validateScope: () => Effect.die("unexpected social-event validation"),
  create: () => Effect.die("unexpected social-event create"),
});

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader !== undefined && cookieHeader.includes(`${token}=`)
      ? Effect.succeed(
          new IdentityActor({
            personId: PersonId.make("person-caller"),
            sessionId: "session-1",
            expiresAt: DateTime.makeUnsafe("2031-09-16T00:00:00.000Z"),
          }),
        )
      : Effect.fail(new IdentitySessionNotFound()),
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const backendServices = Layer.mergeAll(
  database.layer,
  Layer.succeed(Profile, profile),
  Layer.mock(Organization, organization),
  Layer.succeed(SocialEvents, socialEvents),
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const backend = backendHttpHandler(config, backendServices, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
});

const request = (): Effect.Effect<Response> =>
  backend.fetch(
    new Request("http://backend.test/api/people", {
      headers: { cookie: `${token}=value` },
    }),
  );

describe("GET /api/people (spec 0077.2)", () => {
  it.live("answers 401 without a session", () =>
    Effect.gen(function* () {
      const response = yield* backend.fetch(new Request("http://backend.test/api/people"));
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
        title: "Credential required",
        status: 401,
        detail: "A credential is required for this operation.",
        code: "credential.missing",
      });
    }),
  );

  it.live("denies a plain member with typed 403 AuthorityInactive", () =>
    Effect.gen(function* () {
      resetScenario();
      callerProjection = { globalAdministrator: "Absent" };
      membershipsByPerson.set("person-caller", [
        {
          personId: PersonId.make("person-caller"),
          departmentId: DepartmentId.make(departmentA),
          active: true,
          boardLeader: false,
        },
      ]);
      const response = yield* request();
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
        title: "Authority denied",
        status: 403,
        detail: "The authenticated principal is not permitted to perform this operation.",
        code: "authority.denied",
      });
    }),
  );

  it.live("denies an inactive leader with typed 403 AuthorityInactive", () =>
    Effect.gen(function* () {
      resetScenario();
      callerProjection = { globalAdministrator: "Absent" };
      membershipsByPerson.set("person-caller", [
        {
          personId: PersonId.make("person-caller"),
          departmentId: DepartmentId.make(departmentA),
          active: false,
          boardLeader: true,
        },
      ]);
      const response = yield* request();
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
        title: "Authority denied",
        status: 403,
        detail: "The authenticated principal is not permitted to perform this operation.",
        code: "authority.denied",
      });
    }),
  );

  it.live("denies an inactive administrator with typed 403 AuthorityInactive", () =>
    Effect.gen(function* () {
      resetScenario();
      callerProjection = { globalAdministrator: "Inactive" };
      const response = yield* request();
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
        title: "Authority denied",
        status: 403,
        detail: "The authenticated principal is not permitted to perform this operation.",
        code: "authority.denied",
      });
    }),
  );

  it.live("shows an active global administrator the cross-department directory", () =>
    Effect.gen(function* () {
      resetScenario();
      const response = yield* request();
      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(PeopleDirectoryResponse)(
        yield* Effect.promise(() => response.json()),
      );

      expect(body.activePeople.map((row) => row.personId)).toEqual([
        "person-multi-department",
        "person-leader-a",
      ]);
      expect(body.inactivePeople.map((row) => row.personId)).toEqual(["person-ended-membership"]);
      expect(body.nextCursor).toBeNull();
      const multi = body.activePeople.find((row) => row.personId === "person-multi-department");
      // The frozen entry carries department NAMES (spec 0057 falsifier), sorted.
      expect(multi?.departments).toEqual(["Name of department-a", "Name of department-b"]);

      for (const row of [...body.activePeople, ...body.inactivePeople]) {
        expect(Object.keys(row).sort()).toEqual([
          "departments",
          "email",
          "firstName",
          "isActive",
          "lastName",
          "personId",
          "phone",
          "studyProgramme",
        ]);
        expect(row.studyProgramme).toBeNull();
      }
    }),
  );

  it.live("denies a caller with no Organization record with typed 403 NotInScope", () =>
    Effect.gen(function* () {
      resetScenario();
      // Absent grant plus no memberships at all: NotInScope, never a 401.
      callerProjection = { globalAdministrator: "Absent" };
      membershipsByPerson.set("person-caller", []);
      const response = yield* request();
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
        title: "Authority denied",
        status: 403,
        detail: "The authenticated principal is not permitted to perform this operation.",
        code: "authority.denied",
      });
    }),
  );

  it.live("scopes a department leader to the intersection of their leader departments", () =>
    Effect.gen(function* () {
      resetScenario();
      callerProjection = { globalAdministrator: "Absent" };
      membershipsByPerson.set("person-caller", [
        {
          personId: PersonId.make("person-caller"),
          departmentId: DepartmentId.make(departmentB),
          active: true,
          boardLeader: true,
        },
      ]);
      const response = yield* request();
      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(PeopleDirectoryResponse)(
        yield* Effect.promise(() => response.json()),
      );

      // Only the multi-department person touches department B.
      expect(body.activePeople.map((row) => row.personId)).toEqual(["person-multi-department"]);
      expect(body.inactivePeople).toEqual([]);
    }),
  );

  it.live("returns a legitimate 200 with empty arrays when nothing intersects", () =>
    Effect.gen(function* () {
      resetScenario();
      callerProjection = { globalAdministrator: "Absent" };
      membershipsByPerson.set("person-caller", [
        {
          personId: PersonId.make("person-caller"),
          departmentId: DepartmentId.make("department-empty"),
          active: true,
          boardLeader: true,
        },
      ]);
      people = [];
      const response = yield* request();
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        activePeople: [],
        inactivePeople: [],
        nextCursor: null,
      });
    }),
  );

  it.live("walks every page until exhaustion without duplicating or dropping a person", () =>
    Effect.gen(function* () {
      resetScenario();
      people = Array.from({ length: 205 }, (_, index) => ({
        personId: PersonId.make(`person-bulk-${String(index + 1).padStart(4, "0")}`),
        firstName: "Bulk",
        lastName: `Family${String(index % 7)}`,
        email: `bulk-${index + 1}@example.invalid`,
        phone: "90000000",
      }));
      membershipsByPerson = new Map<string, Array<SeededMembership>>([]);
      grantsByPerson = {};
      const response = yield* request();
      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(PeopleDirectoryResponse)(
        yield* Effect.promise(() => response.json()),
      );

      const ids = [...body.activePeople, ...body.inactivePeople].map((row) => row.personId);
      expect(new Set(ids).size).toBe(205);
      expect(ids.length).toBe(205);
    }),
  );

  it.live("fails 503 when a scanned person has no contact row instead of dropping them", () =>
    Effect.gen(function* () {
      resetScenario();
      missingContactFor = "person-multi-department";
      const response = yield* request();
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "urn:vektorprogrammet:problem:v0.2:directory.unavailable",
        title: "Directory unavailable",
        status: 503,
        detail: "The directory service is temporarily unavailable.",
        code: "directory.unavailable",
      });
    }),
  );

  it.live("rejects a query string with 422", () =>
    Effect.gen(function* () {
      resetScenario();

      const response = yield* backend.fetch(
        new Request("http://backend.test/api/people?page=2", {
          headers: { cookie: `${token}=value` },
        }),
      );

      expect(response.status).toBe(422);
    }),
  );
});
