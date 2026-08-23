import { embedDashboard } from "./main";

const DASHBOARD_ELEMENT = "vektor-foldkit-dashboard";
const DASHBOARD_INPUT_ATTRIBUTE = "dashboard-input";

const registerDashboardElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") {
    return;
  }

  if (customElements.get(DASHBOARD_ELEMENT) !== undefined) return;

  customElements.define(
    DASHBOARD_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;

        this.#container.id = "foldkit-live-dashboard";
        this.replaceChildren(this.#container);
        this.#dispose = embedDashboard(
          this.#container,
          this.getAttribute(DASHBOARD_INPUT_ATTRIBUTE),
        );
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

registerDashboardElement();

export { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE };
