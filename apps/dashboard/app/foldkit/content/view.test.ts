// @vitest-environment happy-dom
import { Effect, Schema } from "effect";
import { Scene } from "foldkit/test";
import { commandsFor } from "./command";
import { createBrowserContentWorkspaceClient, type ContentWorkspaceClient } from "./browser-client";
import { ContentArticleObservationSchema, ContentWorkspaceBootstrapSchema } from "./bridge";
import { embedContentWorkspace } from "./main";
import { updateFor } from "./update";

const config = {update: updateFor(commandsFor(createBrowserContentWorkspaceClient("/content"))), view};

import { ArticleId, type ContentWorkspace } from "@vektorprogrammet/http-api"
import { DepartmentId } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { describe, expect, it, vi } from "vitest";
import { init, type Model, ContentWorkspaceData } from "./model";
import { view } from "./view";

const departmentA = DepartmentId.make("department-a");

const departmentB = DepartmentId.make("department-b");

const articleId = ArticleId.make(1);

const workspace: ContentWorkspace = { entries: [] };

const readyModel = (): Model => ({
  ...init(),
  workspace: ContentWorkspaceData.Success({data: workspace}),
  knownDepartments: [
    { departmentId: departmentA, name: "Trondheim" },
    { departmentId: departmentB, name: "Bergen" },
  ],
});

describe("Foldkit content workspace view", () => {
  it("renders active Organization departments for creation and filtering with no articles", () => {
    Scene.scene(config, Scene.given(readyModel()),
      Scene.expect(Scene.selector("#content-dept-department-a")).toBeVisible(),
      Scene.expect(Scene.selector("#content-dept-department-b")).toBeVisible(),
      Scene.expect(Scene.role("option", {name: "Trondheim"})).toHaveValue(departmentA),
      Scene.expect(Scene.role("option", {name: "Bergen"})).toHaveValue(departmentB),
      Scene.expect(Scene.text("Ingen artikler i denne visningen.")).toBeVisible(),
    );
  });

  it("does not render an unsafe revise control without a full working-copy revision", () => {
    const unavailable: Model = {
      ...readyModel(),
      selectedArticleId: articleId,
      selectedEtag: null,
      dirty: true,
      editor: {
        title: "Tittel",
        bodyHtml: "<p>Bevarte byte</p>",
        departmentIds: [departmentA],
        sticky: false,
      },
    };

    Scene.scene(config, Scene.given(unavailable),
      Scene.expectAll(Scene.all.selector("#content-editor-revise")).toBeEmpty(),
    );
    Scene.scene(config, Scene.given({...unavailable, selectedEtag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')}),
      Scene.expect(Scene.selector("#content-editor-revise")).toBeEnabled(),
    );
  });
});

it("keeps a row's publish command on its article when the reload after a save reorders the rows", async () => {
  const twoVersions = {
    articleId: 5,
    title: "To versjoner",
    slug: "to-versjoner",
    status: "Published" as const,
    sticky: false,
    updatedAt: "2031-06-04T00:00:00.000Z",
    departmentIds: [departmentA],
    canRevise: true,
    canPublish: true,
    authorDisplayName: "Erik Forfatter",
  };

  const fresh = {
    ...twoVersions,
    articleId: 6,
    title: "Fersk nyhet fra admin",
    slug: "fersk-nyhet-fra-admin",
    updatedAt: "2031-06-05T00:00:00.000Z",
  };

  const revised = { ...twoVersions, updatedAt: "2031-06-06T00:00:00.000Z" };
  const knownDepartments = [{ departmentId: departmentA, name: "Trondheim" }];

  // The workspace lists entries by updatedAt DESC, so the reload after the save moves the
  // revised article above the other one.
  const listings = Schema.decodeSync(
    Schema.Struct({ before: ContentWorkspaceBootstrapSchema, after: ContentWorkspaceBootstrapSchema }),
  )({
    before: { workspace: { entries: [fresh, twoVersions] }, knownDepartments },
    after: { workspace: { entries: [revised, fresh] }, knownDepartments },
  });

  const observations = Schema.decodeSync(
    Schema.Struct({ detail: ContentArticleObservationSchema, saved: ContentArticleObservationSchema }),
  )({
    detail: {
      body: {
        ...twoVersions,
        bodyHtml: "<p>Versjon én tekst</p>",
        createdAt: "2031-06-01T00:00:00.000Z",
        currentVersionNumber: 1,
        revision: 1,
      },
      etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    },
    saved: {
      body: {
        ...revised,
        bodyHtml: "<p>Versjon to tekst</p>",
        createdAt: "2031-06-01T00:00:00.000Z",
        currentVersionNumber: 1,
        revision: 2,
      },
      etag: '"vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"',
    },
  });

  let releaseReload = () => {};

  const reloadReleased = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });

  let loads = 0;
  const published: Array<number> = [];

  const client: ContentWorkspaceClient = {
    content: {
      readContentWorkspace: Effect.suspend(() => {
        loads += 1;

        return loads === 1
          ? Effect.succeed(listings.before)
          : Effect.as(Effect.promise(() => reloadReleased), listings.after);
      }),
      readArticle: () => Effect.succeed(observations.detail),
      reviseArticle: () => Effect.succeed(observations.saved),
      publishArticle: ({ articleId }) =>
        Effect.sync(() => {
          published.push(articleId);
        }),
      createArticle: () => Effect.die("unexpected create"),
      unpublishArticle: () => Effect.die("unexpected unpublish"),
    },
  };

  const container = document.createElement("div");
  container.id = "content-workspace-reorder-test";
  document.body.append(container);
  const dispose = embedContentWorkspace(container, { client });

  // The runtime patches the container into its own root, so the test queries the document.
  try {
    await vi.waitFor(() => expect(document.querySelector('li[data-article-id="5"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('li[data-article-id="5"] button')!.click();
    const body = document.querySelector<HTMLTextAreaElement>("#content-editor-body")!;
    await vi.waitFor(() => expect(body.value).toBe("<p>Versjon én tekst</p>"));
    body.value = "<p>Versjon to tekst</p>";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("#content-editor-revise")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("#content-editor-revise")!.click();

    // The save settles before its reload arrives. A user or a browser driver holds the
    // "Publiser" control of the "To versjoner" row while the reload reorders the rows.
    await vi.waitFor(() => {
      expect(loads).toBe(2);
      expect(document.querySelector('[data-dirty="false"]')).not.toBeNull();
    });

    const publish = [...document.querySelectorAll<HTMLButtonElement>('li[data-article-id="5"] button')].find(
      (button) => button.textContent === "Publiser",
    )!;

    releaseReload();
    await vi.waitFor(() => expect(document.querySelector("li")!.textContent).toContain("To versjoner"));
    publish.click();

    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published).toEqual([5]);
  } finally {
    dispose();
    await vi.waitFor(() => expect(document.querySelector(".content-workspace")).toBeNull());
    document.getElementById("content-workspace-reorder-test")?.remove();
  }
});
