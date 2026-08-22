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
import { Button, buttonVariants } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  mapReceiptStatus,
  type ApprovalReceiptView,
  type ReceiptApprovalFailure,
  type ReceiptApprovalIntent,
} from "@/lib/receipt-view";
import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";

type ResolutionActionProps = {
  receipt: ApprovalReceiptView;
  intent: ReceiptApprovalIntent;
  failure?: ReceiptApprovalFailure;
  actionErrorId: string;
};

function ResolutionAction({
  receipt,
  intent,
  failure,
  actionErrorId,
}: ResolutionActionProps) {
  const relevantFailure =
    failure?.intent === intent && failure.expectedRevision === receipt.revision
      ? failure
      : undefined;
  const [commandId, setCommandId] = useState(relevantFailure?.commandId ?? "");
  const dialogId = useId();
  const titleId = `${dialogId}-${intent}-title`;
  const descriptionId = `${dialogId}-${intent}-description`;
  const navigation = useNavigation();
  const busy =
    navigation.state !== "idle" &&
    navigation.formData?.get("receiptId") === receipt.receiptId &&
    navigation.formData?.get("_intent") === intent;
  const refunding = intent === "refund";
  const label = refunding ? "Refunder" : "Avvis";
  const confirmation = refunding ? "Bekreft refusjon" : "Bekreft avvisning";

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={refunding ? "default" : "destructive"}
          disabled={navigation.state !== "idle"}
          onClick={() => {
            setCommandId((current) => current || crypto.randomUUID());
          }}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent aria-busy={busy}>
        <AlertDialogHeader>
          <AlertDialogTitle id={titleId}>
            {label} utlegg {receipt.visualId}?
          </AlertDialogTitle>
          <AlertDialogDescription id={descriptionId}>
            {refunding
              ? `${receipt.amount} fra eier ${receipt.ownerPersonId} i avdeling ${receipt.departmentId} markeres som refundert. Handlingen kan ikke angres.`
              : `${receipt.amount} fra eier ${receipt.ownerPersonId} i avdeling ${receipt.departmentId} avvises. Handlingen kan ikke angres.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Form
          method="post"
          aria-labelledby={titleId}
          aria-describedby={`${descriptionId}${relevantFailure ? ` ${actionErrorId}` : ""}`}
          data-receipt-resolution={intent}
        >
          <input type="hidden" name="_intent" value={intent} />
          <input type="hidden" name="receiptId" value={receipt.receiptId} />
          <input type="hidden" name="expectedRevision" value={receipt.revision} />
          <input type="hidden" name="commandId" value={commandId} readOnly />

          {busy && (
            <p className="sr-only" role="status">
              {refunding ? "Refunderer utlegget." : "Avviser utlegget."}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>
              Avbryt
            </AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              disabled={busy || commandId.length === 0}
              className={refunding ? undefined : buttonVariants({ variant: "destructive" })}
            >
              {busy ? (refunding ? "Refunderer …" : "Avviser …") : confirmation}
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ApprovalReceiptRowProps = {
  receipt: ApprovalReceiptView;
  failure?: ReceiptApprovalFailure;
  actionErrorId: string;
};

export function ApprovalReceiptRow({
  receipt,
  failure,
  actionErrorId,
}: ApprovalReceiptRowProps) {
  const relevantFailure = failure?.receiptId === receipt.receiptId ? failure : undefined;

  return (
    <TableRow
      data-receipt-id={receipt.receiptId}
      data-department-id={receipt.departmentId}
      data-owner-person-id={receipt.ownerPersonId}
    >
      <TableCell className="whitespace-normal">
        <div className="flex min-w-40 flex-col gap-1">
          <code className="break-all font-mono text-xs" data-testid="approval-receipt-id">
            {receipt.receiptId}
          </code>
          <span className="text-muted-foreground text-xs">
            Referanse{" "}
            <code className="font-mono" data-testid="approval-visual-id">
              {receipt.visualId}
            </code>
          </span>
        </div>
      </TableCell>
      <TableCell className="whitespace-normal">
        <code className="break-all font-mono text-xs" data-testid="approval-owner-id">
          {receipt.ownerPersonId}
        </code>
      </TableCell>
      <TableCell className="whitespace-normal">
        <code className="break-all font-mono text-xs" data-testid="approval-department-id">
          {receipt.departmentId}
        </code>
      </TableCell>
      <TableCell className="min-w-64 whitespace-normal">{receipt.description}</TableCell>
      <TableCell>
        <data
          value={String(receipt.amountOre)}
          data-amount-ore={receipt.amountOre}
          data-currency={receipt.currency}
        >
          {receipt.amount}
        </data>
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
            <ResolutionAction
              receipt={receipt}
              intent="refund"
              failure={relevantFailure}
              actionErrorId={actionErrorId}
            />
            <ResolutionAction
              receipt={receipt}
              intent="reject"
              failure={relevantFailure}
              actionErrorId={actionErrorId}
            />
          </div>
        ) : (
          <span className="text-muted-foreground text-sm" data-terminal="true">
            Ferdigbehandlet
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
