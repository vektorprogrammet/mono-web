import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_ONLY_STAGE,
  WORKER_PREVIEW_STAGE,
  WORKERS_DEV_HOST_SUFFIX,
  homepageRequestContext,
  loadHomepageRequest,
  resolveHomepageRequest,
} from "../src/lib/host";

afterEach(() => vi.unstubAllEnvs());

describe("homepage stage and host contract", () => {
  it("resolves an unbound Node request and preserves explicit Worker context", () => {
    vi.stubEnv("HOMEPAGE_LOCAL_DEV", "true");
    const context = new RouterContextProvider();

    const request = new Request("http://127.0.0.1:8787/", {
      headers: { host: "127.0.0.1:8787" },
    });

    expect(loadHomepageRequest({ request, context })).toEqual({
      stage: LOCAL_ONLY_STAGE,
      host: "127.0.0.1",
    });

    vi.stubEnv("HOMEPAGE_LOCAL_DEV", "false");
    expect(() => loadHomepageRequest({ request, context })).toThrow();
    context.set(homepageRequestContext, {
      stage: WORKER_PREVIEW_STAGE,
      host: "preview.account.workers.dev",
    });
    expect(loadHomepageRequest({ request, context })).toEqual({
      stage: WORKER_PREVIEW_STAGE,
      host: "preview.account.workers.dev",
    });
  });

  it("accepts workers.dev only through explicit Worker Preview configuration", () => {
    expect(
      resolveHomepageRequest("pr-42-homepage.account.workers.dev", {
        stage: WORKER_PREVIEW_STAGE,
        hostSuffix: WORKERS_DEV_HOST_SUFFIX,
      }),
    ).toEqual({
      stage: WORKER_PREVIEW_STAGE,
      host: "pr-42-homepage.account.workers.dev",
    });

    expect(() => resolveHomepageRequest("pr-42-homepage.account.workers.dev")).toThrow();
    expect(() =>
      resolveHomepageRequest("vektorprogrammet.no", {
        stage: WORKER_PREVIEW_STAGE,
        hostSuffix: WORKERS_DEV_HOST_SUFFIX,
      }),
    ).toThrow();
  });

  it("maps the local-only host after case and numeric port normalization", () => {
    expect(resolveHomepageRequest("P000.vektor.phibkro.org:8787")).toEqual({
      stage: LOCAL_ONLY_STAGE,
      host: "p000.vektor.phibkro.org",
    });
  });

  it("allows loopback only in the local development runtime", () => {
    const hosts = ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"];
    vi.stubEnv("HOMEPAGE_LOCAL_DEV", "false");

    for (const host of hosts) {
      expect(() => resolveHomepageRequest(host)).toThrow();
    }

    vi.stubEnv("HOMEPAGE_LOCAL_DEV", "true");

    for (const host of hosts) {
      expect(resolveHomepageRequest(host).stage).toBe(LOCAL_ONLY_STAGE);
    }

    expect(() => resolveHomepageRequest("localhost.attacker.example:8787")).toThrow();
    expect(() => resolveHomepageRequest("192.168.1.1:8787")).toThrow();
    expect(() => resolveHomepageRequest("localhost:8787", {
      stage: WORKER_PREVIEW_STAGE,
      hostSuffix: WORKERS_DEV_HOST_SUFFIX,
    })).toThrow();
  });

  it("rejects retired and unknown hosts without Worker Preview configuration", () => {
    for (const host of [
      "vektorprogrammet.no",
      "vektor.phibkro.org",
      "p20.vektor.phibkro.org",
      "p0000.vektor.phibkro.org",
    ]) {
      expect(() => resolveHomepageRequest(host)).toThrow();
    }
  });
});
