import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { PREVIEW_IDENTITY } from "./preview/identity.ts";
import { PreviewWorker } from "./preview/worker-resource.ts";

export { homepageDomain, PREVIEW_IDENTITY, PreviewWorker };

const stageGuard = (stage: string): void => {
  if (stage !== PREVIEW_IDENTITY.stage) {
    throw new Error(`Only ${PREVIEW_IDENTITY.stage} is allowed by this delivery stack`);
  }
  if (PREVIEW_IDENTITY.hostname.includes("vektorprogrammet.no")) {
    throw new Error("Forbidden production host in preview identity");
  }
};

export default Alchemy.Stack(
  "vektor",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    stageGuard(stage);
    const domain = PREVIEW_IDENTITY.hostname;

    const homepage = yield* Cloudflare.Website.Vite("Homepage", {
      rootDir: "../../apps/homepage",
      main: "workers/app.ts",
      workersDev: false,
      assets: { runWorkerFirst: true },
    });

    const dashboard = yield* Cloudflare.Website.Vite("Dashboard", {
      rootDir: "../../apps/dashboard",
      main: "workers/app.ts",
      env: { PREVIEW_HOST: PREVIEW_IDENTITY.hostname },
      workersDev: false,
      assets: { runWorkerFirst: true },
    });

    const worker = yield* PreviewWorker(homepage, dashboard);
    return {
      app: PREVIEW_IDENTITY.app,
      stage,
      target: PREVIEW_IDENTITY.target,
      hostname: domain,
      url: worker.url.as<string>(),
      homepage: homepage.url.as<string>(),
      dashboard: dashboard.url.as<string>(),
      container: PREVIEW_IDENTITY.containerInstance,
      mariaDbAuthority: "container-local-mariadb",
      stateKey: PREVIEW_IDENTITY.remoteStateKey,
      seed: "apps/server/infra/preview/seed-policy.json",
      forbiddenHost: PREVIEW_IDENTITY.forbiddenHost,
    };
  }),
);
