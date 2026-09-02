import type { PublicApplicationCatalog } from "@vektorprogrammet/domain/application";
import { IdempotencyKey, SubmitApplicationRequest } from "@vektorprogrammet/http-api";
import { Schema } from "effect";

const applicantFieldNames = [
  "commandId",
  "departmentId",
  "firstName",
  "lastName",
  "phone",
  "email",
  "gender",
  "fieldOfStudyId",
  "yearOfStudy",
] as const;

export type ApplicantFieldName = (typeof applicantFieldNames)[number];

const boundedText = (maximumLength: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength)));

const ApplicantFormRecord = Schema.Struct({
  commandId: boundedText(200),
  departmentId: boundedText(200),
  firstName: boundedText(100),
  lastName: boundedText(100),
  phone: boundedText(32),
  email: boundedText(254),
  gender: Schema.Literals(["0", "1"]),
  fieldOfStudyId: boundedText(200),
  yearOfStudy: Schema.Literals(["1", "2", "3", "4", "5"]),
});

type ApplicantFormRecord = typeof ApplicantFormRecord.Type;

export type PublicApplicationErrorCode =
  | "ApplicationFormInvalid"
  | "validation.failed"
  | "request.malformed"
  | "media-type.unsupported"
  | "application.no-eligible-period"
  | "application.ambiguous-period"
  | "application.invalid-field-of-study"
  | "application.duplicate"
  | "idempotency-key.invalid"
  | "idempotency.in-flight"
  | "idempotency.digest-conflict"
  | "idempotency.response-expired"
  | "idempotency.unavailable"
  | "rate-limit.exceeded"
  | "request.too-large"
  | "dependency.unavailable"
  | "internal.error"
  | "Network"
  | "Configuration"
  | "Unexpected";

export type PublicApplicationErrorView = {
  readonly _tag: PublicApplicationErrorCode;
  readonly message: string;
  readonly fieldErrors?: Partial<Record<ApplicantFieldName, string>>;
  readonly resetCommandId?: boolean;
};

export type PublicApplicationLoaderData =
  | {
      readonly ok: true;
      readonly catalog: PublicApplicationCatalog;
    }
  | {
      readonly ok: false;
      readonly error: PublicApplicationErrorView;
    };

export type PublicApplicationActionData =
  | {
      readonly success: true;
      readonly confirmation: {
        readonly _tag: "ApplicationConfirmed";
        readonly applicationId: string;
      };
    }
  | {
      readonly success: false;
      readonly failure: {
        readonly commandId: string;
        readonly error: PublicApplicationErrorView;
      };
    };

export type ParsedPublicApplicationForm =
  | {
      readonly ok: true;
      readonly value: {
        readonly commandId: IdempotencyKey;
        readonly payload: SubmitApplicationRequest;
      };
    }
  | {
      readonly ok: false;
      readonly commandId: string;
      readonly error: PublicApplicationErrorView;
    };

const expectedFieldNames: Readonly<Record<ApplicantFieldName, true>> = {
  commandId: true,
  departmentId: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  gender: true,
  fieldOfStudyId: true,
  yearOfStudy: true,
};

function readStrictRecord(formData: FormData): Record<string, string> | undefined {
  const record: Record<string, string> = {};

  for (const [name, value] of formData.entries()) {
    if (
      !Object.hasOwn(expectedFieldNames, name) ||
      typeof value !== "string" ||
      Object.hasOwn(record, name)
    ) {
      return undefined;
    }
    record[name] = value.trim();
  }

  return Object.keys(record).length === applicantFieldNames.length ? record : undefined;
}

function safeCommandId(formData: FormData): string {
  const values = formData.getAll("commandId");
  if (values.length !== 1 || typeof values[0] !== "string") return "";
  const commandId = values[0].trim();
  return commandId.length <= 200 ? commandId : "";
}

function requiredFieldErrors(
  record: Readonly<Record<string, string>> | undefined,
): Partial<Record<ApplicantFieldName, string>> {
  if (record === undefined) {
    return {
      commandId: "Start innsendingen på nytt.",
    };
  }

  const errors: Partial<Record<ApplicantFieldName, string>> = {};
  const requiredLabels: ReadonlyArray<readonly [ApplicantFieldName, string]> = [
    ["departmentId", "Velg en avdeling."],
    ["firstName", "Skriv inn fornavn."],
    ["lastName", "Skriv inn etternavn."],
    ["phone", "Skriv inn telefonnummer."],
    ["email", "Skriv inn e-postadresse."],
    ["gender", "Velg kjønn."],
    ["fieldOfStudyId", "Velg studieretning."],
    ["yearOfStudy", "Velg studieår."],
  ];

  for (const [name, message] of requiredLabels) {
    if (!record[name]) errors[name] = message;
  }
  if (!record.commandId) errors.commandId = "Start innsendingen på nytt.";

  return errors;
}

export function parsePublicApplicationForm(formData: FormData): ParsedPublicApplicationForm {
  const record = readStrictRecord(formData);

  try {
    const decoded = Schema.decodeUnknownSync(ApplicantFormRecord)(record, {
      onExcessProperty: "error",
    });
    const commandId = Schema.decodeUnknownSync(IdempotencyKey)(decoded.commandId);
    const payload = Schema.decodeUnknownSync(SubmitApplicationRequest)(
      {
        departmentId: decoded.departmentId,
        firstName: decoded.firstName,
        lastName: decoded.lastName,
        phone: decoded.phone,
        email: decoded.email,
        gender: decoded.gender === "0" ? 0 : 1,
        fieldOfStudyId: decoded.fieldOfStudyId,
        yearOfStudy: Number(decoded.yearOfStudy),
      },
      { onExcessProperty: "error" },
    );
    return { ok: true, value: { commandId, payload } };
  } catch {
    const commandId = safeCommandId(formData);
    return {
      ok: false,
      commandId,
      error: {
        _tag: "ApplicationFormInvalid",
        message: "Kontroller at alle obligatoriske felt er riktig utfylt.",
        fieldErrors: requiredFieldErrors(record),
        resetCommandId: commandId === "",
      },
    };
  }
}

type ErrorShape = {
  readonly code?: unknown;
  readonly type?: unknown;
  readonly validation?: unknown;
};

const problemMessages: Readonly<
  Record<
    Exclude<
      PublicApplicationErrorCode,
      "ApplicationFormInvalid" | "Network" | "Configuration" | "Unexpected"
    >,
    string
  >
> = {
  "validation.failed": "Kontroller at alle obligatoriske felt er riktig utfylt.",
  "request.malformed": "Søknaden kunne ikke leses. Kontroller feltene og prøv igjen.",
  "media-type.unsupported": "Søknaden kunne ikke sendes i riktig format. Prøv igjen.",
  "application.no-eligible-period":
    "Opptaket ble stengt før søknaden ble sendt. Oppdater siden for å se gjeldende opptak.",
  "application.ambiguous-period":
    "Søknaden kunne ikke knyttes til ett opptak. Oppdater siden og prøv igjen.",
  "application.invalid-field-of-study":
    "Studieretningen er ikke tilgjengelig for valgt avdeling. Velg studieretning på nytt.",
  "application.duplicate": "Du har allerede sendt en søknad i denne opptaksperioden.",
  "idempotency-key.invalid": "Innsendingen er utløpt. Start innsendingen på nytt.",
  "idempotency.in-flight": "Søknaden sendes allerede. Vent litt før du prøver igjen.",
  "idempotency.digest-conflict": "Innsendingen ble endret underveis. Start innsendingen på nytt.",
  "idempotency.response-expired":
    "Bekreftelsen for innsendingen er utløpt. Start innsendingen på nytt.",
  "idempotency.unavailable": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
  "rate-limit.exceeded": "Det er sendt for mange forespørsler. Vent litt før du prøver igjen.",
  "request.too-large": "Søknaden inneholder mer data enn tjenesten kan ta imot.",
  "dependency.unavailable": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
  "internal.error": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
};

const applicationFieldByPointer: Readonly<Record<string, ApplicantFieldName>> = {
  "/departmentId": "departmentId",
  "/firstName": "firstName",
  "/lastName": "lastName",
  "/phone": "phone",
  "/email": "email",
  "/gender": "gender",
  "/fieldOfStudyId": "fieldOfStudyId",
  "/yearOfStudy": "yearOfStudy",
};

function validationFieldErrors(
  validation: unknown,
): Partial<Record<ApplicantFieldName, string>> | undefined {
  if (
    typeof validation !== "object" ||
    validation === null ||
    !("errors" in validation) ||
    !Array.isArray(validation.errors)
  ) {
    return undefined;
  }

  const fieldErrors: Partial<Record<ApplicantFieldName, string>> = {};
  for (const error of validation.errors) {
    if (
      typeof error === "object" &&
      error !== null &&
      "pointer" in error &&
      typeof error.pointer === "string"
    ) {
      const field = applicationFieldByPointer[error.pointer];
      if (field !== undefined) fieldErrors[field] = "Kontroller dette feltet.";
    }
  }
  return Object.keys(fieldErrors).length === 0 ? undefined : fieldErrors;
}

function isProblemCode(code: unknown): code is keyof typeof problemMessages {
  return typeof code === "string" && Object.hasOwn(problemMessages, code);
}

export function mapPublicApplicationError(error: unknown): PublicApplicationErrorView {
  const shape: ErrorShape = typeof error === "object" && error !== null ? error : {};

  if (isProblemCode(shape.code)) {
    const resetCommandId =
      shape.code === "idempotency-key.invalid" ||
      shape.code === "idempotency.digest-conflict" ||
      shape.code === "idempotency.response-expired";
    const fieldErrors =
      shape.code === "validation.failed" ? validationFieldErrors(shape.validation) : undefined;
    return {
      _tag: shape.code,
      message: problemMessages[shape.code],
      ...(fieldErrors === undefined ? {} : { fieldErrors }),
      ...(resetCommandId ? { resetCommandId: true } : {}),
    };
  }

  if (shape.type === "network") {
    return {
      _tag: "Network",
      message: "Søknadstjenesten svarer ikke. Kontroller forbindelsen og prøv igjen.",
    };
  }
  if (shape.type === "configuration") {
    return {
      _tag: "Configuration",
      message: "Søknadstjenesten er ikke tilgjengelig på denne siden.",
    };
  }

  return {
    _tag: "Unexpected",
    message: "Søknaden kunne ikke sendes. Prøv igjen senere.",
  };
}
