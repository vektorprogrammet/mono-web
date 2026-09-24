import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_MAIN_STAGE,
  LOCAL_ONLY_STAGE,
  WORKER_PREVIEW_STAGE,
  WORKERS_DEV_HOST_SUFFIX,
  homepageDomain,
  homepageRequestContext,
  loadHomepageRequest,
  resolveHomepageRequest,
  stageFromHost,
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

  it("maps the persistent development host exactly", () => {
    expect(stageFromHost("vektor.phibkro.org")).toBe(DEV_MAIN_STAGE);
    expect(homepageDomain(DEV_MAIN_STAGE)).toBe("vektor.phibkro.org");
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

  it("maps bounded two-digit preview stages and preserves three-digit grammar", () => {
    expect(resolveHomepageRequest("P20.vektor.phibkro.org:8787")).toEqual({
      stage: "p20",
      host: "p20.vektor.phibkro.org",
    });
    expect(homepageDomain("p10")).toBe("p10.vektor.phibkro.org");
    expect(homepageDomain("p99")).toBe("p99.vektor.phibkro.org");
    expect(homepageDomain("p001")).toBe("p001.vektor.phibkro.org");
  });

  it("maps cloud canary hosts and strips only a numeric loopback port", () => {
    expect(resolveHomepageRequest("P001.vektor.phibkro.org:8787")).toEqual({
      stage: "p001",
      host: "p001.vektor.phibkro.org",
    });
    expect(homepageDomain("p999")).toBe("p999.vektor.phibkro.org");
  });

  it("keeps p000 local-only and rejects it before provider mapping", () => {
    expect(resolveHomepageRequest("p000.vektor.phibkro.org")).toEqual({
      stage: LOCAL_ONLY_STAGE,
      host: "p000.vektor.phibkro.org",
    });
    expect(() => homepageDomain(LOCAL_ONLY_STAGE)).toThrow("p000 is reserved for local-only proof");
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

  it("rejects invalid provider stages and hosts", () => {
    for (const stage of [
      "p00",
      "p0000",
      "p1000",
      "local",
      "staging",
      "prod",
      "vektorprogrammet.no",
    ]) {
      expect(() => homepageDomain(stage)).toThrow();
    }

    for (const host of [
      "localhost",
      "vektorprogrammet.no",
      "p0000.vektor.phibkro.org",
      "p1000.vektor.phibkro.org",
      "dev-main.vektor.phibkro.org",
    ]) {
      expect(() => stageFromHost(host)).toThrow();
    }
  });
});
