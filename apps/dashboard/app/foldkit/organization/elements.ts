import { createBrowserOrganizationCatalogClient } from "./browser-client";
import { embedOrganizationCatalog } from "./main";
import type { OrganizationCatalogKind } from "./model";

export const TEAM_CATALOG_ELEMENT = "vektor-team-catalog";
export const FIELD_OF_STUDY_CATALOG_ELEMENT = "vektor-field-of-study-catalog";

const defineOrganizationCatalogElement = (
  elementName: string,
  catalogKind: OrganizationCatalogKind,
): void => {
  if (customElements.get(elementName) !== undefined) return;

  customElements.define(
    elementName,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #connected = false;
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#connected) return;
        this.#connected = true;
        this.#container.id = "foldkit-organization-catalog";
        this.replaceChildren(this.#container);

        try {
          this.#dispose = embedOrganizationCatalog(this.#container, {
            catalogKind,
            client: createBrowserOrganizationCatalogClient(),
          });
        } catch {
          const error = document.createElement("section");
          error.className = "organization-catalog organization-catalog__error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Organisasjonsoversikten kunne ikke startes";
          const guidance = document.createElement("p");
          guidance.textContent = "Last siden på nytt og prøv igjen.";
          error.replaceChildren(heading, guidance);
          this.#container.replaceChildren(error);
        }
      }

      disconnectedCallback(): void {
        this.#connected = false;
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

export const registerOrganizationCatalogElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  defineOrganizationCatalogElement(TEAM_CATALOG_ELEMENT, "Team");
  defineOrganizationCatalogElement(FIELD_OF_STUDY_CATALOG_ELEMENT, "FieldOfStudy");
};
