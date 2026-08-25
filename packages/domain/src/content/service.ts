import { Context, Effect } from "effect";
import type { ContentWorkspace, ContentWorkspaceQuery } from "./schema.js";
import type { ReadContentWorkspaceFailure } from "./errors.js";

export interface ContentManagementShape {
  readonly readWorkspace: (
    query: ContentWorkspaceQuery,
  ) => Effect.Effect<ContentWorkspace, ReadContentWorkspaceFailure>;
}

export class ContentManagement extends Context.Service<ContentManagement, ContentManagementShape>()(
  "@vektorprogrammet/domain/ContentManagement",
) {}
