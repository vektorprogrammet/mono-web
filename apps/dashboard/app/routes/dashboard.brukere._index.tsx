// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://react-router.com/start/framework/route-module
import { DataTable } from "@/components/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ColumnDef } from "@tanstack/react-table";
import { useLoaderData } from "react-router";
import {
  InactiveActorError,
  isFixtureMode,
  NotInScopeError,
  UnauthorizedError,
  type DirectoryEntry,
} from "@vektorprogrammet/sdk";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.brukere._index";

export interface BrukerRow {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly mail: string;
  /** Always null until spec 0058 lands; the column renders an em dash. */
  readonly studyProgramme: string | null;
  readonly departments: string[];
}

function toRow(entry: DirectoryEntry): BrukerRow {
  return {
    personId: entry.personId,
    firstName: entry.firstName,
    lastName: entry.lastName,
    phone: entry.phone,
    mail: entry.email,
    studyProgramme: null,
    departments: [...entry.departments],
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { users: null };

  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const users = await client.admin.users.list();
    return {
      users: {
        activeUsers: users.activePeople.map(toRow),
        inactiveUsers: users.inactivePeople.map(toRow),
      },
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw await expiredSessionRedirect(request);
    }
    if (error instanceof InactiveActorError || error instanceof NotInScopeError) {
      return { users: null, error: "denied" as const };
    }
    console.error("brukere directory load failed", error);
    return { users: null, error: "unavailable" as const };
  }
}

export type user = BrukerRow;

export const columns: Array<ColumnDef<user>> = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  { id: "Fornavn", accessorKey: "firstName", header: "Fornavn" },
  { id: "Etternavn", accessorKey: "lastName", header: "Etternavn" },
  { id: "Telefon", accessorKey: "phone", header: "Telefon" },
  { id: "E-post", accessorKey: "mail", header: "E-post" },
  {
    id: "Studie",
    header: "Studie",
    cell: () => <span>—</span>,
  },
  {
    id: "Avdeling",
    accessorFn: (row) => row.departments.join(", "),
    header: "Avdeling",
    cell: (info) => info.getValue(),
  },
];

export default function Brukere() {
  const data = useLoaderData<typeof loader>();
  const activeUsers = data.users?.activeUsers ?? [];
  const inActiveUsers = data.users?.inactiveUsers ?? [];
  const unavailable = "error" in data && data.error === "unavailable";
  const denied = !data.users && !unavailable;
  return (
    <>
      <h1>Brukere</h1>
      <section className="flex w-full min-w-0 flex-col items-center ">
        <h1 className="mb-10 font-semibold text-2xl">Brukere</h1>
        {unavailable ? (
          <p className="mb-6 text-center text-gray-600" role="alert">
            Brukerlisten kunne ikke lastes. Prøv igjen senere.
          </p>
        ) : denied ? (
          <p className="mb-6 text-center text-gray-600" role="alert">
            Du har ikke tilgang til brukerlisten. Listen er bare tilgjengelig for aktive
            globaladministratorer og avdelingsledere.
          </p>
        ) : null}
        <Tabs defaultValue="active" className="mb-6 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center">
            <TabsList className="my-5 flex flex-wrap justify-center">
              <TabsTrigger value="active">Aktive Brukere</TabsTrigger>
              <TabsTrigger value="inactive">Inaktive Brukere</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="active" className="min-w-0 overflow-x-auto">
            <div className="min-w-full max-w-full overflow-x-auto rounded-lg border border-gray-200">
              <DataTable columns={columns} data={activeUsers} />
            </div>
          </TabsContent>

          <TabsContent value="inactive" className="min-w-0 overflow-x-auto">
            <div className="min-w-full max-w-full overflow-x-auto rounded-lg border border-gray-200">
              <DataTable columns={columns} data={inActiveUsers} />
            </div>
          </TabsContent>
        </Tabs>
      </section>
    </>
  );
}
