import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { APEX_IDENTITY, PREVIEW_IDENTITY } from "./preview/identity.ts";
import { PreviewWorker } from "./preview/worker-resource.ts";
import { apexStack } from "./preview/apex.ts";
import { stateBackendForStage } from "./preview/state-contract.ts";
import * as Layer from "effect/Layer";

export { PREVIEW_IDENTITY, PreviewWorker, apexStack };

const stageGuard = (stage: string): void => {
  if (stage !== PREVIEW_IDENTITY.stage && stage !== APEX_IDENTITY.stage) {
    throw new Error(
      `Only ${PREVIEW_IDENTITY.stage} or ${APEX_IDENTITY.stage} is allowed by this delivery stack`,
    );
  }
  if (
    stage === PREVIEW_IDENTITY.stage &&
    PREVIEW_IDENTITY.hostname.includes("vektorprogrammet.no")
  ) {
    throw new Error("Forbidden production host in preview identity");
  }
};

const deploymentState = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) =>
      stateBackendForStage(stage) === "local" ? Alchemy.localState() : Cloudflare.state(),
    ),
  ),
);
export default Alchemy.Stack(
  "vektor",
  {
    providers: Cloudflare.providers(),
    state: deploymentState,
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    stageGuard(stage);
    const domain =
      stage === APEX_IDENTITY.stage ? APEX_IDENTITY.hostname : PREVIEW_IDENTITY.hostname;

    if (stage === APEX_IDENTITY.stage) {
      return yield* apexStack;
    }

    const homepage = yield* Cloudflare.Website.Vite("Homepage", {
      rootDir: "../../apps/homepage",
      main: "workers/app.ts",
      workersDev: false,
      assets: { runWorkerFirst: true },
    });

    const dashboard = yield* Cloudflare.Website.Vite("Dashboard", {
      rootDir: "../../apps/dashboard",
      main: "workers/app.ts",
      env: {
        PREVIEW_HOST: PREVIEW_IDENTITY.hostname,
        PREVIEW_STAGE: PREVIEW_IDENTITY.stage,
      },
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
