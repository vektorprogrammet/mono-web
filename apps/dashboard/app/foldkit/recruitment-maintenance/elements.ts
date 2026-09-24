import { embedRecruitmentMaintenance } from "./main";
import type { Mode } from "./model";

export const QUESTIONNAIRES_ELEMENT = "vektor-recruitment-questionnaires";

export const STAFFING_ELEMENT = "vektor-recruitment-staffing";

export const registerRecruitmentMaintenanceElements = (): void => {
  if (globalThis.window === undefined || globalThis.customElements === undefined) return;

  const elements: ReadonlyArray<readonly [string, Mode]> = [
    [QUESTIONNAIRES_ELEMENT, "Questionnaires"],
    [STAFFING_ELEMENT, "Staffing"],
  ];

  for (const [name, mode] of elements) {
    if (customElements.get(name) !== undefined) continue;
    customElements.define(
      name,
      class extends HTMLElement {
        readonly #container = document.createElement("div");
        #dispose: (() => void) | undefined;
        connectedCallback(): void {
          if (this.#dispose !== undefined) return;
          this.#container.id =
            mode === "Questionnaires"
              ? "foldkit-recruitment-questionnaires"
              : "foldkit-recruitment-staffing";
          this.replaceChildren(this.#container);

          try {
            this.#dispose = embedRecruitmentMaintenance(this.#container, mode);
          } catch {
            const error = document.createElement("p");
            error.setAttribute("role", "alert");
            error.textContent = "Vedlikehold kunne ikke startes. Last siden på nytt og prøv igjen.";
            this.#container.replaceChildren(error);
          }
        }
        disconnectedCallback(): void {
          this.#dispose?.();
          this.#dispose = undefined;
        }
      },
    );
  }
};
