import { createElement } from "react";
import { SCHOOLS_DIRECTORY_ELEMENT } from "../foldkit/schools/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Skoler() {
  return createElement(SCHOOLS_DIRECTORY_ELEMENT);
}
