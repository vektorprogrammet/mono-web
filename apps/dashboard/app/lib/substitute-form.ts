import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { SubstituteMutation } from "@vektorprogrammet/domain/substitutes";
import { IdempotencyKey, StrongETag } from "@vektorprogrammet/http-api";
import { Schema } from "effect";

export const weekdays = [
  ["monday", "Mandag"],
  ["tuesday", "Tirsdag"],
  ["wednesday", "Onsdag"],
  ["thursday", "Torsdag"],
  ["friday", "Fredag"],
] as const;
export const languages = [
  ["Norwegian", "Norsk"],
  ["English", "Engelsk"],
  ["NorwegianAndEnglish", "Norsk og engelsk"],
] as const;
const text = (form: FormData, key: string): string => {
  const values = form.getAll(key);
  if (values.length !== 1 || typeof values[0] !== "string") throw new Error("Invalid field");
  return values[0];
};
export function parseSubstituteForm(form: FormData) {
  const intent = Schema.decodeUnknownSync(Schema.Literals(["activate", "edit", "deactivate"]))(
    text(form, "intent"),
  );
  const params = {
    applicationId: Schema.decodeUnknownSync(PublicApplicationIdSchema)(text(form, "applicationId")),
  };
  const headers = {
    "idempotency-key": Schema.decodeUnknownSync(IdempotencyKey)(text(form, "commandId")),
    "if-match": Schema.decodeUnknownSync(StrongETag)(text(form, "etag")),
  };
  if (intent === "deactivate") return { intent, params, headers } as const;
  const declared = Object.fromEntries(
    weekdays.map(([key]) => {
      const value = text(form, key);
      if (value !== "true" && value !== "false") throw new Error("Availability must be explicit");
      return [key, value === "true"];
    }),
  );
  const payload = Schema.decodeUnknownSync(SubstituteMutation)({
    ...declared,
    language: text(form, "language"),
    yearOfStudy: Number(text(form, "yearOfStudy")),
  });
  return { intent, params, headers, payload } as const;
}
export function substituteFailure(error: unknown): { message: string; conflict: boolean } {
  const code =
    error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "authority.denied")
    return {
      message: "Du har ikke tilgang til denne vikaroversikten eller endringen.",
      conflict: false,
    };
  if (
    code === "precondition.failed" ||
    code === "transaction.conflict" ||
    code === "idempotency.digest-conflict"
  )
    return {
      message:
        "Opplysningene er endret siden du åpnet skjemaet. Utkastet ditt er beholdt. Hent siste versjon og kontroller opplysningene før du prøver igjen.",
      conflict: true,
    };
  if (code === "scope.invalid" || code === "validation.failed")
    return {
      message: "Kontroller avdeling, semester og alle opplysningene i skjemaet.",
      conflict: false,
    };
  if (code === "substitute.already-active" || code === "substitute.inactive")
    return {
      message: "Vikarstatusen er endret. Last oversikten på nytt før du fortsetter.",
      conflict: true,
    };
  return {
    message:
      "Tjenesten er ikke tilgjengelig akkurat nå. Ingen endring er bekreftet. Utkastet ditt er beholdt; prøv igjen.",
    conflict: false,
  };
}

export function substituteSemesterLabel(semester: { startAt: string; endAt: string }): string {
  const format = new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Oslo",
  });
  return `${format.format(new Date(semester.startAt))} – ${format.format(new Date(semester.endAt))}`;
}
