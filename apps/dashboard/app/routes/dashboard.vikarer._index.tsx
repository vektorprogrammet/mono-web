import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.vikarer._index";

type Substitute = {
  name: string;
  phone: string;
  email: string;
  status: string;
};

const mockSubstitutes: Array<Substitute> = [
  { name: "Kari Nordmann", phone: "98765432", email: "kari@ntnu.no", status: "Tilgjengelig" },
  { name: "Ola Hansen", phone: "91234567", email: "ola@ntnu.no", status: "Opptatt" },
  { name: "Lise Berg", phone: "99887766", email: "lise@ntnu.no", status: "Tilgjengelig" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { substitutes: mockSubstitutes };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const substitutes = await client.admin.scheduling.substitutes();
    return { substitutes: substitutes ?? null };
  } catch {
    return { substitutes: null };
  }
}

const columns: Array<ColumnDef<Substitute>> = [
  { accessorKey: "name", header: "Navn" },
  { accessorKey: "phone", header: "Telefon" },
  { accessorKey: "email", header: "E-post" },
  { accessorKey: "status", header: "Status" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Vikarer() {
  const { substitutes } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Vikarer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={substitutes ?? []} />
      </div>
    </section>
  );
}
