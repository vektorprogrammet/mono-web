import { ArticleId, ArticleSlug, type ContentWorkspace } from "@vektorprogrammet/http-api"
import { DepartmentId } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import { ChangedDepartmentFilter, RetriedWorkspace, LoadedWorkspace, FailedWorkspace, SelectedArticle, LoadedArticleDetail, EditedField, SubmittedRevise, SucceededSave, SubmittedPublish, SubmittedUnpublish, FailedCommand, DismissedBanner } from "./message";
import { init, type Model, ContentFailure, ContentWorkspaceData } from "./model";
import { updateFor, type WorkspaceCommandFactories } from "./update";
import { Effect } from "effect";


const departmentA = DepartmentId.make("department-a");

const article1 = ArticleId.make(1);

const article2 = ArticleId.make(2);

const etag3 = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');

const etag4 = StrongETag.make('"vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"');

const knownDepartments = [{ departmentId: departmentA, name: "Trondheim" }];

const savedDraft = {
  articleId: article1,
  title: "Min kladd",
  slug: ArticleSlug.make("min-kladd"),
  bodyHtml: "<p>Lagret brødtekst</p>",
  sticky: false,
  createdAt: "2031-02-01T00:00:00.000Z",
  updatedAt: "2031-02-01T01:00:00.000Z",
  currentVersionNumber: null,
  revision: 3,
  status: "Draft" as const,
  departmentIds: [departmentA],
  canRevise: true,
  canPublish: false,
  authorDisplayName: "Erik Editor",
};

const workspace: ContentWorkspace = {
  entries: [
    {
      articleId: article2,
      title: "Publisert artikkel",
      slug: ArticleSlug.make("publisert-artikkel"),
      status: "Published",
      sticky: true,
      updatedAt: "2031-03-01T00:00:00.000Z",
      departmentIds: [departmentA],
      canRevise: true,
      canPublish: true,
      authorDisplayName: "Ada Administrator",
    },
    {
      articleId: article1,
      title: "Min kladd",
      slug: ArticleSlug.make("min-kladd"),
      status: "Draft",
      sticky: false,
      updatedAt: "2031-02-01T00:00:00.000Z",
      departmentIds: [departmentA],
      canRevise: true,
      canPublish: false,
      authorDisplayName: "Erik Editor",
    },
  ],
};

const recordingCommands = (issued: Array<string>): WorkspaceCommandFactories => ({
  LoadWorkspace: ({ requestId }) => {
    issued.push(`load:${requestId}`);

    return { name: "LoadContentWorkspace", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
  LoadArticleDetail: ({ requestId, articleId }) => {
    issued.push(`detail:${requestId}:${articleId}`);

    return { name: "LoadContentArticleDetail", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
  SubmitCreate: ({ requestId }) => {
    issued.push(`create:${requestId}`);

    return { name: "SubmitContentCreate", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
  SubmitRevise: ({ requestId, expectedEtag }) => {
    issued.push(`revise:${requestId}:${expectedEtag}`);

    return { name: "SubmitContentRevise", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
  SubmitPublish: ({ requestId }) => {
    issued.push(`publish:${requestId}`);

    return { name: "SubmitContentPublish", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
  SubmitUnpublish: ({ requestId }) => {
    issued.push(`unpublish:${requestId}`);

    return { name: "SubmitContentUnpublish", args: { requestId }, effect: Effect.die("Recording command must not execute") };
  },
});

const issued: Array<string> = [];

const commands = recordingCommands(issued);

const update = updateFor(commands);

const modelWithWorkspace = (): Model => ({
  ...init(),
  workspace: ContentWorkspaceData.Success({data: workspace}),
  knownDepartments,
});

describe("Foldkit content workspace transitions", () => {
  it("accepts a fresh workspace load and rejects a stale one", () => {
    const initial = init();

    const loaded = update(initial, LoadedWorkspace({
      requestId: 1,
      workspace,
      knownDepartments,
    }));

    expect(loaded.model.workspace._tag).toBe("Success");

    // Stale success with mismatched requestId leaves the Model unchanged.
    const stale = update(initial, LoadedWorkspace({
      requestId: 99,
      workspace,
      knownDepartments,
    }));

    expect(stale).toEqual({ model: initial, commands: [] });
  });

  it("retry increments identity and retry count and issues exactly one new load", () => {
    const initial = init();
    const { model: retried, commands: emitted = [] } = update(initial, RetriedWorkspace());
    expect(retried.requestId).toBe(2);
    expect(retried.retryCount).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(issued.filter((entry) => entry === "load:2")).toHaveLength(1);

    // A late failure from request 1 must not touch the retried Model.
    const staleFailure = update(retried, FailedWorkspace({
      requestId: 1,
      failure: ContentFailure.cases.Failed.make({ tag: "ContentPersistenceError", message: "sen" }),
    }));

    expect(staleFailure.model.workspace._tag).toBe("Loading");
    expect(staleFailure.model.banner).toBeNull();

    // A failure for the current request renders the banner.
    const currentFailure = update(retried, FailedWorkspace({
      requestId: 2,
      failure: ContentFailure.cases.Denied.make({ tag: "NotInScope", message: "ikke tilgang" }),
    }));

    expect(currentFailure.model.banner).toEqual(ContentFailure.cases.Denied.make({
      tag: "NotInScope",
      message: "ikke tilgang",
    }));
  });

  it("loads an exact working copy before exposing body and revision", () => {
    const initial = {
      ...modelWithWorkspace(),
      editor: {
        ...modelWithWorkspace().editor,
        bodyHtml: "<p>En annen arbeidskopi</p>",
      },
    };

    const before = issued.length;
    const selected = update(initial, SelectedArticle({ articleId: article1 }));
    expect(selected.model.selectedArticleId).toBe(article1);
    expect(selected.model.selectedEtag).toBeNull();
    expect(selected.model.editor.bodyHtml).toBe("");
    expect(selected.model.pendingCommand).toBe("Detail");
    expect(issued.slice(before)).toEqual(["detail:2:1"]);

    const stale = update(selected.model, LoadedArticleDetail({
      requestId: 1,
      observation: {
        body: {
          ...savedDraft,
          status: "Draft",
          departmentIds: [departmentA],
          canRevise: true,
          canPublish: false,
          authorDisplayName: "Erik Editor",
        },
        etag: etag3,
      },
    }));

    expect(stale).toEqual({ model: selected.model, commands: [] });

    const loaded = update(selected.model, LoadedArticleDetail({
      requestId: 2,
      observation: {
        body: {
          ...savedDraft,
          status: "Draft",
          departmentIds: [departmentA],
          canRevise: true,
          canPublish: false,
          authorDisplayName: "Erik Editor",
        },
        etag: etag3,
      },
    }));

    expect(loaded.model.selectedEtag).toBe(etag3);
    expect(loaded.model.editor.bodyHtml).toBe("<p>Lagret brødtekst</p>");
    expect(loaded.model.pendingCommand).toBeNull();
    expect(loaded.model.dirty).toBe(false);
  });

  it("blocks unsafe revise until a full working-copy observation is available", () => {
    const selected = update(modelWithWorkspace(), SelectedArticle({
      articleId: article1,
    }));

    const editedWithoutRevision = update(selected.model, EditedField({
      title: "Endret",
      bodyHtml: "<p>Ukjent arbeidskopi</p>",
      sticky: null,
    }));

    const before = issued.length;

    const blocked = update(editedWithoutRevision.model, SubmittedRevise({
      commandId: "blocked",
    }));

    expect(blocked.model).toEqual(editedWithoutRevision.model);
    expect(issued.slice(before)).toEqual([]);

    const observed = update(modelWithWorkspace(), SucceededSave({
      requestId: 1,
      observation: { body: savedDraft, etag: etag3 },
    }));

    const edited = update(observed.model, EditedField({
      title: "Endret",
      bodyHtml: null,
      sticky: null,
    }));

    const beforeSubmit = issued.length;
    const submitted = update(edited.model, SubmittedRevise({ commandId: "cmd-1" }));
    expect(submitted.model.requestId).toBe(2);
    expect(submitted.model.pendingCommand).toBe("Revise");
    expect(submitted.model.dirty).toBe(true);
    expect(issued.slice(beforeSubmit)).toEqual([`revise:2:${etag3}`]);
  });

  it("publish and unpublish require publisher capability in the Model", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;

    // entry.canPublish is false for this editor-owned draft row.
    const denied = update(initial, SubmittedPublish({
      commandId: "cmd-p",
      articleId: article1,
    }));

    expect(denied.model).toEqual(initial);
    expect(issued.slice(before)).toEqual([]);

    const allowed = update(initial, SubmittedUnpublish({
      commandId: "cmd-u",
      articleId: article2,
    }));

    expect(allowed.model.requestId).toBe(2);
    expect(issued.slice(before)).toEqual(["unpublish:2"]);
  });

  it("a stale SucceededSave leaves the Model unchanged", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;

    const stale = update(initial, SucceededSave({
      requestId: 42,
      observation: { body: savedDraft, etag: etag3 },
    }));

    expect(stale).toEqual({ model: initial, commands: [] });

    const fresh = update(initial, SucceededSave({
      requestId: 1,
      observation: { body: savedDraft, etag: etag3 },
    }));

    expect(fresh.model.workspace._tag).toBe("Success");
    expect(fresh.commands).toHaveLength(1);
    expect(issued.slice(before)).toEqual(["load:1"]);
  });

  it("department filter narrows rows client-side without any new server request", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;
    const filtered = update(initial, ChangedDepartmentFilter({ departmentId: departmentA }));
    expect(filtered.model.departmentFilter).toBe(departmentA);
    expect(issued.slice(before)).toEqual([]);
    expect(
      update(initial, ChangedDepartmentFilter({ departmentId: null })).model.departmentFilter,
    ).toBeNull();
  });

  it("failed commands preserve selections, edits, and the typed denial tag", () => {
    const observed = update(modelWithWorkspace(), SucceededSave({
      requestId: 1,
      observation: { body: savedDraft, etag: etag3 },
    }));

    const edited = update(observed.model, EditedField({
      title: null,
      bodyHtml: "<p>Ulagret</p>",
      sticky: null,
    }));

    const submitting = update(edited.model, SubmittedRevise({ commandId: "denied" }));

    const failed = update(submitting.model, FailedCommand({
      requestId: 2,
      failure: ContentFailure.cases.Denied.make({
        tag: "DraftNotOwned",
        message: "Du kan bare redigere egne kladder.",
      }),
    }));

    expect(failed.model.selectedArticleId).toBe(article1);
    expect(failed.model.selectedEtag).toBe(etag3);
    expect(failed.model.editor.bodyHtml).toBe("<p>Ulagret</p>");
    expect(failed.model.dirty).toBe(true);
    expect(failed.model.pendingCommand).toBeNull();
    expect(failed.model.banner).toHaveProperty("_tag", "Denied");
    expect(failed.model.banner).toEqual(
      expect.objectContaining({ tag: "DraftNotOwned" }),
    );
    const dismissed = update(failed.model, DismissedBanner({}));
    expect(dismissed.model.banner).toBeNull();
  });

  it("updates body and revision after every successful repeated save", () => {
    const first = update(modelWithWorkspace(), SucceededSave({
      requestId: 1,
      observation: { body: savedDraft, etag: etag3 },
    }));

    const second = update(
      { ...first.model, requestId: 2, pendingCommand: "Revise", dirty: true },
      SucceededSave({
        requestId: 2,
        observation: {
          body: {
            ...savedDraft,
            bodyHtml: "<p>Andre lagring</p>",
            revision: 4,
          },
          etag: etag4,
        },
      }),
    );

    expect(second.model.selectedArticleId).toBe(article1);
    expect(second.model.selectedEtag).toBe(etag4);
    expect(second.model.editor.bodyHtml).toBe("<p>Andre lagring</p>");
    expect(second.model.dirty).toBe(false);
  });
});
