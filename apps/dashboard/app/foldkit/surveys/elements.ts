import { createBrowserSchoolSurveysClient } from "./browser-client";
import { embedSchoolSurveys } from "./main";

export const SCHOOL_SURVEYS_ELEMENT = "vektor-school-surveys-workspace";

export const registerSchoolSurveysElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;

  if (customElements.get(SCHOOL_SURVEYS_ELEMENT) !== undefined) return;

  customElements.define(
    SCHOOL_SURVEYS_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-school-surveys";
        this.replaceChildren(this.#container);

        try {
          this.#dispose = embedSchoolSurveys(this.#container, {
            client: createBrowserSchoolSurveysClient(),
          });
        } catch {
          const error = document.createElement("section");
          error.className = "school-surveys school-surveys__error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Undersøkelsene kunne ikke startes";
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
