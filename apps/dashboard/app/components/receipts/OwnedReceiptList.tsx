import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OwnedReceiptView, ReceiptUiError } from "@/lib/receipt-view";

type Props = {
  receipts: ReadonlyArray<OwnedReceiptView>;
  error?: ReceiptUiError;
  busy: boolean;
};

export function OwnedReceiptList({ receipts, error, busy }: Props) {
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

      <CardContent>
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
        ) : receipts.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6">
            <p className="font-medium">Ingen utlegg er sendt inn ennå.</p>
            <p className="mt-1 text-muted-foreground text-sm">
              Bruk skjemaet over for å sende inn ditt første utlegg.
            </p>
          </div>
        ) : (
          <Table>
            <TableCaption className="sr-only">
              Dine utlegg med stabil ID, beløp, dato og status.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Kvitterings-ID</TableHead>
                <TableHead scope="col">Beskrivelse</TableHead>
                <TableHead scope="col">Beløp</TableHead>
                <TableHead scope="col">Dato</TableHead>
                <TableHead scope="col">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.map((receipt) => (
                <TableRow key={receipt.receiptId} data-receipt-id={receipt.receiptId}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <code className="break-all font-mono text-xs" data-testid="receipt-id">
                        {receipt.receiptId}
                      </code>
                      <span className="text-muted-foreground text-xs">
                        Referanse {receipt.visualId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">{receipt.description}</TableCell>
                  <TableCell>
                    <data value={String(receipt.amountOre)}>{receipt.amount}</data>
                  </TableCell>
                  <TableCell>
                    <time dateTime={receipt.receiptDate}>{receipt.receiptDate}</time>
                  </TableCell>
                  <TableCell>
                    <span
                      className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground text-xs"
                      data-status={receipt.status}
                    >
                      {receipt.status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
