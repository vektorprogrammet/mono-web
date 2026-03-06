import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.intervjuer._index";

type Interview = {
  applicant: string;
  interviewer: string;
  date: string;
  status: string;
};

const mockInterviews: Array<Interview> = [
  { applicant: "Ole Normann", interviewer: "Kari Nordmann", date: "2025-01-15", status: "Gjennomfort" },
  { applicant: "Lise Berg", interviewer: "Per Olsen", date: "2025-01-16", status: "Planlagt" },
  { applicant: "Jonas Lie", interviewer: "Kari Nordmann", date: "2025-01-17", status: "Avlyst" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { interviews: mockInterviews };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/admin/interviews");

  return { interviews: data ?? null };
}

const columns: Array<ColumnDef<Interview>> = [
  { accessorKey: "applicant", header: "Soker" },
  { accessorKey: "interviewer", header: "Intervjuer" },
  { accessorKey: "date", header: "Dato" },
  { accessorKey: "status", header: "Status" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Intervjuer() {
  const { interviews } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Intervjuer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={interviews ?? []} />
      </div>
    </section>
  );
}
