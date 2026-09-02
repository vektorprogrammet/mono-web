import type { StrongETag } from "@vektorprogrammet/http-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReceiptRevisionDraft, ReceiptUiError } from "@/lib/receipt-view";
import { ensureStableReceiptCommandId } from "./receipt-command-form";
import { Form, useNavigation } from "react-router";

export type ReceiptSubmissionNotice = {
  commandId: string;
  receiptId: string;
  etag: StrongETag;
};

type Props = {
  error?: ReceiptUiError;
  submission?: ReceiptSubmissionNotice;
  commandId?: string;
  draft?: ReceiptRevisionDraft;
};

function describedBy(
  helpId: string,
  field: ReceiptUiError["field"],
  error?: ReceiptUiError,
): string {
  return error?.field === field ? `${helpId} receipt-submit-error` : helpId;
}

export function ReceiptSubmitForm({ error, submission, commandId, draft }: Props) {
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" && navigation.formData?.get("_intent") === "submit";

  return (
    <Form
      key={submission?.commandId ?? "new-receipt"}
      method="post"
      encType="multipart/form-data"
      onSubmit={ensureStableReceiptCommandId}
      aria-labelledby="receipt-submit-title"
      aria-busy={isSubmitting}
    >
      <Card>
        <CardHeader>
          <h2 id="receipt-submit-title" className="font-semibold text-lg">
            Send inn utlegg
          </h2>
          <p className="text-muted-foreground text-sm">
            Fyll ut beløpet nøyaktig og legg ved én PDF-, PNG- eller JPEG-fil.
          </p>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-2">
          <input type="hidden" name="_intent" value="submit" />
          <input type="hidden" name="commandId" defaultValue={commandId ?? ""} />

          {error && (
            <p
              id="receipt-submit-error"
              className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm sm:col-span-2"
              role="alert"
              aria-atomic="true"
              data-error-tag={error._tag}
              data-error-field={error.field}
            >
              {error.message}
            </p>
          )}

          {submission && (
            <p
              className="rounded-md border bg-muted p-3 text-sm sm:col-span-2"
              role="status"
              aria-live="polite"
              data-command-id={submission.commandId}
              data-etag={submission.etag}
            >
              Utlegget er sendt inn. Kvitterings-ID:{" "}
              <code className="font-mono">{submission.receiptId}</code>.
            </p>
          )}

          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="description">
              Beskrivelse
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <textarea
              id="description"
              name="description"
              defaultValue={draft?.description}
              required
              maxLength={5000}
              rows={4}
              placeholder="Hva gjelder utlegget?"
              aria-invalid={error?.field === "description" || undefined}
              aria-describedby={describedBy("description-help", "description", error)}
              className="border-input placeholder:text-muted-foreground min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
            />
            <p id="description-help" className="text-muted-foreground text-xs">
              Maksimalt 5 000 tegn.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="amountNok">
              Beløp i NOK
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="amountNok"
              name="amountNok"
              type="text"
              inputMode="decimal"
              defaultValue={draft?.amountNok}
              required
              autoComplete="off"
              placeholder="125,50"
              aria-invalid={error?.field === "amountNok" || undefined}
              aria-describedby={describedBy("amount-nok-help", "amountNok", error)}
            />
            <p id="amount-nok-help" className="text-muted-foreground text-xs">
              Bruk maksimalt to desimaler.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="receiptDate">
              Kvitteringsdato
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="receiptDate"
              name="receiptDate"
              type="date"
              defaultValue={draft?.receiptDate}
              required
              aria-invalid={error?.field === "receiptDate" || undefined}
              aria-describedby={describedBy("receipt-date-help", "receiptDate", error)}
            />
            <p id="receipt-date-help" className="text-muted-foreground text-xs">
              Velg datoen som står på kvitteringen.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="receiptFile">
              Kvitteringsfil
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="receiptFile"
              name="file"
              type="file"
              required
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              aria-invalid={error?.field === "file" || undefined}
              aria-describedby={describedBy("receipt-file-help", "file", error)}
              className="h-auto py-1"
            />
            <p id="receipt-file-help" className="text-muted-foreground text-xs">
              PDF, PNG eller JPEG, maksimalt 10 MiB.
            </p>
          </div>
        </CardContent>

        <CardFooter className="justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sender inn …" : "Send inn utlegg"}
          </Button>
        </CardFooter>
      </Card>
    </Form>
  );
}
