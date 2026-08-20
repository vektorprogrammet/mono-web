import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { Interview } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.intervjuer._index";

type InterviewRow = Pick<
  Interview,
  "id" | "applicantName" | "interviewerName" | "interviewTime" | "schedulingStatus"
>;

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const result = await client.admin.interviews.list();
  const interviews = result.items.map(
    ({ id, applicantName, interviewerName, interviewTime, schedulingStatus }) => ({
      id,
      applicantName,
      interviewerName,
      interviewTime,
      schedulingStatus,
    }),
  );

  return { interviews };
}

const columns: Array<ColumnDef<InterviewRow>> = [
  { accessorKey: "applicantName", header: "Søker" },
  {
    id: "interviewer",
    accessorKey: "interviewerName",
    header: "Intervjuer",
    cell: ({ row }) => row.original.interviewerName ?? "Unavailable",
  },
  {
    accessorKey: "interviewTime",
    header: "Tid",
    cell: ({ row }) => row.original.interviewTime ?? "Unavailable",
  },
  { accessorKey: "schedulingStatus", header: "Planleggingsstatus" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Intervjuer() {
  const { interviews } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Intervjuer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={interviews} />
      </div>
    </section>
  );
}
