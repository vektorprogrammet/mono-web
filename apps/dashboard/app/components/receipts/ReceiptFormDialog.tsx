import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "react-router";

type Receipt = {
  id: number;
  description: string;
  sum: number;
  receiptDate: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receipt?: Receipt; // undefined = create mode
  error?: string;
};

// biome-ignore lint/style/noDefaultExport: component export
export default function ReceiptFormDialog({ open, onOpenChange, receipt, error }: Props) {
  const isEdit = receipt !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Rediger utlegg" : "Legg til utlegg"}</DialogTitle>
        </DialogHeader>

        <Form method="post" encType="multipart/form-data">
          <input type="hidden" name="_intent" value={isEdit ? "edit" : "create"} />
          {isEdit && <input type="hidden" name="receiptId" value={receipt.id} />}

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <p className="rounded bg-red-50 p-3 text-red-600 text-sm">{error}</p>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="description" className="text-sm font-medium">
                Beskrivelse <span className="text-red-500">*</span>
              </label>
              <textarea
                id="description"
                name="description"
                required
                rows={3}
                defaultValue={receipt?.description ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Beskriv utlegget"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="sum" className="text-sm font-medium">
                Beløp (NOK) <span className="text-red-500">*</span>
              </label>
              <input
                id="sum"
                name="sum"
                type="number"
                required
                min="0.01"
                step="0.01"
                defaultValue={receipt?.sum ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="0.00"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="receiptDate" className="text-sm font-medium">
                Dato <span className="text-red-500">*</span>
              </label>
              <input
                id="receiptDate"
                name="receiptDate"
                type="date"
                required
                defaultValue={receipt?.receiptDate ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="picture" className="text-sm font-medium">
                Kvitteringsbilde {!isEdit && <span className="text-red-500">*</span>}
              </label>
              <input
                id="picture"
                name="picture"
                type="file"
                accept="image/*,application/pdf"
                required={!isEdit}
                className="text-sm"
              />
              {isEdit && (
                <p className="text-muted-foreground text-xs">
                  Last opp ny fil for å erstatte eksisterende kvittering.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Avbryt
            </Button>
            <Button type="submit">
              {isEdit ? "Lagre endringer" : "Legg til"}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
