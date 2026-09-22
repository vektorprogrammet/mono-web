import type { DetailedHTMLProps, HTMLAttributes } from "react";

type OrganizationCatalogElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "vektor-team-catalog": OrganizationCatalogElementProps;
      "vektor-field-of-study-catalog": OrganizationCatalogElementProps;
    }
  }
}
