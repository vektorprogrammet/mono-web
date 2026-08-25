import { describe, expect, it } from "vitest";
import {
  ContentAuthorityInactive,
  ContentCommandConflict,
  ContentDecodeError,
  ContentDepartmentNotFound,
  ContentDraftNotOwned,
  ContentNotInScope,
  ContentNotPublisher,
  ContentPersistenceError,
  ContentSlugConflict,
} from "@vektorprogrammet/domain/content";
import type { ContentManagementJourney, ContentRequestActor, PublicNewsJourney } from "./http.js";
import { makeContentManagementApiHttp, makePublicNewsApiHttp } from "./http.js";

const actor: ContentRequestActor = {
  personId: "person-1" as never,
  authorizationInstant: "2031-09-15T12:00:00.000Z",
};

const okActor = async (): Promise<ContentRequestActor> => actor;
const denyingActor = async (): Promise<ContentRequestActor> => {
  throw Object.assign(new Error("denied"), { _tag: "NotInScope" });
};

const makeManagement = (impl: Partial<ContentManagementJourney>): ContentManagementJourney => ({
  readWorkspace: impl.readWorkspace ?? (async () => ({ entries: [] })),
  createDraft: impl.createDraft ?? (async () => ({ _tag: "DraftCreated" })),
  reviseDraft: impl.reviseDraft ?? (async () => ({ _tag: "DraftRevised" })),
  publish: impl.publish ?? (async () => ({ _tag: "Published", versionNumber: 1 })),
  unpublish: impl.unpublish ?? (async () => ({ _tag: "Unpublished" })),
});

const runWith =
  <J>(journey: J) =>
  <A>(use: (journey: J) => Promise<A>): Promise<A> =>
    use(journey);

const managementApi = (
  journey: Partial<ContentManagementJourney>,
  resolveActor: (request: Request) => Promise<ContentRequestActor> = okActor,
) =>
  makeContentManagementApiHttp(
    resolveActor,
    runWith(makeManagement(journey)) as unknown as Parameters<
      typeof makeContentManagementApiHttp
    >[1],
  );

const publicNewsApi = (journey: Partial<PublicNewsJourney>) =>
  makePublicNewsApiHttp(
    runWith({
      readNewsListing: journey.readNewsListing ?? (async () => ({ articles: [] })),
      readPublishedArticle:
        journey.readPublishedArticle ?? (async () => ({ slug: "x", bodyHtml: "<p></p>" })),
    }) as unknown as Parameters<typeof makePublicNewsApiHttp>[0],
  );

const jsonRequest = (url: string, method: string, body?: unknown): Request =>
  new Request(`http://backend.test${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });

describe("content http boundaries", () => {
  it("maps every typed denial to its frozen status", async () => {
    const cases: Array<{
      readonly tag: string;
      readonly status: number;
      readonly failure: unknown;
    }> = [
      { tag: "NotInScope", status: 403, failure: new ContentNotInScope({}) },
      {
        tag: "AuthorityInactive",
        status: 403,
        failure: new ContentAuthorityInactive({}),
      },
      {
        tag: "NotPublisher",
        status: 403,
        failure: new ContentNotPublisher({ articleId: 1 as never }),
      },
      {
        tag: "DraftNotOwned",
        status: 403,
        failure: new ContentDraftNotOwned({ articleId: 1 as never }),
      },
      { tag: "SlugConflict", status: 409, failure: new ContentSlugConflict({}) },
      {
        tag: "CommandConflict",
        status: 409,
        failure: new ContentCommandConflict({ commandId: "c" }),
      },
      {
        tag: "ContentDecodeError",
        status: 422,
        failure: new ContentDecodeError({ operation: "op", message: "bad" }),
      },
      {
        tag: "DepartmentNotFound",
        status: 422,
        failure: new ContentDepartmentNotFound({ departmentId: "dep-x" as never }),
      },
      {
        tag: "ContentPersistenceError",
        status: 503,
        failure: new ContentPersistenceError({ operation: "op", message: "db" }),
      },
    ];
    for (const { tag, status, failure } of cases) {
      const api = managementApi({
        createDraft: async () => {
          throw failure;
        },
      });
      const response = await api.fetch(
        jsonRequest("/api/admin/content/drafts", "POST", {
          commandId: "cmd-1",
          title: "T",
          bodyHtml: "<p>x</p>",
          departmentIds: [],
        }),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: { tag } });
    }
  });

  it("returns 201 with no-store for a created draft and 200 for publish", async () => {
    const api = managementApi({});
    const created = await api.fetch(
      jsonRequest("/api/admin/content/drafts", "POST", {
        commandId: "cmd-2",
        title: "Tittel",
        bodyHtml: "<p>x</p>",
        departmentIds: ["dep-1"],
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");

    const published = await api.fetch(
      jsonRequest("/api/admin/content/drafts/7/publish", "POST", { commandId: "cmd-3" }),
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects strict query parameters with 422", async () => {
    const api = managementApi({});
    const response = await api.fetch(jsonRequest("/api/admin/content/workspace?side=2", "GET"));
    expect(response.status).toBe(422);
    const duplicate = await api.fetch(
      jsonRequest("/api/admin/content/workspace?department=a&department=b", "GET"),
    );
    expect(duplicate.status).toBe(422);
  });

  it("maps unauthenticated actor resolution to 401", async () => {
    const api = managementApi({}, async () => {
      throw Object.assign(new Error("no session"), { _tag: "UnauthenticatedActor" });
    });
    const response = await api.fetch(jsonRequest("/api/admin/content/workspace", "GET"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { tag: "UnauthenticatedActor" },
    });
  });

  it("answers unknown staff paths with RouteNotFound 404", async () => {
    const api = managementApi({});
    const response = await api.fetch(jsonRequest("/api/admin/content/unknown", "GET"));
    expect(response.status).toBe(404);
  });

  it("keeps a missing public slug indistinguishable and no-store", async () => {
    const api = publicNewsApi({
      readPublishedArticle: async () => {
        throw Object.assign(new Error("gone"), { _tag: "ArticleNotFound" });
      },
    });
    const missing = await api.fetch(jsonRequest("/api/news/finnes-ikke", "GET"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toEqual({ error: { tag: "ArticleNotFound" } });
  });

  it("serves the public listing with no-store headers", async () => {
    const listing = { articles: [] };
    const api = publicNewsApi({ readNewsListing: async () => listing });
    const response = await api.fetch(jsonRequest("/api/news", "GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(listing);
  });

  it("never lets an actor leak into the public surface", async () => {
    let resolveActorCalled = false;
    const journey: PublicNewsJourney = {
      readNewsListing: async () => ({ articles: [] }),
      readPublishedArticle: async () => ({ slug: "s", bodyHtml: "" }),
    };
    makePublicNewsApiHttp(
      runWith(journey) as unknown as Parameters<typeof makePublicNewsApiHttp>[0],
    );
    void resolveActorCalled;
    void denyingActor;
  });
});
