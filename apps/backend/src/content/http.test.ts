import { describe, expect, it } from "vitest";
import type { BackendRun } from "../router.js";
import {
  Content,
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
import { Database } from "@vektorprogrammet/domain/database";
import { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import type { ContentRequestActor } from "./http.js";
import {
  makeContentManagementTestHttp as makeContentManagementApiHttp,
  makePublicNewsTestHttp as makePublicNewsApiHttp,
} from "../test/native-http.js";
import { Effect } from "effect";

const actor: ContentRequestActor = {
  personId: "person-1" as never,
  authorizationInstant: "2031-09-15T12:00:00.000Z",
};

const okActor = async (): Promise<ContentRequestActor> => actor;

/**
 * A `run` stub that always rejects with the canned typed cause — the same
 * rejection channel the adapter's errorResponse observes in production.
 */
const failingRun = (journeyFailure: unknown) => async (): Promise<never> => {
  throw journeyFailure;
};

const okActorRun = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

const makePublicApi = (
  readNewsListing: (departmentId?: string) => Promise<unknown>,
  readPublishedArticle: (slug: string, versionNumber?: number) => Promise<unknown>,
) => {
  const service = Content.of({
    readNewsListing: (departmentId) =>
      Effect.tryPromise({
        try: () => readNewsListing(departmentId),
        catch: (cause) => cause,
      }) as never,
    readPublishedArticle: (slug, versionNumber) =>
      Effect.tryPromise({
        try: () => readPublishedArticle(slug, versionNumber),
        catch: (cause) => cause,
      }) as never,
  });
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Content, service),
        Effect.provideService(Database, {} as never),
        Effect.provideService(Organization, {} as never),
        Effect.provideService(Profile, {} as never),
      ) as Effect.Effect<A, E, never>,
    );
  return makePublicNewsApiHttp(run as BackendRun);
};

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
      { tag: "AuthorityInactive", status: 403, failure: new ContentAuthorityInactive({}) },
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
      { tag: "SlugConflict", status: 422, failure: new ContentSlugConflict({}) },
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
      const api = makeContentManagementApiHttp(okActor, failingRun(failure) as never);
      const response = await api.fetch(
        jsonRequest("/api/admin/content/articles", "POST", {
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

  it("maps unauthenticated actor resolution to 401", async () => {
    const rejectingResolveActor = async (): Promise<ContentRequestActor> => {
      throw Object.assign(new Error("no session"), { _tag: "UnauthenticatedActor" });
    };
    const api = makeContentManagementApiHttp(rejectingResolveActor, okActorRun as never);
    const response = await api.fetch(jsonRequest("/api/admin/content/workspace", "GET"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { tag: "UnauthenticatedActor" },
    });
  });

  it("rejects strict query parameters with 422", async () => {
    let ranEffect = false;
    const run = async <A>(effect: Effect.Effect<A, never, never>): Promise<A> => {
      ranEffect = true;
      return (await Effect.runPromise(effect)) as never;
    };
    const api = makeContentManagementApiHttp(okActor, run as unknown as BackendRun);
    const response = await api.fetch(jsonRequest("/api/admin/content/workspace?side=2", "GET"));
    expect(response.status).toBe(422);
    const duplicate = await api.fetch(
      jsonRequest("/api/admin/content/workspace?department=a&department=b", "GET"),
    );
    expect(duplicate.status).toBe(422);
    expect(ranEffect).toBe(false);
  });

  it("maps malformed and path-mismatched command bodies to 422 before running", async () => {
    let ranEffect = false;
    const run = async <A>(effect: Effect.Effect<A, never, never>): Promise<A> => {
      ranEffect = true;
      return (await Effect.runPromise(effect)) as never;
    };
    const api = makeContentManagementApiHttp(okActor, run as unknown as BackendRun);
    const excess = await api.fetch(
      jsonRequest("/api/admin/content/articles", "POST", {
        commandId: "create-extra",
        title: "T",
        bodyHtml: "<p>x</p>",
        departmentIds: [],
        operation: "legacy",
      }),
    );
    expect(excess.status).toBe(422);
    const mismatch = await api.fetch(
      jsonRequest("/api/admin/content/articles/7/publish", "POST", {
        commandId: "publish-mismatch",
        articleId: 8,
      }),
    );
    expect(mismatch.status).toBe(422);
    expect(ranEffect).toBe(false);
  });

  it("answers unknown staff paths with RouteNotFound 404", async () => {
    let ranEffect = false;
    const run = async <A>(effect: Effect.Effect<A, never, never>): Promise<A> => {
      ranEffect = true;
      return (await Effect.runPromise(effect)) as never;
    };
    const api = makeContentManagementApiHttp(okActor, run as unknown as BackendRun);
    const response = await api.fetch(jsonRequest("/api/admin/content/unknown", "GET"));
    expect(response.status).toBe(404);
    expect(ranEffect).toBe(false);
  });

  it("serves only the six frozen 0062.1 staff endpoint shapes and methods", async () => {
    const accepted = [
      jsonRequest("/api/admin/content/workspace", "GET"),
      jsonRequest("/api/admin/content/articles", "POST", {
        commandId: "create-1",
        title: "T",
        bodyHtml: "<p>x</p>",
        departmentIds: [],
      }),
      jsonRequest("/api/admin/content/articles/7", "GET"),
      jsonRequest("/api/admin/content/articles/7", "PUT", {
        commandId: "revise-1",
        articleId: 7,
        expectedRevision: 0,
        title: "T",
        bodyHtml: "<p>x</p>",
        departmentIds: [],
        sticky: false,
      }),
      jsonRequest("/api/admin/content/articles/7/publish", "POST", {
        commandId: "publish-1",
        articleId: 7,
      }),
      jsonRequest("/api/admin/content/articles/7/unpublish", "POST", {
        commandId: "unpublish-1",
        articleId: 7,
      }),
    ];
    for (const request of accepted) {
      const api = makeContentManagementApiHttp(
        okActor,
        failingRun(new ContentNotInScope({})) as never,
      );
      const response = await api.fetch(request);
      expect(response.status).toBe(403);
    }

    const aliases = [
      jsonRequest("/api/admin/content/drafts", "POST", {
        commandId: "off-spec-create",
        title: "T",
        bodyHtml: "<p>x</p>",
        departmentIds: [],
      }),
      jsonRequest("/api/admin/content", "POST", {
        operation: "publish",
        commandId: "alias-1",
        articleId: 7,
      }),
      jsonRequest("/api/admin/content/drafts/7", "PUT", {
        commandId: "alias-2",
      }),
      jsonRequest("/api/admin/content/drafts/7", "PATCH", {
        commandId: "alias-3",
      }),
      jsonRequest("/api/admin/content/drafts/7/publish", "POST", {
        commandId: "alias-4",
      }),
      jsonRequest("/api/admin/content/drafts/7/unpublish", "POST", {
        commandId: "alias-5",
      }),
      jsonRequest("/api/admin/content/articles/7", "PATCH", {
        commandId: "alias-6",
      }),
    ];
    for (const request of aliases) {
      const api = makeContentManagementApiHttp(
        okActor,
        failingRun(new Error("an alias must never invoke a journey")) as never,
      );
      const response = await api.fetch(request);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { tag: "RouteNotFound" } });
    }
  });
  it("maps staff detail scope denial to 403 and absence to 404", async () => {
    for (const [failure, status, tag] of [
      [new ContentDraftNotOwned({ articleId: 7 as never }), 403, "DraftNotOwned"],
      [Object.assign(new Error("missing"), { _tag: "ArticleNotFound" }), 404, "ArticleNotFound"],
    ] as const) {
      const api = makeContentManagementApiHttp(okActor, failingRun(failure) as never);
      const response = await api.fetch(jsonRequest("/api/admin/content/articles/7", "GET"));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: { tag } });
    }

    let ranEffect = false;
    const api = makeContentManagementApiHttp(okActor, (async () => {
      ranEffect = true;
      return undefined as never;
    }) as BackendRun);
    const strictQuery = await api.fetch(
      jsonRequest("/api/admin/content/articles/7?include=authorId", "GET"),
    );
    expect(strictQuery.status).toBe(422);
    expect(ranEffect).toBe(false);
  });

  it("keeps a missing public slug indistinguishable and no-store", async () => {
    const readPublishedArticle = async (): Promise<never> => {
      throw Object.assign(new Error("gone"), { _tag: "ArticleNotFound" });
    };
    const readNewsListing = async (): Promise<never> => {
      throw Object.assign(new Error("gone"), { _tag: "ArticleNotFound" });
    };
    const api = makePublicApi(readNewsListing, readPublishedArticle);
    const missing = await api.fetch(jsonRequest("/api/news/finnes-ikke", "GET"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toEqual({ error: { tag: "ArticleNotFound" } });
  });

  it("serves the public listing with no-store headers", async () => {
    const listing = { articles: [{ slug: "a", title: "A", sticky: true }] };
    const api = makePublicApi(
      async () => listing,
      async () => ({}),
    );
    const response = await api.fetch(jsonRequest("/api/news", "GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(listing);
  });

  it("threads the public department filter and rejects unknown or excess query input", async () => {
    const requestedDepartments: Array<string | undefined> = [];
    const listing = { articles: [{ slug: "organization-wide" }, { slug: "department-a" }] };
    const api = makePublicApi(
      async (departmentId) => {
        requestedDepartments.push(departmentId);
        if (departmentId === "unknown") {
          throw new ContentDepartmentNotFound({ departmentId: departmentId as never });
        }
        return listing;
      },
      async () => ({}),
    );

    const narrowed = await api.fetch(jsonRequest("/api/news?department=department-a", "GET"));
    expect(narrowed.status).toBe(200);
    expect(requestedDepartments).toEqual(["department-a"]);
    await expect(narrowed.json()).resolves.toEqual(listing);

    const unknown = await api.fetch(jsonRequest("/api/news?department=unknown", "GET"));
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toEqual({ error: { tag: "DepartmentNotFound" } });

    const excess = await api.fetch(jsonRequest("/api/news?department=department-a&page=1", "GET"));
    expect(excess.status).toBe(422);
    await expect(excess.json()).resolves.toEqual({ error: { tag: "ContentDecodeError" } });
  });
});
