import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ApprovalReceiptView,
  ReceiptApprovalFailure,
  ReceiptApprovalNotice,
  ReceiptStatus,
  ReceiptUiError,
} from "@/lib/receipt-view";
import { ApprovalReceiptRow } from "./ApprovalReceiptRow";

type ApprovalReceiptListProps = {
  receipts: ReadonlyArray<ApprovalReceiptView>;
  status?: ReceiptStatus;
  error?: ReceiptUiError;
  actionError?: ReceiptUiError;
  actionFailure?: ReceiptApprovalFailure;
  actionNotice?: ReceiptApprovalNotice;
  busy: boolean;
};

export function ApprovalReceiptList({
  receipts,
  status,
  error,
  actionError,
  actionFailure,
  actionNotice,
  busy,
}: ApprovalReceiptListProps) {
  const actionErrorId = "receipt-approval-action-error";

  return (
    <Card
      aria-labelledby="approval-receipts-title"
      aria-busy={busy}
      data-testid="receipt-approval-list"
    >
      <CardHeader>
        <h2 id="approval-receipts-title" className="font-semibold text-lg">
          Utlegg til behandling
        </h2>
        <p className="text-muted-foreground text-sm">
          Listen viser bare utlegg i godkjenningsområdet fra den aktive økten.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4">
        {busy && (
          <p className="sr-only" role="status">
            Oppdaterer godkjenningslisten.
          </p>
        )}

        {error ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
            aria-atomic="true"
            data-error-tag={error._tag}
          >
            {error.message}
          </p>
        ) : (
          <>
            {actionFailure ? (
              <p
                id={actionErrorId}
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                role="alert"
                aria-atomic="true"
                data-error-tag={actionFailure.error._tag}
                data-action-intent={actionFailure.intent}
                data-receipt-id={actionFailure.receiptId}
                data-etag={actionFailure.etag}
                data-command-id={actionFailure.commandId}
              >
                {actionFailure.error.message}
              </p>
            ) : actionError ? (
              <p
                id={actionErrorId}
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                role="alert"
                aria-atomic="true"
                data-error-tag={actionError._tag}
              >
                {actionError.message}
              </p>
            ) : null}

            {actionNotice && (
              <p
                className="rounded-md border bg-muted p-3 text-sm"
                role="status"
                aria-live="polite"
                data-action-intent={actionNotice.intent}
                data-command-id={actionNotice.commandId}
                data-receipt-id={actionNotice.receiptId}
                data-status={actionNotice.status}
                data-revision={actionNotice.revision}
                data-etag={actionNotice.etag}
              >
                Utlegget er {actionNotice.intent === "refund" ? "refundert" : "avvist"} som versjon{" "}
                {actionNotice.revision}.
              </p>
            )}

            {receipts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6">
                <p className="font-medium">
                  {status
                    ? "Ingen utlegg har den valgte statusen."
                    : "Ingen utlegg venter i godkjenningsområdet."}
                </p>
                <p className="mt-1 text-muted-foreground text-sm">
                  {status
                    ? "Velg Alle for å se resten av godkjenningslisten."
                    : "Nye innsendte utlegg vises her når de er klare til behandling."}
                </p>
              </div>
            ) : (
              <Table>
                <TableCaption className="sr-only">
                  Godkjenningslisten viser stabil kvitterings-ID, visuell referanse, eier-ID,
                  avdelings-ID, beskrivelse, eksakt NOK-beløp, dato, status, versjon og
                  tilgjengelige handlinger.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Kvittering</TableHead>
                    <TableHead scope="col">Eier-ID</TableHead>
                    <TableHead scope="col">Avdelings-ID</TableHead>
                    <TableHead scope="col">Beskrivelse</TableHead>
                    <TableHead scope="col">Beløp</TableHead>
                    <TableHead scope="col">Dato</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col" className="text-right">
                      Handlinger
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map((receipt) => (
                    <ApprovalReceiptRow
                      key={`${receipt.receiptId}:${receipt.revision}`}
                      receipt={receipt}
                      failure={actionFailure}
                      actionErrorId={actionErrorId}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
