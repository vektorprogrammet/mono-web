import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";
import { dashboardMount, mountDashboardRoutes } from "../dashboard-base.ts";

// biome-ignore lint/style/noDefaultExport: React Router 8 RouteConfig requires default export
export default flatRoutes().then((routes) =>
  mountDashboardRoutes(routes, dashboardMount(process.env)),
) satisfies RouteConfig;
