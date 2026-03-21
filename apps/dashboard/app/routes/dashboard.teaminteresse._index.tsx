import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.teaminteresse._index";

type TeamInterest = {
  name: string;
  team: string;
  semester: string;
};

const mockTeamInterest: Array<TeamInterest> = [
  { name: "Kari Nordmann", team: "IT", semester: "V2025" },
  { name: "Ola Hansen", team: "Rekruttering", semester: "V2025" },
  { name: "Lise Berg", team: "Skolekoordinering", semester: "H2024" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { teamInterest: mockTeamInterest };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const teamInterest = await client.admin.teamInterest();
    return { teamInterest: teamInterest ?? null };
  } catch {
    return { teamInterest: null };
  }
}

const columns: Array<ColumnDef<TeamInterest>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "team", header: "Team" },
  { accessorKey: "semester", header: "Semester" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Teaminteresse() {
  const { teamInterest } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Teaminteresse</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={teamInterest ?? []} />
      </div>
    </section>
  );
}
