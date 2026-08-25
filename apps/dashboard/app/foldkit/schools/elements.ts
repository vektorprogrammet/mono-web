import { createBrowserSchoolsDirectoryClient } from "./browser-client";
import { embedSchoolsDirectory } from "./main";

export const SCHOOLS_DIRECTORY_ELEMENT = "vektor-schools-directory";

export const registerSchoolsDirectoryElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(SCHOOLS_DIRECTORY_ELEMENT) !== undefined) return;

  customElements.define(
    SCHOOLS_DIRECTORY_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-schools-directory";
        this.replaceChildren(this.#container);

        try {
          this.#dispose = embedSchoolsDirectory(this.#container, {
            client: createBrowserSchoolsDirectoryClient(),
          });
        } catch {
          const error = document.createElement("section");
          error.className = "schools-directory schools-directory__error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Skoleoversikten kunne ikke startes";
          const guidance = document.createElement("p");
          guidance.textContent = "Last siden på nytt og prøv igjen.";
          error.replaceChildren(heading, guidance);
          this.#container.replaceChildren(error);
        }
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};
