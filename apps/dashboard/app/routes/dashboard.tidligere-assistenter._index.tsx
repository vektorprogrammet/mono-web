import { ReturningAssistantRegistrationInputSchema } from "@vektorprogrammet/domain/application";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { IdempotencyHeaders } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { data, useFetcher, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { useState, useSyncExternalStore, type FormEvent } from "react";
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
  const search = new URL(request.url).searchParams;
  const periodIds = search.getAll("admissionPeriodId");
  if ([...search.keys()].some((key) => key !== "admissionPeriodId") || periodIds.length > 1)
    return privateData(
      { options: null, error: "Ugyldig opptaksperiodevalg." },
      400,
    );
  const requestedPeriodId = periodIds[0];
  try {
    const result = await client.admissions.readReturningAssistantOptions();
    if (
      requestedPeriodId !== undefined &&
      !result.body.periods.some(({ period }) => period.id === requestedPeriodId)
    )
      return privateData(
        { options: null, error: "Opptaksperioden er ikke tilgjengelig." },
        400,
      );
    return privateData({ options: result.body, error: null as string | null });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);
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

const returningRegistrationRoute = "/dashboard/tidligere-assistenter";
const returningDraftStoragePrefix = "vektorprogrammet:returning-assistant-draft:";
const ReturningDraftSchema = Schema.Struct({
  personId: PersonId,
  route: Schema.Literal(returningRegistrationRoute),
  payload: ReturningAssistantRegistrationInputSchema,
  signature: Schema.String,
});
type ReturningPayload = typeof ReturningAssistantRegistrationInputSchema.Type;
type SavedReturningDraft = typeof ReturningDraftSchema.Type;
const ReturningDraftJsonSchema = Schema.fromJsonString(ReturningDraftSchema);

const returningDraftStorageKey = (personId: string, admissionPeriodId: string) =>
  `${returningDraftStoragePrefix}${personId}:${returningRegistrationRoute}:${admissionPeriodId}`;
const readReturningDrafts = (personId: string | undefined): SavedReturningDraft[] => {
  if (typeof window === "undefined" || personId === undefined) return [];
  const candidates: SavedReturningDraft[] = [];
  const storageKeyPrefix = `${returningDraftStoragePrefix}${personId}:${returningRegistrationRoute}:`;
  try {
    const storage = window.sessionStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(storageKeyPrefix)) continue;
      try {
        const value = Schema.decodeUnknownSync(ReturningDraftJsonSchema)(
          storage.getItem(key) ?? "",
          { onExcessProperty: "error" },
        );
        const admissionPeriodId = key.slice(storageKeyPrefix.length);
        if (
          value.personId === personId &&
          value.route === returningRegistrationRoute &&
          value.payload.admissionPeriodId === admissionPeriodId
        )
          candidates.push(value);
      } catch {
        // Ignore stale or malformed browser storage. It must never become form state.
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return candidates;
};

const payloadFormValues = (payload: ReturningPayload): Map<string, readonly string[]> =>
  new Map([
    ["commandId", [payload.commandId]],
    ["expectedRevision", [String(payload.expectedRevision)]],
    ["admissionPeriodId", [payload.admissionPeriodId]],
    ["yearOfStudy", [String(payload.yearOfStudy)]],
    ["mondayUnavailable", payload.mondayUnavailable ? ["true"] : []],
    ["tuesdayUnavailable", payload.tuesdayUnavailable ? ["true"] : []],
    ["wednesdayUnavailable", payload.wednesdayUnavailable ? ["true"] : []],
    ["thursdayUnavailable", payload.thursdayUnavailable ? ["true"] : []],
    ["fridayUnavailable", payload.fridayUnavailable ? ["true"] : []],
    ["positionWeeks", [String(payload.positionWeeks)]],
    ["preferredGroup", [payload.preferredGroup]],
    ["language", [payload.language]],
    ["preferredSchool", [payload.preferredSchool ?? ""]],
    ["teamInterest", payload.teamInterest ? ["true"] : []],
    ["teamIds", payload.teamIds.map(String)],
  ]);

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export default function TidligereAssistenter() {
  const { options, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  const savedDrafts = hydrated ? readReturningDrafts(options?.personId) : [];
  const savedDraft = savedDrafts.length === 1 ? savedDrafts[0] : null;
  const savedPayload = savedDraft?.payload;
  const [searchParams, setSearchParams] = useSearchParams();
  const queryPeriodId = searchParams.get("admissionPeriodId");
  const [selectionOverride, setSelectionOverride] = useState<{
    readonly value: string;
    readonly to: string | null;
  }>();
  const explicitSelection =
    selectionOverride?.to === queryPeriodId ? selectionOverride.value : undefined;
  const selectedPeriodId =
    explicitSelection ??
    savedPayload?.admissionPeriodId ??
    queryPeriodId ??
    (savedDrafts.length === 0 ? options?.periods[0]?.period.id ?? "" : "");
  const selectedPeriod = options?.periods.find(({ period }) => period.id === selectedPeriodId);
  const current = selectedPeriod?.currentPreferences ?? null;
  const currentRevision = selectedPeriod?.currentRevision ?? 0;
  const selectedId = selectedPeriod?.period.id ?? selectedPeriodId;
  const restoringDraft = savedPayload?.admissionPeriodId === selectedPeriodId;
  const savedValues = restoringDraft && savedPayload !== undefined ? payloadFormValues(savedPayload) : null;
  const restoredValue = (name: string, fallback: string) =>
    savedValues?.get(name)?.[0] ?? fallback;
  const restoredChecked = (name: string, fallback: boolean) =>
    savedValues?.get(name)?.includes("true") ?? fallback;
  const restoredIncludes = (name: string, value: string, fallback: boolean) =>
    savedValues?.get(name)?.includes(value) ?? fallback;
  const [draftRevisionOverride, setDraftRevisionOverride] = useState<number>();
  const draftRevision =
    draftRevisionOverride ?? (restoringDraft ? savedPayload?.expectedRevision ?? currentRevision : currentRevision);
  const [commandIdOverride, setCommandIdOverride] = useState<string>();
  const commandId = commandIdOverride ?? (restoringDraft ? savedPayload?.commandId ?? "" : "");
  const [commandDraftOverride, setCommandDraftOverride] = useState<string>();
  const commandDraft = commandDraftOverride ?? (restoringDraft ? savedDraft?.signature ?? "" : "");
  const [acceptedCommandId, setAcceptedCommandId] = useState("");
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  if (fetcher.data?.success === true && fetcher.data.commandId !== acceptedCommandId) {
    if (typeof window !== "undefined" && options !== null) {
      try {
        window.sessionStorage.removeItem(returningDraftStorageKey(options.personId, selectedId));
      } catch {
        setPersistenceError(
          "Registreringen er lagret, men nettleseren kunne ikke fjerne gjenopprettingsutkastet.",
        );
      }
    }
    setAcceptedCommandId(fetcher.data.commandId);
    setDraftRevisionOverride(fetcher.data.revision);
    setCommandIdOverride("");
    setCommandDraftOverride("");
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy || event.currentTarget.dataset.pending === "true") {
      event.preventDefault();
      return;
    }
    event.currentTarget.dataset.pending = "true";
    setPersistenceError(null);
    const draft = new FormData(event.currentTarget);
    draft.delete("commandId");
    const entries = [...draft].map(([name, value]) => ({ name, value: String(value) }));
    const signature = JSON.stringify(entries);
    const field = event.currentTarget.elements.namedItem("commandId");
    if (field instanceof HTMLInputElement && (!field.value || signature !== commandDraft)) {
      const key = crypto.randomUUID();
      field.value = key;
      setCommandIdOverride(key);
      setCommandDraftOverride(signature);
    }
    if (typeof window !== "undefined" && options !== null) {
      const payloadForm = new FormData(event.currentTarget);
      let payload: ReturningPayload;
      try {
        payload = Schema.decodeUnknownSync(ReturningAssistantRegistrationInputSchema)({
          commandId: String(payloadForm.get("commandId") || ""),
          admissionPeriodId: payloadForm.get("admissionPeriodId"),
          expectedRevision: Number(payloadForm.get("expectedRevision")),
          yearOfStudy: Number(payloadForm.get("yearOfStudy")),
          mondayUnavailable: boolField(payloadForm, "mondayUnavailable"),
          tuesdayUnavailable: boolField(payloadForm, "tuesdayUnavailable"),
          wednesdayUnavailable: boolField(payloadForm, "wednesdayUnavailable"),
          thursdayUnavailable: boolField(payloadForm, "thursdayUnavailable"),
          fridayUnavailable: boolField(payloadForm, "fridayUnavailable"),
          positionWeeks: Number(payloadForm.get("positionWeeks")),
          preferredGroup: payloadForm.get("preferredGroup"),
          language: payloadForm.get("language"),
          preferredSchool: payloadForm.get("preferredSchool") || null,
          teamInterest: boolField(payloadForm, "teamInterest"),
          teamIds: payloadForm.getAll("teamIds"),
        });
      } catch {
        event.preventDefault();
        event.currentTarget.dataset.pending = "false";
        setPersistenceError("Registreringen kunne ikke klargjøres. Kontroller feltene og prøv igjen.");
        return;
      }
      try {
        window.sessionStorage.setItem(
          returningDraftStorageKey(options.personId, payload.admissionPeriodId),
          JSON.stringify({
            personId: options.personId,
            route: returningRegistrationRoute,
            payload,
            signature,
          }),
        );
      } catch {
        event.preventDefault();
        event.currentTarget.dataset.pending = "false";
        setPersistenceError(
          "Nettleseren kunne ikke lagre et gjenopprettingsutkast. Registreringen ble ikke sendt.",
        );
      }
    }
  };
  const discardDraft = () => {
    if (typeof window !== "undefined")
      for (const draft of savedDrafts)
        window.sessionStorage.removeItem(
          returningDraftStorageKey(draft.personId, draft.payload.admissionPeriodId),
        );
    window.location.reload();
  };
  if (error || options === null) {
    return (
      <main className="space-y-4">
        <h1>Tidligere assistenter</h1>
        <p role="alert">{error ?? "Alternativene kunne ikke lastes."}</p>
      </main>
    );
  }
  if (savedDrafts.length > 1) {
    return (
      <main className="space-y-4">
        <h1>Tidligere assistenter</h1>
        <p role="alert">
          Flere lagrede utkast krever et valg før registreringen kan fortsette.
        </p>
        <Button type="button" onClick={discardDraft}>
          Forkast lagrede utkast
        </Button>
      </main>
    );
  }
  if (savedDraft !== null && selectedPeriod === undefined) {
    return (
      <main className="space-y-4">
        <h1>Tidligere assistenter</h1>
        <p role="alert">
          Det lagrede utkastet gjelder en opptaksperiode som ikke lenger er tilgjengelig.
        </p>
        <Button type="button" onClick={discardDraft}>
          Forkast lagret utkast
        </Button>
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
      <fetcher.Form key={`${selectedId}:${hydrated ? "hydrated" : "server"}`} method="post" onSubmit={onSubmit} data-pending={busy ? "true" : "false"} className="space-y-6" aria-label="Registrer som tidligere assistent">
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
                setSelectionOverride({ value: nextPeriodId, to: nextPeriodId || null });
                setSearchParams(
                  nextPeriodId ? { admissionPeriodId: nextPeriodId } : {},
                  { replace: false },
                );
                setDraftRevisionOverride(
                  options.periods.find(({ period }) => period.id === nextPeriodId)?.currentRevision ?? 0,
                );
                setCommandIdOverride("");
                setCommandDraftOverride("");
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
            <select name="yearOfStudy" defaultValue={restoredValue("yearOfStudy", String(current?.yearOfStudy ?? 1))} required className="mt-1 block w-full rounded border p-2">
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
                  defaultChecked={restoredChecked(name, Boolean(current?.[name as keyof typeof current]))}
                />
                {label}
              </label>
            ))}
          </div>
          <label className="block">Stillingslengde
            <select name="positionWeeks" defaultValue={restoredValue("positionWeeks", String(current?.positionWeeks ?? 4))} required className="mt-1 block w-full rounded border p-2">
              <option value="4">4 uker</option><option value="8">8 uker</option>
            </select>
          </label>
          <label className="block">Semesterblokk
            <select name="preferredGroup" defaultValue={restoredValue("preferredGroup", current?.preferredGroup ?? "all")} required className="mt-1 block w-full rounded border p-2">
              {groups.map((group) => <option key={group} value={group}>{group === "all" ? "Hele semesteret" : group}</option>)}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="text-lg font-semibold">Ønsker</legend>
          <label className="block">Språk
            <select name="language" defaultValue={restoredValue("language", current?.language ?? "Norsk")} required className="mt-1 block w-full rounded border p-2">
              {languages.map((language) => <option key={language} value={language}>{language}</option>)}
            </select>
          </label>
          <label className="block">Ønsket skole (valgfritt)
          <input name="preferredSchool" defaultValue={restoredValue("preferredSchool", current?.preferredSchool ?? "")} className="mt-1 block w-full rounded border p-2" maxLength={255} />
          </label>
          <label className="flex gap-2">
            <input type="checkbox" name="teamInterest" value="true" defaultChecked={restoredChecked("teamInterest", current?.teamInterest ?? false)} />
            Jeg er interessert i teamarbeid
          </label>
          <fieldset className="space-y-2">
            <legend className="font-medium">Teamønsker</legend>
            {options.teams.length === 0 && <p>Ingen team er tilgjengelige i avdelingen.</p>}
            {options.teams.map((team) => (
              <label key={team.teamId} className="flex gap-2">
                <input type="checkbox" name="teamIds" value={team.teamId} defaultChecked={restoredIncludes("teamIds", team.teamId, current?.teamIds.includes(team.teamId) ?? false)} />
                {team.name}
              </label>
            ))}
          </fieldset>
        </fieldset>
        <Button type="submit" disabled={busy}>{busy ? "Lagrer …" : current === null ? "Registrer for semesteret" : "Lagre endringer"}</Button>
        {persistenceError !== null && <p role="alert">{persistenceError}</p>}
        {restoringDraft && (
          <Button type="button" onClick={discardDraft}>
            Forkast lagret utkast
          </Button>
        )}
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

export function ErrorBoundary() {
  useRouteError();
  return (
    <main className="space-y-4">
      <h1>Tidligere assistenter</h1>
      <p role="alert">
        Registreringen ble avbrutt. Utkastet er lagret på denne enheten.
      </p>
      <Button type="button" onClick={() => window.location.reload()}>
        Prøv igjen
      </Button>
      <p>Hvis du ikke vil sende utkastet på nytt, velg Forkast lagret utkast etter omlasting.</p>
    </main>
  );
}
