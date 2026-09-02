import { PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeProfileTestHttp as makeProfileApiHttp } from "../test/native-http.js";

const tagged = (tag: string): Error & { readonly _tag: string } =>
  Object.assign(new Error(tag), { _tag: tag });

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
      expect(await response.json()).toEqual({ error: { tag } });
    },
  );

  it("maps an unknown authority provider failure to unavailable", async () => {
    const response = await request(new Error("provider unavailable"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { tag: "ProfilePersistenceError" } });
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
  const run = ((effect: Effect.Effect<unknown, unknown, Profile>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Profile, profileService)))) as never;

  const readAs = (role: "ROLE_TEAM_MEMBER" | "ROLE_TEAM_LEADER") =>
    makeProfileApiHttp({
      config: {} as never,
      resolveActor: async () => ({ personId: profile.personId, role }),
      run,
    }).fetch(
      new Request("http://backend.test/api/profile", {
        headers: { cookie: "better-auth.session_token=profile-test-session" },
      }),
    );

  it("uses the current projected role as an ETag source", async () => {
    const member = await readAs("ROLE_TEAM_MEMBER");
    const leader = await readAs("ROLE_TEAM_LEADER");

    expect(member.status).toBe(200);
    expect(leader.status).toBe(200);
    expect(member.headers.get("etag")).toMatch(/^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
    expect(leader.headers.get("etag")).not.toBe(member.headers.get("etag"));
  });
});
