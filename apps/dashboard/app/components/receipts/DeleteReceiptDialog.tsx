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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receiptId: number;
};

// biome-ignore lint/style/noDefaultExport: component export
export default function DeleteReceiptDialog({ open, onOpenChange, receiptId }: Props) {
  const fetcher = useFetcher();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Slett utlegg</AlertDialogTitle>
          <AlertDialogDescription>
            Er du sikker? Utlegget vil bli slettet permanent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              fetcher.submit(
                { _intent: "delete", receiptId: String(receiptId) },
                { method: "post" },
              );
              onOpenChange(false);
            }}
          >
            Slett
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
