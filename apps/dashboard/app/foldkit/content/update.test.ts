import { ArticleId, type ContentWorkspace } from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { StrongETag } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import { ChangedDepartmentFilter, RetriedWorkspace } from "./message";
import { makeInitialModel, type Model } from "./model";
import { makeUpdate, type WorkspaceCommandFactories } from "./update";

const departmentA = DepartmentId.make("department-a");
const article1 = ArticleId.make(1);
const article2 = ArticleId.make(2);
const etag3 = StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
const etag4 = StrongETag.make('"vkr2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"');
const knownDepartments = [{ departmentId: departmentA, name: "Trondheim" }];
const savedDraft = {
  articleId: article1,
  title: "Min kladd",
  slug: "min-kladd",
  bodyHtml: "<p>Lagret brødtekst</p>",
  sticky: false,
  createdAt: "2031-02-01T00:00:00.000Z",
  updatedAt: "2031-02-01T01:00:00.000Z",
  currentVersionNumber: null,
  revision: 3,
};

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
  LoadArticleDetail: ({ requestId, articleId }) => {
    issued.push(`detail:${requestId}:${articleId}`);
    return { name: "LoadContentArticleDetail", args: { requestId }, effect: undefined as never };
  },
  SubmitCreate: ({ requestId }) => {
    issued.push(`create:${requestId}`);
    return { name: "SubmitContentCreate", args: { requestId }, effect: undefined as never };
  },
  SubmitRevise: ({ requestId, expectedEtag }) => {
    issued.push(`revise:${requestId}:${expectedEtag}`);
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
  knownDepartments,
});

describe("Foldkit content workspace transitions", () => {
  it("accepts a fresh workspace load and rejects a stale one", () => {
    const initial = makeInitialModel();
    const loaded = update(initial, {
      _tag: "LoadedWorkspace",
      requestId: 1,
      workspace,
      knownDepartments,
    });
    expect(loaded[0].workspace._tag).toBe("Success");

    // Stale success with mismatched requestId leaves the Model unchanged.
    const stale = update(initial, {
      _tag: "LoadedWorkspace",
      requestId: 99,
      workspace,
      knownDepartments,
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
      failure: { _tag: "Failed", tag: "ContentPersistenceError", message: "sen" },
    });
    expect(staleFailure[0].workspace._tag).toBe("Loading");
    expect(staleFailure[0].banner).toBeNull();

    // A failure for the current request renders the banner.
    const currentFailure = update(retried, {
      _tag: "FailedWorkspace",
      requestId: 2,
      failure: { _tag: "Denied", tag: "NotInScope", message: "ikke tilgang" },
    });
    expect(currentFailure[0].banner).toEqual({
      _tag: "Denied",
      tag: "NotInScope",
      message: "ikke tilgang",
    });
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
    const selected = update(initial, { _tag: "SelectedArticle", articleId: article1 });
    expect(selected[0].selectedArticleId).toBe(article1);
    expect(selected[0].selectedEtag).toBeNull();
    expect(selected[0].editor.bodyHtml).toBe("");
    expect(selected[0].pendingCommand).toBe("Detail");
    expect(issued.slice(before)).toEqual(["detail:2:1"]);

    const stale = update(selected[0], {
      _tag: "LoadedArticleDetail",
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
    });
    expect(stale).toEqual([selected[0], []]);

    const loaded = update(selected[0], {
      _tag: "LoadedArticleDetail",
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
    });
    expect(loaded[0].selectedEtag).toBe(etag3);
    expect(loaded[0].editor.bodyHtml).toBe("<p>Lagret brødtekst</p>");
    expect(loaded[0].pendingCommand).toBeNull();
    expect(loaded[0].dirty).toBe(false);
  });

  it("blocks unsafe revise until a full working-copy observation is available", () => {
    const selected = update(modelWithWorkspace(), {
      _tag: "SelectedArticle",
      articleId: article1,
    });
    const editedWithoutRevision = update(selected[0], {
      _tag: "EditedField",
      title: "Endret",
      bodyHtml: "<p>Ukjent arbeidskopi</p>",
      sticky: null,
    });
    const before = issued.length;
    const blocked = update(editedWithoutRevision[0], {
      _tag: "SubmittedRevise",
      commandId: "blocked",
    });
    expect(blocked[0]).toEqual(editedWithoutRevision[0]);
    expect(issued.slice(before)).toEqual([]);

    const observed = update(modelWithWorkspace(), {
      _tag: "SucceededSave",
      requestId: 1,
      observation: { body: savedDraft as never, etag: etag3 },
    });
    const edited = update(observed[0], {
      _tag: "EditedField",
      title: "Endret",
      bodyHtml: null,
      sticky: null,
    });
    const beforeSubmit = issued.length;
    const submitted = update(edited[0], { _tag: "SubmittedRevise", commandId: "cmd-1" });
    expect(submitted[0].requestId).toBe(2);
    expect(submitted[0].pendingCommand).toBe("Revise");
    expect(submitted[0].dirty).toBe(true);
    expect(issued.slice(beforeSubmit)).toEqual([`revise:2:${etag3}`]);
  });

  it("publish and unpublish require publisher capability in the Model", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;
    // entry.canPublish is false for this editor-owned draft row.
    const denied = update(initial, {
      _tag: "SubmittedPublish",
      commandId: "cmd-p",
      articleId: article1,
    });
    expect(denied[0]).toEqual(initial);
    expect(issued.slice(before)).toEqual([]);

    const allowed = update(initial, {
      _tag: "SubmittedUnpublish",
      commandId: "cmd-u",
      articleId: article2,
    });
    expect(allowed[0].requestId).toBe(2);
    expect(issued.slice(before)).toEqual(["unpublish:2"]);
  });

  it("a stale SucceededSave leaves the Model unchanged", () => {
    const initial = modelWithWorkspace();
    const before = issued.length;
    const stale = update(initial, {
      _tag: "SucceededSave",
      requestId: 42,
      observation: { body: savedDraft as never, etag: etag3 },
    });
    expect(stale).toEqual([initial, []]);

    const fresh = update(initial, {
      _tag: "SucceededSave",
      requestId: 1,
      observation: { body: savedDraft as never, etag: etag3 },
    });
    expect(fresh[0].workspace._tag).toBe("Success");
    expect(fresh[1]).toHaveLength(1);
    expect(issued.slice(before)).toEqual(["load:1"]);
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

  it("failed commands preserve selections, edits, and the typed denial tag", () => {
    const observed = update(modelWithWorkspace(), {
      _tag: "SucceededSave",
      requestId: 1,
      observation: { body: savedDraft as never, etag: etag3 },
    });
    const edited = update(observed[0], {
      _tag: "EditedField",
      title: null,
      bodyHtml: "<p>Ulagret</p>",
      sticky: null,
    });
    const submitting = update(edited[0], { _tag: "SubmittedRevise", commandId: "denied" });
    const failed = update(submitting[0], {
      _tag: "FailedCommand",
      requestId: 2,
      failure: {
        _tag: "Denied",
        tag: "DraftNotOwned",
        message: "Du kan bare redigere egne kladder.",
      },
    });
    expect(failed[0].selectedArticleId).toBe(article1);
    expect(failed[0].selectedEtag).toBe(etag3);
    expect(failed[0].editor.bodyHtml).toBe("<p>Ulagret</p>");
    expect(failed[0].dirty).toBe(true);
    expect(failed[0].pendingCommand).toBeNull();
    expect(failed[0].banner).toEqual(
      expect.objectContaining({ _tag: "Denied", tag: "DraftNotOwned" }),
    );
    const dismissed = update(failed[0], { _tag: "DismissedBanner" });
    expect(dismissed[0].banner).toBeNull();
  });

  it("updates body and revision after every successful repeated save", () => {
    const first = update(modelWithWorkspace(), {
      _tag: "SucceededSave",
      requestId: 1,
      observation: { body: savedDraft as never, etag: etag3 },
    });
    const second = update(
      { ...first[0], requestId: 2, pendingCommand: "Revise", dirty: true },
      {
        _tag: "SucceededSave",
        requestId: 2,
        observation: {
          body: {
            ...savedDraft,
            bodyHtml: "<p>Andre lagring</p>",
            revision: 4,
          } as never,
          etag: etag4,
        },
      },
    );
    expect(second[0].selectedArticleId).toBe(article1);
    expect(second[0].selectedEtag).toBe(etag4);
    expect(second[0].editor.bodyHtml).toBe("<p>Andre lagring</p>");
    expect(second[0].dirty).toBe(false);
  });
});
