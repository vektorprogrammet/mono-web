import DeleteReceiptDialog from "@/components/receipts/DeleteReceiptDialog";
import ReceiptFormDialog from "@/components/receipts/ReceiptFormDialog";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import type { ColumnDef } from "@tanstack/react-table";
import { apiUrl, isFixtureMode } from "@vektorprogrammet/sdk";
import { useState } from "react";
import { useActionData, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.mine-utlegg._index";

type Receipt = {
  id: number;
  visualId: string;
  description: string;
  sum: number;
  receiptDate: string | null;
  submitDate: string | null;
  status: "pending" | "refunded" | "rejected";
  refundDate: string | null;
};

const mockReceipts: Receipt[] = [
  { id: 1, visualId: "1a2b3c", description: "Bussreise til skolen", sum: 150, receiptDate: "2025-01-10", submitDate: "2025-01-10", status: "pending", refundDate: null },
  { id: 2, visualId: "4d5e6f", description: "Materiell til undervisning", sum: 320, receiptDate: "2025-01-12", submitDate: "2025-01-12", status: "refunded", refundDate: "2025-02-01" },
  { id: 3, visualId: "7a8b9c", description: "Lunsj teamsamling", sum: 200, receiptDate: "2025-01-14", submitDate: "2025-01-14", status: "rejected", refundDate: null },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { receipts: mockReceipts };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  const { data } = await client.GET("/api/my/receipts" as any, {
    params: { query: status ? { status } : {} },
  });

  return { receipts: ((data as any)?.["hydra:member"] as Receipt[]) ?? [] };
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("_intent")?.toString();

  if (intent === "delete") {
    const id = form.get("receiptId")?.toString();
    if (!id) return { error: "Manglende ID" };

    const { error } = await client.DELETE("/api/receipts/{id}" as any, {
      params: { path: { id } },
    });

    if (error) return { error: "Sletting feilet" };
    return { success: true };
  }

  if (intent === "create" || intent === "edit") {
    const method = intent === "create" ? "POST" : "PUT";
    const id = form.get("receiptId")?.toString();
    const url = intent === "create"
      ? "/api/receipts"
      : `/api/receipts/${id}`;

    const body = new FormData();
    body.append("description", form.get("description")?.toString() ?? "");
    body.append("sum", form.get("sum")?.toString() ?? "");
    const receiptDate = form.get("receiptDate")?.toString();
    if (receiptDate) body.append("receiptDate", receiptDate);
    const file = form.get("picture");
    if (file instanceof File && file.size > 0) body.append("picture", file);

    const res = await fetch(`${apiUrl}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
    });

    if (!res.ok) return { error: "Lagring feilet" };
    return { success: true };
  }

  return { error: "Ukjent handling" };
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

function ActionsCell({
  receipt,
  onEdit,
  onDelete,
}: {
  receipt: Receipt;
  onEdit: (receipt: Receipt) => void;
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
] as const;

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const { receipts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [createOpen, setCreateOpen] = useState(false);
  const [editReceipt, setEditReceipt] = useState<Receipt | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filteredReceipts = statusFilter
    ? receipts.filter((r) => r.status === statusFilter)
    : receipts;

  const columns: ColumnDef<Receipt>[] = [
    { accessorKey: "visualId", header: "ID" },
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

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-semibold text-2xl">Mine Utlegg</h1>
          <Button onClick={() => setCreateOpen(true)}>Legg til utlegg</Button>
        </div>

        {actionError && (
          <p className="mb-4 rounded bg-red-50 p-3 text-red-600 text-sm">{actionError}</p>
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

        <DataTable columns={columns} data={filteredReceipts ?? []} />
      </div>

      <ReceiptFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        error={actionError}
      />

      {editReceipt && (
        <ReceiptFormDialog
          open={editReceipt !== null}
          onOpenChange={(open) => { if (!open) setEditReceipt(null); }}
          receipt={editReceipt}
          error={actionError}
        />
      )}

      {deleteId !== null && (
        <DeleteReceiptDialog
          open={deleteId !== null}
          onOpenChange={(open) => { if (!open) setDeleteId(null); }}
          receiptId={deleteId}
        />
      )}
    </section>
  );
}
