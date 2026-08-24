import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import type { MailingList } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.epostliste._index";

type MailingListEntry = Pick<MailingList, "name"> & {
  email: MailingList["emails"][number];
};

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie);
  const lists = await client.admin.mailingLists();
  const mailingLists = lists.flatMap((list) =>
    list.emails.map((email) => ({ name: list.name, email })),
  );

  return { mailingLists };
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
        <DataTable columns={columns} data={mailingLists} />
      </div>
    </section>
  );
}
