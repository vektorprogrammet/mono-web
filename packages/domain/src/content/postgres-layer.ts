import { Effect, Layer } from "effect";
import { Database } from "../database/service.js";
import { Profile } from "../profile/service.js";
import { Organization } from "../organization/service.js";
import { Content } from "./content-service.js";
import { readNewsListingPostgres, readPublishedArticlePostgres } from "./news.js";
import {
  createDraftPostgres,
  publishPostgres,
  readArticleDetailPostgres,
  readWorkspacePostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "./postgres.js";
import { ContentManagement } from "./service.js";

/**
 * Live ContentManagement editorial authority. The layer captures only the
 * process-owned Database; Organization and Profile remain requirements of the
 * returned operation Effects and are supplied by the composition root.
 */
export const ContentManagementLive: Layer.Layer<ContentManagement, never, Database> = Layer.effect(
  ContentManagement,
  Effect.gen(function* () {
    const database = yield* Database;
    return ContentManagement.of({
      readArticleDetail: (articleId, context) =>
        readArticleDetailPostgres({ articleId, ...context }).pipe(
          Effect.provideService(Database, database),
        ),
      readWorkspace: (context, query) =>
        readWorkspacePostgres({ ...context, query }).pipe(
          Effect.provideService(Database, database),
        ),
      createDraft: (command, context) =>
        createDraftPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
        ),
      reviseDraft: (command, context) =>
        reviseDraftPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
        ),
      publish: (command, context) =>
        publishPostgres({ command, ...context }).pipe(Effect.provideService(Database, database)),
      unpublish: (command, context) =>
        unpublishPostgres({ command, ...context }).pipe(Effect.provideService(Database, database)),
    });
  }),
);

/**
 * Live Content publication-rules authority:
 * `Layer<Content, never, Database | Organization | Profile>`. Its logical
 * dependence on ContentManagement is read-after-write over distinct tables;
 * it writes nothing.
 */
export const ContentLive: Layer.Layer<Content, never, Database | Organization | Profile> =
  Layer.effect(
    Content,
    Effect.gen(function* () {
      const database = yield* Database;
      const organization = yield* Organization;
      const profile = yield* Profile;
      return Content.of({
        readNewsListing: (departmentId) =>
          readNewsListingPostgres(departmentId).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(Organization, organization),
            Effect.provideService(Profile, profile),
          ),
        readPublishedArticle: (slug, versionNumber) =>
          readPublishedArticlePostgres(slug, versionNumber).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(Organization, organization),
            Effect.provideService(Profile, profile),
          ),
      });
    }),
  );
