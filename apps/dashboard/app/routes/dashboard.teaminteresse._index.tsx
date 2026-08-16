import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { TeamInterest } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.teaminteresse._index";

type TeamInterestRow = Pick<TeamInterest, "id" | "userName" | "teamName">;

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const result = await client.admin.teams.interest();
  const teamInterest = result.items.map(({ id, userName, teamName }) => ({
    id,
    userName,
    teamName,
  }));

  return { teamInterest };
}

const columns: Array<ColumnDef<TeamInterestRow>> = [
  { accessorKey: "id", header: "ID" },
  { id: "name", accessorKey: "userName", header: "Brukernavn" },
  { accessorKey: "teamName", header: "Team" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Teaminteresse() {
  const { teamInterest } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Teaminteresse</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={teamInterest} />
      </div>
    </section>
  );
}
