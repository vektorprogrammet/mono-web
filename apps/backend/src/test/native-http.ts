import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import type { Identity } from "@vektorprogrammet/domain/identity";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
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
type TestServiceLayer = Layer.Layer<Identity | OAuthCredentialAuthority>;

const testRouterFetch = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  R,
  S extends TestServiceLayer,
>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, R>,
  services: S,
) => {
  const middleware = NativeHttpApiMiddlewareLive.pipe(Layer.provide(services));
  const app = HttpApiBuilder.layer(contract).pipe(
    Layer.provide(handlers),
    Layer.provide(middleware),
    Layer.provide(platform),
  );
  const remainingServices = Layer.effectContext(
    Effect.context<Exclude<HttpRouter.Request.Only<"Requires", R>, Layer.Success<S>>>(),
  );
  const routerLayer = HttpRouter.provideRequest(remainingServices)(
    HttpRouter.provideRequest(services)(Layer.merge(app, notFound)),
  );
  // Each test request owns and releases the handler layer that serves it.
  return (request: Request) =>
    Effect.contextWith((context) =>
      Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routerLayer, { disableLogger: true })),
        (webHandler) => Effect.promise(() => webHandler.handler(request, context)),
        (webHandler) => Effect.promise(() => webHandler.dispose()),
      ),
    );
};

const testFetch = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  R,
  S extends TestServiceLayer,
>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, R>,
  services: S,
) => testRouterFetch(contract, handlers, services);

export const makeOrganizationTestHttp = <S extends TestServiceLayer>(
  options: OrganizationApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(organizationContract, OrganizationApiHandlers(options), services),
});

export const makeProfileTestHttp = <S extends TestServiceLayer>(
  options: ProfileApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(profileContract, ProfileApiHandlers(options), services),
});

export const makeRecruitmentTestHttp = <S extends TestServiceLayer>(
  options: RecruitmentApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(recruitmentContract, RecruitmentApiHandlers(options), services),
});

export const makeReceiptTestHttp = <E, R, S extends TestServiceLayer>(
  options: ReceiptApiHttpOptions<E, R>,
  services: S,
) => ({
  fetch: testFetch(receiptContract, ReceiptApiHandlers(options), services),
});

export const makeInternalReceiptTestHttp = <E, R, S extends TestServiceLayer>(
  options: ReceiptApiHttpOptions<E, R>,
  services: S,
) => ({
  fetch: testRouterFetch(internalReceiptContract, InternalReceiptApiHandlers(options), services),
});

export const makeContentManagementTestHttp = <E, R, S extends TestServiceLayer>(
  resolveActor: (request: Request) => Effect.Effect<ContentRequestActor, E, R>,
  services: S,
) => ({
  fetch: testFetch(contentContract, ContentApiHandlers(resolveActor), services),
});

export const makePublicNewsTestHttp = <S extends TestServiceLayer>(services: S) => ({
  fetch: testFetch(
    contentContract,
    ContentApiHandlers(() =>
      Effect.fail(new Error("staff actor resolution is unavailable in public-news tests")),
    ),
    services,
  ),
});

export const makeDirectoryTestHttp = <S extends TestServiceLayer>(
  options: DirectoryApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(options, {
      resolveActor: () =>
        Effect.fail(new UnauthenticatedActor({ message: "school actor resolution is unavailable" })),
    }),
    services,
  ),
});

export const makeSchoolsTestHttp = <S extends TestServiceLayer>(
  options: SchoolsApiHttpOptions,
  services: S,
) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(
      {
        resolveAuthority: () =>
          Effect.fail(
            new UnauthenticatedActor({ message: "people directory authority is unavailable" }),
          ),
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
