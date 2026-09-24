import * as build from "#dashboard-server-build";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { handleDashboardWorkerRequest, type DashboardWorkerEnv } from "./dashboard-worker";

const requestHandler = createRequestHandler(build, "production");

export default {
  fetch(request: Request, env: DashboardWorkerEnv): Promise<Response> {
    return handleDashboardWorkerRequest(request, env, (applicationRequest) =>
      requestHandler(applicationRequest, new RouterContextProvider()),
    );
  },
};
