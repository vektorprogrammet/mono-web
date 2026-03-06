import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";

type Team = {
  name: string;
  description: string;
};

const mockTeams: Array<Team> = [
  { name: "IT", description: "Ansvarlig for tekniske losninger" },
  { name: "Rekruttering", description: "Rekruttering av nye assistenter" },
  { name: "Skolekoordinering", description: "Koordinering med skoler" },
];

export async function loader() {
  if (isFixtureMode) return { teams: mockTeams };

  const { data } = await apiClient.GET("/api/teams");

  return { teams: data?.["hydra:member"] ?? null };
}

const columns: Array<ColumnDef<Team>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "description", header: "Beskrivelse" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Team() {
  const { teams } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Team</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={teams ?? []} />
      </div>
    </section>
  );
}
