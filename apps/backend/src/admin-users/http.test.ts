import type { IdentitySnapshot } from "@vektorprogrammet/database";
import type { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { Content } from "@vektorprogrammet/domain/content";
import { ContentManagement } from "@vektorprogrammet/domain/content";
import type { Schools } from "@vektorprogrammet/domain/schools";
import {
  DepartmentId,
  Organization,
  PersonId,
  accumulateOrganizationDirectoryFacts,
  type OrganizationDirectoryFact,
  type OrganizationDirectoryFacts,
  type OrganizationShape,
} from "@vektorprogrammet/domain/organization";
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
  PersonContactProfile,
  PersonProfile,
  Profile,
  ProfileContactNotFound,
  type DirectoryEntry,
  type ProfileShape,
} from "@vektorprogrammet/domain/profile";
import type { Economy } from "@vektorprogrammet/domain/receipt";
import type { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBackendConfig } from "../config.js";
import type { BackendRun } from "../router.js";
import { makeBackendTestHttp as makeBackendHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

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
} as const;
const config = makeBackendConfig(environment);

const instant = "2031-09-15T12:00:00.000Z";
const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");

interface SeededMembership {
  readonly personId: string;
  readonly departmentId: DepartmentId;
  /** Membership interval covers the captured instant when true. */
  readonly active: boolean;
  readonly teamLeader: boolean;
}

interface SeededGrant {
  readonly personId: string;
  readonly status: "Active" | "Inactive";
}

/** Canonical directory population shared by every scenario unless replaced. */
const directoryPeople = [
  {
    personId: "person-leader-a",
    firstName: "Active",
    lastName: "Leader",
    email: "leader-a@example.invalid",
    phone: "90000001",
  },
  {
    personId: "person-multi-department",
    firstName: "Multi",
    lastName: "Department",
    email: "multi@example.invalid",
    phone: "90000002",
  },
  {
    personId: "person-ended-membership",
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
let membershipsByPerson: Record<string, Array<SeededMembership>> = {};
let grantsByPerson: Record<string, SeededGrant | undefined> = {};
let missingContactFor: string | undefined;
let callerProjection: {
  globalAdministrator: "Active" | "Inactive" | "Absent";
} | null = null;

const database = { health: Effect.void } as unknown as DatabaseShape;

/** Profile stub: canonical names joined to canonical contacts, paged. */
const profile: ProfileShape = {
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
          return yield* new ProfileContactNotFound({ personId: tuple.personId as never });
        offset = found + 1;
      }
      const page = sorted.slice(offset, offset + limit);
      const entries: Array<DirectoryEntry> = [];
      for (const person of page) {
        if (missingContactFor === person.personId || !person.email) {
          return yield* new ProfileContactNotFound({
            personId: person.personId as never,
          });
        }
        entries.push({
          personId: person.personId as never,
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
    }).pipe(Effect.mapError((cause) => cause)) as never,
};

/** Organization stub: caller projection plus the frozen membership law. */
const organization = {
  listDepartments: Effect.succeed([]),
  listTeams: () => Effect.succeed([]),
  listFieldOfStudies: Effect.succeed([]),
  resolvePersonAuthority: () => {
    if (callerProjection === null) throw new Error("no caller projection configured");
    return Effect.succeed({
      personId: "person-caller",
      evaluatedAt: instant,
      globalAdministrator: callerProjection.globalAdministrator,
      memberships: (membershipsByPerson["person-caller"] ?? []).map((seed) => ({
        membershipId: `membership-${seed.departmentId}-${seed.personId}`,
        teamId: seed.teamLeader ? `team-leader-${seed.departmentId}` : `team-${seed.departmentId}`,
        departmentId: seed.departmentId,
        active: seed.active,
        teamLeader: seed.teamLeader,
      })),
    });
  },
  deriveDirectoryFacts: (
    personIds: ReadonlyArray<string>,
    evaluatedAt: string,
  ): Effect.Effect<OrganizationDirectoryFacts> =>
    Effect.try(() => {
      const memberships = personIds.flatMap((personId) => {
        const seeds = membershipsByPerson[personId] ?? [];
        return seeds.map((seed) => ({
          personId: personId as never,
          departmentId: seed.departmentId,
          // The stub resolves canonical names the way the PostgreSQL
          // interpreter's team->department join does.
          departmentName: `Name of ${seed.departmentId}`,
          active: seed.active,
        }));
      });
      const grants = personIds.flatMap((personId) => {
        const grant = grantsByPerson[personId];
        return grant ? [{ personId: personId as never, globalAdministrator: grant.status }] : [];
      });
      const facts = accumulateOrganizationDirectoryFacts({
        personIds: personIds as never[],
        instant: evaluatedAt,
        memberships,
        grants,
      }) as unknown as Map<string, OrganizationDirectoryFact>;
      for (const personId of personIds) {
        if (!facts.has(personId as never)) {
          facts.set(personId as never, {
            departments: [],
            departmentNames: [],
            isActive: false,
            globalAdministrator: "Absent",
          });
        }
      }
      return facts as unknown as OrganizationDirectoryFacts;
    }),
} as unknown as OrganizationShape;

const resetScenario = () => {
  people = [...directoryPeople];
  membershipsByPerson = {
    "person-leader-a": [
      { personId: "person-leader-a", departmentId: departmentA, active: true, teamLeader: true },
    ],
    "person-multi-department": [
      {
        personId: "person-multi-department",
        departmentId: departmentA,
        active: true,
        teamLeader: false,
      },
      {
        personId: "person-multi-department",
        departmentId: departmentB,
        active: true,
        teamLeader: false,
      },
    ],
    "person-ended-membership": [
      {
        personId: "person-ended-membership",
        departmentId: departmentA,
        active: false,
        teamLeader: false,
      },
    ],
  };
  grantsByPerson = {};
  missingContactFor = undefined;
  // Caller defaults to an active global administrator viewing everything.
  callerProjection = { globalAdministrator: "Active" };
};

resetScenario();
const successfulRun: BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Database
    | Admissions
    | Economy
    | Organization
    | Profile
    | Recruitment
    | Schools
    | Identity
    | IdentitySnapshot
    | ContentManagement
    | Content
  >,
): Promise<A> =>
  runTestPromise(
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Profile, profile),
      Effect.provideService(Organization, organization),
      Effect.provideService(Identity, {
        signIn: () => Promise.reject(new Error("unexpected sign-in")),
        resolveSession: async (cookieHeader: string | undefined) => {
          if (cookieHeader !== undefined && cookieHeader.includes(`${token}=`)) {
            return new IdentityActor({
              personId: PersonId.make("person-caller"),
              sessionId: "session-1",
              expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T00:00:00.000Z")),
            });
          }
          throw new IdentitySessionNotFound();
        },
        readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
        listSessions: () => Promise.reject(new Error("unexpected session list")),
        revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
        revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
        revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
        revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
        recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
        signOut: async () => ({ setCookies: [] }),
      } satisfies IdentityShape),
    ) as Effect.Effect<A, E>,
  );

const backend = makeBackendHttp(config, successfulRun, {
  handle: async () => new Response(null, { status: 404 }),
  recordTrustedOriginRejection: async () => undefined,
});

const request = (): Promise<Response> =>
  backend.fetch(
    new Request("http://backend.test/api/admin/users", {
      headers: { cookie: `${token}=value` },
    }),
  );

describe("GET /api/admin/users (spec 0057)", () => {
  it("answers 401 without a session", async () => {
    const response = await backend.fetch(new Request("http://backend.test/api/admin/users"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { tag: "UnauthenticatedActor" } });
  });

  it("denies a plain member with typed 403 AuthorityInactive", async () => {
    resetScenario();
    callerProjection = { globalAdministrator: "Absent" };
    membershipsByPerson["person-caller"] = [
      { personId: "person-caller", departmentId: departmentA, active: true, teamLeader: false },
    ];
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { tag: "InactiveActor" } });
  });

  it("denies an inactive leader with typed 403 AuthorityInactive", async () => {
    resetScenario();
    callerProjection = { globalAdministrator: "Absent" };
    membershipsByPerson["person-caller"] = [
      { personId: "person-caller", departmentId: departmentA, active: false, teamLeader: true },
    ];
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { tag: "InactiveActor" } });
  });

  it("denies an inactive administrator with typed 403 AuthorityInactive", async () => {
    resetScenario();
    callerProjection = { globalAdministrator: "Inactive" };
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { tag: "InactiveActor" } });
  });

  it("shows an active global administrator the cross-department directory", async () => {
    resetScenario();
    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activeUsers: Array<Record<string, unknown>>;
      inactiveUsers: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.activeUsers.map((row) => row.personId)).toEqual([
      "person-multi-department",
      "person-leader-a",
    ]);
    expect(body.inactiveUsers.map((row) => row.personId)).toEqual(["person-ended-membership"]);
    expect(body.nextCursor).toBeNull();
    const multi = body.activeUsers.find((row) => row.personId === "person-multi-department");
    // The frozen entry carries department NAMES (spec 0057 falsifier), sorted.
    expect(multi?.departments).toEqual(["Name of department-a", "Name of department-b"]);
    for (const row of [...body.activeUsers, ...body.inactiveUsers]) {
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
  });

  it("denies a caller with no Organization record with typed 403 NotInScope", async () => {
    resetScenario();
    // Absent grant plus no memberships at all: NotInScope, never a 401.
    callerProjection = { globalAdministrator: "Absent" };
    membershipsByPerson["person-caller"] = [];
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { tag: "NotInScope" } });
  });

  it("scopes a department leader to the intersection of their leader departments", async () => {
    resetScenario();
    callerProjection = { globalAdministrator: "Absent" };
    membershipsByPerson["person-caller"] = [
      { personId: "person-caller", departmentId: departmentB, active: true, teamLeader: true },
    ];
    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activeUsers: Array<{ personId: string; departments: string[] }>;
      inactiveUsers: Array<{ personId: string }>;
    };
    // Only the multi-department person touches department B.
    expect(body.activeUsers.map((row) => row.personId)).toEqual(["person-multi-department"]);
    expect(body.inactiveUsers).toEqual([]);
  });

  it("returns a legitimate 200 with empty arrays when nothing intersects", async () => {
    resetScenario();
    callerProjection = { globalAdministrator: "Absent" };
    membershipsByPerson["person-caller"] = [
      {
        personId: "person-caller",
        departmentId: DepartmentId.make("department-empty"),
        active: true,
        teamLeader: true,
      },
    ];
    people = [];
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeUsers: [],
      inactiveUsers: [],
      nextCursor: null,
    });
  });

  it("walks every page until exhaustion without duplicating or dropping a person", async () => {
    resetScenario();
    people = Array.from({ length: 205 }, (_, index) => ({
      personId: `person-bulk-${String(index + 1).padStart(4, "0")}`,
      firstName: "Bulk",
      lastName: `Family${String(index % 7)}`,
      email: `bulk-${index + 1}@example.invalid`,
      phone: "90000000",
    }));
    membershipsByPerson = {};
    grantsByPerson = {};
    const response = await request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activeUsers: Array<{ personId: string }>;
      inactiveUsers: Array<{ personId: string }>;
    };
    const ids = [...body.activeUsers, ...body.inactiveUsers].map((row) => row.personId);
    expect(new Set(ids).size).toBe(205);
    expect(ids.length).toBe(205);
  });

  it("fails 503 when a scanned person has no contact row instead of dropping them", async () => {
    resetScenario();
    missingContactFor = "person-multi-department";
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { tag: "ProfileContactNotFound" } });
  });

  it("rejects a query string with 422", async () => {
    resetScenario();
    const response = await backend.fetch(
      new Request("http://backend.test/api/admin/users?page=2", {
        headers: { cookie: `${token}=value` },
      }),
    );
    expect(response.status).toBe(422);
  });
});
