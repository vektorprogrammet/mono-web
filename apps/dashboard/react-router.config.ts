import type { Config } from "@react-router/dev/config";
import { dashboardMount, type DashboardBaseEnvironment } from "./dashboard-base.ts";

/**
 * `allowedActionOrigins` feeds React Router's server-side CSRF origin check
 * for form actions. The apex preview terminates TLS at Cloudflare and the
 * edge worker forwards the browser's Origin to this app, which is served on
 * a local port, so the apex origin must be explicitly trusted. The origin is
 * taken from PREVIEW_HOST so other deployments keep the default (empty) list.
 */
const configuredActionOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const fixedLoopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  return url.origin === value &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    (url.protocol === "https:" || fixedLoopback)
    ? value
    : undefined;
};

export const makeReactRouterConfig = (environment: DashboardBaseEnvironment): Config => {
  const previewOrigin = environment.PREVIEW_HOST;
  const dashboardOrigin = configuredActionOrigin(environment.DASHBOARD_ORIGIN);
  const allowedActionOrigins = [
    ...(previewOrigin === undefined ? [] : [`https://${previewOrigin}`]),
    ...(dashboardOrigin === undefined ? [] : [dashboardOrigin]),
  ];
  return {
    appDirectory: "app",
    basename: dashboardMount(environment),
    ssr: true,
    ...(allowedActionOrigins.length === 0 ? {} : { allowedActionOrigins }),
  };
};

export default makeReactRouterConfig(process.env);
