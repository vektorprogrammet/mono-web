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
import { Check, RotateCcw, X } from "lucide-react";
import { redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import {
  isUnauthorizedError,
  mapAdminReceiptView,
  mapReceiptError,
  mapReceiptStatus,
  type AdminReceiptView,
  type ReceiptStatus,
} from "../lib/receipt-view";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg._index";

type AdminStatusActionData =
  | { success: true }
  | { error: string };

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function parseReceiptId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isReceiptStatus(value: string | null): value is ReceiptStatus {
  return value === "pending" || value === "refunded" || value === "rejected";
}

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  try {
    const result = await client.admin.receipts.list(status ? { status } : undefined);
    return { receipts: result.items.map(mapAdminReceiptView), error: undefined };
  } catch (error) {
    if (isUnauthorizedError(error)) throw redirect("/login?expired=true");
    const receipts: AdminReceiptView[] = [];
    return { receipts, error: mapReceiptError(error) };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const receiptId = parseReceiptId(readFormText(form, "receiptId"));
  const newStatus = readFormText(form, "status");

  if (receiptId === null || !isReceiptStatus(newStatus)) {
    return { error: "Manglende eller ugyldig felt." };
  }

  try {
    if (newStatus === "refunded") {
      await client.admin.receipts.approve(receiptId);
    } else if (newStatus === "rejected") {
      await client.admin.receipts.reject(receiptId);
    } else {
      await client.admin.receipts.reopen(receiptId);
    }
    return { success: true };
  } catch (error) {
    if (isUnauthorizedError(error)) throw redirect("/login?expired=true");
    return { error: mapReceiptError(error) };
  }
}


const statusColors: Record<ReceiptStatus, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  refunded: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: ReceiptStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status]}`}
    >
      {mapReceiptStatus(status)}
    </span>
  );
}

function StatusAction({
  receiptId,
  newStatus,
  label,
  description,
  icon,
  variant,
}: {
  receiptId: number;
  newStatus: ReceiptStatus;
  label: string;
  description: string;
  icon: ReactNode;
  variant?: "default" | "destructive" | "outline";
}) {
  const fetcher = useFetcher<AdminStatusActionData>();
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;

  return (
    <>
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
      {error && (
        <p className="mt-1 rounded bg-red-50 p-2 text-red-600 text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function ActionsCell({ receipt }: { receipt: AdminReceiptView }) {
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

const columns: ColumnDef<AdminReceiptView>[] = [
  { accessorKey: "visualId", header: "ID" },
  { accessorKey: "userName", header: "Bruker" },
  {
    accessorKey: "description",
    header: "Beskrivelse",
    cell: ({ row }) => (
      <span className="block max-w-[200px] truncate" title={row.original.description}>
        {row.original.description}
      </span>
    ),
  },
  {
    accessorKey: "sum",
    header: "Beløp",
    cell: ({ row }) => `${row.original.sum} kr`,
  },
  {
    accessorKey: "receiptDate",
    header: "Dato",
    cell: ({ row }) => row.original.receiptDate ?? "—",
  },
  {
    accessorKey: "submitDate",
    header: "Innsendt",
    cell: ({ row }) => row.original.submitDate ?? "—",
  },
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
] satisfies Array<{ value: ReceiptStatus | null; label: string }>;

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Utlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const { receipts } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const currentStatus = searchParams.get("status");

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-6 font-semibold text-2xl">Utlegg</h1>

      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        {loaderData.error && (
          <p className="mb-4 rounded bg-red-50 p-3 text-red-600 text-sm" role="alert">
            {loaderData.error}
          </p>
        )}

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

        <DataTable columns={columns} data={receipts} />
      </div>
    </section>
  );
}
