import { randomUUID } from "node:crypto";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import { AuthEngine, AuthLive, DatabaseLive } from "@vektorprogrammet/database";
import { runPublicApplicationOutboxWorker } from "@vektorprogrammet/domain/application";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { databaseHealth } from "@vektorprogrammet/domain/database";
import { OrganizationLive } from "@vektorprogrammet/domain/organization";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import { RecruitmentLive } from "@vektorprogrammet/domain/recruitment";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/domain/content";
import { SchoolsLive } from "@vektorprogrammet/domain/schools";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { Etag, HttpEffect, HttpRouter } from "effect/unstable/http";
import { makeHttpPublicApplicationEffectInterpreter } from "./application/effects.js";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp, makeNativeApiRouterLayer, type BackendRun } from "./router.js";
import { makeBackendRuntime } from "../runtime.js";

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
};

const config = makeBackendConfig();
const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "vektorprogrammet-backend",
  maxConnections: 8,
});
const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
const economyLayer = EconomyLive.pipe(Layer.provide(databaseLayer));
const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
const profileLayer = ProfileLive.pipe(Layer.provide(Layer.merge(databaseLayer, organizationLayer)));
const schoolsLayer = SchoolsLive.pipe(Layer.provide(databaseLayer));
const contentManagementLayer = ContentManagementLive.pipe(Layer.provide(databaseLayer));
const contentLayer = ContentLive.pipe(
  Layer.provide(Layer.mergeAll(databaseLayer, organizationLayer, profileLayer)),
);
const recruitmentLayer = RecruitmentLive.pipe(
  Layer.provide(Layer.mergeAll(databaseLayer, admissionsLayer, organizationLayer, profileLayer)),
);
const capabilityLayers = Layer.mergeAll(
  admissionsLayer,
  economyLayer,
  organizationLayer,
  profileLayer,
  schoolsLayer,
  recruitmentLayer,
  contentManagementLayer,
  contentLayer,
);
const authLayers = AuthLive(config.auth).pipe(Layer.provide(databaseLayer));
const httpPlatformLayer = Layer.mergeAll(BunServices.layer, BunHttpPlatform.layer, Etag.layer);
const httpRouterLayer = HttpRouter.layer;
const run: BackendRun = (effect) => runtime.runPromise(effect);
const nativeApiLayer = makeNativeApiRouterLayer(config, run).pipe(
  Layer.provide(httpPlatformLayer),
  Layer.provide(httpRouterLayer),
);
const runtime = makeBackendRuntime(
  Layer.mergeAll(
    databaseLayer,
    capabilityLayers,
    authLayers,
    httpPlatformLayer,
    httpRouterLayer,
    nativeApiLayer,
  ),
);
const router = await runtime.runPromise(HttpRouter.HttpRouter);
const nativeHandler = HttpEffect.toWebHandler(router.asHttpEffect());
const api = makeBackendHttp(nativeHandler, {
  handle: (request) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* AuthEngine;
        return yield* Effect.promise(() => engine.handler(request));
      }),
    ),
});

try {
  await run(databaseHealth);
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
  const workerFiber =
    config.publicApplicationEffects === undefined
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
  if (workerFiber === undefined) {
    process.stderr.write("public application effect worker is not configured\n");
  }
  process.stdout.write(`backend listening on ${config.host}:${config.port}\n`);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      let exitCode = 0;
      try {
        await server.stop(true);
      } catch {
        exitCode = 1;
      }
      if (workerFiber !== undefined) {
        try {
          await runtime.runPromise(Fiber.interrupt(workerFiber));
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
  if (workerFiber !== undefined) {
    void runtime.runPromise(Fiber.await(workerFiber)).then((exit) => {
      if (Exit.isFailure(exit) && shutdownPromise === undefined) {
        process.stderr.write("public application effect worker failed\n");
        shutdown();
      }
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
