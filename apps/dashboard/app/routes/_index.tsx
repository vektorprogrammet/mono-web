import { redirect } from "react-router";
import { getToken } from "../lib/auth.server";
import type { Route } from "./+types/_index";

export async function loader({ request }: Route.LoaderArgs) {
  const token = getToken(request);
  if (token) throw redirect("/dashboard");
  throw redirect("/login");
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Index() {
  return null;
}
