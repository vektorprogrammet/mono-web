import { describe, expect, it, vi } from "vitest";
import { schoolSurveyIdFromPathSegment, schoolSurveyPath } from "../app/lib/school-survey-path";
import { dashboardApplicationRequest, dashboardAssetResponse } from "../workers/asset-dispatch";
import { handleDashboardWorkerRequest } from "../workers/dashboard-worker";

const request = (pathname: string) => new Request(`https://vektor.phibkro.org${pathname}`);

describe("dashboardAssetResponse", () => {
  it("falls through when a dotted application route is not an asset", async () => {
    const assets = {
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
    };

    const response = await dashboardAssetResponse(request("/undersokelse/survey.0111"), assets);

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

    const response = await dashboardAssetResponse(request("/undersokelse/survey-0111"), assets);

    expect(response).toBeUndefined();
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

describe("dashboardApplicationRequest", () => {
  it("preserves a trailing .data survey ID on document requests", () => {
    const original = new Request("https://vektor.phibkro.org/undersokelse/survey.0111.data", {
      headers: { Accept: "text/html" },
    });

    const application = dashboardApplicationRequest(original);
    expect(new URL(application.url).pathname).toBe(schoolSurveyPath("survey.0111.data"));
  });

  it("decodes an escaped opaque ID before framing its canonical path", () => {
    const original = new Request("https://vektor.phibkro.org/undersokelse/foo%2F%C3%A6.data", {
      headers: { Accept: "text/html" },
    });

    const application = dashboardApplicationRequest(original);
    expect(new URL(application.url).pathname).toBe(schoolSurveyPath("foo/æ.data"));
  });

  it("leaves React Router data-action paths unchanged", () => {
    const original = new Request("https://vektor.phibkro.org/undersokelse/survey.0111.data.data", {
      headers: { Accept: "text/x-script" },
    });

    expect(dashboardApplicationRequest(original)).toBe(original);
  });
});

describe("handleDashboardWorkerRequest", () => {
  it("redirects a reserved document suffix to its canonical framed path", async () => {
    const assets = { fetch: vi.fn(async () => new Response("unexpected")) };
    const applicationHandler = vi.fn(async () => new Response("unexpected"));
    const request = new Request("https://vektor.phibkro.org/undersokelse/survey.0111.data", {
      headers: { Accept: "text/html", Host: "vektor.phibkro.org" },
    });

    const response = await handleDashboardWorkerRequest(
      request,
      {
        ASSETS: assets,
        PREVIEW_HOST: "vektor.phibkro.org",
        PREVIEW_STAGE: "dev-main",
      },
      applicationHandler,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(schoolSurveyPath("survey.0111.data"));
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(applicationHandler).not.toHaveBeenCalled();
  });

  it("serves a Worker Preview URL without granting unrelated hosts", async () => {
    const assets = { fetch: vi.fn(async () => new Response("asset", { status: 404 })) };
    const applicationHandler = vi.fn(async () => new Response("dashboard"));
    const previewEnv = {
      ASSETS: assets,
      PREVIEW_HOST_SUFFIX: ".workers.dev",
      PREVIEW_STAGE: "worker-preview",
    };

    const accepted = await handleDashboardWorkerRequest(
      new Request("https://pr-42-dashboard.account.workers.dev/login", {
        headers: { Host: "pr-42-dashboard.account.workers.dev" },
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

describe("school survey path codec", () => {
  it.each(["survey.data", "survey/%/æ", "~ZnJhbWVk.~"])(
    "round-trips opaque ID %s without a reserved route suffix",
    (surveyId) => {
      const path = schoolSurveyPath(surveyId);
      const segment = path.slice("/undersokelse/".length);

      expect(schoolSurveyIdFromPathSegment(segment)).toBe(surveyId);
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
      expect(segment.endsWith(".data")).toBe(false);
    },
  );
});
