import { AuthEngine, AuthLive, type AuthEngineService } from "@vektorprogrammet/database/auth";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
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
import { Cause, Effect, Layer, ManagedRuntime, Predicate, Redacted } from "effect";
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http";
import { decodeBackendConfig } from "./config.js";
import { CloudflareMailLive, type CloudflareSendEmailBinding } from "./mail/cloudflare.js";
import { ReceiptDeliveryLive, receiptDeliveryConfig } from "./receipt/delivery.js";
import { R2ReceiptFileStoreLive, type R2Bucket } from "./receipt/r2.js";
import { ReceiptFileStoreResource } from "./receipt/filesystem.js";
import {
  backendHttpHandler,
  ExternalNativeApiRouterLive,
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
  readonly MAIL_RECIPIENT_OVERRIDE?: string;
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
    !Predicate.isString(env.HYPERDRIVE.connectionString) ||
    env.HYPERDRIVE.connectionString.length === 0
  ) {
    throw new CloudflareBackendBindingError("HYPERDRIVE");
  }

  if (
    !Predicate.isObject(env.RECEIPT_FILES) ||
    !Predicate.isFunction(env.RECEIPT_FILES.get) ||
    !Predicate.isFunction(env.RECEIPT_FILES.put) ||
    !Predicate.isFunction(env.RECEIPT_FILES.delete)
  ) {
    throw new CloudflareBackendBindingError("RECEIPT_FILES");
  }

  if (!Predicate.isObject(env.MAIL) || !Predicate.isFunction(env.MAIL.send)) {
    throw new CloudflareBackendBindingError("MAIL");
  }

  if (!Predicate.isString(env.MAIL_SENDER) || env.MAIL_SENDER.length === 0) {
    throw new CloudflareBackendBindingError("MAIL_SENDER");
  }

  return {
    hyperdrive: env.HYPERDRIVE,
    receiptFiles: env.RECEIPT_FILES,
    mail: env.MAIL,
    sender: env.MAIL_SENDER,
  };
};

/** Builds the same modular HTTP application as Bun, with Worker-owned provider Layers. */
export const makeCloudflareBackend = async (env: CloudflareBackendEnv): Promise<BackendHttp> => {
  const bindings = requireCloudflareBackendBindings(env);

  const configEnv = Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      Predicate.isString(value) ? [[name, value]] : [],
    ),
  );

  const config = decodeBackendConfig({
    ...configEnv,
    BACKEND_PG_URL: bindings.hyperdrive.connectionString,
  });

  const timeout = env.MAIL_TIMEOUT_MS === undefined ? 10_000 : Number(env.MAIL_TIMEOUT_MS);

  const databaseLayer = DatabaseRuntimeLive({
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

  const receiptDeliveryLayer = ReceiptDeliveryLive(receiptDeliveryConfig(configEnv)).pipe(
    Layer.provide(databaseLayer),
  );

  const mailLayer = CloudflareMailLive({
    binding: bindings.mail,
    recipientOverride: env.MAIL_RECIPIENT_OVERRIDE,
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

  const nativeApiLayer = Layer.unwrap(
    Effect.map(ReceiptFileStoreResource, (receiptFileStore) =>
      ExternalNativeApiRouterLive(config, { receiptFileStore }),
    ),
  ).pipe(
    Layer.provide(R2ReceiptFileStoreLive({ bucket: bindings.receiptFiles })),
    HttpRouter.provideRequest(services),
    Layer.provide(services),
    Layer.provide(httpLayer),
  );

  const runtime = ManagedRuntime.make(Layer.mergeAll(services, httpLayer, nativeApiLayer));
  const router = await runtime.runPromise(HttpRouter.HttpRouter);
  const nativeHandler = HttpEffect.toWebHandler(router.asHttpEffect());

  const runAuth = <A>(operation: (engine: AuthEngineService) => Promise<A>) =>
    runtime.runPromise(
      AuthEngine.use((engine) =>
        Effect.tryPromise({
          try: () => operation(engine),
          catch: (cause) => new Cause.UnknownError(cause, "Better Auth runtime operation failed"),
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

  return backendHttpHandler(nativeHandler, authHandler, config.sessionBoundary);
};

let application: Promise<BackendHttp> | undefined;

export default {
  fetch: (request: Request, env: CloudflareBackendEnv) => {
    application ??= makeCloudflareBackend(env);

    return application.then((backend) => backend.fetch(request));
  },
};
