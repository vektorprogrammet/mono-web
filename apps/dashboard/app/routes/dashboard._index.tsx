import { isFixtureMode } from "@vektorprogrammet/sdk";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard._index";

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { dashboard: null };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/me/dashboard");

  return { dashboard: data ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Index() {
  return (
    <>
      <h1>Dashboard!</h1>
    </>
  );
}
