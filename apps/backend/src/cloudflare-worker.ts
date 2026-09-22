import {
  AuthEngine,
  AuthLive,
  DatabaseLive,
  type AuthEngineService,
} from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { ReturningAssistantsLive } from "@vektorprogrammet/database/application";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { EconomyLive } from "@vektorprogrammet/database/receipt";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { SchoolsLive } from "@vektorprogrammet/database/schools";
import { SocialEventsLive } from "@vektorprogrammet/database/social-events";
import { SchoolSurveysLive } from "@vektorprogrammet/database/surveys";
import { Effect, Layer, ManagedRuntime, Predicate, Redacted } from "effect";
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http";
import { makeBackendConfig } from "./config.js";
import { CloudflareMailLive, type CloudflareSendEmailBinding } from "./mail/cloudflare.js";
import { makeReceiptDeliveryLayer, receiptDeliveryConfig } from "./receipt/delivery.js";
import { makeR2ReceiptFileStore, type R2Bucket } from "./receipt/r2.js";
import {
  makeBackendHttp,
  makeExternalNativeApiRouterLayer,
  nativeHttpRouterConfig,
  type BackendAuthHandler,
  type BackendHttp,
} from "./router.js";

export interface CloudflareHyperdriveBinding {
  readonly connectionString: string;
}

export interface CloudflareBackendEnv {
  readonly [name: string]:
    | string
    | undefined
    | CloudflareHyperdriveBinding
    | R2Bucket
    | CloudflareSendEmailBinding;
  readonly HYPERDRIVE?: CloudflareHyperdriveBinding;
  readonly RECEIPT_FILES?: R2Bucket;
  readonly MAIL?: CloudflareSendEmailBinding;
  readonly MAIL_SENDER?: string;
  readonly MAIL_TIMEOUT_MS?: string;
}

export class CloudflareBackendBindingError extends Error {
  constructor(readonly binding: "HYPERDRIVE" | "RECEIPT_FILES" | "MAIL" | "MAIL_SENDER") {
    super(`Required Cloudflare binding '${binding}' is absent or invalid`);
  }
}

export interface CloudflareBackendBindings {
  readonly hyperdrive: CloudflareHyperdriveBinding;
  readonly receiptFiles: R2Bucket;
  readonly mail: CloudflareSendEmailBinding;
  readonly sender: string;
}

/** Validates every composition-root resource before any application service is constructed. */
export const requireCloudflareBackendBindings = (
  env: CloudflareBackendEnv,
): CloudflareBackendBindings => {
  if (
    !Predicate.isObject(env.HYPERDRIVE) ||
    typeof env.HYPERDRIVE.connectionString !== "string" ||
    env.HYPERDRIVE.connectionString.length === 0
  ) {
    throw new CloudflareBackendBindingError("HYPERDRIVE");
  }
  if (
    !Predicate.isObject(env.RECEIPT_FILES) ||
    typeof env.RECEIPT_FILES.get !== "function" ||
    typeof env.RECEIPT_FILES.put !== "function" ||
    typeof env.RECEIPT_FILES.delete !== "function"
  ) {
    throw new CloudflareBackendBindingError("RECEIPT_FILES");
  }
  if (!Predicate.isObject(env.MAIL) || typeof env.MAIL.send !== "function") {
    throw new CloudflareBackendBindingError("MAIL");
  }
  if (typeof env.MAIL_SENDER !== "string" || env.MAIL_SENDER.length === 0) {
    throw new CloudflareBackendBindingError("MAIL_SENDER");
  }
  return {
    hyperdrive: env.HYPERDRIVE as CloudflareHyperdriveBinding,
    receiptFiles: env.RECEIPT_FILES as R2Bucket,
    mail: env.MAIL as CloudflareSendEmailBinding,
    sender: env.MAIL_SENDER,
  };
};

/** Builds the same modular HTTP application as Bun, with Worker-owned provider Layers. */
export const makeCloudflareBackend = async (env: CloudflareBackendEnv): Promise<BackendHttp> => {
  const bindings = requireCloudflareBackendBindings(env);
  const configEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string | undefined>;
  const config = makeBackendConfig({
    ...configEnv,
    BACKEND_PG_URL: bindings.hyperdrive.connectionString,
  });
  const timeout = env.MAIL_TIMEOUT_MS === undefined ? 10_000 : Number(env.MAIL_TIMEOUT_MS);
  const databaseLayer = DatabaseLive({
    url: Redacted.make(bindings.hyperdrive.connectionString),
    applicationName: "vektorprogrammet-cloudflare-worker",
    maxConnections: 8,
  });
  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
  const economyLayer = EconomyLive.pipe(Layer.provide(databaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const returningAssistantsLayer = ReturningAssistantsLive.pipe(Layer.provide(databaseLayer));
  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
  );
  const schoolsLayer = SchoolsLive.pipe(Layer.provide(databaseLayer));
  const contentManagementLayer = ContentManagementLive.pipe(Layer.provide(databaseLayer));
  const contentLayer = ContentLive.pipe(
    Layer.provide(Layer.mergeAll(databaseLayer, organizationLayer, profileLayer)),
  );
  const recruitmentLayer = RecruitmentLive.pipe(
    Layer.provide(Layer.mergeAll(databaseLayer, admissionsLayer, organizationLayer, profileLayer)),
  );
  const socialEventsLayer = SocialEventsLive.pipe(Layer.provide(databaseLayer));
  const schoolSurveysLayer = SchoolSurveysLive.pipe(Layer.provide(databaseLayer));
  const authLayer = AuthLive(config.auth).pipe(Layer.provide(databaseLayer));
  const receiptDeliveryLayer = makeReceiptDeliveryLayer(receiptDeliveryConfig(configEnv)).pipe(
    Layer.provide(databaseLayer),
  );
  const mailLayer = CloudflareMailLive({
    binding: bindings.mail,
    deliveryTimeoutMilliseconds: timeout,
  });
  const services = Layer.mergeAll(
    databaseLayer,
    admissionsLayer,
    economyLayer,
    organizationLayer,
    returningAssistantsLayer,
    profileLayer,
    schoolsLayer,
    contentManagementLayer,
    contentLayer,
    recruitmentLayer,
    socialEventsLayer,
    schoolSurveysLayer,
    authLayer,
    receiptDeliveryLayer,
    mailLayer,
  );
  const httpLayer = Layer.merge(
    HttpServer.layerServices,
    HttpRouter.layer.pipe(
      Layer.provide(Layer.succeed(HttpRouter.RouterConfig)(nativeHttpRouterConfig)),
    ),
  );
  const fileStore = makeR2ReceiptFileStore({ bucket: bindings.receiptFiles });
  const nativeApiLayer = makeExternalNativeApiRouterLayer(config, {
    receiptFileStore: fileStore,
  }).pipe(HttpRouter.provideRequest(services), Layer.provide(services), Layer.provide(httpLayer));
  const runtime = ManagedRuntime.make(Layer.mergeAll(services, httpLayer, nativeApiLayer));
  const router = await runtime.runPromise(HttpRouter.HttpRouter);
  const nativeHandler = HttpEffect.toWebHandler(router.asHttpEffect());
  const runAuth = <A>(operation: (engine: AuthEngineService) => Promise<A>) =>
    runtime.runPromise(
      AuthEngine.use((engine) =>
        Effect.tryPromise({
          try: () => operation(engine),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Better Auth runtime operation failed"),
        }),
      ),
    );
  const authHandler: BackendAuthHandler = {
    handle: (request, context) => runAuth((engine) => engine.handler(request, context)),
    handleOAuth: (request, context) => runAuth((engine) => engine.oauthHandler(request, context)),
    handleOAuthIntrospection: (request, context) =>
      runAuth((engine) => engine.oauthIntrospectionHandler(request, context)),
    exactRedirectAccepted: (clientId, redirectUri) =>
      runAuth((engine) => engine.exactRedirectAccepted(clientId, redirectUri)),
    recordTrustedOriginRejection: (context, credentialFlow) =>
      runAuth((engine) => engine.recordTrustedOriginRejection(context, credentialFlow)),
  };
  return makeBackendHttp(nativeHandler, authHandler, config.sessionBoundary);
};

let application: Promise<BackendHttp> | undefined;

export default {
  fetch: (request: Request, env: CloudflareBackendEnv) => {
    application ??= makeCloudflareBackend(env);
    return application.then((backend) => backend.fetch(request));
  },
};
