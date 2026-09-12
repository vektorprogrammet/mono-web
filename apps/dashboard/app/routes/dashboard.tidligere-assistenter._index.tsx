import { ReturningAssistantRegistrationInputSchema } from "@vektorprogrammet/domain/application";
import { IdempotencyHeaders } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { data, useFetcher, useLoaderData } from "react-router";
import { useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import type { Route } from "./+types/dashboard.tidligere-assistenter._index";

const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "private, no-store" } });

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  try {
    const result = await client.admissions.readReturningAssistantOptions();
    return privateData({ options: result.body, error: null as string | null });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);
    const causeDetail = cause instanceof Error ? cause.message : JSON.stringify(cause);
    console.error(`returning options loader failed: ${problem?.code ?? "unknown"} ${causeDetail}`);
    const messages: Record<string, string> = {
      "returning.identity-missing": "Fant ikke en koblet søkersidentitet for kontoen.",
      "returning.history-missing": "Fant ingen tidligere assistentplassering for kontoen.",
      "returning.identity-ambiguous": "Kontoen har flere søkere. Kontakt koordinator.",
      "returning.study-invalid": "Studiet ditt kan ikke kobles til en aktiv avdeling.",
      "returning.period-unavailable": "Det finnes ingen åpen opptaksperiode for avdelingen din.",
      "authority.denied": "Du har ikke tilgang til denne funksjonen.",
    };
    return privateData({
      options: null,
      error: messages[problem?.code ?? ""] ?? "Alternativene kunne ikke lastes. Prøv igjen.",
    });
  }
}

const boolField = (form: FormData, name: string) => form.get(name) === "true";

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  const commandId = String(form.get("commandId") || crypto.randomUUID());
  try {
    const payload = Schema.decodeUnknownSync(ReturningAssistantRegistrationInputSchema)({
      commandId,
      admissionPeriodId: form.get("admissionPeriodId"),
      expectedRevision: Number(form.get("expectedRevision")),
      yearOfStudy: Number(form.get("yearOfStudy")),
      mondayUnavailable: boolField(form, "mondayUnavailable"),
      tuesdayUnavailable: boolField(form, "tuesdayUnavailable"),
      wednesdayUnavailable: boolField(form, "wednesdayUnavailable"),
      thursdayUnavailable: boolField(form, "thursdayUnavailable"),
      fridayUnavailable: boolField(form, "fridayUnavailable"),
      positionWeeks: Number(form.get("positionWeeks")),
      preferredGroup: form.get("preferredGroup"),
      language: form.get("language"),
      preferredSchool: form.get("preferredSchool") || null,
      teamInterest: boolField(form, "teamInterest"),
      teamIds: form.getAll("teamIds"),
    });
    const result = await client.admissions.registerReturningAssistant({
      headers: Schema.decodeUnknownSync(IdempotencyHeaders)({ "idempotency-key": commandId }),
      payload,
    });
    return privateData({
      success: true as const,
      message: "Registreringen er lagret.",
      commandId,
      revision: result.body.observation.revision,
    });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);
    const messages: Record<string, string> = {
      "returning.team-scope-denied": "Velg bare team i din nåværende avdeling.",
      "returning.revision-conflict": "Alternativene er endret. Last siden på nytt før du prøver igjen.",
      "returning.period-unavailable": "Opptaksperioden er ikke lenger åpen.",
      "returning.identity-missing": "Fant ikke en koblet søker for kontoen.",
      "returning.history-missing": "Fant ingen tidligere assistentplassering for kontoen.",
      "idempotency.digest-conflict": "Denne kommandoen er allerede brukt med andre verdier.",
    };
    return privateData({
      success: false as const,
      message: messages[problem?.code ?? ""] ?? "Registreringen kunne ikke lagres. Kontroller feltene.",
      commandId,
      code: problem?.code ?? null,
    }, problem?.status ?? 422);
  }
}

const languages = ["Norsk", "Engelsk", "Norsk og engelsk"] as const;
const groups = ["all", "block-1", "block-2"] as const;

export default function TidligereAssistenter() {
  const { options, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [selectedPeriodId, setSelectedPeriodId] = useState(options?.periods[0]?.period.id ?? "");
  const selectedPeriod = options?.periods.find(({ period }) => period.id === selectedPeriodId)
    ?? options?.periods[0];
  const current = selectedPeriod?.currentPreferences ?? null;
  const currentRevision = selectedPeriod?.currentRevision ?? 0;
  const selectedId = selectedPeriod?.period.id ?? "";
  const [draftRevision, setDraftRevision] = useState(currentRevision);
  const [commandId, setCommandId] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  const [acceptedCommandId, setAcceptedCommandId] = useState("");
  if (fetcher.data?.success === true && fetcher.data.commandId !== acceptedCommandId) {
    setAcceptedCommandId(fetcher.data.commandId);
    setDraftRevision(fetcher.data.revision);
    setCommandId("");
    setCommandDraft("");
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy || event.currentTarget.dataset.pending === "true") {
      event.preventDefault();
      return;
    }
    event.currentTarget.dataset.pending = "true";
    const draft = new FormData(event.currentTarget);
    draft.delete("commandId");
    const signature = JSON.stringify([...draft]);
    const field = event.currentTarget.elements.namedItem("commandId");
    if (field instanceof HTMLInputElement && (!field.value || signature !== commandDraft)) {
      const key = crypto.randomUUID();
      field.value = key;
      setCommandId(key);
      setCommandDraft(signature);
    }
  };
  if (error || options === null) {
    return (
      <main className="space-y-4">
        <h1>Tidligere assistenter</h1>
        <p role="alert">{error ?? "Alternativene kunne ikke lastes."}</p>
      </main>
    );
  }
  return (
    <main className="max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1>Tidligere assistenter</h1>
        <p>
          Du er registrert som tidligere assistent. Velg opptaksperiode og oppgi tilgjengelighet
          og ønsker for neste semester.
        </p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="font-medium">Avdeling</dt><dd>{options.departmentId}</dd></div>
          <div><dt className="font-medium">Studium</dt><dd>{options.fieldOfStudyId}</dd></div>
        </dl>
      </header>
      <fetcher.Form key={selectedId} method="post" onSubmit={onSubmit} data-pending={busy ? "true" : "false"} className="space-y-6" aria-label="Registrer som tidligere assistent">
        <input type="hidden" name="commandId" value={commandId} readOnly />
        <input type="hidden" name="expectedRevision" value={draftRevision} readOnly />
        <fieldset disabled={busy} className="space-y-4">
          <legend className="text-lg font-semibold">Opptak og studie</legend>
          <label className="block">Opptaksperiode
            <select
              name="admissionPeriodId"
              required
              value={selectedId}
              onChange={(event) => {
                const nextPeriodId = event.currentTarget.value;
                setSelectedPeriodId(nextPeriodId);
                setDraftRevision(
                  options.periods.find(({ period }) => period.id === nextPeriodId)?.currentRevision ?? 0,
                );
                setCommandId("");
                setCommandDraft("");
              }}
              className="mt-1 block w-full rounded border p-2"
            >
              <option value="">Velg periode</option>
              {options.periods.map(({ period, semesterName, currentRevision: revision }) => (
                <option key={period.id} value={period.id}>
                  {semesterName} ({period.startAt}–{period.endAt}), revisjon {revision}
                </option>
              ))}
            </select>
          </label>
          {selectedPeriod === undefined && <p role="alert">Ingen åpen opptaksperiode er tilgjengelig.</p>}
          <label className="block">Studieår
            <select name="yearOfStudy" defaultValue={String(current?.yearOfStudy ?? 1)} required className="mt-1 block w-full rounded border p-2">
              {[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="text-lg font-semibold">Tilgjengelighet</legend>
          <p>Velg dagene du ikke er tilgjengelig.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              ["mondayUnavailable", "Mandag"],
              ["tuesdayUnavailable", "Tirsdag"],
              ["wednesdayUnavailable", "Onsdag"],
              ["thursdayUnavailable", "Torsdag"],
              ["fridayUnavailable", "Fredag"],
            ].map(([name, label]) => (
              <label key={name} className="flex gap-2">
                <input
                  type="checkbox"
                  name={name}
                  value="true"
                  defaultChecked={Boolean(current?.[name as keyof typeof current])}
                />
                {label}
              </label>
            ))}
          </div>
          <label className="block">Stillingslengde
            <select name="positionWeeks" defaultValue={String(current?.positionWeeks ?? 4)} required className="mt-1 block w-full rounded border p-2">
              <option value="4">4 uker</option><option value="8">8 uker</option>
            </select>
          </label>
          <label className="block">Semesterblokk
            <select name="preferredGroup" defaultValue={current?.preferredGroup ?? "all"} required className="mt-1 block w-full rounded border p-2">
              {groups.map((group) => <option key={group} value={group}>{group === "all" ? "Hele semesteret" : group}</option>)}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="text-lg font-semibold">Ønsker</legend>
          <label className="block">Språk
            <select name="language" defaultValue={current?.language ?? "Norsk"} required className="mt-1 block w-full rounded border p-2">
              {languages.map((language) => <option key={language} value={language}>{language}</option>)}
            </select>
          </label>
          <label className="block">Ønsket skole (valgfritt)
            <input name="preferredSchool" defaultValue={current?.preferredSchool ?? ""} className="mt-1 block w-full rounded border p-2" maxLength={255} />
          </label>
          <label className="flex gap-2">
            <input type="checkbox" name="teamInterest" value="true" defaultChecked={current?.teamInterest ?? false} />
            Jeg er interessert i teamarbeid
          </label>
          <fieldset className="space-y-2">
            <legend className="font-medium">Teamønsker</legend>
            {options.teams.length === 0 && <p>Ingen team er tilgjengelige i avdelingen.</p>}
            {options.teams.map((team) => (
              <label key={team.teamId} className="flex gap-2">
                <input type="checkbox" name="teamIds" value={team.teamId} defaultChecked={current?.teamIds.includes(team.teamId) ?? false} />
                {team.name}
              </label>
            ))}
          </fieldset>
        </fieldset>
        <Button type="submit" disabled={busy}>{busy ? "Lagrer …" : current === null ? "Registrer for semesteret" : "Lagre endringer"}</Button>
        {fetcher.data && <p role={fetcher.data.success ? "status" : "alert"}>{fetcher.data.message}</p>}
        {fetcher.data?.success === false && fetcher.data.code === "returning.revision-conflict" && (
          <Button type="button" onClick={() => window.location.reload()}>
            Last inn siste alternativer
          </Button>
        )}
      </fetcher.Form>
    </main>
  );
}
