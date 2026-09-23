import { createElement } from "react";
import { useHref } from "react-router";
import {
  CONTENT_WORKSPACE_BRIDGE_ATTRIBUTE,
  CONTENT_WORKSPACE_ELEMENT,
} from "../foldkit/content/elements";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Artikler() {
  return createElement(CONTENT_WORKSPACE_ELEMENT, {
    [CONTENT_WORKSPACE_BRIDGE_ATTRIBUTE]: useHref("/content"),
  });
}
