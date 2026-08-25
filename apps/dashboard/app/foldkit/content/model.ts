import type { ContentWorkspace } from "@vektorprogrammet/sdk/effect";
import { ArticleId, ContentWorkspaceSchema, DepartmentId } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";

export const ContentRequestId = S.Int.check(S.isGreaterThanOrEqualTo(1));

/** Typed safe failure rendered as denial or failure banners. */
export const ContentFailure = S.TaggedUnion({
  Denied: { message: S.String },
  Failed: { message: S.String },
});
export type ContentFailure = S.Schema.Type<typeof ContentFailure>;

const EditorValues = S.Struct({
  title: S.String,
  bodyHtml: S.String,
  departmentIds: S.Array(DepartmentId),
  sticky: S.Boolean,
});

export const makeEditorValues = (): S.Schema.Type<typeof EditorValues> => ({
  title: "",
  bodyHtml: "",
  departmentIds: [],
  sticky: false,
});

/**
 * Full-Foldkit state ownership (spec 0062 §Full-Foldkit state ownership):
 * remote AsyncData, listing, selection, editor form values, dirty tracking,
 * command in-flight identity, retry count, stale rejection, banners, and
 * empty/loading/ready states all live here. React owns none of it.
 */
export const Model = S.Struct({
  workspace: AsyncData.Schema(ContentWorkspaceSchema, ContentFailure).schema,
  requestId: ContentRequestId,
  retryCount: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  selectedArticleId: S.NullOr(ArticleId),
  /** The revision the editor form was seeded from; null when nothing loaded. */
  selectedRevision: S.NullOr(S.Int.check(S.isGreaterThanOrEqualTo(0))),
  editor: EditorValues,
  dirty: S.Boolean,
  departmentFilter: S.NullOr(DepartmentId),
  knownDepartments: S.Array(
    S.Struct({
      departmentId: DepartmentId,
      name: S.String,
    }),
  ),
  banner: S.NullOr(ContentFailure),
});
export type Model = S.Schema.Type<typeof Model>;

export const makeInitialModel = (): Model => ({
  workspace: ContentWorkspaceData.Loading(),
  requestId: 1,
  retryCount: 0,
  selectedArticleId: null,
  selectedRevision: null,
  editor: makeEditorValues(),
  dirty: false,
  departmentFilter: null,
  knownDepartments: [],
  banner: null,
});

export const ContentWorkspaceData = AsyncData.Schema(ContentWorkspaceSchema, ContentFailure);
export type { ContentWorkspace };
