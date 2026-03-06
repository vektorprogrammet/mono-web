import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";

export async function loader() {
  if (isFixtureMode) return { teams: null };

  const { data } = await apiClient.GET("/api/teams");

  return { teams: data?.["hydra:member"] ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team() {
  return (
    <>
      <h1>Team</h1>
    </>
  );
}
