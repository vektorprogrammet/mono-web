import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceFailure: undefined as unknown,
  createFailure: undefined as unknown,
  readFailure: undefined as unknown,
  readCalls: [] as Array<unknown>,
  createCalls: [] as Array<unknown>,
}));

vi.mock("../../lib/auth.server", () => ({
  requireAuth: async () => "better-auth.session_token=content-test",
}));

vi.mock("../../lib/api.server", () => ({
  createAuthenticatedClient: () => ({
    admin: {
      content: {
        workspace: async () => {
          if (mocks.workspaceFailure !== undefined) throw mocks.workspaceFailure;
          return { entries: [] };
        },
        read: async (articleId: unknown) => {
          mocks.readCalls.push(articleId);
          if (mocks.readFailure !== undefined) throw mocks.readFailure;
          return { articleId };
        },
        createDraft: async (command: unknown) => {
          mocks.createCalls.push(command);
          if (mocks.createFailure !== undefined) throw mocks.createFailure;
          return {};
        },
      },
    },
    public: {
      organization: {
        listDepartments: async () => [
          { departmentId: "department-a", name: "Trondheim", active: true },
          { departmentId: "department-b", name: "Bergen", active: true },
          { departmentId: "department-old", name: "Tidligere", active: false },
        ],
      },
    },
  }),
}));

import { action, loader } from "../../routes/__foldkit.content";

const loadWorkspace = () =>
  loader({ request: new Request("http://dashboard.test/content") } as never);

const createDraft = (departmentId: string, operation: string = "createDraft") =>
  action({
    request: new Request("http://dashboard.test/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation,
        commandId: "create-1",
        title: "Tittel",
        bodyHtml: "<p>Brødtekst</p>",
        departmentIds: [departmentId],
      }),
    }),
  } as never);

const readArticle = (articleId: unknown, extra: Record<string, unknown> = {}) =>
  action({
    request: new Request("http://dashboard.test/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "readArticle", articleId, ...extra }),
    }),
  } as never);

describe("Content bridge denial decoding", () => {
  beforeEach(() => {
    mocks.workspaceFailure = undefined;
    mocks.createFailure = undefined;
    mocks.readFailure = undefined;
    mocks.readCalls.length = 0;
    mocks.createCalls.length = 0;
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

  it("returns a separate active department bootstrap when the workspace is empty", async () => {
    const result = await loadWorkspace();

    expect(result.data).toEqual({
      workspace: { entries: [] },
      knownDepartments: [
        { departmentId: "department-a", name: "Trondheim" },
        { departmentId: "department-b", name: "Bergen" },
      ],
    });
  });

  it("does not let the option list widen server authority", async () => {
    await loadWorkspace();
    mocks.createFailure = { contentTag: "NotInScope" };

    const result = await createDraft("department-b");

    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "NotInScope" } });
    expect(mocks.createCalls).toHaveLength(1);
  });
  it("dispatches only a strict private article-detail command", async () => {
    const result = await readArticle(7);
    expect(result.data).toEqual({ articleId: 7 });
    expect(mocks.readCalls).toEqual([7]);

    const polluted = await readArticle(7, { createdByPersonId: "person-secret" });
    expect(polluted.init?.status).toBe(422);
    expect(polluted.data).toEqual({ error: { tag: "ContentDecodeError" } });
    expect(mocks.readCalls).toEqual([7]);
  });

  it("strictly rejects unknown bridge operations before calling the SDK", async () => {
    const result = await createDraft("department-a", "saveDraft");

    expect(result.init?.status).toBe(422);
    expect(result.data).toEqual({ error: { tag: "ContentDecodeError" } });
    expect(mocks.createCalls).toEqual([]);
  });
});
