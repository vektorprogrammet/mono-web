import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.epostliste._index";

type MailingListEntry = {
  name: string;
  email: string;
};

const mockMailingList: Array<MailingListEntry> = [
  { name: "Kari Nordmann", email: "kari@ntnu.no" },
  { name: "Ola Hansen", email: "ola@ntnu.no" },
  { name: "Lise Berg", email: "lise@ntnu.no" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { mailingLists: mockMailingList };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const mailingLists = await client.admin.mailingLists();
    return { mailingLists: mailingLists ?? null };
  } catch {
    return { mailingLists: null };
  }
}

const columns: Array<ColumnDef<MailingListEntry>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "email", header: "E-post" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Epostliste() {
  const { mailingLists } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">E-postliste</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={mailingLists ?? []} />
      </div>
    </section>
  );
}
