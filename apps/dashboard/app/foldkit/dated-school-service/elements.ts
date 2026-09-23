import { Schema } from "effect";
import { Input } from "./model";
import { embedDatedService } from "./main";

export const DATED_SERVICE_ELEMENT = "vektor-dated-school-service";

export const registerDatedServiceElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(DATED_SERVICE_ELEMENT) !== undefined) return;
  customElements.define(DATED_SERVICE_ELEMENT, class extends HTMLElement {
    readonly #container = document.createElement("div");
    #dispose: (() => void) | undefined;

    connectedCallback(): void {
      if (this.#dispose) return;
      this.replaceChildren(this.#container);
      try {
        const raw = this.getAttribute("data-state");
        if (raw === null) throw new Error("Missing dated service state");
        const input = Schema.decodeUnknownSync(Input)(JSON.parse(raw));
        this.#dispose = embedDatedService(this.#container, input);
      } catch {
        const alert = document.createElement("p");
        alert.setAttribute("role", "alert");
        alert.textContent = "Daterte skoletjenester kunne ikke vises. Last siden på nytt.";
        this.#container.replaceChildren(alert);
      }
    }

    disconnectedCallback(): void {
      this.#dispose?.();
      this.#dispose = undefined;
    }
  });
};
