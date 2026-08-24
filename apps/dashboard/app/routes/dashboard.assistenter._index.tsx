import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { SchedulingAssistant } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.assistenter._index";

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie);
  const result = await client.admin.scheduling.assistants();

  return { assistants: result.items };
}

function formatNullable(value: string | number | boolean | null): string {
  return value === null ? "Unavailable" : String(value);
}

function formatAvailability(availability: SchedulingAssistant["availability"]): string {
  return Object.entries(availability)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

const columns: Array<ColumnDef<SchedulingAssistant>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "email", header: "E-post" },
  {
    accessorKey: "doublePosition",
    header: "Dobbelposisjon",
    cell: ({ row }) => formatNullable(row.original.doublePosition),
  },
  {
    accessorKey: "preferredGroup",
    header: "Foretrukket gruppe",
    cell: ({ row }) => formatNullable(row.original.preferredGroup),
  },
  {
    accessorKey: "availability",
    header: "Tilgjengelighet",
    cell: ({ row }) => formatAvailability(row.original.availability),
  },
  {
    accessorKey: "score",
    header: "Poengsum",
    cell: ({ row }) => formatNullable(row.original.score),
  },
  {
    accessorKey: "suitability",
    header: "Egnethet",
    cell: ({ row }) => formatNullable(row.original.suitability),
  },
  {
    accessorKey: "previousParticipation",
    header: "Tidligere deltakelse",
    cell: ({ row }) => formatNullable(row.original.previousParticipation),
  },
  {
    accessorKey: "language",
    header: "Språk",
    cell: ({ row }) => formatNullable(row.original.language),
  },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Assistenter() {
  const { assistants } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Assistenter</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={assistants} />
      </div>
    </section>
  );
}
