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
  OwnedReceiptView,
  ReceiptOwnerMutationFailure,
  ReceiptOwnerMutationNotice,
  ReceiptUiError,
} from "@/lib/receipt-view";
import { OwnedReceiptRow } from "./OwnedReceiptRow";

type Props = {
  receipts: ReadonlyArray<OwnedReceiptView>;
  error?: ReceiptUiError;
  mutationFailure?: ReceiptOwnerMutationFailure;
  mutationNotice?: ReceiptOwnerMutationNotice;
  busy: boolean;
};

export function OwnedReceiptList({
  receipts,
  error,
  mutationFailure,
  mutationNotice,
  busy,
}: Props) {
  const actionErrorId = "receipt-owner-action-error";

  return (
    <Card aria-labelledby="owned-receipts-title" aria-busy={busy}>
      <CardHeader>
        <h2 id="owned-receipts-title" className="font-semibold text-lg">
          Dine innsendte utlegg
        </h2>
        <p className="text-muted-foreground text-sm">
          Listen hentes fra den lagrede eieroversikten.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4">
        {busy && (
          <p className="sr-only" role="status">
            Oppdaterer utleggslisten.
          </p>
        )}

        {error ? (
          <p
            className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm"
            role="alert"
            aria-atomic="true"
            data-error-tag={error._tag}
          >
            {error.message}
          </p>
        ) : (
          <>
            {mutationFailure && (
              <p
                id={actionErrorId}
                className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm"
                role="alert"
                aria-atomic="true"
                data-error-tag={mutationFailure.error._tag}
                data-error-field={mutationFailure.error.field}
                data-action-intent={mutationFailure.intent}
                data-receipt-id={mutationFailure.receiptId}
                data-expected-revision={mutationFailure.expectedRevision}
                data-command-id={mutationFailure.commandId}
              >
                {mutationFailure.error.message}
              </p>
            )}

            {mutationNotice && (
              <p
                className="rounded-md border bg-muted p-3 text-sm"
                role="status"
                aria-live="polite"
                data-action-intent={mutationNotice.intent}
                data-command-id={mutationNotice.commandId}
                data-receipt-id={mutationNotice.receiptId}
                data-status={mutationNotice.status}
                data-revision={mutationNotice.revision}
                data-replayed={mutationNotice.replayed}
              >
                {mutationNotice.intent === "revise"
                  ? `Utlegget er oppdatert til versjon ${mutationNotice.revision}.`
                  : `Utlegget er trukket tilbake som versjon ${mutationNotice.revision}.`}
              </p>
            )}

            {receipts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6">
                <p className="font-medium">Ingen utlegg er sendt inn ennå.</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  Bruk skjemaet over for å sende inn ditt første utlegg.
                </p>
              </div>
            ) : (
              <Table>
                <TableCaption className="sr-only">
                  Dine utlegg med stabil ID, beløp, dato, status, versjon og tilgjengelige
                  handlinger.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Kvitterings-ID</TableHead>
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
                    <OwnedReceiptRow
                      key={`${receipt.receiptId}:${receipt.revision}`}
                      receipt={receipt}
                      failure={mutationFailure}
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
