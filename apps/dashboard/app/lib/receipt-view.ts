import {
  NativeProblem,
  ReceiptApprovalQueueItem,
  ReceiptListItem,
  ValidationProblem,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";

type OwnedReceiptProjection = typeof ReceiptListItem.Type;
type ApprovalReceiptProjection = typeof ReceiptApprovalQueueItem.Type;

export type ReceiptStatus = OwnedReceiptProjection["status"];
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
  etag: StrongETagValue;
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
  etag: StrongETagValue;
};

export type ReceiptUiErrorField = "description" | "amountNok" | "receiptDate" | "file";

export type ReceiptUiErrorTag =
  | "UnauthenticatedActor"
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
  readonly etag?: StrongETagValue;
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
  readonly etag: StrongETagValue;
};

export type ReceiptApprovalIntent = "refund" | "reject";

export type ReceiptApprovalFailure = {
  readonly intent: ReceiptApprovalIntent;
  readonly receiptId: string;
  readonly etag?: StrongETagValue;
  readonly commandId: string;
  readonly error: ReceiptUiError;
};

export type ReceiptApprovalNotice = {
  readonly intent: ReceiptApprovalIntent;
  readonly receiptId: string;
  readonly commandId: string;
  readonly status: ReceiptStatus;
  readonly revision: number;
  readonly etag: StrongETagValue;
};

const statusLabels: Record<ReceiptStatus, string> = {
  Pending: "Venter",
  Refunded: "Refundert",
  Rejected: "Avvist",
  Withdrawn: "Trukket tilbake",
};

const receiptErrorMessages: Record<ReceiptUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan administrere utlegg.",
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
  InvalidReceiptTransition: "Utlegget har en ferdig status og kan ikke behandles på nytt.",
  ReceiptFileNotStaged:
    "Erstatningsfilen kunne ikke behandles. Den gjeldende filen er ikke endret.",
  ReceiptNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownReceiptError: "Kunne ikke fullføre forespørselen.",
};

const nativeProblemSchema = Schema.Union([ValidationProblem, NativeProblem]);
type DecodedNativeProblem = {
  readonly code: string;
  readonly validation?: {
    readonly errors: ReadonlyArray<{ readonly pointer: string }>;
  };
};

const decodeNativeProblem = (error: unknown): DecodedNativeProblem | undefined => {
  try {
    return Schema.decodeUnknownSync(nativeProblemSchema)(error, {
      onExcessProperty: "error",
    });
  } catch {
    return undefined;
  }
};

const validationField = (problem: DecodedNativeProblem): ReceiptUiErrorField | undefined => {
  if (problem.validation === undefined) return undefined;
  const pointer = problem.validation.errors[0]?.pointer;
  switch (pointer) {
    case "/description":
      return "description";
    case "/amountOre":
      return "amountNok";
    case "/receiptDate":
      return "receiptDate";
    case "/file":
      return "file";
    default:
      return undefined;
  }
};

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

export function mapOwnedReceiptView(receipt: OwnedReceiptProjection): OwnedReceiptView {
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
    etag: receipt.etag,
  };
}

export function mapApprovalReceiptView(receipt: ApprovalReceiptProjection): ApprovalReceiptView {
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
    etag: receipt.etag,
  };
}

export function mapReceiptStatus(status: ReceiptStatus): string {
  return statusLabels[status];
}

export function isUnauthorizedError(error: unknown): boolean {
  const code = decodeNativeProblem(error)?.code;
  return code === "credential.missing" || code === "credential.invalid";
}

const receiptError = (_tag: ReceiptUiErrorTag, field?: ReceiptUiErrorField): ReceiptUiError => ({
  _tag,
  message: receiptErrorMessages[_tag],
  field,
});

const mapReceiptError = (
  error: unknown,
  authorityTag: "ReceiptOwnerDenied" | "ReceiptScopeDenied",
): ReceiptUiError => {
  const problem = decodeNativeProblem(error);
  if (problem === undefined) {
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "SchemaError"
    ) {
      return receiptError("ReceiptDecodeError");
    }
    return error instanceof Error
      ? receiptError("ReceiptNetworkError")
      : receiptError("UnknownReceiptError");
  }

  switch (problem.code) {
    case "credential.missing":
    case "credential.invalid":
      return receiptError("UnauthenticatedActor");
    case "authority.denied":
      return receiptError(authorityTag);
    case "receipt.not-found":
    case "resource.not-found":
      return receiptError("ReceiptNotFound");
    case "receipt.already-exists":
      return receiptError("ReceiptAlreadyExists");
    case "receipt.invalid-transition":
      return receiptError("InvalidReceiptTransition");
    case "receipt.file-not-staged":
      return receiptError("ReceiptFileNotStaged", "file");
    case "precondition.failed":
      return receiptError("StaleReceiptRevision");
    case "idempotency.digest-conflict":
    case "idempotency.in-flight":
    case "idempotency.response-expired":
      return receiptError("DuplicateReceiptCommandConflict");
    case "receipts.unavailable":
    case "dependency.unavailable":
    case "idempotency.unavailable":
    case "internal.error":
      return receiptError("ReceiptPersistenceError");
    case "validation.failed":
    case "validation.no-change":
    case "validation.field-not-deletable":
      return receiptError("ReceiptDecodeError", validationField(problem));
    case "body.invalid-json":
    case "body.missing":
    case "idempotency-key.invalid":
    case "media-type.unsupported":
    case "precondition.invalid":
    case "precondition.required":
    case "request.malformed":
      return receiptError("ReceiptDecodeError");
    case "request.too-large":
      return receiptError("ReceiptDecodeError", "file");
    default:
      return receiptError("UnknownReceiptError");
  }
};

export function mapOwnedReceiptError(error: unknown): ReceiptUiError {
  return mapReceiptError(error, "ReceiptOwnerDenied");
}

export function mapApprovalReceiptError(error: unknown): ReceiptUiError {
  return mapReceiptError(error, "ReceiptScopeDenied");
}
