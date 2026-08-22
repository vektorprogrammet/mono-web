import {
  ConfigurationError,
  ConflictError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  SdkError,
  UnauthorizedError,
  ValidationError,
} from "@vektorprogrammet/sdk";
import { Schema } from "effect";

export type AdmissionPeriodUiErrorField =
  | "semesterId"
  | "departmentId"
  | "startAt"
  | "endAt"
  | "expectedRevision";

export type AdmissionPeriodUiErrorTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "AdmissionRoleDenied"
  | "AdmissionScopeDenied"
  | "DepartmentRequired"
  | "DepartmentNotFound"
  | "SemesterNotFound"
  | "AdmissionPeriodNotFound"
  | "AdmissionPeriodDecodeError"
  | "InvalidAdmissionPeriodWindow"
  | "AdmissionWindowOutsideSemester"
  | "AdmissionPeriodAlreadyExists"
  | "StaleAdmissionPeriodRevision"
  | "DuplicateAdmissionPeriodCommandConflict"
  | "AdmissionPeriodPersistenceError"
  | "AdmissionPeriodFormError"
  | "AdmissionPeriodConfigurationError"
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
  readonly expectedRevision: number;
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
    }
  | {
      readonly intent: "revise";
      readonly commandId: string;
      readonly admissionPeriodId: string;
    };

export type AdmissionPeriodProjectionValue = {
  readonly id: string;
  readonly departmentId: string;
  readonly semesterId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly revision: number;
  readonly lastCommandId: string;
  readonly eligible: boolean;
};

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
  readonly lastCommandId: string;
  readonly eligible: boolean;
};

type ParsedCreateCommand = {
  readonly _tag: "CreateAdmissionPeriod";
  readonly commandId: string;
  readonly input: {
    readonly commandId: string;
    readonly semesterId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly departmentId?: string;
  };
  readonly draft: AdmissionPeriodDraft;
};

type ParsedReviseCommand = {
  readonly _tag: "ReviseAdmissionPeriod";
  readonly commandId: string;
  readonly admissionPeriodId: string;
  readonly expectedRevision: number;
  readonly input: {
    readonly commandId: string;
    readonly expectedRevision: number;
    readonly startAt: string;
    readonly endAt: string;
  };
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
const revisionText = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(0|[1-9]\d*)$/)),
);

const createFormSchema = Schema.Struct({
  _intent: Schema.Literal("create"),
  commandId: identifierText,
  semesterId: identifierText,
  departmentId: Schema.optional(identifierText),
  startAt: localInstantText,
  endAt: localInstantText,
});

const reviseFormSchema = Schema.Struct({
  _intent: Schema.Literal("revise"),
  commandId: identifierText,
  admissionPeriodId: identifierText,
  expectedRevision: revisionText,
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
  expectedRevision: true,
  startAt: true,
  endAt: true,
};

const errorMessages: Record<AdmissionPeriodUiErrorTag, string> = {
  UnauthenticatedActor: "Du må logge inn før du kan administrere opptaksperioder.",
  InactiveActor: "Kontoen din er ikke aktiv for administrasjon av opptaksperioder.",
  AdmissionRoleDenied: "Rollen din gir ikke tilgang til opptaksperioder.",
  AdmissionScopeDenied: "Du har ikke tilgang til opptaksperioder for denne avdelingen.",
  DepartmentRequired: "Velg avdeling når du oppretter perioden som global administrator.",
  DepartmentNotFound: "Avdelingen finnes ikke.",
  SemesterNotFound: "Semesteret finnes ikke.",
  AdmissionPeriodNotFound: "Opptaksperioden finnes ikke lenger.",
  AdmissionPeriodDecodeError: "Kontroller feltene og prøv igjen.",
  InvalidAdmissionPeriodWindow: "Starttidspunktet må være før sluttidspunktet.",
  AdmissionWindowOutsideSemester:
    "Start og slutt må være innenfor tidsrommet til semesteret.",
  AdmissionPeriodAlreadyExists:
    "Det finnes allerede en opptaksperiode for denne avdelingen og dette semesteret.",
  StaleAdmissionPeriodRevision:
    "Opptaksperioden ble endret et annet sted. Kontroller den nyeste versjonen og prøv igjen.",
  DuplicateAdmissionPeriodCommandConflict:
    "Handlingen er endret etter et tidligere forsøk. Start handlingen på nytt.",
  AdmissionPeriodPersistenceError: "Opptaksperioden kunne ikke lagres. Prøv igjen senere.",
  AdmissionPeriodFormError: "Kontroller feltene og prøv igjen.",
  AdmissionPeriodConfigurationError: "API-konfigurasjonen mangler eller er ugyldig.",
  AdmissionPeriodRateLimited: "For mange forespørsler. Prøv igjen senere.",
  AdmissionPeriodNetworkError: "Kunne ikke nå API-et. Prøv igjen senere.",
  UnknownAdmissionPeriodError: "Kunne ikke fullføre forespørselen.",
};

const canonicalErrorTags: Partial<Record<AdmissionPeriodUiErrorTag, true>> = {
  UnauthenticatedActor: true,
  InactiveActor: true,
  AdmissionRoleDenied: true,
  AdmissionScopeDenied: true,
  DepartmentRequired: true,
  DepartmentNotFound: true,
  SemesterNotFound: true,
  AdmissionPeriodNotFound: true,
  AdmissionPeriodDecodeError: true,
  InvalidAdmissionPeriodWindow: true,
  AdmissionWindowOutsideSemester: true,
  AdmissionPeriodAlreadyExists: true,
  StaleAdmissionPeriodRevision: true,
  DuplicateAdmissionPeriodCommandConflict: true,
  AdmissionPeriodPersistenceError: true,
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

const canonicalAdmissionErrorTag = (
  error: unknown,
): AdmissionPeriodUiErrorTag | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["admissionPeriodTag", "tag", "_tag"] as const) {
    const value = record[key];
    if (
      typeof value === "string" &&
      canonicalErrorTags[value as AdmissionPeriodUiErrorTag] === true
    ) {
      return value as AdmissionPeriodUiErrorTag;
    }
  }
  return undefined;
};

const fieldForTag = (
  tag: AdmissionPeriodUiErrorTag,
): AdmissionPeriodUiErrorField | undefined => {
  switch (tag) {
    case "DepartmentRequired":
    case "DepartmentNotFound":
    case "AdmissionScopeDenied":
      return "departmentId";
    case "SemesterNotFound":
    case "AdmissionPeriodAlreadyExists":
      return "semesterId";
    case "InvalidAdmissionPeriodWindow":
    case "AdmissionWindowOutsideSemester":
      return "endAt";
    case "StaleAdmissionPeriodRevision":
      return "expectedRevision";
    default:
      return undefined;
  }
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
    const revisionValue = firstText(form, "expectedRevision").trim();
    const expectedRevision = /^\d+$/.test(revisionValue) ? Number(revisionValue) : 0;
    const failure = (error: AdmissionPeriodUiError): AdmissionPeriodFormParseResult => ({
      failure: {
        intent: "revise",
        admissionPeriodId,
        expectedRevision,
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
    const revision = Number(decoded.expectedRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return failure(formError("expectedRevision"));
    }
    if (startAt === undefined) return failure(formError("startAt"));
    if (endAt === undefined || Date.parse(startAt) >= Date.parse(endAt)) {
      return failure(
        formError("endAt", errorMessages.InvalidAdmissionPeriodWindow),
      );
    }

    return {
      value: {
        _tag: "ReviseAdmissionPeriod",
        commandId,
        admissionPeriodId: decoded.admissionPeriodId,
        expectedRevision: revision,
        input: {
          commandId,
          expectedRevision: revision,
          startAt,
          endAt,
        },
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

  return {
    value: {
      _tag: "CreateAdmissionPeriod",
      commandId,
      input: {
        commandId,
        semesterId: decoded.semesterId,
        startAt,
        endAt,
        ...(decoded.departmentId === undefined
          ? {}
          : { departmentId: decoded.departmentId }),
      },
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

const rfc3339Instant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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
    throw new TypeError("Admission-period SDK returned an invalid instant");
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
    lastCommandId: period.lastCommandId,
    eligible: period.eligible,
  };
}

export function isAdmissionPeriodUnauthorizedError(error: unknown): boolean {
  return (
    canonicalAdmissionErrorTag(error) === "UnauthenticatedActor" ||
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.type === "unauthorized")
  );
}

export function mapAdmissionPeriodError(error: unknown): AdmissionPeriodUiError {
  const canonicalTag = canonicalAdmissionErrorTag(error);
  if (canonicalTag !== undefined) {
    return {
      _tag: canonicalTag,
      message: errorMessages[canonicalTag],
      field: fieldForTag(canonicalTag),
    };
  }

  if (error instanceof ValidationError) {
    const fieldName = Object.keys(error.fields)[0];
    const field =
      fieldName === "semesterId" ||
      fieldName === "departmentId" ||
      fieldName === "startAt" ||
      fieldName === "endAt" ||
      fieldName === "expectedRevision"
        ? fieldName
        : undefined;
    return {
      _tag: "AdmissionPeriodDecodeError",
      message: errorMessages.AdmissionPeriodDecodeError,
      field,
    };
  }
  if (error instanceof ConflictError) {
    return {
      _tag: "DuplicateAdmissionPeriodCommandConflict",
      message: errorMessages.DuplicateAdmissionPeriodCommandConflict,
    };
  }
  if (error instanceof NotFoundError) {
    return {
      _tag: "AdmissionPeriodNotFound",
      message: errorMessages.AdmissionPeriodNotFound,
    };
  }
  if (error instanceof ConfigurationError) {
    return {
      _tag: "AdmissionPeriodConfigurationError",
      message: errorMessages.AdmissionPeriodConfigurationError,
    };
  }
  if (error instanceof RateLimitedError) {
    return {
      _tag: "AdmissionPeriodRateLimited",
      message: errorMessages.AdmissionPeriodRateLimited,
    };
  }
  if (error instanceof NetworkError) {
    return {
      _tag: "AdmissionPeriodNetworkError",
      message: errorMessages.AdmissionPeriodNetworkError,
    };
  }
  return {
    _tag: "UnknownAdmissionPeriodError",
    message: errorMessages.UnknownAdmissionPeriodError,
  };
}
