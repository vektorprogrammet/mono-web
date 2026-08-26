import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceFailure: undefined as unknown,
}));

vi.mock("../../lib/auth.server", () => ({
  requireAuth: async () => "better-auth.session_token=content-test",
}));

vi.mock("../../lib/api.server", () => ({
  createAuthenticatedClient: () => ({
    admin: {
      content: {
        workspace: async () => {
          throw mocks.workspaceFailure;
        },
      },
    },
  }),
}));

import { loader } from "../../routes/__foldkit.content";

const loadWorkspace = () =>
  loader({ request: new Request("http://dashboard.test/content") } as never);

describe("Content bridge denial decoding", () => {
  beforeEach(() => {
    mocks.workspaceFailure = undefined;
  });

  it("accepts a known structural contentTag across bundle realms", async () => {
    mocks.workspaceFailure = { contentTag: "AuthorityInactive" };

    const result = await loadWorkspace();

    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "AuthorityInactive" } });
  });

  it("rejects arbitrary _tag and unknown contentTag spoof values", async () => {
    for (const failure of [{ _tag: "AuthorityInactive" }, { contentTag: "MadeUpContentFailure" }]) {
      mocks.workspaceFailure = failure;
      const result = await loadWorkspace();

      expect(result.init?.status).toBe(503);
      expect(result.data).toEqual({ error: { tag: "ContentPersistenceError" } });
    }
  });
});
