import {
  ContentAuthorityInactive,
  ContentDepartmentNotFound,
  ContentNotInScope,
} from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserContentWorkspaceClient, type ContentWorkspaceClient } from "./browser-client";
import { failureFrom, makeContentWorkspaceCommands } from "./command";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Content workspace failure classification", () => {
  it("renders internal Content denial tags as denials", () => {
    expect(failureFrom(new ContentAuthorityInactive())).toEqual({
      _tag: "Denied",
      tag: "AuthorityInactive",
      message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
    });
    expect(failureFrom(new ContentNotInScope())).toEqual({
      _tag: "Denied",
      tag: "NotInScope",
      message: "Du har ikke tilgang til artikkeladministrasjon.",
    });
    expect(failureFrom(new ContentDepartmentNotFound())).toEqual({
      _tag: "Failed",
      tag: "DepartmentNotFound",
      message: "En valgt avdeling finnes ikke lenger.",
    });
  });

  it("preserves a failed create tag and never reloads the workspace", async () => {
    let workspaceLoads = 0;
    const client: ContentWorkspaceClient = {
      admin: {
        content: {
          workspace: () => {
            workspaceLoads += 1;
            return Effect.succeed({ workspace: { entries: [] }, knownDepartments: [] });
          },
          readArticle: () => Effect.die("unexpected detail"),
          createDraft: () => Effect.fail(new ContentNotInScope()),
          reviseDraft: () => Effect.die("unexpected revise"),
          publish: () => Effect.die("unexpected publish"),
          unpublish: () => Effect.die("unexpected unpublish"),
        },
      },
    };
    const message = await Effect.runPromise(
      makeContentWorkspaceCommands(client).SubmitCreate({
        requestId: 2,
        commandId: "create-denied",
        title: "Tittel",
        bodyHtml: "<p>Brødtekst</p>",
        departmentIds: ["department-a"],
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

  it("preserves DepartmentNotFound from the bridge into a typed FailedCommand message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { tag: "DepartmentNotFound" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createBrowserContentWorkspaceClient();
    const failure = await Effect.runPromise(
      client.admin.content
        .createDraft({
          commandId: "department-gone",
          title: "Tittel",
          bodyHtml: "<p>Brødtekst</p>",
          departmentIds: ["department-gone"],
        } as never)
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
  it("strictly decodes a working-copy detail through the confined bridge", async () => {
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await Effect.runPromise(
      createBrowserContentWorkspaceClient().admin.content.readArticle(7),
    );
    expect(result).toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      "/content",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operation: "readArticle", articleId: 7 }),
      }),
    );
  });

  it("turns an unknown bridge tag into ContentDecodeError instead of trusting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { tag: "SpoofedAuthority" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createBrowserContentWorkspaceClient();
    const failure = await Effect.runPromise(
      client.admin.content.workspace().pipe(
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
