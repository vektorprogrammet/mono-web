import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface OrganizationCatalogElementAttributes extends HTMLAttributes<HTMLElement> {
  "catalog-kind": "Team" | "FieldOfStudy";
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "vektor-organization-catalog": DetailedHTMLProps<
        OrganizationCatalogElementAttributes,
        HTMLElement
      >;
    }
  }
}
