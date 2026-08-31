import { PREVIEW_DEVTOOLS_BUILD, previewDevtoolsEnabled } from "./preview-devtools";
import {
  PREVIEW_ROLES,
  clearRoleOverride,
  readRoleOverride,
  writeRoleOverride,
} from "./preview-role-override";

/**
 * Preview devtools floating panel (design spec 0074).
 *
 * STRUCTURAL PRODUCTION EXCLUSION:
 * - entry.client.tsx can reach this module only through a dynamic import in a
 *   build-time true branch. Production emits neither this module nor its role
 *   override dependency.
 * - The runtime host gate admits local development and only the exact
 *   dev-main/p20 host pairs accepted by validateDashboardPreviewStage.
 *
 * SECURITY: the panel only reads/writes the client-side role override
 * (localStorage), re-embeds the Foldkit program, or reloads the page. It
 * performs no network calls and never changes server authorization.
 */

const PANEL_ELEMENT_ID = "vektor-preview-devtools-panel";
const DASHBOARD_ELEMENT = "vektor-foldkit-dashboard";

export const panelAllowed = (hostname = window.location.hostname): boolean => {
  if (!PREVIEW_DEVTOOLS_BUILD) return false;

  const normalizedHost = hostname.toLowerCase();
  if (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1"
  ) {
    return true;
  }
  if (normalizedHost === "vektor.phibkro.org") {
    return previewDevtoolsEnabled("preview-stage", "dev-main", normalizedHost);
  }
  if (normalizedHost === "p20.vektor.phibkro.org") {
    return previewDevtoolsEnabled("preview-stage", "p20", normalizedHost);
  }
  return false;
};

export type DevToolsEmbedConfig = false | { show: "Always"; mode: "Inspect" };

let foldkitDevToolsOn = false;

const reembedAll = (config: DevToolsEmbedConfig): void => {
  document
    .querySelectorAll<HTMLElement & { setDevTools?: (config: DevToolsEmbedConfig) => void }>(
      DASHBOARD_ELEMENT,
    )
    .forEach((element) => {
      if (typeof element.setDevTools === "function") element.setDevTools(config);
    });
};

export const toggleFoldkitDevTools = (): boolean => {
  foldkitDevToolsOn = !foldkitDevToolsOn;
  reembedAll(foldkitDevToolsOn ? { show: "Always", mode: "Inspect" } : false);
  return foldkitDevToolsOn;
};

/**
 * Mount the floating panel on dashboard pages. Role changes persist to
 * localStorage and reload so the React and Foldkit shells read the same
 * rendering override. Foldkit devtools re-embed in place without a reload.
 */
export const mountPreviewDevtoolsPanel = (): void => {
  if (
    !panelAllowed() ||
    !window.location.pathname.startsWith("/dashboard") ||
    document.getElementById(PANEL_ELEMENT_ID) !== null
  ) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = PANEL_ELEMENT_ID;
  panel.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:99999",
    "background:rgba(20,20,20,.92)",
    "color:#fff",
    "padding:10px",
    "border-radius:8px",
    "font:12px/1.6 monospace",
    "box-shadow:0 2px 10px rgba(0,0,0,.4)",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Preview Devtools";
  title.style.cssText = "margin-bottom:6px;font-weight:bold;";
  panel.appendChild(title);

  const roleRow = document.createElement("div");
  roleRow.style.cssText = "display:flex;gap:4px;margin-bottom:6px;";
  panel.appendChild(roleRow);

  const current = readRoleOverride();
  PREVIEW_ROLES.forEach((role) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = role.replace("ROLE_", "");
    button.dataset.role = role;
    if (current === role) button.dataset.active = "1";
    button.addEventListener("click", () => {
      writeRoleOverride(role);
      window.location.reload();
    });
    roleRow.appendChild(button);
  });

  const devToolsButton = document.createElement("button");
  devToolsButton.type = "button";
  devToolsButton.textContent = "Foldkit DevTools";
  devToolsButton.addEventListener("click", () => {
    const on = toggleFoldkitDevTools();
    devToolsButton.dataset.active = on ? "1" : "";
  });
  panel.appendChild(devToolsButton);

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.textContent = "Reset";
  resetButton.style.marginLeft = "4px";
  resetButton.addEventListener("click", () => {
    clearRoleOverride();
    window.location.reload();
  });
  panel.appendChild(resetButton);

  const style = document.createElement("style");
  style.textContent = [
    `#${PANEL_ELEMENT_ID} button{cursor:pointer;border:1px solid #666;border-radius:4px;`,
    `background:#333;color:#fff;padding:2px 8px;font:12px monospace;}`,
    `#${PANEL_ELEMENT_ID} button[data-active="1"]{background:#0a7;border-color:#0a7;}`,
  ].join("");
  panel.appendChild(style);

  document.body.appendChild(panel);
};
