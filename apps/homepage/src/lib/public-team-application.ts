import { HttpClientError } from "effect/unstable/http";
import {
  IdempotencyKey,
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

/** The codes of the contract's TeamApplicationsSubmitProblem union; its schema type names every native code. */
type TeamApplicationProblemCode =
  | "request.malformed"
  | "header.malformed"
  | "idempotency-key.invalid"
  | "resource.not-found"
  | "idempotency.in-flight"
  | "idempotency.digest-conflict"
  | "idempotency.response-expired"
  | "team-application.intake-closed"
  | "transaction.conflict"
  | "request.too-large"
  | "media-type.unsupported"
  | "validation.failed"
  | "internal.error"
  | "dependency.unavailable"
  | "idempotency.unavailable";

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
    readonly resetCommandId: boolean;
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

export type PublicTeamApplicationActionData =
  | {
      readonly outcome: "received";
      readonly confirmation: {
        readonly applicationId: string;
        readonly submittedAt: TeamApplicationInstant;
        readonly teamName: string | undefined;
      };
    }
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
        resetCommandId: Option.isNone(commandId),
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
  const problem = decodeIntakeProblem(Predicate.hasProperty(cause, "body") ? cause.body : cause);

  return Option.isSome(problem) && problem.value.code === "resource.not-found"
    ? { state: "not-found" }
    : {
        state: "unavailable",
        message: "Vi fikk ikke hentet søknadsskjemaet akkurat nå. Prøv igjen om litt.",
      };
}

const problemMessages: Readonly<Record<TeamApplicationProblemCode, string>> = {
  "request.malformed": "Søknaden kunne ikke leses. Kontroller feltene og send søknaden på nytt.",
  "header.malformed": "Søknaden kunne ikke sendes i riktig format. Prøv igjen.",
  "idempotency-key.invalid": "Innsendingen kunne ikke identifiseres. Send søknaden på nytt.",
  "resource.not-found": "Fant ikke teamet. Søknaden ble ikke lagret.",
  "idempotency.in-flight": "Søknaden behandles allerede. Vent litt før du prøver igjen.",
  "idempotency.digest-conflict":
    "Innsendingen ble endret underveis. Kontroller feltene og send søknaden på nytt.",
  "idempotency.response-expired": "Bekreftelsen for innsendingen er utløpt. Send søknaden på nytt.",
  "team-application.intake-closed":
    "Teamet tok ikke lenger imot søknader da du sendte. Søknaden ble ikke lagret.",
  "transaction.conflict": "Søknaden kunne ikke lagres akkurat nå. Prøv igjen.",
  "request.too-large":
    "Søknaden inneholder mer tekst enn tjenesten kan ta imot. Kort ned teksten og prøv igjen.",
  "media-type.unsupported": "Søknaden kunne ikke sendes i riktig format. Prøv igjen.",
  "validation.failed": "Kontroller feltene som er markert, og send søknaden på nytt.",
  "internal.error": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
  "dependency.unavailable": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
  "idempotency.unavailable": "Søknadstjenesten er midlertidig utilgjengelig. Prøv igjen senere.",
};

function isTeamApplicationProblemCode(code: string): code is TeamApplicationProblemCode {
  return Object.hasOwn(problemMessages, code);
}

/** These conflicts bind the key to another request or an expired result, so a retry needs a new key. */
const commandIdResetCodes: Readonly<Partial<Record<TeamApplicationProblemCode, true>>> = {
  "idempotency-key.invalid": true,
  "idempotency.digest-conflict": true,
  "idempotency.response-expired": true,
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

const unexpectedFailure = PublicTeamApplicationErrorView.Unexpected({
  message: "Søknaden kunne ikke sendes. Prøv igjen senere.",
  status: 500,
  fieldErrors: {},
  resetCommandId: false,
});

export function mapPublicTeamApplicationError(cause: unknown): PublicTeamApplicationErrorView {
  // The SDK keeps response headers around each canonical problem body.
  const problem = Option.getOrUndefined(
    decodeSubmitProblem(Predicate.hasProperty(cause, "body") ? cause.body : cause),
  );

  if (problem !== undefined && isTeamApplicationProblemCode(problem.code)) {
    return PublicTeamApplicationErrorView[problem.code]({
      message: problemMessages[problem.code],
      status: problem.status,
      fieldErrors: validationFieldErrors(problem),
      resetCommandId: commandIdResetCodes[problem.code] === true,
    });
  }

  if (!HttpClientError.isHttpClientError(cause)) return unexpectedFailure;

  return Match.value(cause.reason).pipe(
    Match.tag("TransportError", () =>
      PublicTeamApplicationErrorView.Network({
        message: "Søknadstjenesten svarer ikke akkurat nå. Prøv igjen om litt.",
        status: 503,
        fieldErrors: {},
        resetCommandId: false,
      }),
    ),
    Match.tag("InvalidUrlError", () =>
      PublicTeamApplicationErrorView.Configuration({
        message: "Søknadstjenesten er ikke tilgjengelig på denne siden.",
        status: 500,
        fieldErrors: {},
        resetCommandId: false,
      }),
    ),
    Match.orElse(() => unexpectedFailure),
  );
}

/** A closed or unknown team ends the form. Other failures keep the draft and, except after an idempotency conflict, the same key. */
export function rejectPublicTeamApplication(
  submission: PublicTeamApplicationSubmission,
  cause: unknown,
): PublicTeamApplicationActionData {
  const error = mapPublicTeamApplicationError(cause);

  return Match.value(error).pipe(
    Match.tag(
      "team-application.intake-closed",
      ({ message }): PublicTeamApplicationActionData => ({ outcome: "closed", message }),
    ),
    Match.tag(
      "resource.not-found",
      (): PublicTeamApplicationActionData => ({ outcome: "not-found" }),
    ),
    Match.orElse(
      (): PublicTeamApplicationActionData => ({
        outcome: "rejected",
        failure: {
          commandId: error.resetCommandId ? newTeamApplicationCommandId() : submission.commandId,
          error,
          values: submission.payload,
        },
      }),
    ),
  );
}

/** The confirmation names the team when a later read finds it; it never repeats applicant data. */
export function receivedPublicTeamApplication(
  submitted: SubmittedTeamApplication,
  teamName: string | undefined,
): PublicTeamApplicationActionData {
  return {
    outcome: "received",
    confirmation: {
      applicationId: submitted.applicationId,
      submittedAt: osloInstant(submitted.submittedAt),
      teamName,
    },
  };
}
