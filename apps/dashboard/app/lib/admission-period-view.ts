import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodMergePatch,
  CreateAdmissionPeriodRequest,
  IdempotencyKey,
  NativeProblem,
  StrongETag,
  ValidationProblem,
  type IdempotencyKey as IdempotencyKeyValue,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";

export type AdmissionPeriodUiErrorField = "semesterId" | "departmentId" | "startAt" | "endAt";

export type AdmissionPeriodUiErrorTag =
  | "UnauthenticatedActor"
  | "AdmissionRoleDenied"
  | "AdmissionPeriodNotFound"
  | "AdmissionPeriodDecodeError"
  | "InvalidAdmissionPeriodWindow"
  | "AdmissionPeriodAlreadyExists"
  | "StaleAdmissionPeriodRevision"
  | "DuplicateAdmissionPeriodCommandConflict"
  | "AdmissionPeriodPersistenceError"
  | "AdmissionPeriodFormError"
  | "AdmissionPeriodRateLimited"
  | "AdmissionPeriodNetworkError"
  | "UnknownAdmissionPeriodError";

export type AdmissionPeriodUiError = {
  readonly _tag: AdmissionPeriodUiErrorTag;
  readonly message: string;
  readonly field?: AdmissionPeriodUiErrorField;
};

export type AdmissionPeriodDraft = {
  readonly semesterId: string;
  readonly departmentId: string;
  readonly startAt: string;
  readonly endAt: string;
};

export type AdmissionPeriodRevisionDraft = {
  readonly startAt: string;
  readonly endAt: string;
};

export type AdmissionPeriodCreateFailure = {
  readonly intent: "create";
  readonly commandId: string;
  readonly draft: AdmissionPeriodDraft;
  readonly error: AdmissionPeriodUiError;
};

export type AdmissionPeriodRevisionFailure = {
  readonly intent: "revise";
  readonly admissionPeriodId: string;
  readonly etag?: StrongETagValue;
  readonly commandId: string;
  readonly draft: AdmissionPeriodRevisionDraft;
  readonly error: AdmissionPeriodUiError;
};

export type AdmissionPeriodMutationFailure =
  | AdmissionPeriodCreateFailure
  | AdmissionPeriodRevisionFailure;

export type AdmissionPeriodMutationNotice =
  | {
      readonly intent: "create";
      readonly commandId: string;
      readonly admissionPeriodId: string;
      readonly etag: StrongETagValue;
    }
  | {
      readonly intent: "revise";
      readonly commandId: string;
      readonly admissionPeriodId: string;
      readonly etag: StrongETagValue;
    };

export type AdmissionPeriodProjectionValue = typeof AdmissionPeriodManagementItem.Type;

export type AdmissionPeriodView = {
  readonly id: string;
  readonly departmentId: string;
  readonly semesterId: string;
  readonly startAt: string;
  readonly startAtInput: string;
  readonly startAtLabel: string;
  readonly endAt: string;
  readonly endAtInput: string;
  readonly endAtLabel: string;
  readonly revision: number;
  readonly etag: StrongETagValue;
};

type ParsedCreateCommand = {
  readonly _tag: "CreateAdmissionPeriod";
  readonly commandId: IdempotencyKeyValue;
  readonly payload: typeof CreateAdmissionPeriodRequest.Type;
  readonly draft: AdmissionPeriodDraft;
};

type ParsedReviseCommand = {
  readonly _tag: "ReviseAdmissionPeriod";
  readonly commandId: IdempotencyKeyValue;
  readonly admissionPeriodId: typeof AdmissionPeriodId.Type;
  readonly etag: StrongETagValue;
  readonly payload: typeof AdmissionPeriodMergePatch.Type;
  readonly draft: AdmissionPeriodRevisionDraft;
};

export type ParsedAdmissionPeriodCommand = ParsedCreateCommand | ParsedReviseCommand;

export type AdmissionPeriodFormParseResult =
  | { readonly value: ParsedAdmissionPeriodCommand }
  | { readonly failure: AdmissionPeriodMutationFailure };

const identifierText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
);
const localInstantText = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
);

const createFormSchema = Schema.Struct({
  _intent: Schema.Literal("create"),
  commandId: IdempotencyKey,
  semesterId: identifierText,
  departmentId: Schema.optional(identifierText),
  startAt: localInstantText,
  endAt: localInstantText,
});

const reviseFormSchema = Schema.Struct({
  _intent: Schema.Literal("revise"),
  commandId: IdempotencyKey,
  admissionPeriodId: AdmissionPeriodId,
  etag: StrongETag,
  startAt: localInstantText,
  endAt: localInstantText,
});

const createFields: Readonly<Record<string, true>> = {
  _intent: true,
  commandId: true,
  semesterId: true,
  departmentId: true,
  startAt: true,
  endAt: true,
};
const reviseFields: Readonly<Record<string, true>> = {
  _intent: true,
  commandId: true,
  admissionPeriodId: true,
  etag: true,
  startAt: true,
  endAt: true,
};

const errorMessages: Record<AdmissionPeriodUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan administrere opptaksperioder.",
  AdmissionRoleDenied: "Rollen din gir ikke tilgang til opptaksperioder.",
  AdmissionPeriodNotFound: "Opptaksperioden finnes ikke lenger.",
  AdmissionPeriodDecodeError: "Kontroller feltene og prøv igjen.",
  InvalidAdmissionPeriodWindow: "Starttidspunktet må være før sluttidspunktet.",
  AdmissionPeriodAlreadyExists:
    "Det finnes allerede en opptaksperiode for denne avdelingen og dette semesteret.",
  StaleAdmissionPeriodRevision:
    "Opptaksperioden ble endret et annet sted. Kontroller den nyeste versjonen og prøv igjen.",
  DuplicateAdmissionPeriodCommandConflict:
    "Handlingen er endret etter et tidligere forsøk. Start handlingen på nytt.",
  AdmissionPeriodPersistenceError: "Opptaksperioden kunne ikke lagres. Prøv igjen senere.",
  AdmissionPeriodFormError: "Kontroller feltene og prøv igjen.",
  AdmissionPeriodRateLimited: "For mange forespørsler. Prøv igjen senere.",
  AdmissionPeriodNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownAdmissionPeriodError: "Kunne ikke fullføre forespørselen.",
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

const validationField = (
  problem: DecodedNativeProblem,
): AdmissionPeriodUiErrorField | undefined => {
  if (problem.validation === undefined) return undefined;
  const pointer = problem.validation.errors[0]?.pointer;
  switch (pointer) {
    case "/semesterId":
      return "semesterId";
    case "/departmentId":
      return "departmentId";
    case "/startAt":
      return "startAt";
    case "/endAt":
      return "endAt";
    default:
      return undefined;
  }
};

const firstText = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const formError = (
  field?: AdmissionPeriodUiErrorField,
  message = errorMessages.AdmissionPeriodFormError,
): AdmissionPeriodUiError => ({
  _tag: "AdmissionPeriodFormError",
  message,
  field,
});

const exactRecord = (
  form: FormData,
  allowedFields: Readonly<Record<string, true>>,
): Record<string, string> | undefined => {
  const record: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (allowedFields[name] !== true || typeof value !== "string" || name in record) {
      return undefined;
    }
    record[name] = value.trim();
  }
  return record;
};

const utcInstant = (localInstant: string): string | undefined => {
  const isoInstant = `${localInstant}:00.000Z`;
  const date = new Date(isoInstant);
  return Number.isFinite(date.getTime()) && date.toISOString() === isoInstant
    ? isoInstant
    : undefined;
};

export function parseAdmissionPeriodForm(
  form: FormData,
  fallbackCommandId: string,
): AdmissionPeriodFormParseResult {
  const intent = firstText(form, "_intent");
  const commandId = firstText(form, "commandId").trim() || fallbackCommandId;

  if (intent === "revise") {
    const draft: AdmissionPeriodRevisionDraft = {
      startAt: firstText(form, "startAt"),
      endAt: firstText(form, "endAt"),
    };
    const admissionPeriodId = firstText(form, "admissionPeriodId").trim();
    let etag: StrongETagValue | undefined;
    try {
      etag = Schema.decodeUnknownSync(StrongETag)(firstText(form, "etag").trim());
    } catch {
      etag = undefined;
    }
    const failure = (error: AdmissionPeriodUiError): AdmissionPeriodFormParseResult => ({
      failure: {
        intent: "revise",
        admissionPeriodId,
        ...(etag === undefined ? {} : { etag }),
        commandId,
        draft,
        error,
      },
    });
    const record = exactRecord(form, reviseFields);
    if (record === undefined) return failure(formError());
    record.commandId = commandId;

    let decoded: typeof reviseFormSchema.Type;
    try {
      decoded = Schema.decodeUnknownSync(reviseFormSchema)(record, {
        onExcessProperty: "error",
      });
    } catch {
      return failure(formError());
    }

    const startAt = utcInstant(decoded.startAt);
    const endAt = utcInstant(decoded.endAt);
    if (startAt === undefined) return failure(formError("startAt"));
    if (endAt === undefined || Date.parse(startAt) >= Date.parse(endAt)) {
      return failure(formError("endAt", errorMessages.InvalidAdmissionPeriodWindow));
    }

    let payload: typeof AdmissionPeriodMergePatch.Type;
    try {
      payload = Schema.decodeUnknownSync(AdmissionPeriodMergePatch)(
        { startAt, endAt },
        { onExcessProperty: "error" },
      );
    } catch {
      return failure(formError());
    }

    return {
      value: {
        _tag: "ReviseAdmissionPeriod",
        commandId: decoded.commandId,
        admissionPeriodId: decoded.admissionPeriodId,
        etag: decoded.etag,
        payload,
        draft,
      },
    };
  }

  const draft: AdmissionPeriodDraft = {
    semesterId: firstText(form, "semesterId"),
    departmentId: firstText(form, "departmentId"),
    startAt: firstText(form, "startAt"),
    endAt: firstText(form, "endAt"),
  };
  const failure = (error: AdmissionPeriodUiError): AdmissionPeriodFormParseResult => ({
    failure: { intent: "create", commandId, draft, error },
  });
  if (intent !== "create") return failure(formError());
  const record = exactRecord(form, createFields);
  if (record === undefined) return failure(formError());
  record.commandId = commandId;
  const normalized = {
    ...record,
    departmentId: record.departmentId === "" ? undefined : record.departmentId,
  };

  let decoded: typeof createFormSchema.Type;
  try {
    decoded = Schema.decodeUnknownSync(createFormSchema)(normalized, {
      onExcessProperty: "error",
    });
  } catch {
    return failure(formError());
  }

  const startAt = utcInstant(decoded.startAt);
  const endAt = utcInstant(decoded.endAt);
  if (startAt === undefined) return failure(formError("startAt"));
  if (endAt === undefined || Date.parse(startAt) >= Date.parse(endAt)) {
    return failure(formError("endAt", errorMessages.InvalidAdmissionPeriodWindow));
  }

  let payload: typeof CreateAdmissionPeriodRequest.Type;
  try {
    payload = Schema.decodeUnknownSync(CreateAdmissionPeriodRequest)(
      {
        semesterId: decoded.semesterId,
        startAt,
        endAt,
        ...(decoded.departmentId === undefined ? {} : { departmentId: decoded.departmentId }),
      },
      { onExcessProperty: "error" },
    );
  } catch {
    return failure(formError());
  }

  return {
    value: {
      _tag: "CreateAdmissionPeriod",
      commandId: decoded.commandId,
      payload,
      draft,
    },
  };
}

const dateFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "UTC",
});

const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function mapAdmissionPeriodView(
  period: AdmissionPeriodProjectionValue,
): AdmissionPeriodView {
  const startDate = new Date(period.startAt);
  const endDate = new Date(period.endAt);
  if (
    !rfc3339Instant.test(period.startAt) ||
    !Number.isFinite(startDate.getTime()) ||
    !rfc3339Instant.test(period.endAt) ||
    !Number.isFinite(endDate.getTime())
  ) {
    throw new TypeError("Admission-period API returned an invalid instant");
  }
  return {
    id: period.id,
    departmentId: period.departmentId,
    semesterId: period.semesterId,
    startAt: period.startAt,
    startAtInput: startDate.toISOString().slice(0, 16),
    startAtLabel: dateFormatter.format(startDate),
    endAt: period.endAt,
    endAtInput: endDate.toISOString().slice(0, 16),
    endAtLabel: dateFormatter.format(endDate),
    revision: period.revision,
    etag: period.etag,
  };
}

export function isAdmissionPeriodUnauthorizedError(error: unknown): boolean {
  const code = decodeNativeProblem(error)?.code;
  return code === "credential.missing" || code === "credential.invalid";
}

const admissionError = (
  _tag: AdmissionPeriodUiErrorTag,
  field?: AdmissionPeriodUiErrorField,
): AdmissionPeriodUiError => ({
  _tag,
  message: errorMessages[_tag],
  field,
});

export function mapAdmissionPeriodError(error: unknown): AdmissionPeriodUiError {
  const problem = decodeNativeProblem(error);
  if (problem === undefined) {
    return error instanceof Error
      ? admissionError("AdmissionPeriodNetworkError")
      : admissionError("UnknownAdmissionPeriodError");
  }

  switch (problem.code) {
    case "credential.missing":
    case "credential.invalid":
      return admissionError("UnauthenticatedActor");
    case "authority.denied":
      return admissionError("AdmissionRoleDenied");
    case "admission-period.not-found":
    case "resource.not-found":
      return admissionError("AdmissionPeriodNotFound");
    case "admission-period.invalid-window":
      return admissionError("InvalidAdmissionPeriodWindow", "endAt");
    case "admission-period.already-exists":
      return admissionError("AdmissionPeriodAlreadyExists", "semesterId");
    case "precondition.failed":
      return admissionError("StaleAdmissionPeriodRevision");
    case "idempotency.digest-conflict":
    case "idempotency.in-flight":
    case "idempotency.response-expired":
      return admissionError("DuplicateAdmissionPeriodCommandConflict");
    case "rate-limit.exceeded":
      return admissionError("AdmissionPeriodRateLimited");
    case "admissions.unavailable":
    case "dependency.unavailable":
    case "idempotency.unavailable":
    case "internal.error":
      return admissionError("AdmissionPeriodPersistenceError");
    case "validation.failed":
    case "validation.no-change":
    case "validation.field-not-deletable":
      return admissionError("AdmissionPeriodDecodeError", validationField(problem));
    case "body.invalid-json":
    case "body.missing":
    case "idempotency-key.invalid":
    case "media-type.unsupported":
    case "precondition.invalid":
    case "precondition.required":
    case "request.malformed":
    case "request.too-large":
      return admissionError("AdmissionPeriodDecodeError");
    default:
      return admissionError("UnknownAdmissionPeriodError");
  }
}
