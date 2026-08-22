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
import type { AdminReceipt, ReceiptProjection } from "@vektorprogrammet/sdk";

export type ReceiptStatus = AdminReceipt["status"];
export type OwnedReceiptStatus = ReceiptProjection["status"];

export type OwnedReceiptView = {
  receiptId: string;
  visualId: string;
  description: string;
  amountOre: number;
  amount: string;
  receiptDate: string;
  status: OwnedReceiptStatus;
  revision: number;
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

export type ReceiptUiErrorField = "description" | "amountNok" | "receiptDate" | "file";

export type ReceiptUiErrorTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "ReceiptOwnerDenied"
  | "ReceiptDecodeError"
  | "ReceiptAlreadyExists"
  | "DuplicateReceiptCommandConflict"
  | "ReceiptPersistenceError"
  | "ConfigurationError"
  | "ReceiptNotFound"
  | "ReceiptRateLimited"
  | "ReceiptNetworkError"
  | "UnknownReceiptError";

export type ReceiptUiError = {
  readonly _tag: ReceiptUiErrorTag;
  readonly message: string;
  readonly field?: ReceiptUiErrorField;
};

const statusLabels: Record<ReceiptStatus, string> = {
  pending: "Venter",
  refunded: "Refundert",
  rejected: "Avvist",
};

const receiptErrorMessages: Record<ReceiptUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan sende inn et utlegg.",
  InactiveActor: "Kontoen din er ikke aktiv for innsending av utlegg.",
  ReceiptOwnerDenied: "Du har ikke tilgang til dette utlegget.",
  ReceiptDecodeError: "Kontroller feltene og prøv igjen.",
  ReceiptAlreadyExists: "Utlegget finnes allerede.",
  DuplicateReceiptCommandConflict:
    "Innsendingen er endret etter et tidligere forsøk. Start en ny innsending.",
  ReceiptPersistenceError: "Utlegget kunne ikke lagres. Prøv igjen senere.",
  ConfigurationError: "API-konfigurasjon mangler eller er ugyldig.",
  ReceiptNotFound: "Utlegget ble ikke funnet.",
  ReceiptRateLimited: "For mange forespørsler. Prøv igjen senere.",
  ReceiptNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownReceiptError: "Kunne ikke fullføre forespørselen.",
};

const canonicalReceiptErrorTags: Partial<Record<ReceiptUiErrorTag, true>> = {
  UnauthenticatedActor: true,
  InactiveActor: true,
  ReceiptOwnerDenied: true,
  ReceiptDecodeError: true,
  ReceiptAlreadyExists: true,
  DuplicateReceiptCommandConflict: true,
  ReceiptPersistenceError: true,
};

function toStableDate(date: Date | null): string | null {
  if (date === null || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function canonicalReceiptErrorTag(error: unknown): ReceiptUiErrorTag | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  for (const key of ["receiptTag", "tag", "_tag"] as const) {
    const value = record[key];
    if (
      typeof value === "string" &&
      canonicalReceiptErrorTags[value as ReceiptUiErrorTag] === true
    ) {
      return value as ReceiptUiErrorTag;
    }
  }

  return undefined;
}

export function formatNokAmount(amountOre: number): string {
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) return "—";
  const digits = String(amountOre).padStart(3, "0");
  return `${digits.slice(0, -2)},${digits.slice(-2)} NOK`;
}

export function mapOwnedReceiptView(receipt: ReceiptProjection): OwnedReceiptView {
  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    description: receipt.description,
    amountOre: receipt.amountOre,
    amount: formatNokAmount(receipt.amountOre),
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    revision: receipt.revision,
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

export function isUnauthorizedError(error: unknown): boolean {
  return (
    canonicalReceiptErrorTag(error) === "UnauthenticatedActor" ||
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.type === "unauthorized")
  );
}

export function mapOwnedReceiptError(error: unknown): ReceiptUiError {
  const canonicalTag = canonicalReceiptErrorTag(error);
  if (canonicalTag !== undefined) {
    return { _tag: canonicalTag, message: receiptErrorMessages[canonicalTag] };
  }

  if (error instanceof ConfigurationError) {
    return {
      _tag: "ConfigurationError",
      message: receiptErrorMessages.ConfigurationError,
    };
  }

  if (error instanceof ValidationError) {
    return {
      _tag: "ReceiptDecodeError",
      message: receiptErrorMessages.ReceiptDecodeError,
    };
  }

  if (error instanceof ConflictError) {
    return {
      _tag: "DuplicateReceiptCommandConflict",
      message: receiptErrorMessages.DuplicateReceiptCommandConflict,
    };
  }

  if (error instanceof NotFoundError) {
    return {
      _tag: "ReceiptNotFound",
      message: receiptErrorMessages.ReceiptNotFound,
    };
  }

  if (error instanceof RateLimitedError) {
    return {
      _tag: "ReceiptRateLimited",
      message: receiptErrorMessages.ReceiptRateLimited,
    };
  }

  if (error instanceof NetworkError) {
    return {
      _tag: "ReceiptNetworkError",
      message: receiptErrorMessages.ReceiptNetworkError,
    };
  }

  return {
    _tag: "UnknownReceiptError",
    message: receiptErrorMessages.UnknownReceiptError,
  };
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

  return "Kunne ikke fullføre forespørselen.";
}
