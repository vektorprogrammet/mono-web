import { describe, expect, it } from "vitest";
import { APEX_IDENTITY } from "./identity.ts";
import { BACKEND_ORIGIN } from "./apex-worker.ts";
import { apexSurface } from "./surface-apex.ts";

describe("apexSurface", () => {
  it("routes the content bridge document and single-fetch requests to dashboard", () => {
    expect(apexSurface("/content")).toBe("dashboard");
    expect(apexSurface("/content.data")).toBe("dashboard");
    expect(apexSurface("/content?operation=load")).toBe("dashboard");
  });
  it.each([
    "/schools",
    "/schools.data",
    "/dashboard",
    "/dashboard.data",
    "/profile",
    "/profile/rediger.data",
    "/recruitment",
    "/recruitment/candidates.data",
    "/interview",
    "/interview/schedule.data",
    "/interview-response/confirm",
    "/interview-response/confirm.data",
  ])("routes dashboard capability path %s to dashboard", (path) => {
    expect(apexSurface(path)).toBe("dashboard");
  });

  it.each(["/", "/nyheter", "/team", "/interview-guidelines", "/profiles"])(
    "keeps public path %s on homepage",
    (path) => {
      expect(apexSurface(path)).toBe("homepage");
    },
  );
  it("keeps browser and backend authority on the preview hosts", () => {
    expect(APEX_IDENTITY.hostname).toBe("vektor.phibkro.org");
    expect(APEX_IDENTITY.apiHostname).toBe("api.vektor.phibkro.org");
    expect(APEX_IDENTITY.backendHostname).toBe("origin-api.vektor.phibkro.org");
    expect(BACKEND_ORIGIN).toBe(APEX_IDENTITY.backendOrigin);
    expect(APEX_IDENTITY.localStateDirectory).toBe(".alchemy");
  });
});
