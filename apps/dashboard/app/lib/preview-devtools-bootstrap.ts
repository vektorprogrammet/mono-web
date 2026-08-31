import { registerPreviewDashboardElement } from "./preview-dashboard-element";
import { mountPreviewDevtoolsPanel } from "./preview-devtools-panel";

/**
 * Preview-only browser composition root.
 *
 * entry.client.tsx imports this module only from the build-time true branch.
 * Keeping the preview element and panel behind this one boundary lets Rollup
 * omit the complete capability graph from production.
 */
export const startPreviewDevtools = (): void => {
  registerPreviewDashboardElement();
  mountPreviewDevtoolsPanel();
};
