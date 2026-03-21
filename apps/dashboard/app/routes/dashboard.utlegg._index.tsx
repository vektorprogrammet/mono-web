import { DataTable } from "@/components/data-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { Check, RotateCcw, X } from "lucide-react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg._index";

type Receipt = {
  id: number;
  visualId: string;
  userName: string;
  description: string;
  sum: number;
  receiptDate: string;
  submitDate: string | null;
  status: "pending" | "refunded" | "rejected";
};

const mockReceipts: Receipt[] = [
  { id: 1, visualId: "1a2b3c", userName: "Kari Nordmann", description: "Bussreise til skolen", sum: 150, receiptDate: "2025-01-10", submitDate: "2025-01-10", status: "pending" },
  { id: 2, visualId: "4d5e6f", userName: "Ola Hansen", description: "Materiell til undervisning", sum: 320, receiptDate: "2025-01-12", submitDate: "2025-01-12", status: "refunded" },
  { id: 3, visualId: "7a8b9c", userName: "Lise Berg", description: "Lunsj teamsamling", sum: 200, receiptDate: "2025-01-14", submitDate: "2025-01-14", status: "rejected" },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { receipts: mockReceipts };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  try {
    const result = await client.admin.receipts.list(status ? { status } : undefined);
    return { receipts: result.items as Receipt[] };
  } catch {
    return { receipts: [] };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();

  const receiptId = form.get("receiptId")?.toString();
  const newStatus = form.get("status")?.toString();

  if (!receiptId || !newStatus) {
    return { error: "Manglende felt" };
  }

  try {
    if (newStatus === "refunded") {
      await client.admin.receipts.approve(Number(receiptId));
    } else if (newStatus === "rejected") {
      await client.admin.receipts.reject(Number(receiptId));
    } else if (newStatus === "pending") {
      await client.admin.receipts.reopen(Number(receiptId));
    }
    return { success: true };
  } catch {
    return { error: "Kunne ikke oppdatere status" };
  }
}

const statusLabels: Record<string, string> = {
  pending: "Venter",
  refunded: "Refundert",
  rejected: "Avvist",
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  refunded: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status] ?? ""}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

function StatusAction({ receiptId, newStatus, label, description, icon, variant }: {
  receiptId: number;
  newStatus: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  variant?: "default" | "destructive" | "outline";
}) {
  const fetcher = useFetcher();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant ?? "outline"} size="sm" disabled={fetcher.state !== "idle"}>
          {icon}
          <span className="ml-1">{label}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              fetcher.submit(
                { receiptId: String(receiptId), status: newStatus },
                { method: "post" },
              );
            }}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ActionsCell({ receipt }: { receipt: Receipt }) {
  if (receipt.status === "pending") {
    return (
      <div className="flex gap-2">
        <StatusAction
          receiptId={receipt.id}
          newStatus="refunded"
          label="Godkjenn"
          description="Godkjenn dette utlegget? Brukeren vil bli varslet på e-post og utlegget markert for refusjon."
          icon={<Check className="h-4 w-4" />}
        />
        <StatusAction
          receiptId={receipt.id}
          newStatus="rejected"
          label="Avvis"
          description="Avvis dette utlegget? Brukeren vil bli varslet på e-post."
          icon={<X className="h-4 w-4" />}
          variant="destructive"
        />
      </div>
    );
  }

  if (receipt.status === "rejected") {
    return (
      <StatusAction
        receiptId={receipt.id}
        newStatus="pending"
        label="Gjenåpne"
        description="Gjenåpne dette utlegget? Statusen settes tilbake til ventende."
        icon={<RotateCcw className="h-4 w-4" />}
      />
    );
  }

  return null;
}

const columns: ColumnDef<Receipt>[] = [
  { accessorKey: "visualId", header: "ID" },
  { accessorKey: "userName", header: "Bruker" },
  {
    accessorKey: "description",
    header: "Beskrivelse",
    cell: ({ row }) => (
      <span className="max-w-[200px] truncate block" title={row.original.description}>
        {row.original.description}
      </span>
    ),
  },
  {
    accessorKey: "sum",
    header: "Beløp",
    cell: ({ row }) => `${row.original.sum} kr`,
  },
  { accessorKey: "receiptDate", header: "Dato" },
  { accessorKey: "submitDate", header: "Innsendt" },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    id: "actions",
    header: "Handlinger",
    cell: ({ row }) => <ActionsCell receipt={row.original} />,
  },
];

const statusFilters = [
  { value: null, label: "Alle" },
  { value: "pending", label: "Venter" },
  { value: "refunded", label: "Refundert" },
  { value: "rejected", label: "Avvist" },
] as const;

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Utlegg() {
  const { receipts } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentStatus = searchParams.get("status");

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-6 font-semibold text-2xl">Utlegg</h1>

      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex gap-2">
          {statusFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={currentStatus === filter.value ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (filter.value === null) {
                  setSearchParams({});
                } else {
                  setSearchParams({ status: filter.value });
                }
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        <DataTable columns={columns} data={receipts ?? []} />
      </div>
    </section>
  );
}
