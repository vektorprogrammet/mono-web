import DeleteReceiptDialog from "@/components/receipts/DeleteReceiptDialog";
import ReceiptFormDialog from "@/components/receipts/ReceiptFormDialog";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import type { ReceiptInput } from "@vektorprogrammet/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import { redirect, useActionData, useLoaderData } from "react-router";
import { useState } from "react";
import {
  isUnauthorizedError,
  mapReceiptError,
  mapReceiptStatus,
  mapReceiptView,
  type ReceiptStatus,
  type ReceiptView,
} from "../lib/receipt-view";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.mine-utlegg._index";

type ParseResult<T> = { value: T } | { error: string };

type ParsedReceipt = {
  input: ReceiptInput;
  file?: File;
};

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function parseReceiptId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseReceiptForm(form: FormData, requireFile: boolean): ParseResult<ParsedReceipt> {
  const descriptionValue = readFormText(form, "description");
  if (descriptionValue === null || descriptionValue.trim().length === 0) {
    return { error: "Beskrivelse er påkrevd." };
  }

  const sumValue = readFormText(form, "sum");
  if (sumValue === null || sumValue.trim().length === 0) {
    return { error: "Beløp må være et positivt tall." };
  }
  const sum = Number(sumValue.trim());
  if (!Number.isFinite(sum) || sum <= 0) {
    return { error: "Beløp må være et positivt tall." };
  }

  const receiptDate = readFormText(form, "receiptDate");
  if (receiptDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
    return { error: "Dato må ha formatet YYYY-MM-DD." };
  }

  const fileValue = form.get("picture");
  if (fileValue !== null && !(fileValue instanceof File)) {
    return { error: "Kvitteringsbilde må være en fil." };
  }
  const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : undefined;
  if (requireFile && file === undefined) {
    return { error: "Kvitteringsbilde er påkrevd." };
  }

  return {
    value: {
      input: {
        description: descriptionValue.trim(),
        sum,
        receiptDate,
      },
      file,
    },
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  try {
    const result = await client.receipts.list(status ? { status } : undefined);
    return { receipts: result.items.map(mapReceiptView), error: undefined };
  } catch (error) {
    if (isUnauthorizedError(error)) throw redirect("/login?expired=true");
    const receipts: ReceiptView[] = [];
    return { receipts, error: mapReceiptError(error) };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = readFormText(form, "_intent");

  if (intent === "delete") {
    const receiptId = parseReceiptId(readFormText(form, "receiptId"));
    if (receiptId === null) return { error: "Manglende eller ugyldig ID." };

    try {
      await client.receipts.delete(receiptId);
      return { success: true };
    } catch (error) {
      if (isUnauthorizedError(error)) throw redirect("/login?expired=true");
      return { error: mapReceiptError(error) };
    }
  }

  if (intent === "create" || intent === "edit") {
    const parsed = parseReceiptForm(form, intent === "create");
    if ("error" in parsed) return parsed;

    const receiptId = parseReceiptId(readFormText(form, "receiptId"));

    try {
      if (intent === "create") {
        await client.receipts.create(parsed.value.input, parsed.value.file);
      } else {
        if (receiptId === null) return { error: "Manglende eller ugyldig ID." };
        await client.receipts.update(receiptId, parsed.value.input, parsed.value.file);
      }
      return { success: true };
    } catch (error) {
      if (isUnauthorizedError(error)) throw redirect("/login?expired=true");
      return { error: mapReceiptError(error) };
    }
  }

  return { error: "Ukjent handling." };
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

function ActionsCell({
  receipt,
  onEdit,
  onDelete,
}: {
  receipt: ReceiptView;
  onEdit: (receipt: ReceiptView) => void;
  onDelete: (id: number) => void;
}) {
  if (receipt.status !== "pending") return null;

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => onEdit(receipt)}>
        Rediger
      </Button>
      <Button variant="destructive" size="sm" onClick={() => onDelete(receipt.id)}>
        Slett
      </Button>
    </div>
  );
}

const statusFilters = [
  { value: null, label: "Alle" },
  { value: "pending", label: "Venter" },
  { value: "refunded", label: "Refundert" },
  { value: "rejected", label: "Avvist" },
] satisfies Array<{ value: ReceiptStatus | null; label: string }>;

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { receipts } = loaderData;

  const [createOpen, setCreateOpen] = useState(false);
  const [editReceipt, setEditReceipt] = useState<ReceiptView | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReceiptStatus | null>(null);

  const filteredReceipts = statusFilter
    ? receipts.filter((receipt) => receipt.status === statusFilter)
    : receipts;

  const columns: ColumnDef<ReceiptView>[] = [
    { accessorKey: "visualId", header: "ID" },
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
      header: "Sendt inn",
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
      cell: ({ row }) => (
        <ActionsCell
          receipt={row.original}
          onEdit={setEditReceipt}
          onDelete={setDeleteId}
        />
      ),
    },
  ];

  const actionError = actionData && "error" in actionData ? actionData.error : undefined;
  const loaderError = loaderData.error;

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-semibold text-2xl">Mine Utlegg</h1>
          <Button onClick={() => setCreateOpen(true)}>Legg til utlegg</Button>
        </div>

        {loaderError && (
          <p className="mb-4 rounded bg-red-50 p-3 text-red-600 text-sm" role="alert">
            {loaderError}
          </p>
        )}

        {actionError && (
          <p className="mb-4 rounded bg-red-50 p-3 text-red-600 text-sm" role="alert">
            {actionError}
          </p>
        )}

        <div className="mb-4 flex gap-2">
          {statusFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={statusFilter === filter.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        <DataTable columns={columns} data={filteredReceipts} />
      </div>

      <ReceiptFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        error={actionError}
      />

      {editReceipt && (
        <ReceiptFormDialog
          open={editReceipt !== null}
          onOpenChange={(open) => {
            if (!open) setEditReceipt(null);
          }}
          receipt={editReceipt}
          error={actionError}
        />
      )}

      {deleteId !== null && receipts.some((receipt) => receipt.id === deleteId) && (
        <DeleteReceiptDialog
          open={deleteId !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
          receiptId={deleteId}
        />
      )}
    </section>
  );
}
