import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  mapReceiptStatus,
  type OwnedReceiptView,
  type ReceiptOwnerMutationFailure,
  type ReceiptUiError,
  type ReceiptUiErrorField,
} from "@/lib/receipt-view";
import { Fragment, useId, useState } from "react";
import { Form, useNavigation } from "react-router";

type ActionPanel = "revise" | "withdraw" | null;

type Props = {
  receipt: OwnedReceiptView;
  failure?: ReceiptOwnerMutationFailure;
  actionErrorId: string;
};

function fieldDescription(
  helpId: string,
  field: ReceiptUiErrorField,
  errorId: string,
  error?: ReceiptUiError,
): string {
  return error?.field === field ? `${helpId} ${errorId}` : helpId;
}

export function OwnedReceiptRow({ receipt, failure, actionErrorId }: Props) {
  const relevantFailure = failure?.receiptId === receipt.receiptId ? failure : undefined;
  const [panel, setPanel] = useState<ActionPanel>(relevantFailure?.intent ?? null);
  const [reviseCommandId, setReviseCommandId] = useState(
    relevantFailure?.intent === "revise" ? relevantFailure.commandId : "",
  );
  const [withdrawCommandId, setWithdrawCommandId] = useState(
    relevantFailure?.intent === "withdraw" ? relevantFailure.commandId : "",
  );
  const fieldId = useId();
  const panelId = `${fieldId}-owner-actions`;
  const reviseTitleId = `${fieldId}-revise-title`;
  const withdrawTitleId = `${fieldId}-withdraw-title`;
  const navigation = useNavigation();
  const navigationReceiptId = navigation.formData?.get("receiptId");
  const navigationIntent = navigation.formData?.get("_intent");
  const busyIntent =
    navigation.state !== "idle" && navigationReceiptId === receipt.receiptId
      ? navigationIntent
      : undefined;
  const revising = busyIntent === "revise";
  const withdrawing = busyIntent === "withdraw";
  const actionBusy = revising || withdrawing;
  const revisionFailure = relevantFailure?.intent === "revise" ? relevantFailure : undefined;
  const withdrawalFailure = relevantFailure?.intent === "withdraw" ? relevantFailure : undefined;
  const draft = revisionFailure?.draft;

  return (
    <Fragment>
      <TableRow data-receipt-id={receipt.receiptId}>
        <TableCell>
          <div className="flex flex-col gap-1">
            <code className="break-all font-mono text-xs" data-testid="receipt-id">
              {receipt.receiptId}
            </code>
            <span className="text-muted-foreground text-xs">Referanse {receipt.visualId}</span>
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
          <div className="flex flex-col items-start gap-1">
            <span
              className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground text-xs"
              data-status={receipt.status}
            >
              {mapReceiptStatus(receipt.status)}
            </span>
            <span className="text-muted-foreground text-xs" data-revision={receipt.revision}>
              Versjon {receipt.revision}
            </span>
          </div>
        </TableCell>
        <TableCell className="whitespace-normal">
          {receipt.status === "Pending" ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-expanded={panel === "revise"}
                aria-controls={panelId}
                disabled={actionBusy}
                onClick={() => {
                  if (panel !== "revise" && reviseCommandId.length === 0) {
                    setReviseCommandId(crypto.randomUUID());
                  }
                  setPanel(panel === "revise" ? null : "revise");
                }}
              >
                {panel === "revise" ? "Lukk redigering" : "Rediger"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={panel === "withdraw"}
                aria-controls={panelId}
                disabled={actionBusy}
                onClick={() => {
                  if (panel !== "withdraw" && withdrawCommandId.length === 0) {
                    setWithdrawCommandId(crypto.randomUUID());
                  }
                  setPanel(panel === "withdraw" ? null : "withdraw");
                }}
              >
                Trekk tilbake
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground text-sm">Ingen handlinger</span>
          )}
        </TableCell>
      </TableRow>

      {receipt.status === "Pending" && (
        <TableRow
          id={panelId}
          hidden={panel === null}
          data-receipt-action-panel={panel ?? undefined}
        >
          <TableCell colSpan={6} className="bg-muted/30 p-4 whitespace-normal sm:p-6">
            {panel === "revise" && (
              <Form
                method="post"
                encType="multipart/form-data"
                aria-labelledby={reviseTitleId}
                aria-describedby={revisionFailure ? actionErrorId : undefined}
                aria-busy={revising}
                className="mx-auto grid max-w-3xl gap-5"
                data-receipt-form="revise"
              >
                <input type="hidden" name="_intent" value="revise" />
                <input type="hidden" name="receiptId" value={receipt.receiptId} />
                <input type="hidden" name="expectedRevision" value={receipt.revision} />
                <input type="hidden" name="commandId" value={reviseCommandId} readOnly />

                <div>
                  <h3 id={reviseTitleId} className="font-semibold text-base">
                    Rediger utlegg
                  </h3>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Feltene er hentet fra versjon {receipt.revision}. En ny fil er valgfri.
                  </p>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="flex flex-col gap-2 sm:col-span-2">
                    <Label htmlFor={`${fieldId}-description`}>
                      Beskrivelse
                      <span className="font-normal text-muted-foreground">(påkrevd)</span>
                    </Label>
                    <textarea
                      id={`${fieldId}-description`}
                      name="description"
                      required
                      maxLength={5000}
                      rows={4}
                      defaultValue={draft?.description ?? receipt.description}
                      aria-invalid={revisionFailure?.error.field === "description" || undefined}
                      aria-describedby={fieldDescription(
                        `${fieldId}-description-help`,
                        "description",
                        actionErrorId,
                        revisionFailure?.error,
                      )}
                      className="border-input placeholder:text-muted-foreground min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
                    />
                    <p id={`${fieldId}-description-help`} className="text-muted-foreground text-xs">
                      Maksimalt 5 000 tegn.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${fieldId}-amount`}>
                      Beløp i NOK
                      <span className="font-normal text-muted-foreground">(påkrevd)</span>
                    </Label>
                    <Input
                      id={`${fieldId}-amount`}
                      name="amountNok"
                      type="text"
                      inputMode="decimal"
                      required
                      autoComplete="off"
                      defaultValue={draft?.amountNok ?? receipt.amountNok}
                      aria-invalid={revisionFailure?.error.field === "amountNok" || undefined}
                      aria-describedby={fieldDescription(
                        `${fieldId}-amount-help`,
                        "amountNok",
                        actionErrorId,
                        revisionFailure?.error,
                      )}
                    />
                    <p id={`${fieldId}-amount-help`} className="text-muted-foreground text-xs">
                      Bruk maksimalt to desimaler.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${fieldId}-date`}>
                      Kvitteringsdato
                      <span className="font-normal text-muted-foreground">(påkrevd)</span>
                    </Label>
                    <Input
                      id={`${fieldId}-date`}
                      name="receiptDate"
                      type="date"
                      required
                      defaultValue={draft?.receiptDate ?? receipt.receiptDate}
                      aria-invalid={revisionFailure?.error.field === "receiptDate" || undefined}
                      aria-describedby={fieldDescription(
                        `${fieldId}-date-help`,
                        "receiptDate",
                        actionErrorId,
                        revisionFailure?.error,
                      )}
                    />
                    <p id={`${fieldId}-date-help`} className="text-muted-foreground text-xs">
                      Velg datoen som står på kvitteringen.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 sm:col-span-2">
                    <Label htmlFor={`${fieldId}-file`}>
                      Erstatt kvitteringsfil
                      <span className="font-normal text-muted-foreground">(valgfritt)</span>
                    </Label>
                    <Input
                      id={`${fieldId}-file`}
                      name="file"
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                      aria-invalid={revisionFailure?.error.field === "file" || undefined}
                      aria-describedby={fieldDescription(
                        `${fieldId}-file-help`,
                        "file",
                        actionErrorId,
                        revisionFailure?.error,
                      )}
                      className="h-auto py-1"
                    />
                    <p id={`${fieldId}-file-help`} className="text-muted-foreground text-xs">
                      La feltet stå tomt for å beholde gjeldende fil. PDF, PNG eller JPEG, maksimalt
                      10 MiB.
                    </p>
                  </div>
                </div>

                {revising && (
                  <p className="sr-only" role="status">
                    Lagrer endringene.
                  </p>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={revising}
                    onClick={() => setPanel(null)}
                  >
                    Avbryt
                  </Button>
                  <Button type="submit" disabled={revising}>
                    {revising ? "Lagrer …" : "Lagre endringer"}
                  </Button>
                </div>
              </Form>
            )}

            {panel === "withdraw" && (
              <Form
                method="post"
                aria-labelledby={withdrawTitleId}
                aria-describedby={`${fieldId}-withdraw-help${withdrawalFailure ? ` ${actionErrorId}` : ""}`}
                aria-busy={withdrawing}
                className="mx-auto grid max-w-3xl gap-5"
                data-receipt-form="withdraw"
              >
                <input type="hidden" name="_intent" value="withdraw" />
                <input type="hidden" name="receiptId" value={receipt.receiptId} />
                <input type="hidden" name="expectedRevision" value={receipt.revision} />
                <input type="hidden" name="commandId" value={withdrawCommandId} readOnly />

                <div>
                  <h3 id={withdrawTitleId} className="font-semibold text-base">
                    Trekk tilbake utlegg
                  </h3>
                  <p id={`${fieldId}-withdraw-help`} className="mt-1 text-muted-foreground text-sm">
                    Utlegget beholder referansen og historikken, men kan ikke åpnes igjen.
                  </p>
                </div>

                {withdrawing && (
                  <p className="sr-only" role="status">
                    Trekker tilbake utlegget.
                  </p>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={withdrawing}
                    onClick={() => setPanel(null)}
                  >
                    Avbryt
                  </Button>
                  <Button type="submit" variant="destructive" disabled={withdrawing}>
                    {withdrawing ? "Trekker tilbake …" : "Bekreft tilbaketrekking"}
                  </Button>
                </div>
              </Form>
            )}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
