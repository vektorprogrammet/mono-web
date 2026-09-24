import { Scene } from "foldkit/test";
import { commandsFor } from "./command";
import { createBrowserContentWorkspaceClient } from "./browser-client";
import { updateFor } from "./update";

const config = {update: updateFor(commandsFor(createBrowserContentWorkspaceClient("/content"))), view};

import { ArticleId, type ContentWorkspace } from "@vektorprogrammet/http-api"
import { DepartmentId } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { describe, it } from "vitest";
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
