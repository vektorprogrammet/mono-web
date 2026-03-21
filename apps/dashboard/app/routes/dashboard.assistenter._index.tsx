import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.assistenter._index";

type Assistant = {
  name: string;
  school: string;
  phone: string;
  email: string;
};

const mockAssistants: Array<Assistant> = [
  { name: "Kari Nordmann", school: "Selsbakk skole", phone: "98765432", email: "kari@ntnu.no" },
  { name: "Ola Hansen", school: "Ila skole", phone: "91234567", email: "ola@ntnu.no" },
  { name: "Lise Berg", school: "Sunnland skole", phone: "99887766", email: "lise@ntnu.no" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { assistants: mockAssistants };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const assistants = await client.admin.scheduling.assistants();
    return { assistants: assistants ?? null };
  } catch {
    return { assistants: null };
  }
}

const columns: Array<ColumnDef<Assistant>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "school", header: "Skole" },
  { accessorKey: "phone", header: "Telefon" },
  { accessorKey: "email", header: "E-post" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Assistenter() {
  const { assistants } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Assistenter</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={assistants ?? []} />
      </div>
    </section>
  );
}
