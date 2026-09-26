import { describe, expect, it, vi } from "vitest";
import { dashboardAssetResponse } from "../workers/asset-dispatch";
import { handleDashboardWorkerRequest } from "../workers/dashboard-worker";

const previewHost = "pr-42-dashboard.account.workers.dev";

const request = (pathname: string) => new Request(`https://${previewHost}${pathname}`);

describe("dashboardAssetResponse", () => {
  it("falls through when a dotted application route is not an asset", async () => {
    const assets = {
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
    };

    const response = await dashboardAssetResponse(request("/profile/rediger.v2"), assets);

    expect(response).toBeUndefined();
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("keeps fingerprinted asset misses authoritative", async () => {
    const notFound = new Response(null, { status: 404 });
    const assets = { fetch: vi.fn(async () => notFound) };

    const response = await dashboardAssetResponse(request("/assets/missing.js"), assets);

    expect(response).toBe(notFound);
  });

  it("does not probe application routes without asset-like suffixes", async () => {
    const assets = {
      fetch: vi.fn(async () => new Response("unexpected")),
    };

    const response = await dashboardAssetResponse(request("/profile/rediger"), assets);

    expect(response).toBeUndefined();
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

describe("handleDashboardWorkerRequest", () => {
  it("serves a Worker Preview URL without granting unrelated hosts", async () => {
    const assets = { fetch: vi.fn(async () => new Response("asset", { status: 404 })) };
    const applicationHandler = vi.fn(async () => new Response("dashboard"));

    const previewEnv = {
      ASSETS: assets,
      PREVIEW_HOST_SUFFIX: ".workers.dev",
      PREVIEW_STAGE: "worker-preview",
    };

    const accepted = await handleDashboardWorkerRequest(
      new Request(`https://${previewHost}/login`, {
        headers: { Host: previewHost },
      }),
      previewEnv,
      applicationHandler,
    );

    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("x-mono-web-stage")).toBe("worker-preview");

    const denied = await handleDashboardWorkerRequest(
      new Request("https://vektorprogrammet.no/login", {
        headers: { Host: "vektorprogrammet.no" },
      }),
      previewEnv,
      applicationHandler,
    );

    expect(denied.status).toBe(421);
  });
});
