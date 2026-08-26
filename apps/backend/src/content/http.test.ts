import { describe, expect, it } from "vitest";
import type { BackendRun } from "../router.js";
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
import type { ContentRequestActor } from "./http.js";
import {
  makeContentManagementApiHttp,
  makePublicNewsApiHttp,
} from "./http.js";
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
const failingRun =
  (journeyFailure: unknown) =>
  async (): Promise<never> => {
    throw journeyFailure;
  };

const okActorRun = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

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
      const api = makeContentManagementApiHttp(
        okActor,
        failingRun(failure) as never,
      );
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

  it("keeps a missing public slug indistinguishable and no-store", async () => {
    const readPublishedArticle = async (): Promise<never> => {
      throw Object.assign(new Error("gone"), { _tag: "ArticleNotFound" });
    };
    const readNewsListing = async (): Promise<never> => {
      throw Object.assign(new Error("gone"), { _tag: "ArticleNotFound" });
    };
    const api = makePublicNewsApiHttp(readNewsListing, readPublishedArticle);
    const missing = await api.fetch(jsonRequest("/api/news/finnes-ikke", "GET"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toEqual({ error: { tag: "ArticleNotFound" } });
  });

  it("serves the public listing with no-store headers", async () => {
    const listing = { articles: [{ slug: "a", title: "A", sticky: true }] };
    const api = makePublicNewsApiHttp(
      async () => listing,
      async () => ({}),
    );
    const response = await api.fetch(jsonRequest("/api/news", "GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(listing);
  });
});
