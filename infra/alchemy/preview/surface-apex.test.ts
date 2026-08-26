import { describe, expect, it } from "vitest";
import { apexSurface } from "./surface-apex.ts";

describe("apexSurface", () => {
  it("routes the content bridge document and single-fetch requests to dashboard", () => {
    expect(apexSurface("/content")).toBe("dashboard");
    expect(apexSurface("/content.data")).toBe("dashboard");
    expect(apexSurface("/content?operation=load")).toBe("dashboard");
  });
  it("routes the authenticated schools bridge to dashboard", () => {
    expect(apexSurface("/schools")).toBe("dashboard");
    expect(apexSurface("/schools.data")).toBe("dashboard");
    expect(apexSurface("/dashboard")).toBe("dashboard");
    expect(apexSurface("/dashboard.data")).toBe("dashboard");
  });
});
