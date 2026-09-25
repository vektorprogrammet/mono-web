// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPreviewDevtoolsPanel, panelAllowed } from "./preview-devtools-panel";

describe("preview devtools panel", () => {
  beforeEach(() => {
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

  it("admits only local development hosts", () => {
    expect(panelAllowed("localhost")).toBe(true);
    expect(panelAllowed("127.0.0.1")).toBe(true);
    expect(panelAllowed("pr-42-dashboard.account.workers.dev")).toBe(false);
    expect(panelAllowed("production.example.org")).toBe(false);
    expect(panelAllowed("localhost.evil.example")).toBe(false);
  });

  it("does not mount without the dashboard shell", () => {
    document.querySelector("[data-dashboard-shell]")?.remove();

    mountPreviewDevtoolsPanel();

    expect(document.getElementById("vektor-preview-devtools-panel")).toBeNull();
  });
});
