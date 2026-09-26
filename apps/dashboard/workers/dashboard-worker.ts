import { dashboardAssetResponse } from "./asset-dispatch";
import {
  type DashboardPreviewStage,
  isDashboardPreviewHost,
  validateDashboardPreviewStage,
} from "./preview-stage";

export interface DashboardWorkerEnv {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly PREVIEW_HOST?: string;
  readonly PREVIEW_HOST_SUFFIX?: string;
  readonly PREVIEW_STAGE: string;
}

export type DashboardApplicationHandler = (request: Request) => Promise<Response>;

const withPreviewHeaders = (response: Response, host: string, stage: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("X-Mono-Web-Stage", stage);
  headers.set("X-Mono-Web-Host", host);
  headers.set("X-Robots-Tag", "noindex");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const handleDashboardWorkerRequest = async (
  request: Request,
  env: DashboardWorkerEnv,
  applicationHandler: DashboardApplicationHandler,
): Promise<Response> => {
  let stage: DashboardPreviewStage;

  try {
    stage = validateDashboardPreviewStage(
      env.PREVIEW_STAGE,
      env.PREVIEW_HOST,
      env.PREVIEW_HOST_SUFFIX,
    );
  } catch {
    return new Response("Invalid dashboard preview stage", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const host = request.headers.get("host")?.toLowerCase() ?? "";

  if (!isDashboardPreviewHost(stage, host, env.PREVIEW_HOST, env.PREVIEW_HOST_SUFFIX)) {
    return new Response("Unsupported dashboard host", {
      status: 421,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const assetResponse = await dashboardAssetResponse(request, env.ASSETS);

  if (assetResponse !== undefined) {
    return withPreviewHeaders(assetResponse, host, stage);
  }

  return withPreviewHeaders(await applicationHandler(request), host, stage);
};
