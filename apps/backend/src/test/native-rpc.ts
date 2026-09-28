/**
 * The backend test harness for native RPCs. A test builds the complete backend over the services it
 * supplies, with every other service unimplemented, and calls it through the RPC client over the
 * real HTTP ingress: trusted origins, CORS, the credential middlewares, and the defect boundary.
 */
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
import { NativeRpcs, nativeRpcPath } from "@vektorprogrammet/rpc";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import { Context, Effect, Layer, Option, Predicate } from "effect";
import { Etag, HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import type { BackendConfig } from "../config.js";
import {
  backendHttpHandler,
  ExternalNativeRpcRouterLive,
  type BackendAuthHandler,
  type BackendHttpHandler,
  type BackendHttpOptions,
} from "../router.js";
import { TestPlatform } from "./platform.js";

// Handlers reach the platform per request, so the router serves it from its own context.
const platform = Layer.mergeAll(TestPlatform, BunHttpPlatform.layer, Etag.layer);

/** An identity engine whose Better Auth routes answer 404. */
export const testAuthHandler: BackendAuthHandler = {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
};

/** The services a test supplies; every service it leaves out is unimplemented. */
export type TestServiceLayer = Layer.Layer<never>;

const unavailableIdentity = () =>
  Effect.fail(
    IdentityEngineError.make({ operation: "test", message: "Unexpected identity operation" }),
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

export interface BackendTestRpcOptions {
  readonly config: BackendConfig;
  /** The services the test supplies; every other service is unimplemented. */
  readonly services: TestServiceLayer;
  readonly authHandler?: BackendAuthHandler;
  readonly options?: BackendHttpOptions;
  /**
   * HTTP headers that every request of the client carries, as a browser's `user-agent` does. A
   * header set with `RpcClient.withHeaders` travels in the RPC message instead, and the ingress
   * keeps only the credential and contact headers of a message.
   */
  readonly transportHeaders?: Readonly<Record<string, string>>;
}

/**
 * The complete external backend over `services`: `fetch` answers one web request through the
 * ingress, and `client` is the native RPC client whose requests take that path.
 *
 * A test sends a person's credential per call with `RpcClient.withHeaders`, as a server does.
 */
/**
 * The external native router over `services`, every other service unimplemented. A test that
 * serves several requests on one router, as the process does, builds its web handler once.
 */
export const backendTestRouterLayer = ({
  config,
  services,
  options = {},
}: Pick<BackendTestRpcOptions, "config" | "services" | "options">) =>
  ExternalNativeRpcRouterLive({ ...options, config }).pipe(
    Layer.provideMerge(completeServices(services)),
    Layer.provideMerge(platform),
  );

export const makeBackendTestRpc = ({
  config,
  services,
  authHandler = testAuthHandler,
  options = {},
  transportHeaders = {},
}: BackendTestRpcOptions) => {
  const routerLayer = backendTestRouterLayer({ config, services, options });

  const native = serveEachRequest(() =>
    HttpRouter.toWebHandler(routerLayer, { disableLogger: true }),
  );

  const fetch: BackendHttpHandler = backendHttpHandler(native, authHandler, config.sessionBoundary);

  const origin = config.sessionBoundary.trustedOrigins[0] ?? "http://127.0.0.1:5174";

  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = new Request(new URL(nativeRpcPath, "http://native-rpc.test"), {
        method: request.method,
        headers: { ...request.headers, ...transportHeaders, origin },
        body: Predicate.isTagged(request.body, "Uint8Array") ? request.body.body : undefined,
      });

      return HttpClientResponse.fromWeb(request, yield* fetch(web));
    }),
  );

  const client = RpcClient.make(NativeRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://native-rpc.test${nativeRpcPath}` }).pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(Layer.succeed(HttpClient.HttpClient)(httpClient)),
      ),
    ),
  );

  return { fetch, client };
};
