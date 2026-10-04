import {
  AdmissionOutcomeAnnounceCommand,
  AdmissionOutcomeCommand,
  AdmissionOutcomeScope,
  IdempotencyIfMatchHeaders,
  PublicApplicationIdSchema,
  type AdmissionOutcomeAnnounceResource,
  type AdmissionOutcomeResource,
} from "@vektorprogrammet/http-api";
import { Match, Option, Predicate, Schema } from "effect";
import { useState, type ReactNode } from "react";
import {
  Form,
  Link,
  data,
  href,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router";
import { Button } from "../components/ui/button";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import { semesterLabel } from "../lib/semester-label";
import { formText } from "../lib/form-text";
import type { Route } from "./+types/dashboard.opptaksutfall._index";

const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "private, no-store" } });

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const query = new URL(request.url).searchParams;

  const selection = {
    departmentId: query.get("departmentId") ?? "",
    semesterId: query.get("semesterId") ?? "",
  };

  try {
    const scopes = (await client.admissionOutcomes.listScopes()).body;

    if (!selection.departmentId && !selection.semesterId)
      return privateData({ ...selection, scopes, board: null, error: null });

    if (
      !scopes.departments.some((item) => item.departmentId === selection.departmentId) ||
      !scopes.semesters.some((item) => item.semesterId === selection.semesterId)
    )
      return privateData({
        ...selection,
        scopes,
        board: null,
        error: "Velg en avdeling du har tilgang til og et gyldig semester.",
      });

    try {
      const board = (
        await client.admissionOutcomes.readOutcomes({
          query: Schema.decodeSync(AdmissionOutcomeScope)(selection),
        })
      ).body;

      return privateData({ ...selection, scopes, board, error: null });
    } catch (cause) {
      return privateData({
        ...selection,
        scopes,
        board: null,
        error:
          nativeProblemFrom(cause)?.code === "authority.denied"
            ? "Du har ikke lenger tilgang til denne avdelingen."
            : "Opptaksutfallene kunne ikke lastes. Prøv igjen.",
      });
    }
  } catch (cause) {
    return privateData({
      ...selection,
      scopes: null,
      board: null,
      error:
        nativeProblemFrom(cause)?.code === "authority.denied"
          ? "Du har ikke tilgang til opptaksutfall i noen avdeling."
          : "Opptaksutfallene kunne ikke lastes. Prøv igjen.",
    });
  }
}

/** The fields of one decision form, decoded as the SDK's decide request. */
const DecideOutcomeRequest = Schema.Struct({
  params: Schema.Struct({ applicationId: PublicApplicationIdSchema }),
  headers: IdempotencyIfMatchHeaders,
  payload: AdmissionOutcomeCommand,
});

/** The fields of one announcement form: the server derives the outcome and the message. */
const AnnounceOutcomeRequest = Schema.Struct({
  params: Schema.Struct({ applicationId: PublicApplicationIdSchema }),
  headers: IdempotencyIfMatchHeaders,
  payload: AdmissionOutcomeAnnounceCommand,
});

type Intent = "decide" | "announce";

const failureMessage = (code: string | undefined, intent: Intent) =>
  Match.value(code).pipe(
    Match.when("authority.denied", () =>
      intent === "announce"
        ? "Du har ikke tilgang til å kunngjøre opptaksutfall i denne avdelingen."
        : "Du har ikke tilgang til å avgjøre opptaksutfall i denne avdelingen.",
    ),
    Match.when("resource.not-found", () => "Søknaden finnes ikke lenger. Last siden på nytt."),
    Match.when("idempotency.in-flight", () =>
      intent === "announce"
        ? "Utfallet kunngjøres allerede. Vent litt og prøv igjen."
        : "Utfallet lagres allerede. Vent litt og prøv igjen.",
    ),
    Match.when("validation.failed", () =>
      intent === "announce" ? "Kunngjøringen er ugyldig." : "Velg et utfall før du lagrer.",
    ),
    Match.when(
      "admission-outcome.undecided",
      () => "Rekruttering har ikke avgjort utfallet ennå. Det kan ikke kunngjøres før det er avgjort.",
    ),
    Match.when(
      "admission-outcome.placement-active",
      () =>
        "Søkeren har en aktiv skoleplassering. Fjern plasseringen før avslaget kan kunngjøres.",
    ),
    Match.when(
      "admission-outcome.final",
      () => "Utfallet er allerede kunngjort og kan ikke endres. Hent siste versjon.",
    ),
    Match.when(
      "admission-outcome.derived",
      () => "Utfallet følger av intervjuet og kan ikke endres.",
    ),
    Match.when(
      "admission-outcome.unreviewed",
      () => "Søknaden har ingen vurdering ennå, så utfallet kan ikke avgjøres.",
    ),
    Match.orElse(() =>
      intent === "announce"
        ? "Utfallet kunne ikke kunngjøres nå. Ingen endring er bekreftet. Prøv igjen."
        : "Utfallet kunne ikke lagres nå. Ingen endring er bekreftet. Prøv igjen.",
    ),
  );

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form: FormData = await request.formData();
  const applicationId = formText(form, "applicationId");
  const commandId = formText(form, "commandId");
  const intent: Intent = formText(form, "intent") === "announce" ? "announce" : "decide";

  // Both intents are one dispatch: a decoded request bound to its operation. The result is not read.
  const send: Option.Option<() => Promise<void>> =
    intent === "announce"
      ? Option.map(
          Schema.decodeUnknownOption(AnnounceOutcomeRequest)({
            params: { applicationId: form.get("applicationId") },
            headers: { "if-match": form.get("etag"), "idempotency-key": form.get("commandId") },
            payload: {},
          }),
          (request) => async () => {
            await client.admissionOutcomes.announceOutcome(request);
          },
        )
      : Option.map(
          Schema.decodeUnknownOption(DecideOutcomeRequest)({
            params: { applicationId: form.get("applicationId") },
            headers: { "if-match": form.get("etag"), "idempotency-key": form.get("commandId") },
            payload: { outcome: form.get("outcome") },
          }),
          (request) => async () => {
            await client.admissionOutcomes.decideOutcome(request);
          },
        );

  if (Option.isNone(send))
    return privateData(
      {
        success: false as const,
        applicationId,
        commandId,
        conflict: false,
        message: failureMessage("validation.failed", intent),
      },
      422,
    );

  try {
    await send.value();

    return privateData({
      success: true as const,
      applicationId,
      commandId,
      conflict: false,
      message: intent === "announce" ? "Utfallet er kunngjort." : "Utfallet er lagret.",
    });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);

    const conflict =
      problem?.code === "precondition.failed" ||
      problem?.code === "transaction.conflict" ||
      problem?.code === "idempotency.digest-conflict" ||
      problem?.code === "admission-outcome.final";

    return privateData(
      {
        success: false as const,
        applicationId,
        commandId,
        conflict,
        message:
          conflict && problem?.code !== "admission-outcome.final"
            ? "Oversikten er endret av noen andre. Valget ditt er beholdt. Hent siste versjon før du lagrer på nytt."
            : failureMessage(problem?.code, intent),
      },
      problem?.status ?? 503,
    );
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

type DecideEntry = typeof AdmissionOutcomeResource.Type;

type AnnounceEntry = typeof AdmissionOutcomeAnnounceResource.Type;

type BoardEntry = DecideEntry | AnnounceEntry;

type Outcome = (AdmissionOutcomeCommand)["outcome"];

const outcomeLabels: Readonly<Record<Outcome, string>> = {
  Admitted: "Tatt opp",
  Rejected: "Ikke tatt opp",
};

const outcomes: ReadonlyArray<Outcome> = ["Admitted", "Rejected"];

const outcomeText = (outcome: Outcome | null) =>
  outcome === null ? "Ikke avgjort" : outcomeLabels[outcome];

const basisLabels: Readonly<Record<DecideEntry["basis"], string>> = {
  Ja: "Intervju: Ja",
  Kanskje: "Intervju: Kanskje",
  Nei: "Intervju: Nei",
  Returning: "Returnerende assistent uten intervju",
  Unreviewed: "Ikke vurdert",
};


interface CommandFormProps {
  readonly entry: BoardEntry;
  readonly intent: Intent;
  readonly label: string;
  readonly submitLabel: string;
  readonly busyLabel: string;
  /** Whether the form has a draft that a changed version must not silently overwrite. */
  readonly hasDraft: boolean;
  readonly latestSummary: (latest: BoardEntry) => string;
  readonly fields?: (field: { busy: boolean; revision: string }) => ReactNode;
  /** The final state that replaces the controls once no command is left to give. */
  readonly settled?: ReactNode;
}

function CommandForm({
  entry,
  intent,
  label,
  submitLabel,
  busyLabel,
  hasDraft,
  latestSummary,
  fields,
  settled,
}: CommandFormProps) {
  const fetcher = useFetcher<typeof action>();
  const refresh = useFetcher<typeof loader>();
  const location = useLocation();
  const [baseline, setBaseline] = useState(entry.etag);
  const [fieldRevision, setFieldRevision] = useState(entry.etag);
  const [dirty, setDirty] = useState(false);
  const [commandId, setCommandId] = useState("");
  const [signature, setSignature] = useState("");
  const [accepted, setAccepted] = useState("");

  // Without a draft the form follows the loaded version. A draft keeps the version it was
  // made from, so a change by someone else is a conflict and never a silent overwrite.
  if (!dirty && baseline !== entry.etag) setBaseline(entry.etag);

  if (!dirty && fieldRevision !== entry.etag) setFieldRevision(entry.etag);
  const busy = fetcher.state !== "idle";
  const completed = fetcher.data?.success ? fetcher.data.commandId : "";

  if (completed && completed !== accepted) {
    setAccepted(completed);
    setDirty(false);
    setBaseline(entry.etag);
    setCommandId("");
    setSignature("");
  }

  const id = entry.applicationId;
  const feedback = busy ? undefined : fetcher.data;
  const refreshedBoard = refresh.state === "idle" ? refresh.data?.board : undefined;
  const latest = refreshedBoard?.entries.find((item) => item.applicationId === id);

  return (
    <fetcher.Form
      method="post"
      aria-label={label}
      className="space-y-3"
      data-pending={busy ? "true" : "false"}
      onChange={() => {
        if (hasDraft) setDirty(true);
      }}
      onSubmit={(event) => {
        if (busy || event.currentTarget.dataset.pending === "true") {
          event.preventDefault();

          return;
        }

        event.currentTarget.dataset.pending = "true";

        if (hasDraft) setDirty(true);

        const draft = new FormData(event.currentTarget);
        draft.delete("commandId");
        const nextSignature = JSON.stringify([...draft]);
        const field = event.currentTarget.elements.namedItem("commandId");

        // An unchanged retry reuses its key; a changed draft or version is a new command.
        if (field instanceof HTMLInputElement && (!field.value || nextSignature !== signature)) {
          const key = crypto.randomUUID();
          field.value = key;
          setCommandId(key);
          setSignature(nextSignature);
        }
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="applicationId" value={id} />
      <input type="hidden" name="etag" value={baseline} />
      <input type="hidden" name="commandId" value={commandId} />
      {settled ?? (
        <div className="flex flex-wrap items-end gap-3">
          {fields?.({ busy, revision: fieldRevision })}
          <Button type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      )}
      {busy && <p role="status">{busyLabel}</p>}
      {feedback && (
        <div
          key={feedback.commandId}
          ref={revealCommandFeedback}
          tabIndex={-1}
          role={feedback.success ? "status" : "alert"}
          className="space-y-3 rounded-md border bg-muted p-3 text-sm"
        >
          <p>{feedback.message}</p>
          {!feedback.success && feedback.conflict && (
            <>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={refresh.state !== "idle"}
                  onClick={() => void refresh.load(`${location.pathname}${location.search}`)}
                >
                  Hent siste versjon
                </Button>
                {latest && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={baseline === latest.etag}
                    onClick={() => {
                      setBaseline(latest.etag);
                      setCommandId("");
                      setSignature("");
                    }}
                  >
                    Bruk siste versjon med mitt valg
                  </Button>
                )}
              </div>
              {refresh.state === "idle" && refresh.data && (
                <p>
                  {refreshedBoard === null || refreshedBoard === undefined
                    ? "Siste versjon kunne ikke hentes. Prøv igjen."
                    : latest === undefined
                      ? "Søknaden finnes ikke lenger i denne opptaksperioden."
                      : latestSummary(latest)}
                </p>
              )}
              {latest && baseline === latest.etag && (
                <p>Siste versjon er valgt. Kontroller valget og lagre på nytt.</p>
              )}
            </>
          )}
        </div>
      )}
    </fetcher.Form>
  );
}

function DecideForm({ entry, name }: { entry: DecideEntry; name: string }) {
  const id = entry.applicationId;

  return (
    <CommandForm
      entry={entry}
      intent="decide"
      label={`Opptaksutfall: ${name}`}
      submitLabel="Lagre utfall"
      busyLabel="Lagrer …"
      hasDraft
      latestSummary={(latest) =>
        `Siste lagrede utfall: ${latest.outcome === null ? "ikke registrert" : outcomeLabels[latest.outcome]}.`
      }
      fields={({ busy, revision }) => (
        <label htmlFor={`${id}-outcome`} className="min-w-48 flex-1 space-y-1 text-sm">
          Utfall
          <select
            key={revision}
            id={`${id}-outcome`}
            name="outcome"
            required
            disabled={busy}
            defaultValue={entry.outcome ?? ""}
            className={selectClass}
          >
            {entry.outcome === null && (
              <option value="" disabled>
                Velg utfall
              </option>
            )}
            {outcomes.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeLabels[outcome]}
              </option>
            ))}
          </select>
        </label>
      )}
    />
  );
}

function AnnounceForm({ entry, name }: { entry: BoardEntry; name: string }) {
  return (
    <CommandForm
      entry={entry}
      intent="announce"
      label={`Kunngjør utfall: ${name}`}
      submitLabel="Kunngjør utfall"
      busyLabel="Kunngjør …"
      hasDraft={false}
      settled={
        entry.state === "OutcomeAnnounced" ? <p>Kunngjort: {outcomeText(entry.outcome)}</p> : undefined
      }
      latestSummary={(latest) =>
        latest.state === "OutcomeAnnounced"
          ? `Siste status: kunngjort, ${outcomeText(latest.outcome)}.`
          : `Siste status: venter på kunngjøring, ${outcomeText(latest.outcome)}.`
      }
    />
  );
}

function DecideEntryCard({ entry, announceable }: { entry: DecideEntry; announceable: boolean }) {
  const name = `${entry.firstName} ${entry.lastName}`;
  const announced = entry.state === "OutcomeAnnounced";

  return (
    <article
      aria-label={`Søknad: ${name}`}
      className="space-y-3 rounded-lg border bg-card p-4"
      data-state={entry.state}
    >
      <h3 className="font-semibold">{name}</h3>
      <p className="break-words text-sm text-muted-foreground">
        {entry.email} · {entry.phone} · {entry.yearOfStudy}. studieår
      </p>
      <p className="text-sm">
        {basisLabels[entry.basis]} · {entry.placed ? "Har skoleplassering" : "Ingen skoleplassering"}
      </p>
      {!announced &&
        (entry.basis === "Kanskje" || entry.basis === "Returning" ? (
          <DecideForm entry={entry} name={name} />
        ) : (
          <p>Utfall: {outcomeText(entry.outcome)}</p>
        ))}
      {announceable ? (
        <AnnounceForm entry={entry} name={name} />
      ) : (
        announced && <p>Kunngjort: {outcomeText(entry.outcome)}</p>
      )}
    </article>
  );
}

function AnnounceEntryCard({ entry }: { entry: AnnounceEntry }) {
  const name = `${entry.firstName} ${entry.lastName}`;
  const announced = entry.state === "OutcomeAnnounced";

  return (
    <article
      aria-label={`Søknad: ${name}`}
      className="space-y-3 rounded-lg border bg-card p-4"
      data-state={entry.state}
    >
      <h3 className="font-semibold">{name}</h3>
      <p className="text-sm">
        Beslutning: {outcomeText(entry.outcome)} ·{" "}
        {entry.placed ? "Har skoleplassering" : "Ingen skoleplassering"}
      </p>
      <p className="text-sm">Status: {announced ? "Kunngjort" : "Venter på kunngjøring"}</p>
      <AnnounceForm entry={entry} name={name} />
    </article>
  );
}

export default function Opptaksutfall() {
  const { scopes, board, error, departmentId, semesterId } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <section
      className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-10 sm:px-6"
      aria-labelledby="outcome-page-title"
    >
      <header>
        <h1 id="outcome-page-title" className="font-semibold text-2xl">
          Opptaksutfall
        </h1>
        <p className="mt-2 text-muted-foreground">
          Rekruttering avgjør utfallet for søkere uten avgjørende intervju. Skolekoordinator
          kunngjør hvert utfall én gang, og søkeren får e-post med den gjeldende malen.
        </p>
        <p className="mt-2">
          <Link to={href("/opptaksutfall/maler")} className="underline">
            Rediger e-postmaler
          </Link>
        </p>
      </header>
      {scopes && (
        <Form
          key={`${departmentId}-${semesterId}`}
          method="get"
          className="flex flex-wrap items-end gap-4"
        >
          <label htmlFor="outcome-department" className="min-w-48 flex-1 space-y-1">
            Avdeling
            <select
              id="outcome-department"
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
          <label htmlFor="outcome-semester" className="min-w-48 flex-1 space-y-1">
            Semester
            <select
              id="outcome-semester"
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
                  {semesterLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={navigation.state !== "idle"}>Vis opptaksutfall</Button>
        </Form>
      )}
      {error && (
        <p role="alert" className="rounded-md border p-4">
          {error}
        </p>
      )}
      {navigation.state !== "idle" && <p role="status">Henter opptaksutfallene …</p>}
      {!board && !error && <p>Velg avdeling og semester for å se opptaksutfallene.</p>}
      {board &&
        (board.admissionPeriodId === null ? (
          <p>Det finnes ingen opptaksperiode for valgt avdeling og semester.</p>
        ) : (
          <div key={`${board.departmentId}-${board.semesterId}`} className="space-y-8">
            {Predicate.isTagged(board, "Decide") && (
              <section aria-labelledby="outcome-title" className="space-y-4">
                <h2 id="outcome-title" className="font-semibold text-xl">
                  Opptaksutfall
                </h2>
                {board.entries.length === 0 ? (
                  <p>Ingen søknader i opptaksperioden.</p>
                ) : (
                  board.entries.map((entry) => (
                    <DecideEntryCard
                      key={entry.applicationId}
                      entry={entry}
                      announceable={board.canAnnounce}
                    />
                  ))
                )}
              </section>
            )}
            {Predicate.isTagged(board, "Announce") && (
              <section aria-labelledby="announce-title" className="space-y-4">
                <h2 id="announce-title" className="font-semibold text-xl">
                  Kunngjøring
                </h2>
                {board.entries.length === 0 ? (
                  <p>Ingen søknader i opptaksperioden.</p>
                ) : (
                  board.entries.map((entry) => (
                    <AnnounceEntryCard key={entry.applicationId} entry={entry} />
                  ))
                )}
              </section>
            )}
          </div>
        ))}
    </section>
  );
}
