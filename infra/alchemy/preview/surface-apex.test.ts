import { describe, expect, it } from "vitest";

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
    "/undersokelse",
    "/undersokelse/survey-0111.data",
  ])("routes dashboard capability path %s to dashboard", (path) => {
    expect(apexSurface(path)).toBe("dashboard");
  });

  it("routes dynamic manifest patches by their requested application paths", () => {
    expect(
      apexSurface("/__manifest?paths=%2Fundersokelse%2C%2Fundersokelse%2Fsurvey-0111&version=abc"),
    ).toBe("dashboard");
    expect(apexSurface("/__manifest?paths=%2Fnyheter%2C%2Fnyheter%2Farticle&version=abc")).toBe(
      "homepage",
    );
  });

  it.each(["/dashboard/profile", "/dashboard/not-a-route", "/dashboard/recruitment"])(
    "keeps dashboard descendant %s on the dashboard worker",
    (path) => {
      expect(apexSurface(path)).toBe("dashboard");
    },
  );

  it.each(["/", "/nyheter", "/team", "/interview-guidelines", "/profiles"])(
    "keeps public path %s on homepage",
    (path) => {
      expect(apexSurface(path)).toBe("homepage");
    },
  );
});
