import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiUrl, createClient, type Team as TeamDto } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";

export async function loader() {
  const client = createClient(apiUrl);
  const teams = await client.public.teams();

  return { teams: [...teams] };
}

const columns: Array<ColumnDef<TeamDto>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Team() {
  const { teams } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Team</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={teams} />
      </div>
    </section>
  );
}
