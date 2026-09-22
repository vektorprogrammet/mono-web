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
  ReceiptSettlementFailure,
  ReceiptSettlementNotice,
  ReceiptUiError,
  SettlementReceiptView,
} from "@/lib/receipt-view";
import { Link } from "react-router";
import { ReceiptSettlementEvidence } from "./ReceiptSettlementEvidence";
import { SettlementReceiptRow } from "./SettlementReceiptRow";

type Props = {
  receipts: ReadonlyArray<SettlementReceiptView>;
  error?: ReceiptUiError;
  actionError?: ReceiptUiError;
  actionFailure?: ReceiptSettlementFailure;
  actionNotice?: ReceiptSettlementNotice;
  busy: boolean;
};

export function SettlementReceiptList({
  receipts,
  error,
  actionError,
  actionFailure,
  actionNotice,
  busy,
}: Props) {
  const actionErrorId = "receipt-settlement-action-error";

  return (
    <Card
      aria-labelledby="settlement-receipts-title"
      aria-busy={busy}
      data-testid="receipt-settlement-list"
    >
      <CardHeader>
        <h2 id="settlement-receipts-title" className="font-semibold text-lg">
          Godkjente utlegg klare for oppgjør
        </h2>
        <p className="text-muted-foreground text-sm">
          Listen viser bare godkjente utlegg uten registrert oppgjørsbevis i ditt aktive
          oppgjørsområde.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4">
        {busy && (
          <p className="sr-only" role="status">
            Oppdaterer oppgjørskøen.
          </p>
        )}

        {actionNotice && (
          <div
            className="grid gap-3 rounded-md border bg-muted p-3"
            role="status"
            aria-live="polite"
            data-testid="receipt-settlement-success"
            data-command-id={actionNotice.commandId}
            data-receipt-id={actionNotice.settlement.receiptId}
          >
            <p className="text-sm">
              Oppgjøret er registrert. Utlegget er fortsatt godkjent; oppgjørsbeviset er en
              separat, uforanderlig registrering.
            </p>
            <Link
              className="text-sm underline underline-offset-4"
              to={encodeURIComponent(actionNotice.settlement.receiptId)}
              data-testid="read-receipt-settlement"
            >
              Se lagret oppgjørsbevis
            </Link>
            <ReceiptSettlementEvidence evidence={actionNotice.settlement} title="Oppgjørsbevis" />
          </div>
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


            {receipts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6">
                <p className="font-medium">Ingen godkjente utlegg venter på oppgjør.</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  Nye godkjente utlegg vises her når de er i oppgjørsområdet ditt.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableCaption className="sr-only">
                    Oppgjørskøen viser stabil kvitterings-ID, eier, avdeling, beløp, godkjenning
                    og registreringshandling for godkjente utlegg uten oppgjørsbevis.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Kvittering</TableHead>
                      <TableHead scope="col">Eier-ID</TableHead>
                      <TableHead scope="col">Avdelings-ID</TableHead>
                      <TableHead scope="col">Beskrivelse</TableHead>
                      <TableHead scope="col">Beløp</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col" className="text-right">
                        Handling
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((receipt) => (
                      <SettlementReceiptRow
                        key={`${receipt.receiptId}:${receipt.revision}`}
                        receipt={receipt}
                        failure={actionFailure}
                        actionErrorId={actionErrorId}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
