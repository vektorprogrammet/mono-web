import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeProfileTestHttp as makeProfileApiHttp } from "../test/native-http.js";

const tagged = (tag: string): Error & { readonly _tag: string } =>
  Object.assign(new Error(tag), { _tag: tag });

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

const request = async (cause: unknown): Promise<Response> =>
  makeProfileApiHttp({
    config: {} as never,
    resolveActor: async () => {
      throw cause;
    },
    run: vi.fn() as never,
  }).fetch(
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

  it("maps an unknown authority provider failure to unavailable", async () => {
    const response = await request(new Error("provider unavailable"));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
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
  } as never;
  const readAs = (
    role: "ROLE_TEAM_MEMBER" | "ROLE_TEAM_LEADER",
    representationRevision: number,
  ) => {
    const database = ((_strings: TemplateStringsArray) =>
      Effect.succeed([
        {
          ...profile,
          contactPersonId: profile.personId,
          representationRevision,
        },
      ])) as unknown as DatabaseShape;
    const run = ((effect: Effect.Effect<unknown, unknown, Database | Profile>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Profile, profileService),
        ),
      )) as never;
    return makeProfileApiHttp({
      config: {} as never,
      resolveActor: async () => ({ personId: profile.personId, role }),
      run,
    }).fetch(
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
