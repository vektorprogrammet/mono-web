import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { APEX_IDENTITY } from "./identity.ts";
import { ApexWorker } from "./apex-worker-resource.ts";

/**
 * Apex preview stack: stage dev-main, hostname vektor.phibkro.org.
 *
 * Isolation contract (checked before any provider effect):
 *   - stage must be exactly dev-main (the p20 guard rejects it)
 *   - hostname must be the zone apex, never the forbidden production host
 */
export const assertApexIdentity = (): void => {
  if (APEX_IDENTITY.stage !== "dev-main") {
    throw new Error("Apex preview must run on stage dev-main");
  }
  if (
    APEX_IDENTITY.hostname !== "vektor.phibkro.org" ||
    APEX_IDENTITY.apiHostname !== "api.vektor.phibkro.org" ||
    !APEX_IDENTITY.resourcePrefix.startsWith("vektor-apex")
  ) {
    throw new Error("Apex identity drift");
  }
  if (
    APEX_IDENTITY.hostname.includes(APEX_IDENTITY.forbiddenHost) ||
    APEX_IDENTITY.apiHostname.includes(APEX_IDENTITY.forbiddenHost)
  ) {
    throw new Error("Forbidden production host in apex identity");
  }
};

export const apexStack = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== APEX_IDENTITY.stage) {
    throw new Error(`Only ${APEX_IDENTITY.stage} is allowed by the apex delivery stack`);
  }
  assertApexIdentity();

  const homepage = yield* Cloudflare.Website.Vite(`${APEX_IDENTITY.resourcePrefix}-homepage`, {
    rootDir: "../../apps/homepage",
    main: "workers/app.ts",
    env: { API_URL: APEX_IDENTITY.backendOrigin },
    compatibility: {
      flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
      date: "2025-04-01",
    },
    workersDev: false,
    assets: { runWorkerFirst: true },
  });

  const dashboard = yield* Cloudflare.Website.Vite(`${APEX_IDENTITY.resourcePrefix}-dashboard`, {
    rootDir: "../../apps/dashboard",
    main: "workers/app.ts",
    // API_URL is server-only and reaches the tunnel origin directly.
    // VITE_API_URL is inlined into browser bundles and must stay same-origin.
    env: {
      PREVIEW_HOST: APEX_IDENTITY.hostname,
      PREVIEW_STAGE: APEX_IDENTITY.stage,
      API_URL: APEX_IDENTITY.backendOrigin,
      VITE_API_URL: `https://${APEX_IDENTITY.hostname}`,
    },
    // nodejs_compat_populate_process_env mirrors worker env bindings into
    // process.env so `process.env.API_URL` resolves at runtime.
    compatibility: {
      flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
      date: "2025-04-01",
    },
    workersDev: false,
    assets: { runWorkerFirst: true },
  });

  const worker = yield* ApexWorker(homepage, dashboard);

  return {
    app: APEX_IDENTITY.app,
    stage,
    target: APEX_IDENTITY.target,
    hostname: APEX_IDENTITY.hostname,
    apiHostname: APEX_IDENTITY.apiHostname,
    previewStage: APEX_IDENTITY.stage,
    backendHostname: APEX_IDENTITY.backendHostname,
    url: worker.url.as<string>(),
    homepage: homepage.url.as<string>(),
    dashboard: dashboard.url.as<string>(),
    backendOrigin: APEX_IDENTITY.backendOrigin,
    stateDirectory: APEX_IDENTITY.localStateDirectory,
    forbiddenHost: APEX_IDENTITY.forbiddenHost,
  };
});
