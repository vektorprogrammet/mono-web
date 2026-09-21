import type { Config } from "@react-router/dev/config";
import { dashboardMount, type DashboardBaseEnvironment } from "./dashboard-base.ts";

/**
 * `allowedActionOrigins` feeds React Router's server-side CSRF check.
 * Despite the option name, React Router 8 compares URL hosts (`host:port`),
 * not serialized origins. The apex worker forwards the browser's Origin to
 * the dashboard service, so both the apex host and explicit dashboard host
 * must be listed without a scheme.
 */
const configuredActionHost = (value: string | undefined): string | undefined => {
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
    ? url.host
    : undefined;
};

export const makeReactRouterConfig = (environment: DashboardBaseEnvironment): Config => {
  const previewHost =
    environment.PREVIEW_HOST === undefined
      ? undefined
      : configuredActionHost(`https://${environment.PREVIEW_HOST}`);
  const dashboardHost = configuredActionHost(environment.DASHBOARD_ORIGIN);
  const allowedActionOrigins = [
    ...(previewHost === undefined ? [] : [previewHost]),
    ...(dashboardHost === undefined ? [] : [dashboardHost]),
  ];
  return {
    appDirectory: "app",
    basename: dashboardMount(environment),
    ssr: true,
    ...(allowedActionOrigins.length === 0 ? {} : { allowedActionOrigins }),
  };
};

export default makeReactRouterConfig(process.env);
