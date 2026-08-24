import { createElement } from "react";
import { ORGANIZATION_CATALOG_ELEMENT } from "../foldkit/organization/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Team() {
  return createElement(ORGANIZATION_CATALOG_ELEMENT, { "catalog-kind": "Team" });
}
