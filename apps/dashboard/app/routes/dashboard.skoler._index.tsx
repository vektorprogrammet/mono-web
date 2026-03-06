import { isFixtureMode } from "@vektorprogrammet/sdk";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.skoler._index";

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { schools: null };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/admin/scheduling/schools");

  return { schools: data ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Skoler() {
  return (
    <>
      <h1>Skoler</h1>
    </>
  );
}
