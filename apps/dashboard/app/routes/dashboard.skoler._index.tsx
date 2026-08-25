import { createElement } from "react";
import { SCHOOLS_DIRECTORY_ELEMENT } from "../foldkit/schools/elements";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.skoler._index";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  return null;
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Skoler() {
  return createElement(SCHOOLS_DIRECTORY_ELEMENT);
}
