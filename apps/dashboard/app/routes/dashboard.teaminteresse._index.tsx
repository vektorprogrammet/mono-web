import { isFixtureMode } from "@vektorprogrammet/sdk";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.teaminteresse._index";

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { teamInterest: null };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/admin/team-interest");

  return { teamInterest: data ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Teaminteresse() {
  return (
    <>
      <h1>Teaminteresse</h1>
    </>
  );
}
