import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { apiUrl, createClient, isFixtureMode, type Sponsor } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { fixtureSponsors } from "../mock/api/public";

export async function loader() {
  if (isFixtureMode) return { sponsors: fixtureSponsors };
  const client = createClient(apiUrl);
  const sponsors = await client.public.sponsors();

  return { sponsors: [...sponsors] };
}

const columns: Array<ColumnDef<Sponsor>> = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Navn" },
  {
    accessorKey: "logoUrl",
    header: "Logo",
    cell: ({ row }) => {
      const { logoUrl, name } = row.original;
      return logoUrl ? (
        <img
          src={logoUrl}
          alt={`${name} logo`}
          className="h-8 w-auto object-contain"
        />
      ) : null;
    },
  },
  {
    accessorKey: "url",
    header: "Nettside",
    cell: ({ row }) => {
      const { url } = row.original;
      return url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      ) : null;
    },
  },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Sponsorer() {
  const { sponsors } = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Sponsorer</h1>
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <DataTable columns={columns} data={[...sponsors]} />
      </div>
    </section>
  );
}
