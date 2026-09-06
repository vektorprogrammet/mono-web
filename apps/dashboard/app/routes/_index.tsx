import { redirect } from "react-router";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/_index";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  throw redirect("/dashboard");
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Index() {
  return null;
}
