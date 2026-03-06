import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.skoler._index";

type School = {
  name: string;
  capacity: number;
  assistantCount: number;
};

const mockSchools: Array<School> = [
  { name: "Selsbakk skole", capacity: 10, assistantCount: 8 },
  { name: "Ila skole", capacity: 8, assistantCount: 6 },
  { name: "Sunnland skole", capacity: 12, assistantCount: 11 },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { schools: mockSchools };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/admin/scheduling/schools");

  return { schools: data ?? null };
}

const columns: Array<ColumnDef<School>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "capacity", header: "Kapasitet" },
  { accessorKey: "assistantCount", header: "Antall assistenter" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Skoler() {
  const { schools } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Skoler</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={schools ?? []} />
      </div>
    </section>
  );
}
