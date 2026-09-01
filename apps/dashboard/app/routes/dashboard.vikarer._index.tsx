import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { Substitute } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.vikarer._index";

type SubstituteRow = Pick<
  Substitute,
  | "id"
  | "name"
  | "email"
  | "yearOfStudy"
  | "language"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
>;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  try {
    const result = await client.admin.scheduling.substitutes();
    const substitutes = result.items.map(
      ({
        id,
        name,
        email,
        yearOfStudy,
        language,
        monday,
        tuesday,
        wednesday,
        thursday,
        friday,
      }) => ({
        id,
        name,
        email,
        yearOfStudy,
        language,
        monday,
        tuesday,
        wednesday,
        thursday,
        friday,
      }),
    );
    return { substitutes, available: true as const };
  } catch {
    return {
      substitutes: [] as SubstituteRow[],
      available: false as const,
    };
  }
}

function formatNullable(value: string | number | boolean | null): string {
  return value === null ? "Unavailable" : String(value);
}

const columns: Array<ColumnDef<SubstituteRow>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "email", header: "E-post" },
  {
    accessorKey: "yearOfStudy",
    header: "Studieår",
    cell: ({ row }) => formatNullable(row.original.yearOfStudy),
  },
  {
    accessorKey: "language",
    header: "Språk",
    cell: ({ row }) => formatNullable(row.original.language),
  },
  {
    accessorKey: "monday",
    header: "Mandag",
    cell: ({ row }) => formatNullable(row.original.monday),
  },
  {
    accessorKey: "tuesday",
    header: "Tirsdag",
    cell: ({ row }) => formatNullable(row.original.tuesday),
  },
  {
    accessorKey: "wednesday",
    header: "Onsdag",
    cell: ({ row }) => formatNullable(row.original.wednesday),
  },
  {
    accessorKey: "thursday",
    header: "Torsdag",
    cell: ({ row }) => formatNullable(row.original.thursday),
  },
  {
    accessorKey: "friday",
    header: "Fredag",
    cell: ({ row }) => formatNullable(row.original.friday),
  },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Vikarer() {
  const { substitutes, available } = useLoaderData<typeof loader>();
  if (!available) {
    return (
      <section className="mx-auto mt-10 max-w-2xl rounded-lg border bg-gray-50 p-6">
        <h1 className="font-semibold text-xl">Vikaroversikten kunne ikke hentes</h1>
        <p className="mt-2 text-muted-foreground">
          Den native tjenesten har ikke gjort vikardata tilgjengelig ennå.
        </p>
      </section>
    );
  }

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Vikarer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={substitutes} />
      </div>
    </section>
  );
}
