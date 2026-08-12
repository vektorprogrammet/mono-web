import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFetcher } from "react-router";

type DeleteReceiptActionData =
  | { success: true }
  | { error: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receiptId: number;
};

// biome-ignore lint/style/noDefaultExport: component export
export default function DeleteReceiptDialog({ open, onOpenChange, receiptId }: Props) {
  const fetcher = useFetcher<DeleteReceiptActionData>();
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  const succeeded = fetcher.data !== undefined && "success" in fetcher.data;
  const dialogOpen = open && fetcher.state === "idle" && !succeeded;

  return (
    <AlertDialog open={dialogOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Slett utlegg</AlertDialogTitle>
          <AlertDialogDescription>
            Er du sikker? Utlegget vil bli slettet permanent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="rounded bg-red-50 p-3 text-red-600 text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              fetcher.submit(
                { _intent: "delete", receiptId: String(receiptId) },
                { method: "post" },
              );
            }}
          >
            Slett
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
