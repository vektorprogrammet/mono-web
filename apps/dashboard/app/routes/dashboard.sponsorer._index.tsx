import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";

export async function loader() {
  if (isFixtureMode) return { sponsors: null };

  const { data } = await apiClient.GET("/api/sponsors");

  return { sponsors: data?.["hydra:member"] ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Sponsorer() {
  return (
    <>
      <h1>Sponsorer</h1>
    </>
  );
}
