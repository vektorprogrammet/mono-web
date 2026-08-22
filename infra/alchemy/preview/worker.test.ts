import { describe, expect, it } from "bun:test";
import { previewSurface } from "./surface.ts";

describe("previewSurface", () => {
  it("routes public pages and assets to the homepage", () => {
    expect(previewSurface("/")).toBe("homepage");
    expect(previewSurface("/team")).toBe("homepage");
    expect(previewSurface("/assets/homepage.js")).toBe("homepage");
  });

  it("routes dashboard and authentication pages to the dashboard", () => {
    expect(previewSurface("/dashboard")).toBe("dashboard");
    expect(previewSurface("/dashboard/sokere")).toBe("dashboard");
    expect(previewSurface("/login")).toBe("dashboard");
    expect(previewSurface("/tilbakestill-passord/code")).toBe("dashboard");
  });

  it("routes API and health requests to Symfony", () => {
    expect(previewSurface("/api")).toBe("server");
    expect(previewSurface("/api/admin/users")).toBe("server");
    expect(previewSurface("/health")).toBe("server");
  });
});
