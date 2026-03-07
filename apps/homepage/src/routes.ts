import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// biome-ignore lint/style/noDefaultExport: Routes configuration require default export https://reactrouter.com/start/framework/routing
export default flatRoutes() satisfies RouteConfig;
