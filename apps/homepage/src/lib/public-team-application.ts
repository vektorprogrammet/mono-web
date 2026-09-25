import { HttpClientError } from "effect/unstable/http";
import {
  IdempotencyKey,
  isProblem,
  problemBody,
  PublicTeamApplicationIntake,
  TeamApplicationInput,
  TeamApplicationsReadIntakeProblem,
  TeamApplicationsSubmitProblem,
} from "@vektorprogrammet/http-api";
import { Data, Match, Option, Predicate, Schema, Struct } from "effect";
import type {
  HomepageTeamApplicationIntake,
  SubmittedTeamApplication,
  TeamApplicationPayload,
} from "./api-types";

export type TeamApplicationFieldName = keyof TeamApplicationPayload;

export type TeamApplicationFieldValues = Readonly<Record<TeamApplicationFieldName, string>>;

export type TeamApplicationFieldErrors = Readonly<
  Partial<Record<TeamApplicationFieldName, string>>
>;

/** Field bounds and choices sent by the loader, so the browser bundle never imports the contract. */
export type TeamApplicationFormRules = {
  readonly maxLength: Readonly<Record<TeamApplicationFieldName, number>>;
  readonly yearsOfStudy: ReadonlyArray<string>;
};

/** An instant with its Europe/Oslo label. The server formats it once, so hydration shows the same text. */
export type TeamApplicationInstant = {
  readonly at: string;
  readonly label: string;
};

export type TeamApplicationTeam = Pick<
  HomepageTeamApplicationIntake,
  "teamName" | "departmentName"
> & {
  readonly deadline: TeamApplicationInstant | null;
};

type TeamApplicationProblem = typeof TeamApplicationsSubmitProblem.Type;

/** The codes of the contract's TeamApplicationsSubmitProblem union. */
type TeamApplicationProblemCode = TeamApplicationProblem["code"];

export type PublicTeamApplicationErrorCode =
  | TeamApplicationProblemCode
  | "TeamApplicationFormInvalid"
  | "Network"
  | "Configuration"
  | "Unexpected";

export type PublicTeamApplicationErrorView = Data.TaggedEnum<{
  [Code in PublicTeamApplicationErrorCode]: {
    readonly message: string;
    /** Status of the homepage response that reports this failure. */
    readonly status: number;
    readonly fieldErrors: TeamApplicationFieldErrors;
  };
}>;

const PublicTeamApplicationErrorView = Data.taggedEnum<PublicTeamApplicationErrorView>();

export type PublicTeamApplicationLoaderData =
  | {
      readonly state: "open";
      readonly team: TeamApplicationTeam;
      readonly commandId: string;
      readonly rules: TeamApplicationFormRules;
    }
  | { readonly state: "closed"; readonly team: TeamApplicationTeam }
  | { readonly state: "not-found" }
  | { readonly state: "unavailable"; readonly message: string };

export type PublicTeamApplicationFailure = {
  readonly commandId: string;
  readonly error: PublicTeamApplicationErrorView;
  /** The submitted field text, returned so a retry without JavaScript keeps the draft. */
  readonly values: TeamApplicationFieldValues;
};

/** The stored application as its confirmation names it. */
export type TeamApplicationReceipt = {
  readonly applicationId: string;
  readonly submittedAt: TeamApplicationInstant;
};

export type ReceivedPublicTeamApplication = {
  readonly outcome: "received";
  /** Null when this exact submission was stored earlier and its stored response has expired. */
  readonly receipt: TeamApplicationReceipt | null;
  /** Set when a read after the submission finds the team. */
  readonly teamName?: string;
};

export type PublicTeamApplicationActionData =
  | ReceivedPublicTeamApplication
  | { readonly outcome: "closed"; readonly message: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "rejected"; readonly failure: PublicTeamApplicationFailure };

export type PublicTeamApplicationSubmission = {
  readonly commandId: IdempotencyKey;
  readonly payload: TeamApplicationPayload;
};

export type ParsedPublicTeamApplicationForm =
  | { readonly ok: true; readonly value: PublicTeamApplicationSubmission }
  | { readonly ok: false; readonly failure: PublicTeamApplicationFailure };

/** Decodes the route segment as the contract's team identity. Any other segment names no team. */
export const decodeTeamApplicationTeamId = Schema.decodeUnknownOption(
  PublicTeamApplicationIntake.fields.teamId,
);

const teamApplicationFieldNames = Struct.keys(TeamApplicationInput.fields);

const formMemberNames: Readonly<Record<"commandId" | TeamApplicationFieldName, true>> = {
  commandId: true,
  ...fieldRecord((): true => true),
};

/** The legacy form offered these years of study and stored the chosen text. */
const yearsOfStudy: ReadonlyArray<string> = [
  "1. klasse",
  "2. klasse",
  "3. klasse",
  "4. klasse",
  "5. klasse",
];

/** Builds one value per applicant field. The return type keeps the field list complete. */
function fieldRecord<A>(
  valueOf: (field: TeamApplicationFieldName) => A,
): Readonly<Record<TeamApplicationFieldName, A>> {
  return {
    name: valueOf("name"),
    email: valueOf("email"),
    phone: valueOf("phone"),
    yearOfStudy: valueOf("yearOfStudy"),
    fieldOfStudy: valueOf("fieldOfStudy"),
    biography: valueOf("biography"),
    motivation: valueOf("motivation"),
  };
}

const JsonSchemaMaxLength = Schema.Struct({ maxLength: Schema.Int });

const teamApplicationFormRules: TeamApplicationFormRules = {
  // The JSON Schema projection of each contract field carries its length check.
  maxLength: fieldRecord(
    (field) =>
      Schema.decodeUnknownSync(JsonSchemaMaxLength)(
        Schema.toJsonSchemaDocument(TeamApplicationInput.fields[field]).schema,
      ).maxLength,
  ),
  yearsOfStudy,
};

const fieldCopy: Readonly<
  Record<TeamApplicationFieldName, { readonly subject: string; readonly missing: string }>
> = {
  name: { subject: "Navnet", missing: "Skriv inn navnet ditt." },
  email: { subject: "E-postadressen", missing: "Skriv inn e-postadressen din." },
  phone: { subject: "Telefonnummeret", missing: "Skriv inn telefonnummeret ditt." },
  yearOfStudy: { subject: "Årstrinnet", missing: "Velg årstrinn." },
  fieldOfStudy: { subject: "Linjen", missing: "Skriv inn linjen du går på." },
  biography: { subject: "Teksten om deg selv", missing: "Skriv litt om deg selv." },
  motivation: {
    subject: "Motivasjonsteksten",
    missing: "Skriv kort om motivasjonen din for vervet.",
  },
};

const lengthFormat = new Intl.NumberFormat("nb-NO");

const osloInstantFormat = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

/** Labels a contract instant in Norwegian time for visitors. */
function osloInstant(at: string): TeamApplicationInstant {
  return { at, label: osloInstantFormat.format(new Date(at)) };
}

/** A fresh key for one rendered form. A UUID fits the unpadded base64url key alphabet. */
function newTeamApplicationCommandId(): IdempotencyKey {
  return IdempotencyKey.make(globalThis.crypto.randomUUID());
}

/** The trimmed text of a member that occurs exactly once. Anything else reads as empty. */
function memberText(formData: FormData, name: string): string {
  const values = formData.getAll(name);
  const [value] = values;

  return values.length === 1 && Predicate.isString(value) ? value.trim() : "";
}

/** The rendered form sends each expected member once, as text, and nothing else. */
function hasExactMembers(formData: FormData): boolean {
  const seen = new Set<string>();

  for (const [name, value] of formData.entries()) {
    if (!Object.hasOwn(formMemberNames, name) || !Predicate.isString(value) || seen.has(name)) {
      return false;
    }

    seen.add(name);
  }

  return seen.size === Object.keys(formMemberNames).length;
}

/** Chooses the message for one field; the contract schema decides validity. */
function fieldError(field: TeamApplicationFieldName, value: string): string | undefined {
  const maxLength = teamApplicationFormRules.maxLength[field];

  if (value.length === 0) return fieldCopy[field].missing;

  if (value.length > maxLength) {
    return `${fieldCopy[field].subject} kan ha høyst ${lengthFormat.format(maxLength)} tegn.`;
  }

  if (field === "yearOfStudy" && !yearsOfStudy.includes(value)) {
    return "Velg et av årstrinnene i listen.";
  }

  if (Schema.is(TeamApplicationInput.fields[field])(value)) return undefined;

  return field === "email"
    ? "Skriv inn en gyldig e-postadresse."
    : "Feltet inneholder tegn som ikke er tillatt.";
}

export function parsePublicTeamApplicationForm(
  formData: FormData,
): ParsedPublicTeamApplicationForm {
  const values = fieldRecord((field) => memberText(formData, field));
  const commandId = Schema.decodeUnknownOption(IdempotencyKey)(memberText(formData, "commandId"));
  const fieldErrors: Partial<Record<TeamApplicationFieldName, string>> = {};

  for (const field of teamApplicationFieldNames) {
    const message = fieldError(field, values[field]);

    if (message !== undefined) fieldErrors[field] = message;
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  const payload = Schema.decodeUnknownOption(TeamApplicationInput)(values, {
    onExcessProperty: "error",
  });

  if (
    hasExactMembers(formData) &&
    !hasFieldErrors &&
    Option.isSome(commandId) &&
    Option.isSome(payload)
  ) {
    return { ok: true, value: { commandId: commandId.value, payload: payload.value } };
  }

  return {
    ok: false,
    failure: {
      // Without JavaScript the browser cannot mint a key, so a lost key is replaced here.
      commandId: Option.getOrElse(commandId, newTeamApplicationCommandId),
      error: PublicTeamApplicationErrorView.TeamApplicationFormInvalid({
        message: hasFieldErrors
          ? "Kontroller feltene som er markert, og send søknaden på nytt."
          : "Skjemaet kunne ikke leses. Send søknaden på nytt.",
        status: hasFieldErrors ? 422 : 400,
        fieldErrors,
      }),
      values: fieldRecord((field) =>
        values[field].slice(0, teamApplicationFormRules.maxLength[field]),
      ),
    },
  };
}

/** Only an open intake renders a form, so only an open intake receives a fresh key. */
export function publicTeamApplicationPage(
  intake: HomepageTeamApplicationIntake,
): PublicTeamApplicationLoaderData {
  const team: TeamApplicationTeam = {
    teamName: intake.teamName,
    departmentName: intake.departmentName,
    deadline: intake.deadline === null ? null : osloInstant(intake.deadline),
  };

  return intake.open
    ? {
        state: "open",
        team,
        commandId: newTeamApplicationCommandId(),
        rules: teamApplicationFormRules,
      }
    : { state: "closed", team };
}

const decodeIntakeProblem = Schema.decodeUnknownOption(TeamApplicationsReadIntakeProblem);

/** Unknown and inactive teams are not found. Every other read failure is a temporary outage. */
export function publicTeamApplicationPageFailure(cause: unknown): PublicTeamApplicationLoaderData {
  const problem = decodeIntakeProblem(isProblem(cause) ? problemBody(cause) : cause);

  return Option.isSome(problem) && problem.value.code === "resource.not-found"
    ? { state: "not-found" }
    : {
        state: "unavailable",
        message: "Vi fikk ikke hentet søknadsskjemaet akkurat nå. Prøv igjen om litt.",
      };
}

/** What a submit problem means for the visitor's application. */
type SubmitProblemOutcome = Data.TaggedEnum<{
  /** The intake closed before the submission, so nothing was stored. */
  Closed: { readonly message: string };
  /** The team is unknown or inactive, so nothing was stored. */
  TeamNotFound: {};
  /** This exact submission was stored earlier; only its stored response has expired. */
  AlreadyReceived: {};
  /** Nothing was stored. A retry repeats the key unless the key is bound to another request. */
  Retry: { readonly message: string; readonly newKey: boolean };
}>;

const SubmitProblemOutcome = Data.taggedEnum<SubmitProblemOutcome>();

/** A failure that stored nothing and leaves the key free for the same submission. */
function retry(message: string): SubmitProblemOutcome {
  return SubmitProblemOutcome.Retry({ message, newKey: false });
}

const unavailableMessage = "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.";

/** One outcome for each code of the contract's TeamApplicationsSubmitProblem union. */
const submitProblemOutcomes: Readonly<Record<TeamApplicationProblemCode, SubmitProblemOutcome>> = {
  "request.malformed": retry(
    "Søknaden kunne ikke leses. Kontroller feltene og send søknaden på nytt.",
  ),
  "header.malformed": retry("Søknaden kunne ikke sendes i riktig format. Prøv igjen."),
  "idempotency-key.invalid": SubmitProblemOutcome.Retry({
    message: "Innsendingen kunne ikke identifiseres. Send søknaden på nytt.",
    newKey: true,
  }),
  "resource.not-found": SubmitProblemOutcome.TeamNotFound(),
  "idempotency.in-flight": retry("Søknaden behandles allerede. Vent litt før du prøver igjen."),
  "idempotency.digest-conflict": SubmitProblemOutcome.Retry({
    message: "Innsendingen ble endret underveis. Kontroller feltene og send søknaden på nytt.",
    newKey: true,
  }),
  "idempotency.response-expired": SubmitProblemOutcome.AlreadyReceived(),
  "team-application.intake-closed": SubmitProblemOutcome.Closed({
    message: "Teamet tok ikke lenger imot søknader da du sendte. Søknaden ble ikke lagret.",
  }),
  "transaction.conflict": retry("Søknaden kunne ikke lagres akkurat nå. Prøv igjen."),
  "request.too-large": retry(
    "Søknaden inneholder mer tekst enn tjenesten kan ta imot. Kort ned teksten og prøv igjen.",
  ),
  "media-type.unsupported": retry("Søknaden kunne ikke sendes i riktig format. Prøv igjen."),
  "validation.failed": retry("Kontroller feltene som er markert, og send søknaden på nytt."),
  "internal.error": retry(unavailableMessage),
  // The limiter binds nothing to the key, so the same submission may be sent again later.
  "rate-limit.exceeded": retry(
    "Det er sendt mange søknader på kort tid. Vent litt, og send søknaden på nytt.",
  ),
  "idempotency.unavailable": retry(unavailableMessage),
};

/** Top-level JSON pointers of the contract fields, such as `/fieldOfStudy`. */
const fieldByPointer: Readonly<Partial<Record<string, TeamApplicationFieldName>>> =
  Object.fromEntries(teamApplicationFieldNames.map((field) => [`/${field}`, field]));

const decodeSubmitProblem = Schema.decodeUnknownOption(TeamApplicationsSubmitProblem);

function validationFieldErrors(problem: TeamApplicationProblem): TeamApplicationFieldErrors {
  const fieldErrors: Partial<Record<TeamApplicationFieldName, string>> = {};

  if (problem.code !== "validation.failed") return fieldErrors;

  for (const { pointer } of problem.validation.errors) {
    const field = fieldByPointer[pointer];

    if (field !== undefined) fieldErrors[field] = "Kontroller dette feltet.";
  }

  return fieldErrors;
}

/** A failure outside the contract's problems: the service was not reached, or answered otherwise. */
function transportFailure(cause: unknown): PublicTeamApplicationErrorView {
  const unexpected = PublicTeamApplicationErrorView.Unexpected({
    message: "Søknaden kunne ikke sendes. Prøv igjen senere.",
    status: 500,
    fieldErrors: {},
  });

  if (!HttpClientError.isHttpClientError(cause)) return unexpected;

  return Match.value(cause.reason).pipe(
    Match.tag("TransportError", () =>
      PublicTeamApplicationErrorView.Network({
        message: "Søknadstjenesten svarer ikke akkurat nå. Prøv igjen om litt.",
        status: 503,
        fieldErrors: {},
      }),
    ),
    Match.tag("InvalidUrlError", () =>
      PublicTeamApplicationErrorView.Configuration({
        message: "Søknadstjenesten er ikke tilgjengelig på denne siden.",
        status: 500,
        fieldErrors: {},
      }),
    ),
    Match.orElse(() => unexpected),
  );
}

/**
 * The outcome of a submission that returned no confirmation. A closed or unknown team ends the
 * form, and an expired replay of a stored submission confirms it without its reference. Every
 * other failure keeps the draft and, unless the key is bound to another request, the key.
 */
export function failedPublicTeamApplication(
  submission: PublicTeamApplicationSubmission,
  cause: unknown,
): PublicTeamApplicationActionData {
  // The SDK fails with a Problem; its body is the canonical wire problem.
  const problem = Option.getOrUndefined(
    decodeSubmitProblem(isProblem(cause) ? problemBody(cause) : cause),
  );

  const rejected = (
    error: PublicTeamApplicationErrorView,
    newKey: boolean,
  ): PublicTeamApplicationActionData => ({
    outcome: "rejected",
    failure: {
      commandId: newKey ? newTeamApplicationCommandId() : submission.commandId,
      error,
      values: submission.payload,
    },
  });

  if (problem === undefined) {
    return rejected(transportFailure(cause), false);
  }

  const code = problem.code;

  return Match.value(submitProblemOutcomes[code]).pipe(
    Match.withReturnType<PublicTeamApplicationActionData>(),
    Match.tagsExhaustive({
      Closed: ({ message }) => ({ outcome: "closed", message }),
      TeamNotFound: () => ({ outcome: "not-found" }),
      AlreadyReceived: () => ({ outcome: "received", receipt: null }),
      Retry: ({ message, newKey }) =>
        rejected(
          PublicTeamApplicationErrorView[code]({
            message,
            status: problem.status,
            fieldErrors: validationFieldErrors(problem),
          }),
          newKey,
        ),
    }),
  );
}

/** The confirmation of a stored application. It never repeats applicant data. */
export function receivedPublicTeamApplication(
  submitted: SubmittedTeamApplication,
): ReceivedPublicTeamApplication {
  return {
    outcome: "received",
    receipt: {
      applicationId: submitted.applicationId,
      submittedAt: osloInstant(submitted.submittedAt),
    },
  };
}
