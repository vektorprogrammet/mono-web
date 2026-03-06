import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.utlegg._index";

type Receipt = {
  user: string;
  description: string;
  amount: string;
  status: string;
  date: string;
};

const mockReceipts: Array<Receipt> = [
  { user: "Kari Nordmann", description: "Bussreise til skolen", amount: "150 kr", status: "Godkjent", date: "2025-01-10" },
  { user: "Ola Hansen", description: "Materiell til undervisning", amount: "320 kr", status: "Venter", date: "2025-01-12" },
  { user: "Lise Berg", description: "Lunsj teamsamling", amount: "200 kr", status: "Avvist", date: "2025-01-14" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { receipts: mockReceipts };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/admin/receipts");

  return { receipts: data ?? null };
}

const columns: Array<ColumnDef<Receipt>> = [
  { accessorKey: "user", header: "Bruker" },
  { accessorKey: "description", header: "Beskrivelse" },
  { accessorKey: "amount", header: "Belop" },
  { accessorKey: "status", header: "Status" },
  { accessorKey: "date", header: "Dato" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Utlegg() {
  const { receipts } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Utlegg</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={receipts ?? []} />
      </div>
    </section>
  );
}
