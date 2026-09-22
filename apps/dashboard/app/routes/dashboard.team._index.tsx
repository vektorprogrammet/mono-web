import { createElement } from "react";
import { TEAM_CATALOG_ELEMENT } from "../foldkit/organization/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Team() {
  return createElement(TEAM_CATALOG_ELEMENT);
}
