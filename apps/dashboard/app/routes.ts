import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";
import { mountDashboardRoutes } from "../dashboard-base.ts";

// biome-ignore lint/style/noDefaultExport: React Router 8 RouteConfig requires default export
export default flatRoutes().then(mountDashboardRoutes) satisfies RouteConfig;
