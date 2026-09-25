/**
 * Golden team-application journey for `docs/specs/team-application-journey.md`.
 *
 * Boots a private PostgreSQL cluster, a loopback mail provider, the native Bun
 * backend, the built dashboard, and the built homepage Worker preview on private
 * loopback ports. Fixtures seed prerequisites only; one continuous Chromium
 * journey then drives every observable item, and each checkpoint is bound to an
 * independent REPEATABLE READ PostgreSQL snapshot.
 *
 * Usage: bun --no-env-file tools/e2e/golden-team-application.ts
 * Faults: GOLDEN_TEAM_APPLICATION_FAULT=after-submitted|interrupt-after-submitted
 */
import { join } from "node:path";
import type * as BunServices from "@effect/platform-bun/BunServices";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Effect, Exit, FileSystem, Scope } from "effect";
import {
  runTeamApplicationBrowser,
  teamApplicationCheckpoints,
} from "../../apps/dashboard/e2e/golden-team-application-browser";
import {
  eventually,
  failure,
  fromAbortable,
  type GoldenContext,
  type GoldenJourney,
  runGoldenJourney,
  waitForHttp,
} from "./golden-harness";
import {
  identitySeedPersons,
  mailSender,
  teamApplicationObserver,
  notificationStates,
  retainedAttempts,
  seedTeamApplicationFixture,
  teamApplicationFixture,
} from "./golden-team-application-evidence";

const homepageHost = "p000.vektor.phibkro.org";

const steps = teamApplicationCheckpoints.map(({ step }) => step);

/** Digests every file below one build output directory for `browser-build.json`. */
const buildInventory = (context: GoldenContext, directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = join(context.root, directory);
    const names = (yield* fs.readDirectory(root, { recursive: true })).sort();

    const files = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const path = join(root, name);

        if ((yield* fs.stat(path)).type !== "File") return [];

        const bytes = yield* fs.readFile(path);

        return [{ bytes: bytes.length, path: name, sha256: sha256Hex(bytes) }];
      }),
    );

    const inventory = files.flat();

    return {
      directory,
      digest: `sha256:${sha256Hex(canonicalJsonBytes(inventory))}`,
      files: inventory,
    };
  }).pipe(Effect.mapError(failure(`inventory ${directory}`)));

const journey: GoldenJourney = {
  id: "golden-team-application",
  sourcePaths: [
    "apps/backend",
    "apps/dashboard",
    "apps/homepage",
    "packages/domain",
    "packages/database",
    "packages/http-api",
    "packages/sdk",
    "tools/e2e",
  ],
  steps,
  faultVariable: "GOLDEN_TEAM_APPLICATION_FAULT",
  faultPoints: ["after-submitted"],
  deadline: "25 minutes",
  requiredBrowser: true,
  body: (context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const [postgresPort = 0, apiPort = 0, dashboardPort = 0, homepagePort = 0, providerPort = 0] =
        yield* context.reservePorts(5);

      const password = yield* context.secret(24);
      const token = yield* context.secret(24);
      const authSecret = yield* context.secret(32);
      const fixture = teamApplicationFixture(password);

      const origins = {
        backend: `http://127.0.0.1:${apiPort}`,
        dashboard: `http://127.0.0.1:${dashboardPort}`,
        homepage: `http://${homepageHost}:${homepagePort}`,
      };

      const database = yield* context.postgres(
        postgresPort,
        "team-application-independent-observer",
      );

      const provider = yield* context.provider({
        port: providerPort,
        path: "/mail",
        token,
        maxBodyBytes: 65_536,
      });

      for (const directory of ["receipt-staging", "receipt-committed"])
        yield* fs
          .makeDirectory(join(context.privateRoot, directory), { mode: 0o700 })
          .pipe(Effect.mapError(failure("receipt roots")));

      const backendEnvironment = {
        ...context.environment,
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: String(apiPort),
        BACKEND_INGRESS: "external",
        BACKEND_PG_URL: database.url,
        BETTER_AUTH_SECRET: authSecret,
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([origins.dashboard]),
        OAUTH_CANONICAL_ORIGIN: origins.backend,
        OAUTH_DASHBOARD_ORIGIN: origins.dashboard,
        OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
        RECEIPT_STAGING_ROOT: join(context.privateRoot, "receipt-staging"),
        RECEIPT_COMMITTED_ROOT: join(context.privateRoot, "receipt-committed"),
        PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
        PASSWORD_RESET_DELIVERY_MODE: "disabled",
        RECEIPT_DELIVERY_MODE: "disabled",
        RECRUITMENT_NOTIFICATION_MODE: "disabled",
        SCHOOL_SERVICE_NOTIFICATION_MODE: "disabled",
        SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE: "disabled",
        TEAM_APPLICATION_DELIVERY_MODE: "http",
        TEAM_APPLICATION_DELIVERY_POLL_MS: "250",
        TEAM_APPLICATION_DELIVERY_STALE_MS: "5000",
        // The public submit limiter shares one bucket per process. The journey sends 17
        // submissions in about a minute; the admissions journey uses the same bound.
        TEAM_APPLICATION_RATE_LIMIT_MAX: "64",
        TEAM_APPLICATION_RATE_LIMIT_WINDOW_MS: "600000",
        MAIL_DELIVERY_URL: provider.url,
        MAIL_DELIVERY_TOKEN: token,
        MAIL_DELIVERY_TIMEOUT_MS: "1000",
        MAIL_SENDER: mailSender,
      };

      yield* context.run(
        {
          label: "identity-seed",
          command: "bun",
          args: ["--no-env-file", "run", "--cwd", "packages/database", "identity:seed"],
          cwd: context.root,
          env: {
            ...backendEnvironment,
            IDENTITY_SEED_PG_URL: database.url,
            IDENTITY_SEED_PERSONS: JSON.stringify(identitySeedPersons(fixture)),
          },
        },
        "180 seconds",
      );
      yield* seedTeamApplicationFixture(database.pool, fixture);

      // The backend lives in its own sub-scope so the journey can replace it mid-run.
      const journeyScope = yield* Scope.Scope;

      const bootBackend = Effect.gen(function* () {
        const scope = yield* Scope.fork(journeyScope);

        const backend = yield* context
          .spawn({
            label: "backend",
            command: "bun",
            args: ["--no-env-file", "apps/backend/src/main.ts"],
            cwd: context.root,
            env: backendEnvironment,
            forceKillAfter: "10 seconds",
            supervised: true,
          })
          .pipe(Scope.provide(scope));

        yield* waitForHttp({
          label: "backend",
          url: `${origins.backend}/health`,
          process: backend,
          deadline: "60 seconds",
        });

        return scope;
      });

      let backendScope = yield* bootBackend;

      yield* context.run(
        {
          label: "sdk-build",
          command: "bun",
          args: ["--no-env-file", "run", "--cwd", "packages/sdk", "build"],
          cwd: context.root,
          env: context.environment,
        },
        "180 seconds",
      );

      const dashboardRoot = join(context.root, "apps/dashboard");

      const dashboardEnvironment = {
        ...context.environment,
        API_URL: origins.backend,
        VITE_API_URL: origins.dashboard,
        DASHBOARD_ORIGIN: origins.dashboard,
        DASHBOARD_MOUNT: "/dashboard/",
        HOST: "127.0.0.1",
        PORT: String(dashboardPort),
        NODE_ENV: "production",
        REAL_NATIVE_IDENTITY_E2E: "1",
      };

      yield* context.run(
        {
          label: "dashboard-build",
          command: "bun",
          args: ["--no-env-file", "run", "build"],
          cwd: dashboardRoot,
          env: dashboardEnvironment,
        },
        "600 seconds",
      );

      const homepageRoot = join(context.root, "apps/homepage");

      // The Cloudflare plugin serializes preview variables at build time; process
      // variables are included only on request. The inherited set is the allow-list.
      const homepageEnvironment = {
        ...context.environment,
        API_URL: origins.backend,
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
      };

      yield* context.run(
        {
          label: "homepage-build",
          command: "bun",
          args: ["--no-env-file", "run", "worker:build"],
          cwd: homepageRoot,
          env: homepageEnvironment,
        },
        "600 seconds",
      );

      const builds = yield* Effect.all([
        buildInventory(context, "apps/dashboard/build"),
        buildInventory(context, "apps/homepage/build"),
      ]);

      yield* fs
        .writeFileString(
          join(context.artifacts, "browser-build.json"),
          JSON.stringify(
            { revision: context.revision, sourceTree: context.sourceTree, builds },
            null,
            2,
          ),
          { mode: 0o600 },
        )
        .pipe(Effect.mapError(failure("browser-build")));

      const dashboard = yield* context.spawn({
        label: "dashboard",
        command: "bun",
        args: ["--no-env-file", "server.mjs"],
        cwd: dashboardRoot,
        env: dashboardEnvironment,
        supervised: true,
      });

      yield* waitForHttp({
        label: "dashboard",
        url: `${origins.dashboard}/dashboard/login`,
        process: dashboard,
        deadline: "60 seconds",
      });

      const homepage = yield* context.spawn({
        label: "homepage",
        command: "bun",
        args: [
          "--no-env-file",
          "run",
          "vite",
          "preview",
          "--host",
          "127.0.0.1",
          "--port",
          String(homepagePort),
          "--strictPort",
        ],
        cwd: homepageRoot,
        env: homepageEnvironment,
        supervised: true,
      });

      yield* waitForHttp({
        label: "homepage",
        url: `http://127.0.0.1:${homepagePort}/health`,
        host: homepageHost,
        process: homepage,
        deadline: "90 seconds",
      });

      const observer = teamApplicationObserver({
        pool: database.pool,
        fixture,
        steps,
        attempts: provider.attempts,
      });

      const services = yield* Effect.context<Scope.Scope | BunServices.BunServices>();
      const run = Effect.runPromiseWith(services);

      const checks = yield* fromAbortable(
        "browser",
        (signal) =>
          runTeamApplicationBrowser({
            origins,
            homepageHost,
            chromiumExecutable:
              context.environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
              "/etc/profiles/per-user/nori/bin/chromium-browser",
            artifacts: context.artifacts,
            signal,
            fixture,
            hooks: {
              checkpoint: (step, record) =>
                run(context.checkpoint(step, observer.observe(step, record)), { signal }),
              awaitNotifications: (applicationId, status) =>
                run(
                  eventually(
                    `${applicationId} notifications ${status}`,
                    notificationStates(database.pool, applicationId).pipe(
                      Effect.map(
                        (rows) =>
                          rows.length === 2 &&
                          rows.every((row) => row.status === status && row.attempts > 0),
                      ),
                    ),
                    "90 seconds",
                  ),
                  { signal },
                ),
              setProviderMode: (mode) => run(provider.setMode(mode), { signal }),
              restartBackend: () =>
                run(
                  Effect.gen(function* () {
                    const before = yield* retainedAttempts(database.pool);

                    yield* Scope.close(backendScope, Exit.void);
                    backendScope = yield* bootBackend;
                    yield* eventually(
                      "restarted worker retries retained notifications",
                      retainedAttempts(database.pool).pipe(Effect.map((after) => after > before)),
                      "60 seconds",
                    );
                    yield* context.sample("backend-restarted");
                  }),
                  { signal },
                ),
              faultPoint: (point) => run(context.faultPoint(point), { signal }),
            },
          }),
        "30 seconds",
      );

      yield* context.record("browser", { checks: [...checks] });
      yield* context.record("checkpointItems", {
        items: teamApplicationCheckpoints.map(({ step, items }) => ({ step, items: [...items] })),
        wholeRun:
          "22 one browser session; 23 snapshot at every checkpoint; 24 harness-verified release",
      });
    }),
};

runGoldenJourney(journey);
