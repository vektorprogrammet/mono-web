import { createElement } from "react";
import {
  ORGANIZATION_CATALOG_ELEMENT,
  ORGANIZATION_CATALOG_KIND_ATTRIBUTE,
} from "../foldkit/organization/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Team() {
  return createElement(ORGANIZATION_CATALOG_ELEMENT, {
    ref: (element: HTMLElement | null) => {
      element?.setAttribute(ORGANIZATION_CATALOG_KIND_ATTRIBUTE, "Team");
    },
  });
}
