// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These imports intentionally reload the preview module after vi.stubEnv sets
// its build-time seam; a static runtime import would freeze the constant
// before each test can establish its environment.

describe("preview devtools panel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_PREVIEW_DEVTOOLS", "true");
    window.history.replaceState({}, "", "/dashboard");
    window.localStorage.clear();
    document.body.replaceChildren();
    const shell = document.createElement("aside");
    shell.dataset.dashboardShell = "";
    document.body.appendChild(shell);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  it("admits local development and only validated preview hosts", async () => {
    const { panelAllowed } = await import("./preview-devtools-panel");

    expect(panelAllowed("localhost")).toBe(true);
    expect(panelAllowed("127.0.0.1")).toBe(true);
    expect(panelAllowed("vektor.phibkro.org")).toBe(true);
    expect(panelAllowed("p20.vektor.phibkro.org")).toBe(true);
    expect(panelAllowed("production.example.org")).toBe(false);
    expect(panelAllowed("p20.vektor.phibkro.org.evil.example")).toBe(false);
  });

  it("does not mount without the dashboard shell", async () => {
    document.querySelector("[data-dashboard-shell]")?.remove();
    const { mountPreviewDevtoolsPanel } = await import("./preview-devtools-panel");

    mountPreviewDevtoolsPanel();

    expect(document.getElementById("vektor-preview-devtools-panel")).toBeNull();
  });
});
