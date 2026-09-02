import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
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
  type BackendRun,
} from "../router.js";
import { type SchoolsApiHttpOptions } from "../schools/http.js";
import type { BackendConfig } from "../config.js";

const platform = Layer.mergeAll(BunServices.layer, BunHttpPlatform.layer, Etag.layer);
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

const testRouterFetch = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<
    HttpApiGroup.ToService<Id, Groups>,
    never,
    SessionSecurity | PersonSecurity | InvitationCapabilitySecurity | RequestSchemaErrorMiddleware
  >,
): ((request: Request) => Promise<Response>) => {
  const app = HttpApiBuilder.layer(contract).pipe(
    Layer.provide(handlers),
    Layer.provide(NativeHttpApiMiddlewareLive),
    Layer.provide(platform),
  );
  const webHandler = HttpRouter.toWebHandler(Layer.merge(app, notFound), {
    disableLogger: true,
  }).handler;
  // HttpRouter's conditional context type cannot reduce across this generic group helper.
  return webHandler as unknown as (request: Request) => Promise<Response>;
};

const testFetch = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  contract: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<
    HttpApiGroup.ToService<Id, Groups>,
    never,
    SessionSecurity | PersonSecurity | InvitationCapabilitySecurity | RequestSchemaErrorMiddleware
  >,
): ((request: Request) => Promise<Response>) =>
  makeBackendHttp(
    testRouterFetch(contract, handlers),
    {
      handle: () => Promise.resolve(new Response(null, { status: 404 })),
      recordTrustedOriginRejection: () => Promise.resolve(),
    },
    testSessionBoundary,
  ).fetch;

export const makeOrganizationTestHttp = (options: OrganizationApiHttpOptions) => ({
  fetch: testFetch(organizationContract, OrganizationApiHandlers(options)),
});

export const makeProfileTestHttp = (options: ProfileApiHttpOptions) => ({
  fetch: testFetch(profileContract, ProfileApiHandlers(options)),
});

export const makeRecruitmentTestHttp = (options: RecruitmentApiHttpOptions) => ({
  fetch: testFetch(recruitmentContract, RecruitmentApiHandlers(options)),
});

export const makeReceiptTestHttp = (options: ReceiptApiHttpOptions) => ({
  fetch: testFetch(receiptContract, ReceiptApiHandlers(options)),
});

export const makeInternalReceiptTestHttp = (options: ReceiptApiHttpOptions) => ({
  fetch: testRouterFetch(internalReceiptContract, InternalReceiptApiHandlers(options)),
});

export const makeContentManagementTestHttp = (
  resolveActor: (request: Request) => Promise<ContentRequestActor>,
  run: BackendRun,
) => ({
  fetch: testFetch(contentContract, ContentApiHandlers(resolveActor, run)),
});

export const makePublicNewsTestHttp = (run: BackendRun) => ({
  fetch: testFetch(
    contentContract,
    ContentApiHandlers(
      () => Promise.reject(new Error("staff actor resolution is unavailable in public-news tests")),
      run,
    ),
  ),
});

export const makeDirectoryTestHttp = (options: DirectoryApiHttpOptions) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(options, {
      resolveActor: () => Promise.reject(new Error("school actor resolution is unavailable")),
      run: options.run,
    }),
  ),
});

export const makeSchoolsTestHttp = (options: SchoolsApiHttpOptions) => ({
  fetch: testFetch(
    directoryContract,
    DirectoryApiHandlers(
      {
        resolveAuthority: () =>
          Promise.reject(new Error("people directory authority is unavailable")),
        run: options.run,
      },
      options,
    ),
  ),
});

export const makeBackendTestHttp = (
  config: BackendConfig,
  run: BackendRun,
  authHandler: BackendAuthHandler,
  options: BackendHttpOptions = {},
) => {
  const native = HttpRouter.toWebHandler(
    makeExternalNativeApiRouterLayer(config, run, options).pipe(Layer.provide(platform)),
    { disableLogger: true },
  ).handler as unknown as (request: Request) => Promise<Response>;
  return makeBackendHttp(native, authHandler, config.sessionBoundary);
};

export const makeBackendInternalTestHttp = (
  config: BackendConfig,
  run: BackendRun,
  options: BackendHttpOptions = {},
) => {
  const internal = HttpRouter.toWebHandler(
    makeInternalNativeApiRouterLayer(config, run, options).pipe(Layer.provide(platform)),
    { disableLogger: true },
  ).handler as unknown as (request: Request) => Promise<Response>;
  return { fetch: internal };
};
