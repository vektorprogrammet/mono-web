import { Predicate, Data, flow } from "effect";
import { nativeProblemFrom as decodeNativeProblem, type NativeProblemSummary as DecodedNativeProblem, nativeFailureFrom } from "./native-problem";
import {
  ReceiptApprovalQueueItem,
  ReceiptListItem,
  ReceiptSettlementQueueItem,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";

type OwnedReceiptProjection = typeof ReceiptListItem.Type;

type ApprovalReceiptProjection = typeof ReceiptApprovalQueueItem.Type;

type SettlementQueueProjection = typeof ReceiptSettlementQueueItem.Type;

type ReceiptSettlementEvidenceProjection = Exclude<OwnedReceiptProjection["settlement"], null>;

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
  approvedAt: string | null;
  settlement: ReceiptSettlementEvidenceView | null;
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
  approvedAt: string | null;
  revision: number;
  etag: StrongETagValue;
};

export type ReceiptSettlementEvidenceView = {
  settlementId: string;
  receiptId: string;
  amountOre: number;
  amount: string;
  currency: "NOK";
  paymentDestinationFingerprint: string;
  externalAuthority: string;
  externalReference: string;
  settledAt: string;
  recordedByPersonId: string;
  recordedAt: string;
  receiptRevision: number;
};

export type SettlementReceiptView = {
  receiptId: string;
  visualId: string;
  ownerPersonId: string;
  departmentId: string;
  description: string;
  amountOre: number;
  amount: string;
  currency: "NOK";
  receiptDate: string;
  status: "Approved";
  approvedAt: string;
  revision: number;
  etag: StrongETagValue;
};

export type ReceiptUiErrorField =
  | "description"
  | "amountNok"
  | "receiptDate"
  | "file"
  | "externalAuthority"
  | "externalReference"
  | "settledAt";

export type ReceiptUiErrorTag =
  | "UnauthenticatedActor"
  | "ReceiptOwnerDenied"
  | "ReceiptScopeDenied"
  | "ReceiptDecodeError"
  | "ReceiptAlreadyExists"
  | "ReceiptAlreadySettled"
  | "DuplicateExternalSettlementReference"
  | "SettlementAfterRecordedAt"
  | "DuplicateReceiptCommandConflict"
  | "ReceiptPersistenceError"
  | "ReceiptNotFound"
  | "StaleReceiptRevision"
  | "InvalidReceiptTransition"
  | "ReceiptFileNotStaged"
  | "ReceiptNetworkError"
  | "UnknownReceiptError";

export type ReceiptUiError = Data.TaggedEnum<{
  [Tag in ReceiptUiErrorTag]: { readonly message: string; readonly field?: ReceiptUiErrorField };
}>;

export const ReceiptUiError = Data.taggedEnum<ReceiptUiError>();

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

export type ReceiptApprovalIntent = "approve" | "reject" | "reopen";

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

export type ReceiptSettlementFailure = {
  readonly receiptId: string;
  readonly etag?: StrongETagValue;
  readonly commandId: string;
  readonly externalAuthority: string;
  readonly externalReference: string;
  readonly settledAt: string;
  readonly error: ReceiptUiError;
};

export type ReceiptSettlementNotice = {
  readonly commandId: string;
  readonly settlement: ReceiptSettlementEvidenceView;
};

const statusLabels: Record<ReceiptStatus, string> = {
  Pending: "Venter",
  Approved: "Godkjent",
  Rejected: "Avvist",
  Withdrawn: "Trukket tilbake",
};

const receiptErrorMessages: Record<ReceiptUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan administrere utlegg.",
  ReceiptOwnerDenied: "Du har ikke tilgang til dette utlegget.",
  ReceiptScopeDenied: "Du har ikke godkjenningsområde for dette utlegget.",
  ReceiptDecodeError: "Kontroller feltene og prøv igjen.",
  ReceiptAlreadyExists: "Utlegget finnes allerede.",
  ReceiptAlreadySettled: "Oppgjør er allerede registrert for dette utlegget.",
  DuplicateExternalSettlementReference:
    "Den eksterne autoriteten og referansen er allerede brukt for et annet oppgjør.",
  SettlementAfterRecordedAt:
    "Oppgjørstidspunktet kan ikke være senere enn tidspunktet det registreres.",
  DuplicateReceiptCommandConflict:
    "Handlingen er endret etter et tidligere forsøk. Start handlingen på nytt.",
  ReceiptPersistenceError: "Utlegget kunne ikke lagres. Prøv igjen senere.",
  ReceiptNotFound: "Utlegget ble ikke funnet.",
  StaleReceiptRevision:
    "Utlegget ble endret et annet sted. Listen viser nå siste versjon. Kontroller statusen og prøv igjen.",
  InvalidReceiptTransition:
    "Handlingen kan ikke utføres med utleggets nåværende status. Last inn listen på nytt.",
  ReceiptFileNotStaged:
    "Erstatningsfilen kunne ikke behandles. Den gjeldende filen er ikke endret.",
  ReceiptNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownReceiptError: "Kunne ikke fullføre forespørselen.",
};

const validationField = (problem: DecodedNativeProblem): ReceiptUiErrorField | undefined => {
  if (!("validation" in problem)) return undefined;
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
    case "/externalAuthority":
      return "externalAuthority";
    case "/externalReference":
      return "externalReference";
    case "/settledAt":
      return "settledAt";
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

export function mapReceiptSettlementEvidenceView(
  settlement: ReceiptSettlementEvidenceProjection,
): ReceiptSettlementEvidenceView {
  return {
    settlementId: settlement.settlementId,
    receiptId: settlement.receiptId,
    amountOre: settlement.amountOre,
    amount: formatNokAmount(settlement.amountOre),
    currency: settlement.currency,
    paymentDestinationFingerprint: settlement.paymentDestinationFingerprint,
    externalAuthority: settlement.externalAuthority,
    externalReference: settlement.externalReference,
    settledAt: settlement.settledAt,
    recordedByPersonId: settlement.recordedByPersonId,
    recordedAt: settlement.recordedAt,
    receiptRevision: settlement.receiptRevision,
  };
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
    approvedAt: receipt.approvedAt,
    settlement:
      receipt.settlement === null ? null : mapReceiptSettlementEvidenceView(receipt.settlement),
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
    approvedAt: receipt.approvedAt,
    revision: receipt.revision,
    etag: receipt.etag,
  };
}

export function mapSettlementReceiptView(receipt: SettlementQueueProjection): SettlementReceiptView {
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
    approvedAt: receipt.approvedAt,
    revision: receipt.revision,
    etag: receipt.etag,
  };
}

export function mapReceiptStatus(status: ReceiptStatus): string {
  return statusLabels[status];
}

export const isUnauthorizedError = flow(decodeNativeProblem, (problem) => {
  const code = problem?.code;

  return code === "credential.missing" || code === "credential.invalid";
});

const receiptError = (_tag: ReceiptUiErrorTag, field?: ReceiptUiErrorField): ReceiptUiError => ReceiptUiError[_tag]({message: receiptErrorMessages[_tag], field});

const receiptErrorFor = (authorityTag: "ReceiptOwnerDenied" | "ReceiptScopeDenied") => flow(nativeFailureFrom, (error): ReceiptUiError => {
 const problem = error instanceof Error || error instanceof Response ? undefined : error;

  if (problem === undefined) {
    if (
      Predicate.isObjectOrArray(error) &&
      error !== null &&
      "_tag" in error &&
      Predicate.isTagged(error, "SchemaError")
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
    case "receipt.already-settled":
      return receiptError("ReceiptAlreadySettled");
    case "settlement.external-reference-conflict":
      return receiptError("DuplicateExternalSettlementReference", "externalReference");
    case "settlement.after-recorded-at":
      return receiptError("SettlementAfterRecordedAt", "settledAt");
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
});

export const mapOwnedReceiptError = receiptErrorFor("ReceiptOwnerDenied");

export const mapApprovalReceiptError = receiptErrorFor("ReceiptScopeDenied");
