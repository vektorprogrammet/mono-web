import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import type { Identity } from "@vektorprogrammet/domain/identity";
import {
  ContentApi,
  DirectoryApi,
  InternalReceiptsApi,
  OrganizationApi,
  ProfileApi,
  ReceiptsApi,
  RecruitmentApi,
  InvitationCapabilitySecurity,
  PersonSecurity,
  RequestSchemaErrorMiddleware,
  SessionSecurity,
} from "@vektorprogrammet/http-api";
import { Effect, Layer } from "effect";
import { Etag, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi";
import { DirectoryApiHandlers, type DirectoryApiHttpOptions } from "../directory/http.js";
import { ContentApiHandlers, type ContentRequestActor } from "../content/http.js";
import { NativeHttpApiMiddlewareLive } from "../http-api/transport.js";
import { OrganizationApiHandlers, type OrganizationApiHttpOptions } from "../organization/http.js";
import { ProfileApiHandlers, type ProfileApiHttpOptions } from "../profile/http.js";
import {
  InternalReceiptApiHandlers,
  ReceiptApiHandlers,
  type ReceiptApiHttpOptions,
} from "../receipt/http.js";
import { RecruitmentApiHandlers, type RecruitmentApiHttpOptions } from "../recruitment/http.js";
import {
  makeBackendHttp,
  makeExternalNativeApiRouterLayer,
  makeInternalNativeApiRouterLayer,
  type BackendAuthHandler,
  type BackendHttpOptions,
} from "../router.js";
import { type SchoolsApiHttpOptions } from "../schools/http.js";
import type { BackendConfig } from "../config.js";

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunHttpPlatform.layer,
  BunPath.layer,
  Etag.layer,
);
const testSessionBoundary = {
  deployment: "local",
  trustedOrigins: ["http://127.0.0.1:5174"],
  secureCookies: false,
} as const;
const notFound = HttpRouter.use((router) =>
  router.add(
    "*",
    "*",
    Effect.sync(() =>
      HttpServerResponse.fromWeb(
        new Response(JSON.stringify({ error: { tag: "RouteNotFound" } }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
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

type NativeMiddlewareRequirements =
  | SessionSecurity
  | PersonSecurity
  | InvitationCapabilitySecurity
  | RequestSchemaErrorMiddleware;
type TestServiceLayer = Layer.Layer<unknown>;
const provideTestServices = <Output, Error, Requirements>(
  layer: Layer.Layer<Output, Error, Requirements>,
  services: TestServiceLayer,
) => layer.pipe(Layer.provide(services as Layer.Layer<Requirements>));

const testRouterFetch = <Id extends string, Groups extends HttpApiGroup.Constraint, R>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<
    HttpApiGroup.ToService<Id, Groups>,
    never,
    R | NativeMiddlewareRequirements
  >,
  services: TestServiceLayer,
): ((request: Request) => Promise<Response>) => {
  const middleware = provideTestServices(NativeHttpApiMiddlewareLive, services);
  const app = provideTestServices(
    HttpApiBuilder.layer(contract).pipe(
      Layer.provide(handlers),
      Layer.provide(middleware),
    ),
    services,
  ).pipe(Layer.provide(platform));
  const routerLayer = Layer.merge(app, notFound);
  // Each test request owns and releases the handler layer that serves it.
  return async (request) => {
    const webHandler = HttpRouter.toWebHandler(routerLayer, {
      disableLogger: true,
    });
    // HttpRouter's conditional context type cannot reduce across this generic group helper.
    const handler = webHandler.handler as unknown as (request: Request) => Promise<Response>;
    try {
      return await handler(request);
    } finally {
      await webHandler.dispose();
    }
  };
};

const testFetch = <Id extends string, Groups extends HttpApiGroup.Constraint, R>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<
    HttpApiGroup.ToService<Id, Groups>,
    never,
    R | NativeMiddlewareRequirements
  >,
  services: TestServiceLayer,
): ((request: Request) => Promise<Response>) =>
  makeBackendHttp(
    testRouterFetch(contract, handlers, services),
    {
      handle: () => Promise.resolve(new Response(null, { status: 404 })),
      recordTrustedOriginRejection: () => Promise.resolve(),
    },
    testSessionBoundary,
  ).fetch;

export const makeOrganizationTestHttp = (
  options: OrganizationApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(organizationContract, OrganizationApiHandlers(options), services),
});

export const makeProfileTestHttp = (
  options: ProfileApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(profileContract, ProfileApiHandlers(options), services),
});

export const makeRecruitmentTestHttp = (
  options: RecruitmentApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(recruitmentContract, RecruitmentApiHandlers(options), services),
});

export const makeReceiptTestHttp = (
  options: ReceiptApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(receiptContract, ReceiptApiHandlers(options), services),
});

export const makeInternalReceiptTestHttp = (
  options: ReceiptApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testRouterFetch(internalReceiptContract, InternalReceiptApiHandlers(options), services),
});

export const makeContentManagementTestHttp = <E, R>(
  resolveActor: (request: Request) => Effect.Effect<ContentRequestActor, E, R>,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(contentContract, ContentApiHandlers(resolveActor), services),
});

export const makePublicNewsTestHttp = (services: TestServiceLayer) => ({
  fetch: testFetch(
    contentContract,
    ContentApiHandlers(() =>
      Effect.fail(new Error("staff actor resolution is unavailable in public-news tests")),
    ),
    services,
  ),
});

export const makeDirectoryTestHttp = (
  options: DirectoryApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(options, {
      resolveActor: () => Effect.fail(new Error("school actor resolution is unavailable")),
    }),
    services,
  ),
});

export const makeSchoolsTestHttp = (
  options: SchoolsApiHttpOptions,
  services: TestServiceLayer,
) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(
      {
        resolveAuthority: () =>
          Effect.fail(new Error("people directory authority is unavailable")),
      },
      options,
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
    makeExternalNativeApiRouterLayer(config, options),
    services,
  ).pipe(Layer.provide(platform));
  const native = async (request: Request): Promise<Response> => {
    const { dispose, handler } = HttpRouter.toWebHandler(routerLayer, {
      disableLogger: true,
    });
    try {
      return await handler(request);
    } finally {
      await dispose();
    }
  };
  return makeBackendHttp(native, authHandler, config.sessionBoundary);
};

export const makeBackendInternalTestHttp = (
  config: BackendConfig,
  services: TestServiceLayer,
  options: BackendHttpOptions = {},
) => {
  const routerLayer = provideTestServices(
    makeInternalNativeApiRouterLayer(config, options),
    services,
  ).pipe(Layer.provide(platform));
  return {
    fetch: async (request: Request): Promise<Response> => {
      const { dispose, handler } = HttpRouter.toWebHandler(routerLayer, {
        disableLogger: true,
      });
      try {
        return await handler(request);
      } finally {
        await dispose();
      }
    },
  };
};
