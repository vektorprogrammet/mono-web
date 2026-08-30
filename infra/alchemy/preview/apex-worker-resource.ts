import * as Cloudflare from "alchemy/Cloudflare";
import { APEX_IDENTITY } from "./identity.ts";

const apexWorkerMain = new URL("./apex-worker.ts", import.meta.url).pathname;

/**
 * Apex edge worker bound to the zone apex. Website.Vite resources are passed
 * in already-built by the stack (same shape as the p20 PreviewWorker).
 */
export const ApexWorker = (homepage: Cloudflare.Worker, dashboard: Cloudflare.Worker) =>
  Cloudflare.Worker(`${APEX_IDENTITY.resourcePrefix}-worker`, {
    main: apexWorkerMain,
    compatibility: {
      flags: ["nodejs_compat", "enable_ctx_exports"],
      date: "2026-08-20",
    },
    domain: {
      name: APEX_IDENTITY.hostname,
      aliases: [APEX_IDENTITY.apiHostname],
    },
    env: {
      Homepage: homepage,
      Dashboard: dashboard,
    },
  });
