import { DepartmentId, SemesterId } from "@vektorprogrammet/http-api"
import { type SubstituteBoard, type SubstituteResource } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { useState } from "react";
import { Form, data, useFetcher, useLoaderData, useLocation, useNavigation } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import {
  languages,
  parseSubstituteForm,
  substituteFailure,
  substituteSemesterLabel,
  weekdays,
} from "../lib/substitute-form";
import type { Route } from "./+types/dashboard.vikarer._index";

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const query = new URL(request.url).searchParams;
  const departmentId = query.get("departmentId") ?? "";
  const semesterId = query.get("semesterId") ?? "";
  try {
    const scopes = (await client.substitutes.listScopes()).body;
    let board: typeof SubstituteBoard.Type | null = null;
    let error: string | null = null;
    if (departmentId || semesterId) {
      if (
        !scopes.departments.some((item) => item.departmentId === departmentId) ||
        !scopes.semesters.some((item) => item.semesterId === semesterId)
      ) {
        error = "Velg en avdeling du har tilgang til og et gyldig semester.";
      } else {
        board = (
          await client.substitutes.readPool({
            query: {
              departmentId: Schema.decodeUnknownSync(DepartmentId)(departmentId),
              semesterId: Schema.decodeUnknownSync(SemesterId)(semesterId),
            },
          })
        ).body;
      }
    }
    return data(
      { scopes, board, error, departmentId, semesterId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return data(
      {
        scopes: null,
        board: null,
        error: substituteFailure(cause).message,
        departmentId,
        semesterId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
const privateActionData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "no-store" } });

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  let command: ReturnType<typeof parseSubstituteForm>;
  try {
    command = parseSubstituteForm(await request.formData());
  } catch {
    return privateActionData(
      {
        _tag: "InvalidForm" as const,
        success: false as const,
        message: "Fyll ut alle ukedager, undervisningsspråk og studieår (1–5).",
        conflict: false,
      },
      422,
    );
  }
  try {
    if (command.intent === "deactivate")
      await client.substitutes.deactivate({
        params: command.params,
        headers: command.headers,
        payload: {},
      });
    else if (command.intent === "activate") await client.substitutes.activate(command);
    else await client.substitutes.edit(command);
    return privateActionData({
      _tag: "Completed" as const,
      success: true as const,
      applicationId: command.params.applicationId,
      commandId: command.headers["idempotency-key"],
      message:
        command.intent === "deactivate"
          ? "Vikaren er fjernet fra oversikten. Søknaden og opplysningene er bevart."
          : command.intent === "activate"
            ? "Vikaren er lagt til."
            : "Opplysningene er lagret.",
      conflict: false,
    });
  } catch (cause) {
    return privateActionData({
      _tag: "Rejected" as const,
      success: false as const,
      applicationId: command.params.applicationId,
      commandId: command.headers["idempotency-key"],
      etag: command.headers["if-match"],
      intent: command.intent,
      draft: command.intent === "deactivate" ? null : command.payload,
      ...substituteFailure(cause),
    });
  }
}
// Callback ref runs only when a new command result is mounted, after its DOM exists.
// Keep feedback in normal flow and bring it into the post-action viewport.
function revealCommandFeedback(element: HTMLElement | null): void {
  if (element !== null) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  }
}

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
type Entry = typeof SubstituteResource.Type;
function EntryForm({ entry, onCommand }: { entry: Entry; onCommand: () => void }) {
  const fetcher = useFetcher<typeof action>({ key: "substitute-command" });
  const refresh = useFetcher<typeof loader>();
  const location = useLocation();
  const busy = fetcher.state !== "idle" || refresh.state !== "idle";
  const rejected =
    fetcher.data &&
    fetcher.data._tag === "Rejected" &&
    fetcher.data.applicationId === entry.applicationId
      ? fetcher.data
      : undefined;
  const retainedDraft = rejected?.draft;
  const [baseline, setBaseline] = useState(rejected?.etag ?? entry.etag);
  const [commandId, setCommandId] = useState("");
  const [commandDraft, setCommandDraft] = useState("");
  const [lastResult, setLastResult] = useState(fetcher.data);
  // A completed successful command starts a new conditional command. A rejected draft
  // keeps its selected version until the coordinator explicitly requests a refresh.
  if (fetcher.data !== lastResult && fetcher.state === "idle") {
    setLastResult(fetcher.data);
    if (fetcher.data?.success && fetcher.data.applicationId === entry.applicationId) {
      setBaseline(entry.etag);
      setCommandId("");
    }
  }
  const id = entry.applicationId;
  const feedback =
    fetcher.data && "applicationId" in fetcher.data && fetcher.data.applicationId === id
      ? fetcher.data
      : undefined;
  const refreshed = refresh.data?.board;
  const current =
    refreshed &&
    [...refreshed.entries, ...(refreshed._tag === "Manage" ? refreshed.candidates : [])].find(
      (item) => item.applicationId === id,
    );
  return (
    <fetcher.Form
      method="post"
      className="space-y-4"
      data-pending={busy ? "true" : "false"}
      onSubmit={(event) => {
        if (busy || event.currentTarget.dataset.pending === "true") {
          event.preventDefault();
          return;
        }
        event.currentTarget.dataset.pending = "true";
        onCommand();
        const field = event.currentTarget.elements.namedItem("commandId");
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const draft = new FormData(event.currentTarget);
        draft.delete("commandId");
        if (submitter instanceof HTMLButtonElement) draft.set("intent", submitter.value);
        const signature = JSON.stringify([...draft]);
        if (field instanceof HTMLInputElement && (!field.value || signature !== commandDraft)) {
          const key = crypto.randomUUID();
          field.value = key;
          setCommandId(key);
          setCommandDraft(signature);
        }
      }}
    >
      <input type="hidden" name="applicationId" value={id} />
      <input type="hidden" name="etag" value={baseline} />
      <input type="hidden" name="commandId" value={commandId} />
      <fieldset disabled={busy} className="space-y-4">
        <legend className="font-medium">Tilgjengelighet og undervisning</legend>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {weekdays.map(([key, label]) => (
            <label key={key} htmlFor={`${id}-${key}`} className="space-y-1 text-sm">
              {label}
              <select
                id={`${id}-${key}`}
                name={key}
                className={selectClass}
                required
                defaultValue={
                  retainedDraft
                    ? String(retainedDraft[key])
                    : entry.preferences === null
                      ? ""
                      : String(entry.preferences[key])
                }
              >
                <option value="" disabled>
                  Velg
                </option>
                <option value="true">Tilgjengelig</option>
                <option value="false">Ikke tilgjengelig</option>
              </select>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={`${id}-language`} className="space-y-1 text-sm">
            Undervisningsspråk
            <select
              id={`${id}-language`}
              name="language"
              className={selectClass}
              required
              defaultValue={retainedDraft?.language ?? entry.preferences?.language ?? ""}
            >
              <option value="" disabled>
                Velg språk
              </option>
              {languages.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-year`} className="space-y-1 text-sm">
            Studieår
            <Input
              id={`${id}-year`}
              name="yearOfStudy"
              type="number"
              required
              min={1}
              max={5}
              step={1}
              defaultValue={retainedDraft?.yearOfStudy ?? entry.yearOfStudy}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" name="intent" value={entry.active ? "edit" : "activate"}>
            {busy ? "Lagrer …" : entry.active ? "Lagre endringer" : "Legg til som vikar"}
          </Button>
          {entry.active && (
            <Button type="submit" name="intent" value="deactivate" variant="outline" formNoValidate>
              Fjern fra vikaroversikten
            </Button>
          )}
        </div>
      </fieldset>
      {feedback && feedback._tag === "Rejected" && fetcher.state === "idle" && (
        <div
          key={feedback.commandId}
          ref={revealCommandFeedback}
          tabIndex={-1}
          role="alert"
          className="rounded-md border bg-muted p-3 text-sm"
        >
          {!entry.active && feedback.intent === "edit"
            ? "Søkeren er ikke lenger aktiv vikar. Utkastet er beholdt. Å legge til igjen er en ny aktivering."
            : feedback.message}
          {feedback.conflict && (
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => refresh.load(`${location.pathname}${location.search}`)}
              >
                Hent siste versjon
              </Button>
              {current && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setBaseline(current.etag);
                    setCommandId("");
                  }}
                >
                  Bruk siste versjon med mitt utkast
                </Button>
              )}
            </div>
          )}
          {current && feedback.conflict && (
            <p className="mt-2">
              Siste lagrede versjon: studieår {current.yearOfStudy},{" "}
              {current.preferences === null
                ? "ingen tilgjengelighet registrert"
                : languages.find(([value]) => value === current.preferences?.language)?.[1]}
              .{" "}
              {current.preferences !== null &&
                weekdays
                  .map(
                    ([key, label]) =>
                      `${label}: ${current.preferences?.[key] ? "tilgjengelig" : "ikke tilgjengelig"}`,
                  )
                  .join(" · ")}
              . Kontroller utkastet før du lagrer.
            </p>
          )}
        </div>
      )}
    </fetcher.Form>
  );
}
function EntryCard({
  entry,
  manage,
  onCommand,
}: {
  entry: Entry;
  manage: boolean;
  onCommand: () => void;
}) {
  return (
    <article
      aria-label={`${entry.firstName} ${entry.lastName}`}
      className="rounded-lg border bg-card p-4 sm:p-6"
    >
      <h3 className="font-semibold text-lg">
        {entry.firstName} {entry.lastName}
      </h3>
      <p className="mb-4 break-words text-sm text-muted-foreground">
        {entry.email} · {entry.phone}
      </p>
      {manage ? (
        <EntryForm entry={entry} onCommand={onCommand} />
      ) : (
        <>
          <p>
            Studieår {entry.yearOfStudy} ·{" "}
            {languages.find(([value]) => value === entry.preferences?.language)?.[1]}
          </p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-5">
            {weekdays.map(([key, label]) => (
              <div key={key}>
                <dt className="font-medium">{label}</dt>
                <dd>{entry.preferences?.[key] ? "Tilgjengelig" : "Ikke tilgjengelig"}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </article>
  );
}
export default function Vikarer() {
  const { scopes, board, error, departmentId, semesterId } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [selected, setSelected] = useState("");
  const command = useFetcher<typeof action>({ key: "substitute-command" });
  const candidate =
    board?._tag === "Manage"
      ? board.candidates.find((entry) => entry.applicationId === selected)
      : undefined;
  return (
    <section
      className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-10 sm:px-6"
      aria-labelledby="substitute-title"
    >
      <header>
        <h1 id="substitute-title" className="font-semibold text-2xl">
          Vikarer
        </h1>
        <p className="mt-2 text-muted-foreground">
          Se og vedlikehold vikaroversikten for en avdeling og et semester.
        </p>
      </header>
      {scopes && (
        <Form
          key={`${departmentId}-${semesterId}`}
          method="get"
          className="flex flex-wrap items-end gap-4"
        >
          <label htmlFor="substitute-department" className="min-w-48 flex-1 space-y-1">
            Avdeling
            <select
              id="substitute-department"
              name="departmentId"
              required
              defaultValue={departmentId}
              className={selectClass}
            >
              <option value="" disabled>
                Velg avdeling
              </option>
              {scopes.departments.map((item) => (
                <option key={item.departmentId} value={item.departmentId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="substitute-semester" className="min-w-48 flex-1 space-y-1">
            Semester
            <select
              id="substitute-semester"
              name="semesterId"
              required
              defaultValue={semesterId}
              className={selectClass}
            >
              <option value="" disabled>
                Velg semester
              </option>
              {scopes.semesters.map((item) => (
                <option key={item.semesterId} value={item.semesterId}>
                  {substituteSemesterLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={navigation.state !== "idle"}>Vis vikarer</Button>
        </Form>
      )}
      {error && (
        <p role="alert" className="rounded-md border p-4">
          {error}
        </p>
      )}
      {navigation.state !== "idle" && <p role="status">Henter vikaroversikten …</p>}
      {!board && !error && <p>Velg avdeling og semester for å se vikarene.</p>}
      {scopes?.departments.length === 0 && (
        <p>Du har ingen avdelingstilgang til vikaroversikten.</p>
      )}
      {board && (
        <div key={`${board.departmentId}-${board.semesterId}`} className="space-y-6">
          {board._tag === "ReadOnly" && (
            <p>Du har lesetilgang. En avdelingsleder kan endre vikaroversikten.</p>
          )}
          {board.admissionPeriodId === null ? (
            <p>Det finnes ingen opptaksperiode for valgt avdeling og semester.</p>
          ) : (
            <>
              <h2 className="font-semibold text-xl">Aktive vikarer ({board.entries.length})</h2>
              {board.entries.length === 0 && <p>Ingen aktive vikarer i dette semesteret.</p>}
              {board.entries.map((entry) => (
                <EntryCard
                  key={entry.applicationId}
                  entry={entry}
                  manage={board._tag === "Manage"}
                  onCommand={() => setSelected(entry.applicationId)}
                />
              ))}
              {board._tag === "Manage" && (
                <section className="space-y-4" aria-labelledby="add-substitute">
                  <h2 id="add-substitute" className="font-semibold text-xl">
                    Legg til vikar
                  </h2>
                  {board.candidates.length === 0 ? (
                    <p>Ingen flere søknader kan legges til i denne opptaksperioden.</p>
                  ) : (
                    <>
                      <label className="block space-y-1" htmlFor="substitute-candidate">
                        Søker
                        <select
                          id="substitute-candidate"
                          value={candidate?.applicationId ?? ""}
                          onChange={(event) => setSelected(event.target.value)}
                          className={selectClass}
                        >
                          <option value="">Velg en søknad</option>
                          {board.candidates.map((entry) => (
                            <option key={entry.applicationId} value={entry.applicationId}>
                              {entry.firstName} {entry.lastName} ({entry.email})
                            </option>
                          ))}
                        </select>
                      </label>
                      {candidate && (
                        <EntryCard
                          key={candidate.applicationId}
                          entry={candidate}
                          manage
                          onCommand={() => setSelected(candidate.applicationId)}
                        />
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}
      {command.data && !("applicationId" in command.data) && (
        <p
          ref={revealCommandFeedback}
          tabIndex={-1}
          role="alert"
          className="rounded-md border bg-background p-4"
        >
          {command.data.message}
        </p>
      )}
      {command.data?.success && command.state === "idle" && (
        <p
          key={command.data.commandId}
          ref={revealCommandFeedback}
          tabIndex={-1}
          role="status"
          className="rounded-md border bg-background p-4"
        >
          {command.data.message}
        </p>
      )}
    </section>
  );
}
