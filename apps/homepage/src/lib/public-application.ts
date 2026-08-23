import type {
  PublicApplicationCatalog,
  PublicApplicationSubmitInput,
} from "@vektorprogrammet/sdk";
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
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength)),
  );

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
  | "PublicApplicationDecodeError"
  | "NoEligibleAdmissionPeriod"
  | "DepartmentNotFound"
  | "FieldOfStudyNotFound"
  | "FieldOfStudyInactive"
  | "FieldOfStudyDepartmentMismatch"
  | "DuplicatePublicApplication"
  | "DuplicatePublicApplicationCommandConflict"
  | "PublicApplicationNotFound"
  | "PublicApplicationPersistenceError"
  | "RequestBodyTooLarge"
  | "PublicApplicationRateLimitExceeded"
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
      readonly value: PublicApplicationSubmitInput;
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

  return Object.keys(record).length === applicantFieldNames.length
    ? record
    : undefined;
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
  const requiredLabels: ReadonlyArray<
    readonly [ApplicantFieldName, string]
  > = [
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

export function parsePublicApplicationForm(
  formData: FormData,
): ParsedPublicApplicationForm {
  const record = readStrictRecord(formData);
  let decoded: ApplicantFormRecord;

  try {
    decoded = Schema.decodeUnknownSync(ApplicantFormRecord)(record, {
      onExcessProperty: "error",
    });
  } catch {
    return {
      ok: false,
      commandId: safeCommandId(formData),
      error: {
        _tag: "ApplicationFormInvalid",
        message: "Kontroller at alle obligatoriske felt er riktig utfylt.",
        fieldErrors: requiredFieldErrors(record),
        resetCommandId: safeCommandId(formData) === "",
      },
    };
  }

  return {
    ok: true,
    value: {
      commandId: decoded.commandId,
      departmentId: decoded.departmentId,
      firstName: decoded.firstName,
      lastName: decoded.lastName,
      phone: decoded.phone,
      email: decoded.email,
      gender: decoded.gender === "0" ? 0 : 1,
      fieldOfStudyId: decoded.fieldOfStudyId,
      yearOfStudy: Number(decoded.yearOfStudy) as 1 | 2 | 3 | 4 | 5,
    },
  };
}

type ErrorShape = {
  readonly _tag?: unknown;
  readonly type?: unknown;
};


const domainMessages: Readonly<
  Record<
    Exclude<
      PublicApplicationErrorCode,
      "ApplicationFormInvalid" | "Network" | "Configuration" | "Unexpected"
    >,
    string
  >
> = {
  PublicApplicationDecodeError:
    "Kontroller at alle obligatoriske felt er riktig utfylt.",
  NoEligibleAdmissionPeriod:
    "Opptaket ble stengt før søknaden ble sendt. Oppdater siden for å se gjeldende opptak.",
  DepartmentNotFound:
    "Avdelingen er ikke tilgjengelig. Oppdater siden og velg på nytt.",
  FieldOfStudyNotFound:
    "Studieretningen er ikke tilgjengelig. Velg en annen studieretning.",
  FieldOfStudyInactive:
    "Studieretningen er ikke tilgjengelig. Velg en annen studieretning.",
  FieldOfStudyDepartmentMismatch:
    "Studieretningen tilhører ikke valgt avdeling. Velg studieretning på nytt.",
  DuplicatePublicApplication:
    "Du har allerede sendt en søknad i denne opptaksperioden.",
  DuplicatePublicApplicationCommandConflict:
    "Innsendingen ble endret underveis. Prøv å sende søknaden på nytt.",
  PublicApplicationNotFound:
    "Vi kunne ikke bekrefte søknadsreferansen akkurat nå. Prøv igjen.",
  PublicApplicationPersistenceError:
    "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
  RequestBodyTooLarge:
    "Søknaden inneholder mer data enn tjenesten kan ta imot.",
  PublicApplicationRateLimitExceeded:
    "Det er sendt for mange forespørsler. Vent litt før du prøver igjen.",
};

function isDomainErrorCode(value: unknown): value is keyof typeof domainMessages {
  return typeof value === "string" && Object.hasOwn(domainMessages, value);
}

export function mapPublicApplicationError(
  error: unknown,
): PublicApplicationErrorView {
  const shape: ErrorShape =
    typeof error === "object" && error !== null ? error : {};

  if (isDomainErrorCode(shape._tag)) {
    return {
      _tag: shape._tag,
      message: domainMessages[shape._tag],
      ...(shape._tag === "DuplicatePublicApplicationCommandConflict"
        ? { resetCommandId: true }
        : {}),
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
  if (shape.type === "validation") {
    return {
      _tag: "PublicApplicationDecodeError",
      message: domainMessages.PublicApplicationDecodeError,
    };
  }
  if (shape.type === "rate_limited") {
    return {
      _tag: "PublicApplicationRateLimitExceeded",
      message: domainMessages.PublicApplicationRateLimitExceeded,
    };
  }

  return {
    _tag: "Unexpected",
    message: "Søknaden kunne ikke sendes. Prøv igjen senere.",
  };
}
