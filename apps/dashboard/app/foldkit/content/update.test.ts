import { ArticleId, DepartmentId, type ContentWorkspace } from "@vektorprogrammet/sdk/effect";
import { describe, expect, it } from "vitest";
import { ChangedDepartmentFilter, RetriedWorkspace } from "./message";
import { makeInitialModel, type Model } from "./model";
import { makeUpdate, type WorkspaceCommandFactories } from "./update";

const departmentA = DepartmentId.make("department-a");
const article1 = ArticleId.make(1);
const article2 = ArticleId.make(2);

const workspace: ContentWorkspace = {
  entries: [
    {
      articleId: article2,
      title: "Publisert artikkel",
      slug: "publisert-artikkel",
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
      slug: "min-kladd",
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
    return { name: "LoadContentWorkspace", args: { requestId }, effect: undefined as never };
  },
  SubmitCreate: ({ requestId }) => {
    issued.push(`create:${requestId}`);
    return { name: "SubmitContentCreate", args: { requestId }, effect: undefined as never };
  },
  SubmitRevise: ({ requestId }) => {
    issued.push(`revise:${requestId}`);
    return { name: "SubmitContentRevise", args: { requestId }, effect: undefined as never };
  },
  SubmitPublish: ({ requestId }) => {
    issued.push(`publish:${requestId}`);
    return { name: "SubmitContentPublish", args: { requestId }, effect: undefined as never };
  },
  SubmitUnpublish: ({ requestId }) => {
    issued.push(`unpublish:${requestId}`);
    return { name: "SubmitContentUnpublish", args: { requestId }, effect: undefined as never };
  },
});

const issued: Array<string> = [];
const commands = recordingCommands(issued);
const update = makeUpdate(commands);

const modelWithWorkspace = (): Model => ({
  ...makeInitialModel(),
  workspace: { _tag: "Success", data: workspace },
});

describe("Foldkit content workspace transitions", () => {
  it("accepts a fresh workspace load and rejects a stale one", () => {
    const initial = makeInitialModel();
    const loaded = update(initial, {
      _tag: "LoadedWorkspace",
      requestId: 1,
      workspace,
    });
    expect(loaded[0].workspace._tag).toBe("Success");

    // Stale success with mismatched requestId leaves the Model unchanged.
    const stale = update(initial, {
      _tag: "LoadedWorkspace",
      requestId: 99,
      workspace,
    });
    expect(stale).toEqual([initial, []]);
  });

  it("retry increments identity and retry count and issues exactly one new load", () => {
    const initial = makeInitialModel();
    const [retried, emitted] = update(initial, RetriedWorkspace());
    expect(retried.requestId).toBe(2);
    expect(retried.retryCount).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(issued.filter((entry) => entry === "load:2")).toHaveLength(1);

    // A late failure from request 1 must not touch the retried Model.
    const staleFailure = update(retried, {
      _tag: "FailedWorkspace",
      requestId: 1,
      failure: { _tag: "Failed", message: "sen" },
    });
    expect(staleFailure[0].workspace._tag).toBe("Loading");
    expect(staleFailure[0].banner).toBeNull();

    // A failure for the current request renders the banner.
    const currentFailure = update(retried, {
      _tag: "FailedWorkspace",
      requestId: 2,
      failure: { _tag: "Denied", message: "ikke tilgang" },
    });
    expect(currentFailure[0].banner).toEqual({ _tag: "Denied", message: "ikke tilgang" });
  });

  it("selecting an article seeds the editor and clears banners; editing marks dirty without sending", () => {
    const initial = modelWithWorkspace();
    const selected = update(initial, { _tag: "SelectedArticle", articleId: article1 });
    expect(selected[0].selectedArticleId).toBe(article1);
    expect(selected[0].editor.title).toBe("Min kladd");
    expect(selected[0].dirty).toBe(false);
    expect(selected[0].banner).toBeNull();

    const edited = update(selected[0], {
      _tag: "EditedField",
      title: "Ny tittel",
      bodyHtml: "<p>Ny brødtekst</p>",
      sticky: null,
    });
    expect(edited[0].editor.title).toBe("Ny tittel");
    expect(edited[0].dirty).toBe(true);
    expect(edited[1]).toEqual([]);
  });

  it("submitting revise requires dirty state and issues one command under a new request id", () => {
    const initial = modelWithWorkspace();
    const selected = update(initial, { _tag: "SelectedArticle", articleId: article1 });
    const before = issued.length;

    const notDirty = update(selected[0], { _tag: "SubmittedRevise", commandId: "cmd-1" });
    expect(notDirty[0].requestId).toBe(selected[0].requestId);
    expect(issued.slice(before)).toEqual([]);

    const edited = update(selected[0], {
      _tag: "EditedField",
      title: "Endret",
      bodyHtml: null,
      sticky: null,
    });
    const submitted = update(edited[0], { _tag: "SubmittedRevise", commandId: "cmd-1" });
    expect(submitted[0].requestId).toBe(2);
    expect(submitted[0].dirty).toBe(false);
    expect(issued.slice(before)).toEqual(["revise:2"]);
  });

  it("publish and unpublish require publisher capability in the Model", () => {
    const initial = modelWithWorkspace();
    const selected = update(initial, { _tag: "SelectedArticle", articleId: article1 });
    const before = issued.length;
    // entry.canPublish is false for this editor-owned draft row.
    const denied = update(selected[0], {
      _tag: "SubmittedPublish",
      commandId: "cmd-p",
      articleId: article2,
    });
    expect(denied[0]).toEqual(selected[0]);
    expect(issued.slice(before)).toEqual([]);

    const publishedRow = update(modelWithWorkspace(), {
      _tag: "SelectedArticle",
      articleId: article2,
    });
    const allowed = update(publishedRow[0], {
      _tag: "SubmittedUnpublish",
      commandId: "cmd-u",
      articleId: article2,
    });
    expect(allowed[0].requestId).toBe(2);
    expect(issued.slice(before)).toEqual(["unpublish:2"]);
  });

  it("a stale SucceededSave leaves the Model unchanged", () => {
    const initial = modelWithWorkspace();
    const stale = update(initial, {
      _tag: "SucceededSave",
      requestId: 42,
      workspace,
    });
    expect(stale).toEqual([initial, []]);

    const fresh = update(initial, {
      _tag: "SucceededSave",
      requestId: 1,
      workspace,
    });
    expect(fresh[0].workspace._tag).toBe("Success");
  });

  it("department filter narrows rows client-side without any new server request", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;
    const filtered = update(initial, ChangedDepartmentFilter({ departmentId: departmentA }));
    expect(filtered[0].departmentFilter).toBe(departmentA);
    expect(issued.slice(before)).toEqual([]);
    expect(
      update(initial, ChangedDepartmentFilter({ departmentId: null }))[0].departmentFilter,
    ).toBeNull();
  });

  it("failed commands preserve selections and render the typed denial", () => {
    const initial = modelWithWorkspace();
    const selected = update(initial, { _tag: "SelectedArticle", articleId: article1 });
    const failed = update(selected[0], {
      _tag: "FailedCommand",
      requestId: 1,
      failure: { _tag: "Denied", message: "Du kan bare redigere egne kladder." },
    });
    expect(failed[0].selectedArticleId).toBe(article1);
    expect(failed[0].banner?._tag).toBe("Denied");
    const dismissed = update(failed[0], { _tag: "DismissedBanner" });
    expect(dismissed[0].banner).toBeNull();
  });
});
