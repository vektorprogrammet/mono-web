import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";

type FieldOfStudy = {
  name: string;
  shortName: string;
};

const mockFieldOfStudies: Array<FieldOfStudy> = [
  { name: "Matematikk og teknologi", shortName: "MTDT" },
  { name: "Informatikk", shortName: "BIT" },
  { name: "Kommunikasjonsteknologi", shortName: "MTKOM" },
];

export async function loader() {
  if (isFixtureMode) return { fieldOfStudies: mockFieldOfStudies };

  try {
    const fieldOfStudies = await apiClient.public.fieldOfStudies();
    return { fieldOfStudies: fieldOfStudies ?? null };
  } catch {
    return { fieldOfStudies: null };
  }
}

const columns: Array<ColumnDef<FieldOfStudy>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "shortName", header: "Kortnavn" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Linjer() {
  const { fieldOfStudies } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Linjer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={fieldOfStudies ?? []} />
      </div>
    </section>
  );
}
