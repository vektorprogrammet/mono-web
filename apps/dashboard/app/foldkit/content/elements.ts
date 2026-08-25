import { createBrowserContentWorkspaceClient } from "./browser-client";
import { embedContentWorkspace } from "./main";

export const CONTENT_WORKSPACE_ELEMENT = "vektor-article-workspace";

export const registerContentWorkspaceElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(CONTENT_WORKSPACE_ELEMENT) !== undefined) return;

  customElements.define(
    CONTENT_WORKSPACE_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-content-workspace";
        this.replaceChildren(this.#container);

        try {
          this.#dispose = embedContentWorkspace(this.#container, {
            client: createBrowserContentWorkspaceClient(),
          });
        } catch {
          const error = document.createElement("section");
          error.className = "content-workspace content-workspace__error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Artikkeladministrasjonen kunne ikke startes";
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
