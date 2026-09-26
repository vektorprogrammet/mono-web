import { HttpRecruitmentNotificationsLive } from "./recruitment/delivery.js";
import { runRecruitmentInvitationWorker } from "./recruitment/worker.js";
import { runOnboardingExpirySweeper } from "./onboarding/delivery.js";
import { ReceiptDeliveryLive } from "./receipt/delivery.js";
import { ReceiptFileStoreLive } from "./receipt/filesystem.js";
import { runReceiptDeliveryWorker } from "./receipt/worker.js";
import { runPasswordResetDeliveryWorker } from "./password-recovery/worker.js";
import { HttpMailLive } from "./mail/http.js";
import { randomUUID } from "node:crypto";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  AuthEngine,
  AuthLive,
  databaseHealth,
  type AuthEngineService,
} from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { ReturningAssistantsLive } from "@vektorprogrammet/database/application";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import { SubstitutesLive } from "@vektorprogrammet/database/substitutes";
import { EconomyLive } from "@vektorprogrammet/database/receipt/postgres";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { SchoolsLive } from "@vektorprogrammet/database/schools";
import { SocialEventsLive } from "@vektorprogrammet/database/social-events";
import { SchoolSurveysLive } from "@vektorprogrammet/database/surveys";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import { runTeamApplicationDeliveryWorker } from "./team-application/worker.js";
import { runPublicApplicationOutboxWorker } from "./application/worker.js";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { Etag, HttpEffect, HttpRouter } from "effect/unstable/http";
import { publicApplicationHttpEffects } from "./application/effects.js";
import { decodeBackendConfig } from "./config.js";
import {
  schoolServiceNotificationDelivery,
  runSchoolServiceNotificationWorker,
} from "./placements/notification.js";
import {
  schoolServiceDispatchDelivery,
  runSchoolServiceDispatchNotificationWorker,
} from "./placements/dispatch-notification.js";
import {
  backendHttpHandler,
  ExternalNativeApiRouterLive,
  internalBackendHttpHandler,
  InternalNativeApiRouterLive,
  nativeHttpRouterConfig,
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

const config = decodeBackendConfig(process.env);

const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "vektorprogrammet-backend",
  maxConnections: 8,
});

const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));

const economyLayer = EconomyLive.pipe(Layer.provide(databaseLayer));

const placementsLayer = PlacementsLive.pipe(Layer.provide(databaseLayer));

const substitutesLayer = SubstitutesLive.pipe(Layer.provide(databaseLayer));

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

const teamApplicationsLayer = TeamApplicationsLive.pipe(Layer.provide(databaseLayer));

const capabilityLayers = Layer.mergeAll(
  returningAssistantsLayer,
  admissionsLayer,
  economyLayer,
  placementsLayer,
  substitutesLayer,
  organizationLayer,
  profileLayer,
  schoolsLayer,
  recruitmentLayer,
  contentManagementLayer,
  contentLayer,
  socialEventsLayer,
  schoolSurveysLayer,
  teamApplicationsLayer,
);

const receiptDeliveryLayer = ReceiptDeliveryLive(config.receiptDelivery).pipe(
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

const httpRouterLayer = HttpRouter.layer.pipe(
  Layer.provide(Layer.succeed(HttpRouter.RouterConfig)(nativeHttpRouterConfig)),
);

const httpLayer = Layer.merge(httpPlatformLayer, httpRouterLayer);

const nativeApiLayer = (
  ingress === "external" ? ExternalNativeApiRouterLive(config) : InternalNativeApiRouterLive(config)
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
      catch: (cause) => new Cause.UnknownError(cause, "Better Auth runtime operation failed"),
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
    ? backendHttpHandler(nativeHandler, authHandler, config.sessionBoundary)
    : internalBackendHttpHandler(nativeHandler, authHandler, config.auth.internalSourceNetworks);

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
            publicApplicationHttpEffects(config.publicApplicationEffects),
            {
              workerId: `backend-${randomUUID()}`,
              pollIntervalMilliseconds: config.publicApplicationEffects.pollIntervalMilliseconds,
              staleClaimMilliseconds: config.publicApplicationEffects.staleClaimMilliseconds,
            },
          ),
        );

  const schoolServiceWorkerFiber =
    ingress === "internal" || config.schoolServiceNotifications === undefined
      ? undefined
      : runtime.runFork(
          runSchoolServiceNotificationWorker(
            schoolServiceNotificationDelivery(config.schoolServiceNotifications),
            {
              workerId: `school-service-${randomUUID()}`,
              pollIntervalMilliseconds: config.schoolServiceNotifications.pollIntervalMilliseconds,
              staleClaimMilliseconds: config.schoolServiceNotifications.staleClaimMilliseconds,
            },
          ),
        );

  const schoolServiceDispatchWorkerFiber =
    ingress === "internal" || config.schoolServiceDispatchNotifications === undefined
      ? undefined
      : runtime.runFork(
          runSchoolServiceDispatchNotificationWorker(
            schoolServiceDispatchDelivery(config.schoolServiceDispatchNotifications),
            {
              workerId: `school-service-dispatch-${randomUUID()}`,
              pollIntervalMilliseconds:
                config.schoolServiceDispatchNotifications.pollIntervalMilliseconds,
              staleClaimMilliseconds:
                config.schoolServiceDispatchNotifications.staleClaimMilliseconds,
            },
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

  if (ingress === "external" && schoolServiceDispatchWorkerFiber === undefined) {
    process.stderr.write("school service dispatch notification worker is not configured\n");
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

      if (schoolServiceDispatchWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(schoolServiceDispatchWorkerFiber));
        } catch {
          exitCode = 1;
        }
      }

      if (recruitmentWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(recruitmentWorkerFiber));
        } catch {
          exitCode = 1;
        }
      }

      if (passwordResetWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(passwordResetWorkerFiber));
          const exit = await runtime.runPromise(Fiber.await(passwordResetWorkerFiber));

          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) exitCode = 1;
        } catch {
          exitCode = 1;
        }
      }

      if (receiptWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(receiptWorkerFiber));
          const exit = await runtime.runPromise(Fiber.await(receiptWorkerFiber));

          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) exitCode = 1;
        } catch {
          exitCode = 1;
        }
      }

      if (teamApplicationWorkerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(teamApplicationWorkerFiber));
          const exit = await runtime.runPromise(Fiber.await(teamApplicationWorkerFiber));

          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) exitCode = 1;
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
        shutdown(true);
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

  if (schoolServiceDispatchWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(schoolServiceDispatchWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("school service dispatch notification worker failed\n");
        shutdown(true);
      }
    });
  }

  if (recruitmentWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(recruitmentWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("recruitment notification worker failed\n");
        shutdown(true);
      }
    });
  }

  if (passwordResetWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(passwordResetWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("password reset delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  if (receiptWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(receiptWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("receipt delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  if (teamApplicationWorkerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(teamApplicationWorkerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("team application delivery worker failed\n");
        shutdown(true);
      }
    });
  }

  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}
