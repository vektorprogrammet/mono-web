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
import type { ReceiptProjection } from "@vektorprogrammet/sdk";

export type ReceiptStatus = ReceiptProjection["status"];
export type OwnedReceiptStatus = ReceiptStatus;

export type OwnedReceiptView = {
  receiptId: string;
  visualId: string;
  description: string;
  amountOre: number;
  amountNok: string;
  amount: string;
  receiptDate: string;
  status: OwnedReceiptStatus;
  revision: number;
};

export type ApprovalReceiptView = {
  receiptId: string;
  visualId: string;
  ownerPersonId: string;
  departmentId: string;
  description: string;
  amountOre: number;
  amount: string;
  currency: "NOK";
  receiptDate: string;
  status: ReceiptStatus;
  revision: number;
};

export type ReceiptUiErrorField = "description" | "amountNok" | "receiptDate" | "file";

export type ReceiptUiErrorTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "ReceiptOwnerDenied"
  | "ReceiptScopeDenied"
  | "ReceiptDecodeError"
  | "ReceiptAlreadyExists"
  | "DuplicateReceiptCommandConflict"
  | "ReceiptPersistenceError"
  | "ReceiptNotFound"
  | "StaleReceiptRevision"
  | "InvalidReceiptTransition"
  | "ReceiptFileNotStaged"
  | "ConfigurationError"
  | "ReceiptRateLimited"
  | "ReceiptNetworkError"
  | "UnknownReceiptError";

export type ReceiptUiError = {
  readonly _tag: ReceiptUiErrorTag;
  readonly message: string;
  readonly field?: ReceiptUiErrorField;
};

export type ReceiptOwnerMutationIntent = "revise" | "withdraw";

export type ReceiptRevisionDraft = {
  readonly description: string;
  readonly amountNok: string;
  readonly receiptDate: string;
};

export type ReceiptOwnerMutationFailure = {
  readonly intent: ReceiptOwnerMutationIntent;
  readonly receiptId: string;
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly error: ReceiptUiError;
  readonly draft?: ReceiptRevisionDraft;
};

export type ReceiptOwnerMutationNotice = {
  readonly intent: ReceiptOwnerMutationIntent;
  readonly receiptId: string;
  readonly commandId: string;
  readonly status: OwnedReceiptStatus;
  readonly revision: number;
  readonly replayed: boolean;
};

export type ReceiptApprovalIntent = "refund" | "reject";

export type ReceiptApprovalFailure = {
  readonly intent: ReceiptApprovalIntent;
  readonly receiptId: string;
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly error: ReceiptUiError;
};

export type ReceiptApprovalNotice = {
  readonly intent: ReceiptApprovalIntent;
  readonly receiptId: string;
  readonly commandId: string;
  readonly status: ReceiptStatus;
  readonly revision: number;
  readonly replayed: boolean;
};

const statusLabels: Record<ReceiptStatus, string> = {
  Pending: "Venter",
  Refunded: "Refundert",
  Rejected: "Avvist",
  Withdrawn: "Trukket tilbake",
};

const receiptErrorMessages: Record<ReceiptUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan administrere utlegg.",
  InactiveActor: "Kontoen din er ikke aktiv for administrasjon av utlegg.",
  ReceiptOwnerDenied: "Du har ikke tilgang til dette utlegget.",
  ReceiptScopeDenied: "Du har ikke godkjenningsområde for dette utlegget.",
  ReceiptDecodeError: "Kontroller feltene og prøv igjen.",
  ReceiptAlreadyExists: "Utlegget finnes allerede.",
  DuplicateReceiptCommandConflict:
    "Handlingen er endret etter et tidligere forsøk. Start handlingen på nytt.",
  ReceiptPersistenceError: "Utlegget kunne ikke lagres. Prøv igjen senere.",
  ReceiptNotFound: "Utlegget ble ikke funnet.",
  StaleReceiptRevision:
    "Utlegget ble endret et annet sted. Listen viser nå siste versjon. Kontroller statusen og prøv igjen.",
  InvalidReceiptTransition:
    "Utlegget har en ferdig status og kan ikke behandles på nytt.",
  ReceiptFileNotStaged:
    "Erstatningsfilen kunne ikke behandles. Den gjeldende filen er ikke endret.",
  ConfigurationError: "API-konfigurasjon mangler eller er ugyldig.",
  ReceiptRateLimited: "For mange forespørsler. Prøv igjen senere.",
  ReceiptNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownReceiptError: "Kunne ikke fullføre forespørselen.",
};

const canonicalReceiptErrorTags: Partial<Record<ReceiptUiErrorTag, true>> = {
  UnauthenticatedActor: true,
  InactiveActor: true,
  ReceiptOwnerDenied: true,
  ReceiptScopeDenied: true,
  ReceiptDecodeError: true,
  ReceiptAlreadyExists: true,
  DuplicateReceiptCommandConflict: true,
  ReceiptPersistenceError: true,
  ReceiptNotFound: true,
  StaleReceiptRevision: true,
  InvalidReceiptTransition: true,
  ReceiptFileNotStaged: true,
};


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

export function formatNokInput(amountOre: number): string {
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) return "";
  const digits = String(amountOre).padStart(3, "0");
  return `${digits.slice(0, -2)},${digits.slice(-2)}`;
}

export function mapOwnedReceiptView(receipt: ReceiptProjection): OwnedReceiptView {
  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    description: receipt.description,
    amountOre: receipt.amountOre,
    amount: formatNokAmount(receipt.amountOre),
    amountNok: formatNokInput(receipt.amountOre),
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    revision: receipt.revision,
  };
}

export function mapApprovalReceiptView(receipt: ReceiptProjection): ApprovalReceiptView {
  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    ownerPersonId: receipt.ownerPersonId,
    departmentId: receipt.departmentId,
    description: receipt.description,
    amountOre: receipt.amountOre,
    amount: formatNokAmount(receipt.amountOre),
    currency: receipt.currency,
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    revision: receipt.revision,
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
    const fieldName = Object.keys(error.fields)[0];
    const field =
      fieldName === "amountOre"
        ? "amountNok"
        : fieldName === "replacementFile"
          ? "file"
          : fieldName === "description" ||
              fieldName === "amountNok" ||
              fieldName === "receiptDate" ||
              fieldName === "file"
            ? fieldName
            : undefined;
    return {
      _tag: "ReceiptDecodeError",
      message: receiptErrorMessages.ReceiptDecodeError,
      field,
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

export function mapApprovalReceiptError(error: unknown): ReceiptUiError {
  return mapOwnedReceiptError(error);
}

