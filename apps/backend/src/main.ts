import { runOnboardingExpirySweeper } from "./onboarding/delivery.js";
import { makeReceiptDeliveryLayer, receiptDeliveryConfig } from "./receipt/delivery.js";
import { randomUUID } from "node:crypto";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  AuthEngine,
  AuthLive,
  DatabaseLive,
  databaseHealth,
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
import { runPublicApplicationOutboxWorker } from "./application/worker.js";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { Etag, HttpEffect, HttpRouter } from "effect/unstable/http";
import { makeHttpPublicApplicationEffectInterpreter } from "./application/effects.js";
import { makeBackendConfig } from "./config.js";
import {
  makeHttpSchoolServiceNotificationInterpreter,
  runSchoolServiceNotificationWorker,
} from "./placements/notification.js";
import {
  makeBackendHttp,
  makeExternalNativeApiRouterLayer,
  makeInternalBackendHttp,
  makeInternalNativeApiRouterLayer,
  type BackendAuthHandler,
} from "./router.js";

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
};

const ingress = process.env.BACKEND_INGRESS ?? "external";
if (ingress !== "external" && ingress !== "internal") {
  throw new TypeError("BACKEND_INGRESS must be external or internal");
}

const config = makeBackendConfig();
const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "vektorprogrammet-backend",
  maxConnections: 8,
});
const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
const economyLayer = EconomyLive.pipe(Layer.provide(databaseLayer));
const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
const returningAssistantsLayer = ReturningAssistantsLive.pipe(Layer.provide(databaseLayer));
const profileLayer = ProfileLive.pipe(Layer.provide(Layer.merge(databaseLayer, organizationLayer)));
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
const capabilityLayers = Layer.mergeAll(
  returningAssistantsLayer,
  admissionsLayer,
  economyLayer,
  organizationLayer,
  profileLayer,
  schoolsLayer,
  recruitmentLayer,
  contentManagementLayer,
  contentLayer,
  socialEventsLayer,
  schoolSurveysLayer,
);
const receiptDeliveryLayer = makeReceiptDeliveryLayer(receiptDeliveryConfig(process.env)).pipe(
  Layer.provide(databaseLayer),
);
const authLayer = AuthLive(config.auth).pipe(Layer.provide(databaseLayer));
const backendServicesLayer = Layer.mergeAll(
  databaseLayer,
  capabilityLayers,
  receiptDeliveryLayer,
  authLayer,
);
const httpPlatformLayer = Layer.mergeAll(BunServices.layer, BunHttpPlatform.layer, Etag.layer);
const httpRouterLayer = HttpRouter.layer;
const httpLayer = Layer.merge(httpPlatformLayer, httpRouterLayer);
const nativeApiLayer = (
  ingress === "external"
    ? makeExternalNativeApiRouterLayer(config)
    : makeInternalNativeApiRouterLayer(config)
).pipe(
  HttpRouter.provideRequest(backendServicesLayer),
  Layer.provide(backendServicesLayer),
  Layer.provide(httpLayer),
);
const backendLayer = Layer.mergeAll(backendServicesLayer, httpLayer, nativeApiLayer);
const runtime = ManagedRuntime.make(backendLayer);
const router = await runtime.runPromise(HttpRouter.HttpRouter);
const nativeHandler = HttpEffect.toWebHandler(router.asHttpEffect());
const authBoundary = <A>(operation: (engine: AuthEngineService) => Promise<A>) =>
  AuthEngine.use((engine) =>
    Effect.tryPromise({
      try: () => operation(engine),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Better Auth runtime operation failed"),
    }),
  );
const authHandler: BackendAuthHandler = {
  handle: (request, context) =>
    runtime.runPromise(authBoundary((engine) => engine.handler(request, context))),
  handleOAuth: (request, context) =>
    runtime.runPromise(authBoundary((engine) => engine.oauthHandler(request, context))),
  handleOAuthIntrospection: (request, context) =>
    runtime.runPromise(
      authBoundary((engine) => engine.oauthIntrospectionHandler(request, context)),
    ),
  exactRedirectAccepted: (clientId, redirectUri) =>
    runtime.runPromise(
      authBoundary((engine) => engine.exactRedirectAccepted(clientId, redirectUri)),
    ),
  recordTrustedOriginRejection: (context, credentialFlow) =>
    runtime.runPromise(
      authBoundary((engine) => engine.recordTrustedOriginRejection(context, credentialFlow)),
    ),
};
const api =
  ingress === "external"
    ? makeBackendHttp(nativeHandler, authHandler, config.sessionBoundary)
    : makeInternalBackendHttp(nativeHandler, authHandler, config.auth.internalSourceNetworks);

try {
  await runtime.runPromise(databaseHealth);
} catch {
  process.stderr.write("backend database initialization failed\n");
  process.exitCode = 1;
  try {
    await runtime.dispose();
  } catch {
    process.stderr.write("backend runtime disposal failed\n");
  }
}

if (process.exitCode !== 1) {
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: api.fetch });
  const onboardingExpiryFiber =
    ingress === "external" ? runtime.runFork(runOnboardingExpirySweeper) : undefined;
  const workerFiber =
    ingress === "internal" || config.publicApplicationEffects === undefined
      ? undefined
      : runtime.runFork(
          runPublicApplicationOutboxWorker(
            makeHttpPublicApplicationEffectInterpreter(config.publicApplicationEffects),
            {
              workerId: `backend-${randomUUID()}`,
              pollIntervalMilliseconds: config.publicApplicationEffects.pollIntervalMilliseconds,
              staleClaimMilliseconds: config.publicApplicationEffects.staleClaimMilliseconds,
              now: () => new Date().toISOString(),
            },
          ),
        );
  const schoolServiceWorkerFiber =
    ingress === "internal" || config.schoolServiceNotifications === undefined
      ? undefined
      : runtime.runFork(
          runSchoolServiceNotificationWorker(
            makeHttpSchoolServiceNotificationInterpreter(config.schoolServiceNotifications),
            {
              workerId: `school-service-${randomUUID()}`,
              pollIntervalMilliseconds: config.schoolServiceNotifications.pollIntervalMilliseconds,
              staleClaimMilliseconds: config.schoolServiceNotifications.staleClaimMilliseconds,
              now: () => new Date().toISOString(),
            },
          ),
        );
  if (ingress === "external" && workerFiber === undefined) {
    process.stderr.write("public application effect worker is not configured\n");
  }
  if (ingress === "external" && schoolServiceWorkerFiber === undefined) {
    process.stderr.write("school service notification worker is not configured\n");
  }
  process.stdout.write(`${ingress} backend listening on ${config.host}:${config.port}\n`);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (workerFailed = false) => {
    shutdownPromise ??= (async () => {
      let exitCode = workerFailed ? 1 : 0;
      try {
        await server.stop(true);
      } catch {
        exitCode = 1;
      }
      if (onboardingExpiryFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(onboardingExpiryFiber));
        } catch {
          exitCode = 1;
        }
      }
      if (workerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(workerFiber));
        } catch {
          exitCode = 1;
        }
      }
      if (schoolServiceWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(schoolServiceWorkerFiber));
        } catch {
          exitCode = 1;
        }
      }
      try {
        await runtime.dispose();
      } catch {
        exitCode = 1;
      }
      process.exitCode = exitCode;
      process.exit(exitCode);
    })();
  };
  if (onboardingExpiryFiber !== undefined) {
    void runtime.runPromise(Fiber.await(onboardingExpiryFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("onboarding expiry worker failed\n");
        void shutdown(true);
      }
    });
  }
  if (workerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(workerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("public application effect worker failed\n");
        shutdown(true);
      }
    });
  }
  if (schoolServiceWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(schoolServiceWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("school service notification worker failed\n");
        shutdown(true);
      }
    });
  }
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}
