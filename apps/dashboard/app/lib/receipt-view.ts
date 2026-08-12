import {
  ConflictError,
  ConfigurationError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  SdkError,
  UnauthorizedError,
  ValidationError,
} from "@vektorprogrammet/sdk";
import type { AdminReceipt, Receipt } from "@vektorprogrammet/sdk";

export type ReceiptStatus = Receipt["status"];

export type ReceiptView = {
  id: number;
  visualId: string;
  description: string;
  sum: number;
  receiptDate: string | null;
  submitDate: string | null;
  status: ReceiptStatus;
  refundDate: string | null;
};

export type AdminReceiptView = {
  id: number;
  visualId: string;
  userName: string;
  description: string;
  sum: number;
  receiptDate: string | null;
  submitDate: string | null;
  status: ReceiptStatus;
  refundDate: string | null;
};

const statusLabels: Record<ReceiptStatus, string> = {
  pending: "Venter",
  refunded: "Refundert",
  rejected: "Avvist",
};

function toStableDate(date: Date | null): string | null {
  if (date === null || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function mapReceiptView(receipt: Receipt): ReceiptView {
  return {
    id: receipt.id,
    visualId: receipt.visualId,
    description: receipt.description,
    sum: receipt.sum,
    receiptDate: toStableDate(receipt.receiptDate),
    submitDate: toStableDate(receipt.submitDate),
    status: receipt.status,
    refundDate: toStableDate(receipt.refundDate),
  };
}

export function mapAdminReceiptView(receipt: AdminReceipt): AdminReceiptView {
  return {
    id: receipt.id,
    visualId: receipt.visualId,
    userName: receipt.userName,
    description: receipt.description,
    sum: receipt.sum,
    receiptDate: toStableDate(receipt.receiptDate),
    submitDate: toStableDate(receipt.submitDate),
    status: receipt.status,
    refundDate: toStableDate(receipt.refundDate),
  };
}

export function mapReceiptStatus(status: ReceiptStatus): string {
  return statusLabels[status];
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.type === "unauthorized")
  );
}

export function mapReceiptError(error: unknown): string {
  if (error instanceof ConfigurationError) {
    return "API-konfigurasjon mangler eller er ugyldig.";
  }

  if (error instanceof ValidationError) {
    const fields = Object.keys(error.fields);
    return fields.length > 0
      ? `Kontroller feltene: ${fields.join(", ")}.`
      : "Kontroller feltene og prøv igjen.";
  }

  if (error instanceof ConflictError) {
    return "Utlegget er endret et annet sted. Last inn siden på nytt og prøv igjen.";
  }

  if (error instanceof NotFoundError) {
    return "Utlegget ble ikke funnet.";
  }

  if (error instanceof RateLimitedError) {
    return "For mange forespørsler. Prøv igjen senere.";
  }

  if (error instanceof NetworkError) {
    return "Kunne ikke nå API-et. Prøv igjen senere.";
  }

  if (error instanceof SdkError) {
    return "Kunne ikke fullføre forespørselen.";
  }

  return "Kunne ikke fullføre forespørselen.";
}
