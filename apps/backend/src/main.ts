import { HttpRecruitmentNotificationsLive } from "./recruitment/delivery.js";
import { runRecruitmentInvitationWorker } from "./recruitment/worker.js";
import { runOnboardingExpirySweeper } from "./onboarding/delivery.js";
import { ReceiptDeliveryLive } from "./receipt/delivery.js";
import { ReceiptFileStoreLive } from "./receipt/filesystem.js";
import { runReceiptDeliveryWorker } from "./receipt/worker.js";
import { runPasswordResetDeliveryWorker } from "./password-recovery/worker.js";
import { HttpMailLive } from "./mail/http.js";
import { randomUUID } from "node:crypto";
import process from "node:process";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import { AuthEngine, AuthLive, databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { ReturningAssistantsLive } from "@vektorprogrammet/database/application";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import { EconomyLive } from "@vektorprogrammet/database/receipt/postgres";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { SchoolsLive } from "@vektorprogrammet/database/schools";
import { SocialEventsLive } from "@vektorprogrammet/database/social-events";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import { runTeamApplicationDeliveryWorker } from "./team-application/worker.js";
import { runPublicApplicationOutboxWorker } from "./application/worker.js";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { Etag, FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { publicApplicationHttpEffects } from "./application/effects.js";
import { decodeBackendConfig } from "./config.js";
import {
  schoolServiceNotificationDelivery,
  runSchoolServiceNotificationWorker,
} from "./placements/notification.js";
import {
  backendHttpHandler,
  ExternalNativeApiRouterLive,
  internalBackendHttpHandler,
  InternalNativeApiRouterLive,
  nativeHttpRouterConfig,
  nativeRouterWebHandler,
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

// An empty value is present, not absent, so it fails the check below as it always has.
const ingress = Effect.runSync(
  Config.String("BACKEND_INGRESS")
    .pipe(Config.withDefault("external"))
    .parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
);

if (ingress !== "external" && ingress !== "internal") {
  throw new TypeError("BACKEND_INGRESS must be external or internal");
}

const config = Effect.runSync(decodeBackendConfig(process.env));

// The migration reader reads the migration files through the Bun file system and path services.
const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "vektorprogrammet-backend",
  maxConnections: 8,
}).pipe(Layer.provide(BunServices.layer));

const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));

const economyLayer = EconomyLive.pipe(Layer.provide(databaseLayer));

const placementsLayer = PlacementsLive.pipe(Layer.provide(databaseLayer));

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

const teamApplicationsLayer = TeamApplicationsLive.pipe(Layer.provide(databaseLayer));

const capabilityLayers = Layer.mergeAll(
  returningAssistantsLayer,
  admissionsLayer,
  economyLayer,
  placementsLayer,
  organizationLayer,
  profileLayer,
  schoolsLayer,
  recruitmentLayer,
  contentManagementLayer,
  contentLayer,
  socialEventsLayer,
  teamApplicationsLayer,
);

// Handlers and workers reach the platform, delivery providers included, through these services.
const platformLayer = Layer.merge(BunServices.layer, FetchHttpClient.layer);

const receiptDeliveryLayer = ReceiptDeliveryLive(config.receiptDelivery).pipe(
  Layer.provide(Layer.merge(databaseLayer, platformLayer)),
);

const authLayer = AuthLive(config.auth).pipe(Layer.provide(databaseLayer));

const backendServicesLayer = Layer.mergeAll(
  databaseLayer,
  capabilityLayers,
  receiptDeliveryLayer,
  authLayer,
);

const httpPlatformLayer = Layer.mergeAll(platformLayer, BunHttpPlatform.layer, Etag.layer);

const httpRouterLayer = HttpRouter.layer.pipe(
  Layer.provide(Layer.succeed(HttpRouter.RouterConfig)(nativeHttpRouterConfig)),
);

const httpLayer = Layer.merge(httpPlatformLayer, httpRouterLayer);

const nativeApiLayer = (
  ingress === "external" ? ExternalNativeApiRouterLive(config) : InternalNativeApiRouterLive(config)
).pipe(
  HttpRouter.provideRequest(Layer.merge(backendServicesLayer, platformLayer)),
  Layer.provide(backendServicesLayer),
  Layer.provide(httpLayer),
);

const backendLayer = Layer.mergeAll(backendServicesLayer, httpLayer, nativeApiLayer);

const runtime = ManagedRuntime.make(backendLayer);

const router = await runtime.runPromise(HttpRouter.HttpRouter);

const nativeHandler = nativeRouterWebHandler(router);

// The HTTP boundary delegates to the one identity engine of this process.
const authEngine = await runtime.runPromise(AuthEngine);

const api =
  ingress === "external"
    ? backendHttpHandler(nativeHandler, authEngine, config.sessionBoundary)
    : internalBackendHttpHandler(nativeHandler, authEngine, config.auth.internalSourceNetworks);

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
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => runtime.runPromise(api(request)),
  });

  const onboardingExpiryFiber =
    ingress === "external" ? runtime.runFork(runOnboardingExpirySweeper) : undefined;

  const { publicApplicationEffects, schoolServiceNotifications } = config;

  const workerFiber =
    ingress === "internal" || publicApplicationEffects === undefined
      ? undefined
      : runtime.runFork(
          Effect.flatMap(publicApplicationHttpEffects(publicApplicationEffects), (interpreter) =>
            runPublicApplicationOutboxWorker(interpreter, {
              workerId: `backend-${randomUUID()}`,
              pollIntervalMilliseconds: publicApplicationEffects.pollIntervalMilliseconds,
              staleClaimMilliseconds: publicApplicationEffects.staleClaimMilliseconds,
            }),
          ),
        );

  const schoolServiceWorkerFiber =
    ingress === "internal" || schoolServiceNotifications === undefined
      ? undefined
      : runtime.runFork(
          Effect.flatMap(
            schoolServiceNotificationDelivery(schoolServiceNotifications),
            (interpreter) =>
              runSchoolServiceNotificationWorker(interpreter, {
                workerId: `school-service-${randomUUID()}`,
                pollIntervalMilliseconds: schoolServiceNotifications.pollIntervalMilliseconds,
                staleClaimMilliseconds: schoolServiceNotifications.staleClaimMilliseconds,
              }),
          ),
        );

  const recruitmentWorkerFiber =
    ingress === "internal" || config.recruitmentNotifications === undefined
      ? undefined
      : runtime.runFork(
          runRecruitmentInvitationWorker({
            workerId: `recruitment-${randomUUID()}`,
            pollIntervalMilliseconds: config.recruitmentNotifications.pollIntervalMilliseconds,
            staleClaimMilliseconds: config.recruitmentNotifications.staleClaimMilliseconds,
          }).pipe(
            Effect.provide(HttpRecruitmentNotificationsLive(config.recruitmentNotifications)),
          ),
        );

  const passwordResetWorkerFiber =
    ingress === "internal" || config.passwordResetDelivery === undefined
      ? undefined
      : runtime.runFork(
          runPasswordResetDeliveryWorker(config.auth, config.passwordResetDelivery).pipe(
            Effect.provide(HttpMailLive(config.passwordResetDelivery.transport)),
          ),
        );

  const receiptWorkerFiber =
    ingress === "internal" || config.receiptDeliveryPollMilliseconds === undefined
      ? undefined
      : runtime.runFork(
          runReceiptDeliveryWorker(config.receiptDeliveryPollMilliseconds).pipe(
            Effect.provide(ReceiptFileStoreLive(config.receipt)),
          ),
        );

  const teamApplicationWorkerFiber =
    ingress === "internal" || config.teamApplicationDelivery === undefined
      ? undefined
      : runtime.runFork(
          runTeamApplicationDeliveryWorker(config.teamApplicationDelivery).pipe(
            Effect.provide(HttpMailLive(config.teamApplicationDelivery.transport)),
          ),
        );

  if (ingress === "external" && teamApplicationWorkerFiber === undefined) {
    process.stderr.write("team application delivery worker is not configured\n");
  }

  if (ingress === "external" && recruitmentWorkerFiber === undefined) {
    process.stderr.write("recruitment notification worker is not configured\n");
  }

  if (ingress === "external" && workerFiber === undefined) {
    process.stderr.write("public application effect worker is not configured\n");
  }

  if (ingress === "external" && schoolServiceWorkerFiber === undefined) {
    process.stderr.write("school service notification worker is not configured\n");
  }

  process.stdout.write(`${ingress} backend listening on ${config.host}:${config.port}\n`);

  const interruptWorker = <A, E>(fiber: Fiber.Fiber<A, E> | undefined) =>
    fiber === undefined ? Effect.succeed(false) : Effect.as(Fiber.interrupt(fiber), false);

  // After the interrupt, a delivery worker's own failure also fails the shutdown.
  const interruptDeliveryWorker = <A, E>(fiber: Fiber.Fiber<A, E> | undefined) =>
    fiber === undefined
      ? Effect.succeed(false)
      : Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.map((exit) => Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)),
        );

  // Run in this order; each step reports whether it failed, and a failed step does not stop the next.
  const shutdownSteps: ReadonlyArray<Effect.Effect<boolean, Cause.UnknownError>> = [
    Effect.as(
      Effect.tryPromise(() => Promise.resolve(server.stop(true))),
      false,
    ),
    interruptWorker(onboardingExpiryFiber),
    interruptWorker(workerFiber),
    interruptWorker(schoolServiceWorkerFiber),
    interruptWorker(recruitmentWorkerFiber),
    interruptDeliveryWorker(passwordResetWorkerFiber),
    interruptDeliveryWorker(receiptWorkerFiber),
    interruptDeliveryWorker(teamApplicationWorkerFiber),
    Effect.as(runtime.disposeEffect, false),
  ];

  let shuttingDown = false;

  const shutdown = (workerFailed = false) => {
    if (shuttingDown) return;

    shuttingDown = true;

    void Effect.runPromise(
      Effect.forEach(shutdownSteps, (step) => Effect.catchCause(step, () => Effect.succeed(true))),
    ).then((stepFailures) => {
      const exitCode = workerFailed || stepFailures.includes(true) ? 1 : 0;

      process.exitCode = exitCode;
      process.exit(exitCode);
    });
  };

  if (onboardingExpiryFiber !== undefined) {
    void runtime.runPromise(Fiber.await(onboardingExpiryFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("onboarding expiry worker failed\n");
        shutdown(true);
      }
    });
  }

  if (workerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(workerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("public application effect worker failed\n");
        shutdown(true);
      }
    });
  }

  if (schoolServiceWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(schoolServiceWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("school service notification worker failed\n");
        shutdown(true);
      }
    });
  }

  if (recruitmentWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(recruitmentWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("recruitment notification worker failed\n");
        shutdown(true);
      }
    });
  }

  if (passwordResetWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(passwordResetWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("password reset delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  if (receiptWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(receiptWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("receipt delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  if (teamApplicationWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(teamApplicationWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && !shuttingDown) {
        process.stderr.write("team application delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}
