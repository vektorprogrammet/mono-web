import * as build from "../build/server/index.js";
import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import { handleDashboardWorkerRequest, type DashboardWorkerEnv } from "./dashboard-worker";

// React Router's generated module erases entry.module's type; Wrangler exercises the real export.
const requestHandler = createRequestHandler(build as unknown as ServerBuild, "production");

export default {
  fetch(request: Request, env: DashboardWorkerEnv): Promise<Response> {
    return handleDashboardWorkerRequest(request, env, (applicationRequest) =>
      requestHandler(applicationRequest, new RouterContextProvider()),
    );
  },
};
