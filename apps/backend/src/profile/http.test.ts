import { backendDatabase } from "../../test/database.js";
import { HttpSemanticFailure } from "../http-semantics.js";
import { backendTestConfig } from "../../test/config.js";
import { Database, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { OrganizationPersistenceError, PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeProfileTestHttp as makeProfileApiHttp } from "../test/native-http.js";

type ProfileAuthorityTestFailure = HttpSemanticFailure;

const tagged = (_tag: "AuthorityInactive" | "NotInScope") =>
  new HttpSemanticFailure("authority.denied", 403);

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
  resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
  resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
});

const identity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookieHeader: string | undefined) => {
    if (cookieHeader?.includes("profile-test-session")) {
      return new IdentityActor({
        personId: PersonId.make("profile-test-person"),
        sessionId: "profile-test-session",
        expiresAt: DateTime.makeUnsafe(new Date("2032-04-02T12:00:00.000Z")),
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
} satisfies IdentityOperations);

const securityServices = Layer.mergeAll(
  Layer.succeed(Identity, identity),
  Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
);

const request = async (
  cause: ProfileAuthorityTestFailure | OrganizationPersistenceError,
): Promise<Response> =>
  makeProfileApiHttp(
    {
      config: backendTestConfig,
      resolveActor: () => Effect.fail(cause),
    },
    securityServices,
  ).fetch(
    new Request("http://backend.test/api/profile", {
      headers: { cookie: "better-auth.session_token=profile-test-session" },
    }),
  );

describe("Profile HTTP authority failures", () => {
  it.each(["AuthorityInactive", "NotInScope"] as const)(
    "preserves %s as a typed scope denial",
    async (tag) => {
      const response = await request(tagged(tag));

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(await response.json()).toEqual(authorityDeniedProblem);
    },
  );

  it("maps an unavailable authority provider failure to unavailable", async () => {
    const response = await request(
      new OrganizationPersistenceError({
        operation: "resolve profile test authority",
        message: "provider unavailable",
      }),
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
        resolveActor: () => Effect.succeed({ personId: profile.personId, role }),
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
