import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Placements } from "@vektorprogrammet/domain/placements";
import { TeamApplications } from "@vektorprogrammet/domain/team-application";
import {
  Admissions,
  ReturningAssistants,
  Organization,
  Profile,
  Schools,
  Recruitment,
  SocialEvents,
  Mail,
  ServicePrincipalGrantAuthority,
} from "@vektorprogrammet/domain";
import { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  Economy,
  ReceiptAuxiliaryEffects,
  ReceiptFileService,
} from "@vektorprogrammet/domain/receipt";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import { backendDatabase } from "../../test/database.js";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import { TestPlatform } from "./platform.js";

import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ContentApi,
  DirectoryApi,
  InternalReceiptsApi,
  OrganizationApi,
  ProfileApi,
  ReceiptsApi,
  RecruitmentApi,
  RequestSchemaErrorMiddleware,
  TeamApplicationsApi,
} from "@vektorprogrammet/http-api";
import { TeamApplicationsApiHandlers } from "../team-application/http.js";
import { Context, Effect, Layer, Option, type Crypto, type FileSystem, type Path } from "effect";
import {
  Etag,
  HttpRouter,
  HttpServerResponse,
  type HttpClient,
  type HttpPlatform,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { DirectoryApiHandlers, type DirectoryApiHttpOptions } from "../directory/http.js";
import { ContentApiHandlers } from "../content/http.js";
import type { ContentRequestActor } from "../content/http-context.js";
import { ProblemBoundaryLive } from "../http-api/problem.js";
import { NativeHttpApiMiddlewareLive } from "../http-api/transport.js";
import { OrganizationApiHandlers, type OrganizationApiHttpOptions } from "../organization/http.js";
import { ProfileApiHandlers, type ProfileApiHttpOptions } from "../profile/http.js";
import { InternalReceiptApiHandlers, ReceiptApiHandlers } from "../receipt/http.js";
import type { ReceiptApiHttpOptions, ReceiptIdentityFailure } from "../receipt/http-context.js";
import { ReceiptFileStoreResource, type ReceiptFileStore } from "../receipt/filesystem.js";
import { RecruitmentApiHandlers } from "../recruitment/http.js";
import type { RecruitmentApiHttpOptions } from "../recruitment/http-context.js";
import {
  backendHttpHandler,
  ExternalNativeApiRouterLive,
  InternalNativeApiRouterLive,
  nativeHttpRouterConfig,
  type BackendAuthHandler,
  type BackendHttpHandler,
  type BackendHttpOptions,
} from "../router.js";
import { type SchoolsApiHttpOptions } from "../schools/http.js";
import type { BackendConfig, TeamApplicationApiConfig } from "../config.js";

// Handlers reach the platform per request, so the router serves it from its own context.
const platform = Layer.mergeAll(TestPlatform, BunHttpPlatform.layer, Etag.layer);

const testSessionBoundary = {
  deployment: "local",
  trustedOrigins: ["http://127.0.0.1:5174"],
  secureCookies: false,
} as const;

const testAuthHandler: BackendAuthHandler = {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
};

const notFound = HttpRouter.use((router) =>
  router.add(
    "*",
    "*",
    Effect.sync(() =>
      HttpServerResponse.fromWeb(
        Response.json(
          { error: { tag: "RouteNotFound" } },
          { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
        ),
      ),
    ),
  ),
);

const organizationContract = HttpApi.make("external-native-api")
  .add(OrganizationApi)
  .middleware(RequestSchemaErrorMiddleware);

const profileContract = HttpApi.make("external-native-api")
  .add(ProfileApi)
  .middleware(RequestSchemaErrorMiddleware);

const directoryContract = HttpApi.make("external-native-api")
  .add(DirectoryApi)
  .middleware(RequestSchemaErrorMiddleware);

const recruitmentContract = HttpApi.make("external-native-api")
  .add(RecruitmentApi)
  .middleware(RequestSchemaErrorMiddleware);

const receiptContract = HttpApi.make("external-native-api")
  .add(ReceiptsApi)
  .middleware(RequestSchemaErrorMiddleware);

const internalReceiptContract = HttpApi.make("internal-native-api")
  .add(InternalReceiptsApi)
  .middleware(RequestSchemaErrorMiddleware);

const contentContract = HttpApi.make("external-native-api")
  .add(ContentApi)
  .middleware(RequestSchemaErrorMiddleware);

const teamApplicationsContract = HttpApi.make("external-native-api")
  .add(TeamApplicationsApi)
  .middleware(RequestSchemaErrorMiddleware);

type BackendTestServices =
  | Database
  | IdentitySnapshot
  | OAuthCredentialAuthority
  | Identity
  | Admissions
  | ReturningAssistants
  | Economy
  | Organization
  | Profile
  | Schools
  | Recruitment
  | Placements
  | Content
  | ContentManagement
  | SocialEvents
  | TeamApplications
  | Mail
  | ReceiptAuxiliaryEffects
  | ReceiptFileService
  | ServicePrincipalGrantAuthority;

type TestServiceLayer = Layer.Layer<never>;

type TestPlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | HttpClient.HttpClient;

type TestApplicationRequirement =
  | BackendTestServices
  | TestPlatformServices
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", BackendTestServices | TestPlatformServices>
  | Etag.Generator
  | HttpPlatform.HttpPlatform;

const unavailableIdentity = () =>
  Effect.fail(
    new IdentityEngineError({ operation: "test", message: "Unexpected identity operation" }),
  );

const unimplementedServices = Layer.mergeAll(
  Layer.mock(IdentitySnapshot, {}),
  Layer.mock(OAuthCredentialAuthority, {}),
  Layer.succeed(Identity, {
    signIn: unavailableIdentity,
    resolveSession: unavailableIdentity,
    readCurrentSession: unavailableIdentity,
    listSessions: unavailableIdentity,
    revokeCurrentSession: unavailableIdentity,
    revokeSession: unavailableIdentity,
    revokeOtherSessions: unavailableIdentity,
    revokeAllSessions: unavailableIdentity,
    recordSecurityEvent: unavailableIdentity,
    signOut: unavailableIdentity,
  }),
  Layer.mock(Admissions, {}),
  Layer.mock(ReturningAssistants, {}),
  Layer.mock(Economy, {}),
  Layer.mock(Organization, {}),
  Layer.mock(Profile, {}),
  Layer.mock(Schools, {}),
  Layer.mock(Recruitment, {}),
  Layer.mock(Placements, {}),
  Layer.mock(Content, {}),
  Layer.mock(ContentManagement, {}),
  Layer.mock(SocialEvents, {}),
  Layer.mock(TeamApplications, {}),
  Layer.mock(Mail, {}),
  Layer.mock(ReceiptAuxiliaryEffects, {}),
  Layer.mock(ReceiptFileService, {}),
  Layer.mock(ServicePrincipalGrantAuthority, {}),
);

const fallbackDatabase = backendDatabase();

const completeServices = (services: TestServiceLayer) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const provided = yield* Layer.build(services);
      const defaults = yield* Layer.build(unimplementedServices);
      const database = Context.getOption(provided, Database);

      const sql = Option.isSome(database)
        ? database.value
        : yield* Effect.provide(Database, fallbackDatabase.layer);

      return Context.add(Context.merge(defaults, provided), Database, sql);
    }),
  );

const provideTestServices = (
  layer: Layer.Layer<never, never, TestApplicationRequirement>,
  services: TestServiceLayer,
) => layer.pipe(Layer.provideMerge(completeServices(services)));

/** Serves each request on a fresh web handler, whose runtime is disposed after the response. */
const serveEachRequest =
  (
    makeWebHandler: () => {
      readonly handler: (request: Request) => Promise<Response>;
      readonly dispose: () => Promise<void>;
    },
  ): BackendHttpHandler =>
  (request) =>
    Effect.acquireUseRelease(
      Effect.sync(makeWebHandler),
      ({ handler }) => Effect.promise(() => handler(request)),
      ({ dispose }) => Effect.promise(() => dispose()),
    );

const testRouterFetch = (
  app: Layer.Layer<never, never, TestApplicationRequirement>,
  services: TestServiceLayer,
) => {
  const routerLayer = Layer.mergeAll(app, notFound, ProblemBoundaryLive).pipe(
    Layer.provideMerge(completeServices(services)),
    Layer.provideMerge(platform),
  );

  return serveEachRequest(() =>
    HttpRouter.toWebHandler(routerLayer, {
      disableLogger: true,
      routerConfig: nativeHttpRouterConfig,
    }),
  );
};

const testFetch = (
  app: Layer.Layer<never, never, TestApplicationRequirement>,
  services: TestServiceLayer,
) => backendHttpHandler(testRouterFetch(app, services), testAuthHandler, testSessionBoundary);

export const makeOrganizationTestHttp = <S extends TestServiceLayer>(
  options: OrganizationApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(organizationContract).pipe(
      Layer.provide(OrganizationApiHandlers(options)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeProfileTestHttp = <S extends TestServiceLayer>(
  options: ProfileApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(profileContract).pipe(
      Layer.provide(ProfileApiHandlers(options)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeRecruitmentTestHttp = <S extends TestServiceLayer>(
  options: RecruitmentApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(recruitmentContract).pipe(
      Layer.provide(RecruitmentApiHandlers(options)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export interface ReceiptTestHttpOptions<
  E extends ReceiptIdentityFailure,
  R,
> extends ReceiptApiHttpOptions<E, R> {
  readonly fileStore: ReceiptFileStore;
}

export const makeReceiptTestHttp = <E extends ReceiptIdentityFailure, S extends TestServiceLayer>(
  options: ReceiptTestHttpOptions<E, BackendTestServices>,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(receiptContract).pipe(
      Layer.provide(
        ReceiptApiHandlers(options).pipe(
          Layer.provide(Layer.succeed(ReceiptFileStoreResource, options.fileStore)),
        ),
      ),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeInternalReceiptTestHttp = <
  E extends ReceiptIdentityFailure,
  S extends TestServiceLayer,
>(
  options: ReceiptApiHttpOptions<E, BackendTestServices>,
  services: S,
) => ({
  fetch: testRouterFetch(
    HttpApiBuilder.layer(internalReceiptContract).pipe(
      Layer.provide(InternalReceiptApiHandlers(options)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeContentManagementTestHttp = <E, S extends TestServiceLayer>(
  resolveActor: (request: Request) => Effect.Effect<ContentRequestActor, E, BackendTestServices>,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(contentContract).pipe(
      Layer.provide(ContentApiHandlers(resolveActor)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makePublicNewsTestHttp = <S extends TestServiceLayer>(services: S) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(contentContract).pipe(
      Layer.provide(
        ContentApiHandlers(() =>
          Effect.die(new Error("staff actor resolution is unavailable in public-news tests")),
        ),
      ),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeDirectoryTestHttp = <S extends TestServiceLayer>(
  options: DirectoryApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(directoryContract).pipe(
      Layer.provide(
        DirectoryApiHandlers(options, {
          resolveActor: () =>
            Effect.fail(
              new UnauthenticatedActor({ message: "school actor resolution is unavailable" }),
            ),
        }),
      ),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeSchoolsTestHttp = <S extends TestServiceLayer>(
  options: SchoolsApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(directoryContract).pipe(
      Layer.provide(
        DirectoryApiHandlers(
          {
            resolveAuthority: () =>
              Effect.fail(
                new UnauthenticatedActor({ message: "people directory authority is unavailable" }),
              ),
          },
          options,
        ),
      ),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeTeamApplicationsTestHttp = <S extends TestServiceLayer>(
  config: TeamApplicationApiConfig,
  services: S,
) => ({
  fetch: testFetch(
    HttpApiBuilder.layer(teamApplicationsContract).pipe(
      Layer.provide(TeamApplicationsApiHandlers(config)),
      Layer.provide(NativeHttpApiMiddlewareLive),
    ),
    services,
  ),
});

export const makeBackendTestHttp = (
  config: BackendConfig,
  services: TestServiceLayer,
  authHandler: BackendAuthHandler,
  options: BackendHttpOptions = {},
) => {
  const routerLayer = provideTestServices(
    ExternalNativeApiRouterLive(config, options),
    services,
  ).pipe(Layer.provideMerge(platform));

  const native = serveEachRequest(() =>
    HttpRouter.toWebHandler(routerLayer, {
      disableLogger: true,
    }),
  );

  return { fetch: backendHttpHandler(native, authHandler, config.sessionBoundary) };
};

export const makeBackendInternalTestHttp = (
  config: BackendConfig,
  services: TestServiceLayer,
  options: BackendHttpOptions = {},
) => {
  const routerLayer = provideTestServices(
    InternalNativeApiRouterLive(config, options),
    services,
  ).pipe(Layer.provideMerge(platform));

  return {
    fetch: serveEachRequest(() =>
      HttpRouter.toWebHandler(routerLayer, {
        disableLogger: true,
      }),
    ),
  };
};
