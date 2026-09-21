import { createRequestHandler, RouterContextProvider } from "react-router";
import type { DashboardWorkerEnv } from "./dashboard-worker";
import { handleDashboardWorkerRequest } from "./dashboard-worker";

type DashboardExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(
    request: Request,
    env: DashboardWorkerEnv,
    _ctx: DashboardExecutionContext,
  ): Promise<Response> {
    return handleDashboardWorkerRequest(request, env, (applicationRequest) =>
      requestHandler(applicationRequest, new RouterContextProvider()),
    );
  },
};
