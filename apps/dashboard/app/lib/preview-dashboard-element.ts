import { embedDashboard, type DevToolsEmbedConfig } from "../foldkit/dashboard/main";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import { applyRoleOverrideToInput, readRoleOverride } from "./preview-role-override";

/**
 * Register the preview-only dashboard element.
 *
 * This module is reachable only through the build-gated dynamic import in
 * entry.client.tsx. Production registers the ordinary element instead, so
 * neither role override storage nor the Foldkit devtools re-embed hook ships
 * in the production client bundle.
 */
export const registerPreviewDashboardElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(DASHBOARD_ELEMENT) !== undefined) return;

  customElements.define(
    DASHBOARD_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;
      #devToolsConfig: DevToolsEmbedConfig = false;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;

        this.#container.id = "foldkit-live-dashboard";
        this.replaceChildren(this.#container);
        this.#embed();
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }

      setDevTools(config: DevToolsEmbedConfig): void {
        this.#devToolsConfig = config;
        this.#dispose?.();
        this.#dispose = undefined;
        if (this.isConnected) this.#embed();
      }

      #embed(): void {
        const input = applyRoleOverrideToInput(
          this.getAttribute(DASHBOARD_INPUT_ATTRIBUTE),
          readRoleOverride(),
        );
        this.#dispose = embedDashboard(this.#container, input, this.#devToolsConfig);
      }
    },
  );
};
