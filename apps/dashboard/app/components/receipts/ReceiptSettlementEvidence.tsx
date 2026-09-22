import type { ReceiptSettlementEvidenceView } from "@/lib/receipt-view";

type ReceiptSettlementEvidenceProps = {
  evidence: ReceiptSettlementEvidenceView;
  title: string;
};

export function ReceiptSettlementEvidence({ evidence, title }: ReceiptSettlementEvidenceProps) {
  return (
    <section
      className="rounded-md border bg-muted/30 p-4"
      data-testid="receipt-settlement-evidence"
      data-settlement-id={evidence.settlementId}
    >
      <h3 className="font-semibold text-base">{title}</h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Oppgjørs-ID</dt>
          <dd className="break-all font-mono text-xs">{evidence.settlementId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Kvitterings-ID</dt>
          <dd className="break-all font-mono text-xs">{evidence.receiptId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Beløp</dt>
          <dd data-amount-ore={evidence.amountOre} data-currency={evidence.currency}>
            {evidence.amount}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Betalingsdestinasjonens fingeravtrykk</dt>
          <dd className="break-all font-mono text-xs" data-payment-destination-fingerprint>
            {evidence.paymentDestinationFingerprint}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ekstern autoritet</dt>
          <dd>{evidence.externalAuthority}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ekstern referanse</dt>
          <dd className="break-all font-mono text-xs">{evidence.externalReference}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oppgjort</dt>
          <dd>
            <time dateTime={evidence.settledAt}>{evidence.settledAt}</time>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Registrert av</dt>
          <dd className="break-all font-mono text-xs">{evidence.recordedByPersonId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Registrert</dt>
          <dd>
            <time dateTime={evidence.recordedAt}>{evidence.recordedAt}</time>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Kvitteringsversjon</dt>
          <dd>{evidence.receiptRevision}</dd>
        </div>
      </dl>
    </section>
  );
}
