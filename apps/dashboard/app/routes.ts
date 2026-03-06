import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// biome-ignore lint/style/noDefaultExport: React Router 7 RouteConfig requires default export https://reactrouter.com/start/framework/routing
export default flatRoutes() satisfies RouteConfig;
