import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { SchedulingSchool } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.skoler._index";

type SchoolRow = Pick<SchedulingSchool, "id" | "name" | "capacity">;

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const result = await client.admin.scheduling.schools();
  const schools = result.items.map(({ id, name, capacity }) => ({
    id,
    name,
    capacity,
  }));

  return { schools };
}

function formatCapacity(capacity: SchedulingSchool["capacity"]): string {
  if (capacity.length === 0) return "No capacity records";

  return capacity
    .map((record) =>
      Object.entries(record)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join(", "),
    )
    .join(" | ");
}

const columns: Array<ColumnDef<SchoolRow>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
  {
    accessorKey: "capacity",
    header: "Kapasitet",
    cell: ({ row }) => formatCapacity(row.original.capacity),
  },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Skoler() {
  const { schools } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Skoler</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={schools} />
      </div>
    </section>
  );
}
