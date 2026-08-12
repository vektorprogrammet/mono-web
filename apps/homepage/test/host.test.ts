import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEV_MAIN_STAGE,
  LOCAL_ONLY_STAGE,
  homepageDomain,
  resolveHomepageRequest,
  stageFromHost,
} from "../src/lib/host";

describe("homepage stage and host contract", () => {
  it("maps the persistent development host exactly", () => {
    expect(stageFromHost("vektor.phibkro.org")).toBe(DEV_MAIN_STAGE);
    expect(homepageDomain(DEV_MAIN_STAGE)).toBe("vektor.phibkro.org");
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
    expect(() => homepageDomain(LOCAL_ONLY_STAGE)).toThrow(
      "p000 is reserved for local-only proof",
    );
  });

  it("rejects invalid provider stages and hosts", () => {
    for (const stage of ["p00", "p0000", "p1000", "local", "staging", "prod", "vektorprogrammet.no"]) {
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

  it("declares the frozen Worker, container-backed Durable Object, websites, and support resources", () => {
    const declaration = readFileSync(
      new URL("../../../infra/alchemy/alchemy.run.ts", import.meta.url),
      "utf8",
    );
    const resources = JSON.parse(
      readFileSync(
        new URL("../../../infra/preview/resources.json", import.meta.url),
        "utf8",
      ),
    ) as Array<{ type: string; id: string; name: string }>;

    expect(declaration).toContain('Alchemy.Stack(\n  "vektor"');
    expect(declaration).toContain("state: Cloudflare.state()");
    expect(declaration).toContain('Cloudflare.Website.Vite("Homepage"');
    expect(declaration).toContain('Cloudflare.Website.Vite("Dashboard"');
    expect(declaration).toContain('yield* PreviewWorker');
    expect(declaration).toContain('container: PREVIEW_IDENTITY.containerInstance');
    expect(declaration).not.toContain("PreviewSpine");
    expect(declaration).not.toContain("localState");

    expect(resources).toEqual([
      { type: "worker", id: "vektor-p20-worker", name: "vektor-p20-worker" },
      {
        type: "durable-object-namespace",
        id: "vektor-p20-preview-container-namespace",
        name: "vektor-p20-preview-container-namespace",
      },
      {
        type: "durable-object-migration",
        id: "vektor-p20-preview-container-migration",
        name: "vektor-p20-preview-container-migration",
      },
      { type: "container", id: "vektor-p20-container", name: "vektor-p20-container" },
      {
        type: "container-image",
        id: "vektor-p20-container-image",
        name: "vektor-p20-container-image",
      },
      { type: "homepage", id: "vektor-p20-homepage", name: "vektor-p20-homepage" },
      { type: "dashboard", id: "vektor-p20-dashboard", name: "vektor-p20-dashboard" },
      { type: "route", id: "vektor-p20-route", name: "vektor-p20-route" },
      { type: "dns-tls", id: "vektor-p20-dns-tls", name: "vektor-p20-dns-tls" },
      {
        type: "seed-artifact",
        id: "vektor-p20-seed-artifact",
        name: "vektor-p20-seed-artifact",
      },
    ]);
  });
});
