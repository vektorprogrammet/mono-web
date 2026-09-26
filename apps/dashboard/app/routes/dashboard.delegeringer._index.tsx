import { createElement } from "react";
import { DELEGATION_MANAGEMENT_ELEMENT } from "../foldkit/organization/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Delegeringer() {
  return createElement(DELEGATION_MANAGEMENT_ELEMENT);
}
