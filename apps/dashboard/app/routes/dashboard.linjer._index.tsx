import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";

export async function loader() {
  if (isFixtureMode) return { fieldOfStudies: null };

  const { data } = await apiClient.GET("/api/field_of_studies");

  return { fieldOfStudies: data?.["hydra:member"] ?? null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Linjer() {
  return (
    <>
      <h1>Linjer</h1>
    </>
  );
}
