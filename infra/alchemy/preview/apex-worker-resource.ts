import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { APEX_IDENTITY } from "./identity.ts";
import { APEX_STATELESS_BINDING_NAMES } from "./state-contract.ts";

const apexWorkerMain = new URL("./apex-worker.ts", import.meta.url).pathname;
export const PASSWORD_RESET_SENDER = `noreply@${APEX_IDENTITY.zoneName}`;

/**
 * Apex edge worker bound to the zone apex. Website.Vite resources are passed
 * in already-built by the stack (same shape as the p20 PreviewWorker).
 */
export const ApexWorker = (homepage: Cloudflare.Worker, dashboard: Cloudflare.Worker) =>
  Effect.gen(function* () {
    // Inactive authority capsule: no 0054.2 outbox consumer is deployed in this Worker.
    const passwordResetEmail = yield* Cloudflare.Email.SendEmail(APEX_STATELESS_BINDING_NAMES[0], {
      allowedSenderAddresses: [PASSWORD_RESET_SENDER],
    });

    return yield* Cloudflare.Worker(`${APEX_IDENTITY.resourcePrefix}-worker`, {
      main: apexWorkerMain,
      compatibility: {
        flags: ["nodejs_compat", "enable_ctx_exports"],
        date: "2026-08-20",
      },
      workersDev: false,
      domain: APEX_IDENTITY.hostname,
      routes: [{ pattern: `${APEX_IDENTITY.apiHostname}/*` }],
      env: {
        Homepage: homepage,
        Dashboard: dashboard,
        PasswordResetEmail: passwordResetEmail,
        PREVIEW_STAGE: APEX_IDENTITY.stage,
        PREVIEW_HOST: APEX_IDENTITY.hostname,
      },
    });
  });
