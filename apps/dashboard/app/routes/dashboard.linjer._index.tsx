import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiUrl, createClient, isFixtureMode, type FieldOfStudy } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { fixtureFieldOfStudies } from "../mock/api/public";

export async function loader() {
  if (isFixtureMode) return { fieldOfStudies: fixtureFieldOfStudies };
  const client = createClient(apiUrl);
  const fieldOfStudies = await client.public.fieldOfStudies();

  return { fieldOfStudies: [...fieldOfStudies] };
}

const columns: Array<ColumnDef<FieldOfStudy>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Linjer() {
  const { fieldOfStudies } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Linjer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={[...fieldOfStudies]} />
      </div>
    </section>
  );
}
