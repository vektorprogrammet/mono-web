import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { Database, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  OrganizationPersistenceError,
  type OrganizationPersonAuthority,
  OrganizationPersonAuthoritySchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeProfileTestHttp as makeProfileApiHttp } from "../test/native-http.js";

const authority = (
  personId: string,
  globalAdministrator: "Active" | "Inactive" | "Absent",
  memberships: ReadonlyArray<{ readonly active: boolean; readonly unitLeader: boolean }>,
) =>
  Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
    personId,
    evaluatedAt: "2032-04-01T12:00:00.000Z",
    globalAdministrator,
    memberships: memberships.map((membership, index) => ({
      membershipId: `membership-${index}`,
      teamId: "team-1",
      departmentId: "department-1",
      unitKind: "Team",
      teamScope: "HomeDepartment",
      departmentIndependent: false,
      ...membership,
    })),
    nationalBoardSeats: [],
    delegations: [],
  });

const authorityDeniedProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
  title: "Authority denied",
  status: 403,
  detail: "The authenticated principal is not permitted to perform this operation.",
  code: "authority.denied",
} as const;

const profileUnavailableProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:profile.unavailable",
  title: "Profile unavailable",
  status: 503,
  detail: "The profile service is temporarily unavailable.",
  code: "profile.unavailable",
} as const;

const oauthCredentialAuthority = OAuthCredentialAuthority.of({
  resolve: () => Effect.die("unexpected OAuth credential resolution"),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader?.includes("profile-test-session")
      ? Effect.succeed(
          new IdentityActor({
            personId: PersonId.make("profile-test-person"),
            sessionId: "profile-test-session",
            expiresAt: DateTime.makeUnsafe("2032-04-02T12:00:00.000Z"),
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

const securityServices = Layer.mergeAll(
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const request = async (
  resolved: Effect.Effect<OrganizationPersonAuthority, OrganizationPersistenceError>,
): Promise<Response> =>
  makeProfileApiHttp(
    {
      config: backendTestConfig,
      resolveActor: () => resolved,
    },
    securityServices,
  ).fetch(
    new Request("http://backend.test/api/profile", {
      headers: { cookie: "better-auth.session_token=profile-test-session" },
    }),
  );

describe("Profile HTTP authority failures", () => {
  it.each([
    [
      "AuthorityInactive",
      authority("profile-test-person", "Inactive", [{ active: false, unitLeader: false }]),
    ],
    ["NotInScope", authority("profile-test-person", "Absent", [])],
  ] as const)("preserves %s as a typed scope denial", async (_, resolved) => {
    const response = await request(Effect.succeed(resolved));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toEqual(authorityDeniedProblem);
  });

  it("maps an unavailable authority provider failure to unavailable", async () => {
    const response = await request(
      Effect.fail(
        new OrganizationPersistenceError({
          operation: "resolve profile test authority",
          message: "provider unavailable",
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(profileUnavailableProblem);
  });
});

describe("Profile HTTP ETag", () => {
  const profile = {
    personId: PersonId.make("person-1"),
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.invalid",
    phone: "+47 900 00 000",
    nameRevision: 7,
    contactRevision: 11,
  } as const;

  const profileService = {
    readOwnProfile: () => Effect.succeed(profile),
  };

  const readAs = (
    role: "ROLE_TEAM_MEMBER" | "ROLE_TEAM_LEADER",
    representationRevision: number,
  ) => {
    const database = backendDatabase(
      Database.use((sql) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO person_profiles VALUES (${profile.personId},${profile.firstName},${profile.lastName},${profile.nameRevision})`;
          yield* sql`INSERT INTO person_contact_profiles VALUES (${profile.personId},${profile.email},${profile.phone},${profile.contactRevision})`;
          yield* sql`UPDATE public.profile_http_versions SET representation_revision=${representationRevision} WHERE person_id=${profile.personId}`;
        }),
      ),
    );

    const services = Layer.mergeAll(
      database.layer,
      Layer.mock(Profile, profileService),
      securityServices,
    );

    return makeProfileApiHttp(
      {
        config: backendTestConfig,
        resolveActor: () =>
          Effect.succeed(
            authority(profile.personId, "Absent", [
              { active: true, unitLeader: role === "ROLE_TEAM_LEADER" },
            ]),
          ),
      },
      services,
    ).fetch(
      new Request("http://backend.test/api/profile", {
        headers: { cookie: "better-auth.session_token=profile-test-session" },
      }),
    );
  };

  it("changes only after the persisted role representation revision changes", async () => {
    const member = await readAs("ROLE_TEAM_MEMBER", 3);
    const changedProjectionWithoutRevision = await readAs("ROLE_TEAM_LEADER", 3);
    const leaderAfterCommittedAuthorityChange = await readAs("ROLE_TEAM_LEADER", 4);

    expect(member.status).toBe(200);
    expect(changedProjectionWithoutRevision.status).toBe(200);
    expect(leaderAfterCommittedAuthorityChange.status).toBe(200);
    expect(member.headers.get("etag")).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(changedProjectionWithoutRevision.headers.get("etag")).toBe(member.headers.get("etag"));
    expect(leaderAfterCommittedAuthorityChange.headers.get("etag")).not.toBe(
      member.headers.get("etag"),
    );
  });
});
