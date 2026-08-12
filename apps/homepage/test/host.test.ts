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

  it("declares only the accepted Website.Vite resource contract", () => {
    const declaration = readFileSync(
      new URL("../../../infra/alchemy/alchemy.run.ts", import.meta.url),
      "utf8",
    );
    expect(declaration).toContain('"MonoWebHomepage"');
    expect(declaration).toContain('Cloudflare.Website.Vite("Homepage"');
    expect(declaration).toContain('domain,');
    expect(declaration).toContain("workersDev: false");
    expect(declaration).toContain("assets: { runWorkerFirst: true }");
    expect(declaration).not.toContain("routes:");
    expect(declaration).not.toContain("PreviewSpine");
  });
});
