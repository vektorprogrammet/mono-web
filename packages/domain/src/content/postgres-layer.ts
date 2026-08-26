import { Context, Effect, Layer } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { OrganizationLive } from "../organization/postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";
import { Profile } from "../profile/service.js";
import { Organization } from "../organization/service.js";
import { Content } from "./content-service.js";
import { readNewsListingPostgres, readPublishedArticlePostgres } from "./news.js";
import {
  createDraftPostgres,
  publishPostgres,
  readWorkspacePostgres,
  reviseDraftPostgres,
  unpublishPostgres,
} from "./postgres.js";
import { ContentManagement } from "./service.js";

/**
 * Derives the Organization authority over the SAME database instance this
 * layer owns, scoped to the layer's lifetime (built once, disposed once with
 * the ManagedRuntime). No runtime is constructed here.
 */
const organizationLayerFor = (database: DatabaseShape): Layer.Layer<Organization> =>
  OrganizationLive.pipe(Layer.provide(Layer.succeed(Database, database)));

const profileLayerFor = (database: DatabaseShape): Layer.Layer<Profile> =>
  ProfileLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(Database, database), organizationLayerFor(database)),
    ),
  );

/**
 * Live ContentManagement editorial authority (spec 0062 §Service and Layer
 * contract): `Layer<ContentManagement, never, Database>`. It reuses the
 * process Database, constructs no runtime, and disposes with the
 * ManagedRuntime.
 */
export const ContentManagementLive: Layer.Layer<ContentManagement, never, Database> = Layer.effect(
  ContentManagement,
  Effect.gen(function* () {
    const database = yield* Database;
    const organizationContext = yield* Layer.build(organizationLayerFor(database));
    const organization = Context.get(organizationContext, Organization);
    const profileContext = yield* Layer.build(profileLayerFor(database));
    const profile = Context.get(profileContext, Profile);
    return ContentManagement.of({
      readWorkspace: (context, query) =>
        readWorkspacePostgres({ ...context, query }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      createDraft: (command, context) =>
        createDraftPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      reviseDraft: (command, context) =>
        reviseDraftPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      publish: (command, context) =>
        publishPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      unpublish: (command, context) =>
        unpublishPostgres({ command, ...context }).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
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
