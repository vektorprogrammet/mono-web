import type { Config } from "@react-router/dev/config";
import { dashboardMount, type DashboardBaseEnvironment } from "./dashboard-base.ts";

/**
 * `allowedActionOrigins` feeds React Router's server-side CSRF origin check
 * for form actions. The apex preview terminates TLS at Cloudflare and the
 * edge worker forwards the browser's Origin to this app, which is served on
 * a local port, so the apex origin must be explicitly trusted. The origin is
 * taken from PREVIEW_HOST so other deployments keep the default (empty) list.
 */
export const makeReactRouterConfig = (environment: DashboardBaseEnvironment): Config => {
  const previewHost = environment.PREVIEW_HOST;
  return {
    appDirectory: "app",
    basename: dashboardMount(environment),
    ssr: true,
    ...(previewHost ? { allowedActionOrigins: [`https://${previewHost}`] } : {}),
  };
};

export default makeReactRouterConfig(process.env);
