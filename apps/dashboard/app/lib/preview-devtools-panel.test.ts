// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevToolsEmbedConfig } from "./preview-devtools-panel";

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

  it("mounts the role controls on a dashboard page", async () => {
    const { mountPreviewDevtoolsPanel } = await import("./preview-devtools-panel");

    mountPreviewDevtoolsPanel();

    const panel = document.getElementById("vektor-preview-devtools-panel");
    expect(panel?.textContent).toContain("Preview Devtools");
    expect(panel?.querySelectorAll("button[data-role]")).toHaveLength(3);
    expect(panel?.textContent).toContain("TEAM_MEMBER");
    expect(panel?.textContent).toContain("TEAM_LEADER");
    expect(panel?.textContent).toContain("ADMIN");
  });

  it("does not mount outside dashboard routes", async () => {
    window.history.replaceState({}, "", "/login");
    const { mountPreviewDevtoolsPanel } = await import("./preview-devtools-panel");

    mountPreviewDevtoolsPanel();

    expect(document.getElementById("vektor-preview-devtools-panel")).toBeNull();
  });

  it("re-embeds dashboard elements when Foldkit devtools toggle", async () => {
    const setDevTools = vi.fn<(config: DevToolsEmbedConfig) => void>();
    const dashboard = document.createElement("vektor-foldkit-dashboard") as HTMLElement & {
      setDevTools: (config: DevToolsEmbedConfig) => void;
    };
    dashboard.setDevTools = setDevTools;
    document.body.appendChild(dashboard);
    const { toggleFoldkitDevTools } = await import("./preview-devtools-panel");

    expect(toggleFoldkitDevTools()).toBe(true);
    expect(setDevTools).toHaveBeenLastCalledWith({
      show: "Always",
      mode: "Inspect",
    });

    expect(toggleFoldkitDevTools()).toBe(false);
    expect(setDevTools).toHaveBeenLastCalledWith(false);
  });
});
