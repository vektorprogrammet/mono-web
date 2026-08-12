import * as Cloudflare from "alchemy/Cloudflare";
import { PreviewContainer } from "./container.ts";

export class PreviewWorker extends Cloudflare.Worker<PreviewWorker>()("PreviewWorker", {
  main: new URL("./worker.ts", import.meta.url).pathname,
  compatibility: { flags: ["nodejs_compat"], date: "2026-08-12" },
  env: {
    PreviewContainer: Cloudflare.Container<PreviewContainer>("PreviewContainer", {
      context: new URL("../../../apps/server/infra/preview", import.meta.url).pathname,
      dockerfile: "Dockerfile",
      name: "vektor-p20-container",
      className: "PreviewContainer",
      maxInstances: 1,
      instances: 1,
      instanceType: "lite",
      labels: [
        { name: "app", value: "vektor" },
        { name: "stage", value: "p20" },
        { name: "pr", value: "21" },
        { name: "target", value: "p20" },
      ],
      environmentVariables: [
        { name: "APP_ENV", value: "prod" },
        { name: "PREVIEW_APP", value: "vektor" },
        { name: "PREVIEW_STAGE", value: "p20" },
        { name: "PREVIEW_TARGET", value: "p20" },
        { name: "PREVIEW_CONTAINER_NAME", value: "vektor-p20-container" },
        { name: "PREVIEW_EGRESS_POLICY", value: "deny-by-default" },
      ],
    }),
  },
}) {}
