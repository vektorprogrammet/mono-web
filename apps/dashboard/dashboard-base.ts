import type { RouteConfigEntry } from "@react-router/dev/routes";

export type DashboardBaseEnvironment = Readonly<Record<string, string | undefined>>;

export const dashboardMount = (environment: DashboardBaseEnvironment): string =>
  environment.REAL_NATIVE_CONDUCT_E2E === "1" || environment.ORGANIZATION_IMPORT_REHEARSAL === "1"
    ? "/"
    : "/dashboard/";

export const dashboardBaseUrl = (origin: string, environment: DashboardBaseEnvironment): string =>
  new URL(dashboardMount(environment), origin).toString();

const DASHBOARD_LAYOUT_FILE = "routes/dashboard.tsx";
const DASHBOARD_PATH = "dashboard";

export const mountDashboardRoutes = (
  routes: ReadonlyArray<RouteConfigEntry>,
): Array<RouteConfigEntry> =>
  routes.map((route) => {
    if (route.file === DASHBOARD_LAYOUT_FILE) {
      if (route.path !== DASHBOARD_PATH) {
        throw new Error(`Expected ${DASHBOARD_LAYOUT_FILE} at /${DASHBOARD_PATH}`);
      }
      return { ...route, path: undefined };
    }
    if (route.path?.startsWith(`${DASHBOARD_PATH}/`) === true) {
      return { ...route, path: route.path.slice(DASHBOARD_PATH.length + 1) };
    }
    return route;
  });
