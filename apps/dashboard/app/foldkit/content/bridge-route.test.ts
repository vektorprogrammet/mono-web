import { Exit, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeArgs, sessionCookie } from "../../../test/native-http";
import {
  isNativeRpcRequest,
  nativeRpcProblem,
  nativeRpcSuccess,
  nativeSession,
  readNativeRpcCall,
  type NativeRpcCall,
} from "../../../test/native-rpc";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action, loader } from "../../routes/__foldkit.content";

const etag = `"vkr2.${"A".repeat(43)}"`;

/** One draft as `content.readArticle` encodes it. */
const article = {
  articleId: 7,
  title: "Opptak 2026",
  slug: "opptak-2026",
  status: "Draft",
  bodyHtml: "<p>Informasjon om opptak.</p>",
  sticky: false,
  createdAt: "2026-08-20T09:00:00.000Z",
  updatedAt: "2026-08-24T09:00:00.000Z",
  currentVersionNumber: null,
  revision: 0,
  departmentIds: ["department-a"],
  canRevise: true,
  canPublish: true,
  authorDisplayName: "Kari Penerbit",
};

/** A department as `organization.listDepartments` encodes it. */
const department = (departmentId: string, name: string, active: boolean) => ({
  departmentId,
  name,
  shortName: name.slice(0, 3),
  email: `${departmentId}@example.invalid`,
  address: null,
  city: name,
  latitude: null,
  longitude: null,
  slackChannel: null,
  logoPath: null,
  active,
  revision: 0,
});

const departments = [
  department("department-a", "Trondheim", true),
  department("department-b", "Bergen", true),
  department("department-old", "Tidligere", false),
];

const RpcExitMessage = Schema.TaggedStruct("Exit", {
  requestId: Schema.Union([Schema.String, Schema.Finite]),
  exit: Schema.Json,
});

const encodeJsonExit = Schema.encodeSync(
  Schema.toCodecJson(Schema.Exit(Schema.Json, Schema.Json, Schema.Json)),
);

/** Answers `call` with a failure that is no declared problem. */
const undeclaredFailure = (call: NativeRpcCall, failure: Schema.Json) =>
  Response.json([
    RpcExitMessage.make({ requestId: call.id, exit: encodeJsonExit(Exit.fail(failure)) }),
  ]);

const calls: NativeRpcCall[] = [];

let workspaceAnswer = (call: NativeRpcCall) => nativeRpcSuccess(call, { entries: [] });

let createAnswer = (call: NativeRpcCall) => nativeRpcProblem(call, "authority.denied");

const loadWorkspace = () =>
  loader(
    routeArgs(
      new Request("http://dashboard.test/content", { headers: { cookie: sessionCookie } }),
      {},
    ),
  );

const post = (body: string) =>
  action(
    routeArgs(
      new Request("http://dashboard.test/content", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body,
      }),
      {},
    ),
  );

beforeEach(() => {
  calls.length = 0;
  workspaceAnswer = (call) => nativeRpcSuccess(call, { entries: [] });
  createAnswer = (call) => nativeRpcProblem(call, "authority.denied");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (!isNativeRpcRequest(input)) {
        throw new Error(`Unexpected content request: ${new Request(input, init).url}`);
      }

      const call = await readNativeRpcCall(input, init);
      calls.push(call);

      switch (call.tag) {
        case "system.readSession":
          return nativeRpcSuccess(call, nativeSession);
        case "organization.listDepartments":
          return nativeRpcSuccess(call, departments);
        case "content.readContentWorkspace":
          return workspaceAnswer(call);
        case "content.readArticle":
          return nativeRpcSuccess(call, { article, etag });
        case "content.createArticle":
          return createAnswer(call);
        default:
          throw new Error(`Unexpected content call: ${call.tag}`);
      }
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("Content bridge denial decoding", () => {
  it("maps canonical authority denial across the RPC client", async () => {
    workspaceAnswer = (call) => nativeRpcProblem(call, "authority.denied");
    const result = await loadWorkspace();
    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "NotInScope" } });
  });

  it.each<Schema.Json>([
    Schema.TaggedStruct("AuthorityInactive", {}).make({}),
    { code: "made-up.failure" },
  ])(
    "does not grant authority to a failure that is no declared problem: %o",
    async (failure) => {
      workspaceAnswer = (call) => undeclaredFailure(call, failure);
      const result = await loadWorkspace();
      expect(result.init?.status).toBe(503);
      expect(result.data).toEqual({ error: { tag: "ContentPersistenceError" } });
    },
  );

  it("returns only active department choices even when the workspace is empty", async () => {
    const result = await loadWorkspace();
    expect(result.data).toEqual({
      workspace: { entries: [] },
      knownDepartments: [
        { departmentId: "department-a", name: "Trondheim" },
        { departmentId: "department-b", name: "Bergen" },
      ],
    });
  });

  it("does not let a visible department choice override server authority", async () => {
    await loadWorkspace();

    const result = await post(
      JSON.stringify({
        operation: "createDraft",
        commandId: "AAAAAAAAAAAAAAAAAAAAAA",
        title: "Tittel",
        bodyHtml: "<p>Brødtekst</p>",
        departmentIds: ["department-b"],
        sticky: false,
      }),
    );

    expect(result.init?.status).toBe(403);
    expect(result.data).toEqual({ error: { tag: "NotInScope" } });
    expect(calls.find((call) => call.tag === "content.createArticle")?.payload).toEqual({
      idempotencyKey: "AAAAAAAAAAAAAAAAAAAAAA",
      request: {
        title: "Tittel",
        bodyHtml: "<p>Brødtekst</p>",
        departmentIds: ["department-b"],
        sticky: false,
      },
    });
  });

  it("reads private detail but rejects caller-supplied authority fields before dispatch", async () => {
    const result = await post('{"operation":"readArticle","articleId":7}');
    expect(result.data).toEqual({ body: article, etag });

    const reads = () => calls.filter((call) => call.tag === "content.readArticle").length;
    const before = reads();

    const polluted = await post(
      '{"operation":"readArticle","articleId":7,"createdByPersonId":"person-secret"}',
    );

    expect(polluted.init?.status).toBe(422);
    expect(polluted.data).toEqual({ error: { tag: "ContentDecodeError" } });
    expect(reads()).toBe(before);
  });

  it("rejects unknown operations without a content write", async () => {
    const result = await post('{"operation":"saveDraft","articleId":7}');
    expect(result.init?.status).toBe(422);
    expect(calls.some((call) => call.tag.startsWith("content."))).toBe(false);
  });
});
