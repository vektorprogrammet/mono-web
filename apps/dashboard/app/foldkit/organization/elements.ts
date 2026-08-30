import { Schema as S } from "effect";
import { createBrowserOrganizationCatalogClient } from "./browser-client";
import { embedOrganizationCatalog } from "./main";
import { OrganizationCatalogKind } from "./model";

export const ORGANIZATION_CATALOG_ELEMENT = "vektor-organization-catalog";
export const ORGANIZATION_CATALOG_KIND_ATTRIBUTE = "catalog-kind";

export const registerOrganizationCatalogElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(ORGANIZATION_CATALOG_ELEMENT) !== undefined) return;

  customElements.define(
    ORGANIZATION_CATALOG_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-organization-catalog";
        this.replaceChildren(this.#container);

        try {
          const catalogKind = S.decodeUnknownSync(OrganizationCatalogKind)(
            this.getAttribute(ORGANIZATION_CATALOG_KIND_ATTRIBUTE),
            { onExcessProperty: "error" },
          );
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
          guidance.textContent = "Katalogtypen mangler eller er ugyldig.";
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
