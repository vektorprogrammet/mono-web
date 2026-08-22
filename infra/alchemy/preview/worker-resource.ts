import * as Cloudflare from "alchemy/Cloudflare";
import type { Worker } from "alchemy/Cloudflare";
import { PREVIEW_IDENTITY, PREVIEW_TAGS } from "./identity.ts";
import type { PreviewContainer } from "./worker.ts";

export const PreviewContainerResource = Cloudflare.Container<PreviewContainer>("PreviewContainer", {
  context: new URL("../../../apps/server", import.meta.url).pathname,
  dockerfile: new URL("../../../apps/server/infra/preview/Dockerfile", import.meta.url).pathname,
  name: PREVIEW_IDENTITY.containerInstance,
  className: "PreviewContainer",
  maxInstances: 1,
  instances: 1,
  instanceType: "lite",
  labels: Object.entries(PREVIEW_TAGS).map(([name, value]) => ({ name, value })),
  environmentVariables: [
    { name: "APP_ENV", value: "prod" },
    { name: "PREVIEW_APP", value: PREVIEW_IDENTITY.app },
    { name: "PREVIEW_STAGE", value: PREVIEW_IDENTITY.stage },
    { name: "PREVIEW_TARGET", value: PREVIEW_IDENTITY.target },
    {
      name: "PREVIEW_CONTAINER_NAME",
      value: PREVIEW_IDENTITY.containerInstance,
    },
    { name: "PREVIEW_EGRESS_POLICY", value: "deny-by-default" },
  ],
});

export const PreviewWorker = (homepage: Worker, dashboard: Worker) =>
  Cloudflare.Worker("PreviewWorker", {
    main: new URL("./worker.ts", import.meta.url).pathname,
    compatibility: { flags: ["nodejs_compat"], date: "2026-08-12" },
    domain: PREVIEW_IDENTITY.hostname,
    workersDev: false,
    env: {
      Homepage: homepage,
      Dashboard: dashboard,
      PreviewContainer: PreviewContainerResource,
    },
  });
