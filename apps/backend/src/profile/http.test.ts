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
    new Request("http://backend.test/api/me", {
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
