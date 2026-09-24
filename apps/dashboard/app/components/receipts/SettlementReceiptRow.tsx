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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  mapReceiptStatus,
  type ReceiptSettlementFailure,
  type SettlementReceiptView,
} from "@/lib/receipt-view";
import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";

type Props = {
  receipt: SettlementReceiptView;
  failure?: ReceiptSettlementFailure;
  actionErrorId: string;
};

function toUtcDateTimeInputValue(instant: string): string {
  const date = new Date(instant);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
}

export function SettlementReceiptRow({ receipt, failure, actionErrorId }: Props) {
  const relevantFailure =
    failure?.receiptId === receipt.receiptId && failure.etag === receipt.etag ? failure : undefined;

  const [commandId, setCommandId] = useState(relevantFailure?.commandId ?? "");

  const [externalAuthority, setExternalAuthority] = useState(
    relevantFailure?.externalAuthority ?? "",
  );

  const [externalReference, setExternalReference] = useState(
    relevantFailure?.externalReference ?? "",
  );

  const [settledAt, setSettledAt] = useState(toUtcDateTimeInputValue(relevantFailure?.settledAt ?? ""));
  const fieldId = useId();
  const titleId = `${fieldId}-settlement-title`;
  const descriptionId = `${fieldId}-settlement-description`;
  const confirmationId = `${fieldId}-settlement-confirmation`;
  const navigation = useNavigation();

  const busy =
    navigation.state !== "idle" &&
    navigation.formData?.get("receiptId") === receipt.receiptId &&
    navigation.formData?.get("_intent") === "settle";

  const referenceForConfirmation = externalReference.trim();
  const authorityForConfirmation = externalAuthority.trim();
  const settledAtForConfirmation = settledAt.trim();

  return (
    <TableRow
      data-receipt-id={receipt.receiptId}
      data-department-id={receipt.departmentId}
      data-owner-person-id={receipt.ownerPersonId}
      data-etag={receipt.etag}
    >
      <TableCell className="whitespace-normal">
        <div className="flex min-w-40 flex-col gap-1">
          <code className="break-all font-mono text-xs" data-testid="settlement-receipt-id">
            {receipt.receiptId}
          </code>
          <span className="text-muted-foreground text-xs">
            Referanse <code className="font-mono">{receipt.visualId}</code>
          </span>
        </div>
      </TableCell>
      <TableCell className="whitespace-normal">
        <code className="break-all font-mono text-xs">{receipt.ownerPersonId}</code>
      </TableCell>
      <TableCell className="whitespace-normal">
        <code className="break-all font-mono text-xs">{receipt.departmentId}</code>
      </TableCell>
      <TableCell className="min-w-56 whitespace-normal">{receipt.description}</TableCell>
      <TableCell>
        <data value={String(receipt.amountOre)} data-amount-ore={receipt.amountOre}>
          {receipt.amount}
        </data>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <span
            className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground text-xs"
            data-status={receipt.status}
          >
            {mapReceiptStatus(receipt.status)}
          </span>
          <time className="text-muted-foreground text-xs" dateTime={receipt.approvedAt}>
            Godkjent {receipt.approvedAt}
          </time>
        </div>
      </TableCell>
      <TableCell className="whitespace-normal text-right">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              disabled={navigation.state !== "idle"}
              data-testid="record-receipt-settlement"
              onClick={() => {
                setCommandId((current) => current || crypto.randomUUID());
              }}
            >
              Registrer oppgjør
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            aria-busy={busy}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            data-receipt-settlement-dialog
          >
            <AlertDialogHeader>
              <AlertDialogTitle id={titleId}>
                Registrer oppgjør for utlegg {receipt.visualId}
              </AlertDialogTitle>
              <AlertDialogDescription id={descriptionId}>
                Utlegget er godkjent med beløpet {receipt.amount}. Registrer bare bevis etter at
                oppgjøret er utført utenfor systemet. Godkjenningen endres ikke.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <Form
              method="post"
              aria-labelledby={titleId}
              aria-describedby={`${descriptionId} ${confirmationId}${relevantFailure ? ` ${actionErrorId}` : ""}`}
              data-receipt-settlement="record"
              className="grid gap-4"
            >
              <input type="hidden" name="_intent" value="settle" />
              <input type="hidden" name="receiptId" value={receipt.receiptId} />
              <input type="hidden" name="etag" value={receipt.etag} />
              <input type="hidden" name="expectedRevision" value={receipt.revision} />
              <input type="hidden" name="commandId" value={commandId} readOnly />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={`${fieldId}-authority`}>Ekstern autoritet</Label>
                  <Input
                    id={`${fieldId}-authority`}
                    name="externalAuthority"
                    type="text"
                    required
                    onChange={(event) => setExternalAuthority(event.target.value)}
                    autoComplete="off"
                    defaultValue={relevantFailure?.externalAuthority ?? ""}
                    aria-invalid={relevantFailure?.error.field === "externalAuthority" || undefined}
                    aria-describedby={
                      relevantFailure?.error.field === "externalAuthority"
                        ? actionErrorId
                        : undefined
                    }
                    data-testid="settlement-external-authority"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`${fieldId}-reference`}>Ekstern referanse</Label>
                  <Input
                    id={`${fieldId}-reference`}
                    name="externalReference"
                    type="text"
                    required
                    autoComplete="off"
                    defaultValue={relevantFailure?.externalReference ?? ""}
                    onChange={(event) => setExternalReference(event.target.value)}
                    aria-invalid={relevantFailure?.error.field === "externalReference" || undefined}
                    aria-describedby={
                      relevantFailure?.error.field === "externalReference"
                        ? actionErrorId
                        : undefined
                    }
                    data-testid="settlement-external-reference"
                  />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor={`${fieldId}-settled-at`}>Oppgjørstidspunkt (UTC)</Label>
                  <Input
                    id={`${fieldId}-settled-at`}
                    name="settledAt"
                    type="datetime-local"
                    step="1"
                    onChange={(event) => setSettledAt(event.target.value)}
                    required
                    defaultValue={toUtcDateTimeInputValue(relevantFailure?.settledAt ?? "")}
                    aria-invalid={relevantFailure?.error.field === "settledAt" || undefined}
                    aria-describedby={`${fieldId}-settled-at-help${relevantFailure?.error.field === "settledAt" ? ` ${actionErrorId}` : ""}`}
                    data-testid="settlement-settled-at"
                  />
                  <p id={`${fieldId}-settled-at-help`} className="text-muted-foreground text-xs">
                    Oppgi tidspunktet i UTC. Det kan ikke være etter registreringstidspunktet.
                  </p>
                </div>
              </div>

              <p id={confirmationId} className="rounded-md border bg-muted p-3 text-sm">
                Bekreft oppgjør av <strong>{receipt.amount}</strong> for {receipt.visualId}
                {authorityForConfirmation.length > 0 &&
                referenceForConfirmation.length > 0 &&
                settledAtForConfirmation.length > 0 ? (
                  <>
                    {" "}hos <strong>{authorityForConfirmation}</strong> med ekstern referanse{" "}
                    <code className="break-all">{referenceForConfirmation}</code> på{" "}
                    <time dateTime={settledAtForConfirmation}>{settledAtForConfirmation}</time>.
                  </>
                ) : (
                  ". Fyll inn ekstern autoritet, referanse og tidspunkt før du bekrefter."
                )}
              </p>
              {busy && (
                <p className="sr-only" role="status">
                  Registrerer oppgjørsbeviset.
                </p>
              )}

              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={busy}>
                  Avbryt
                </AlertDialogCancel>
                <AlertDialogAction
                  type="submit"
                  disabled={
                    busy ||
                    commandId.length === 0 ||
                    authorityForConfirmation.length === 0 ||
                    referenceForConfirmation.length === 0 ||
                    settledAtForConfirmation.length === 0
                  }
                >
                  {busy ? "Registrerer …" : "Bekreft oppgjør"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </Form>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
