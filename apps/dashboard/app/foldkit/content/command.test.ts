import { ArticleId } from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentBridgeFailure } from "./bridge";
import { createBrowserContentWorkspaceClient, type ContentWorkspaceClient } from "./browser-client";
import { failureFrom, makeContentWorkspaceCommands } from "./command";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Content workspace failure classification", () => {
  it("renders bridge denial tags as denials", () => {
    expect(failureFrom(contentBridgeFailure("AuthorityInactive"))).toEqual({
      _tag: "Denied",
      tag: "AuthorityInactive",
      message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
    });
    expect(failureFrom(contentBridgeFailure("NotInScope"))).toEqual({
      _tag: "Denied",
      tag: "NotInScope",
      message: "Du har ikke tilgang til artikkeladministrasjon.",
    });
    expect(failureFrom(contentBridgeFailure("DepartmentNotFound"))).toEqual({
      _tag: "Failed",
      tag: "DepartmentNotFound",
      message: "En valgt avdeling finnes ikke lenger.",
    });
  });

  it("preserves a failed create tag and never reloads the workspace", async () => {
    let workspaceLoads = 0;
    const client: ContentWorkspaceClient = {
      content: {
        readContentWorkspace: () => {
          workspaceLoads += 1;
          return Effect.succeed({ workspace: { entries: [] }, knownDepartments: [] });
        },
        readArticle: () => Effect.die("unexpected detail"),
        createArticle: () => Effect.fail(contentBridgeFailure("NotInScope")),
        reviseArticle: () => Effect.die("unexpected revise"),
        publishArticle: () => Effect.die("unexpected publish"),
        unpublishArticle: () => Effect.die("unexpected unpublish"),
      },
    };
    const message = await Effect.runPromise(
      makeContentWorkspaceCommands(client).SubmitCreate({
        requestId: 2,
        commandId: IdempotencyKey.make("create-denied-command"),
        title: "Tittel",
        bodyHtml: "<p>Brødtekst</p>",
        departmentIds: [DepartmentId.make("department-a")],
        sticky: false,
      }).effect,
    );

    expect(message).toEqual({
      _tag: "FailedCommand",
      requestId: 2,
      failure: {
        _tag: "Denied",
        tag: "NotInScope",
        message: "Du har ikke tilgang til artikkeladministrasjon.",
      },
    });
    expect(workspaceLoads).toBe(0);
  });

  it("preserves DepartmentNotFound from the bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { tag: "DepartmentNotFound" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const failure = await Effect.runPromise(
      createBrowserContentWorkspaceClient()
        .content.createArticle({
          commandId: IdempotencyKey.make("department-gone-command"),
          title: "Tittel",
          bodyHtml: "<p>Brødtekst</p>",
          departmentIds: [DepartmentId.make("department-gone")],
          sticky: false,
        })
        .pipe(
          Effect.map(() => undefined),
          Effect.catch((error) => Effect.succeed(failureFrom(error))),
        ),
    );

    expect(failure).toEqual({
      _tag: "Failed",
      tag: "DepartmentNotFound",
      message: "En valgt avdeling finnes ikke lenger.",
    });
  });

  it("strictly decodes a working-copy observation through the bridge", async () => {
    const detail = {
      articleId: 7,
      title: "Tittel",
      slug: "tittel",
      status: "Draft",
      bodyHtml: "<p>Eksakt brødtekst</p>",
      sticky: false,
      createdAt: "2031-01-01T00:00:00.000Z",
      updatedAt: "2031-01-01T00:01:00.000Z",
      currentVersionNumber: null,
      revision: 2,
      departmentIds: ["department-a"],
      canRevise: true,
      canPublish: false,
      authorDisplayName: "Forfatter",
    };
    const observation = {
      body: detail,
      etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(observation), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await Effect.runPromise(
      createBrowserContentWorkspaceClient().content.readArticle({ articleId: ArticleId.make(7) }),
    );
    expect(result).toEqual(observation);
    expect(fetchMock).toHaveBeenCalledWith(
      "/content",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operation: "readArticle", articleId: 7 }),
      }),
    );
  });

  it("turns an unknown bridge tag into ContentDecodeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { tag: "SpoofedAuthority" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const failure = await Effect.runPromise(
      createBrowserContentWorkspaceClient().content.readContentWorkspace().pipe(
        Effect.map(() => undefined),
        Effect.catch((error) => Effect.succeed(failureFrom(error))),
      ),
    );

    expect(failure).toEqual({
      _tag: "Failed",
      tag: "ContentDecodeError",
      message: "Artikkeldataene hadde et ugyldig format.",
    });
  });
});
