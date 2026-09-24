import { createBrowserSocialEventsClient } from "./browser-client";
import { embedSocialEvents } from "./main";

export const SOCIAL_EVENTS_ELEMENT = "vektor-social-events-workspace";

export const registerSocialEventsElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;

  if (customElements.get(SOCIAL_EVENTS_ELEMENT) !== undefined) return;

  customElements.define(
    SOCIAL_EVENTS_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-social-events";
        this.replaceChildren(this.#container);

        try {
          this.#dispose = embedSocialEvents(this.#container, {
            client: createBrowserSocialEventsClient(),
          });
        } catch {
          const error = document.createElement("section");
          error.className = "social-events social-events__error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Arrangementene kunne ikke startes";
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
