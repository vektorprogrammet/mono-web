import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiClient, isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";

type Sponsor = {
  name: string;
  size: string;
};

const mockSponsors: Array<Sponsor> = [
  { name: "Bekk", size: "Stor" },
  { name: "Computas", size: "Medium" },
  { name: "Kantega", size: "Liten" },
];

export async function loader() {
  if (isFixtureMode) return { sponsors: mockSponsors };

  try {
    const result = await apiClient.public.sponsors();
    return { sponsors: result.items ?? null };
  } catch {
    return { sponsors: null };
  }
}

const columns: Array<ColumnDef<Sponsor>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "size", header: "Storrelse" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Sponsorer() {
  const { sponsors } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Sponsorer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={sponsors ?? []} />
      </div>
    </section>
  );
}
