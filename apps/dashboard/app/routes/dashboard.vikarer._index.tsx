import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeScope,
  IdempotencyIfMatchHeaders,
  PublicApplicationIdSchema,
  type AdmissionOutcomeResource,
} from "@vektorprogrammet/http-api";
import { Option, Predicate, Schema } from "effect";
import { useState } from "react";
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
import type { Route } from "./+types/dashboard.vikarer._index";

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
            : "Vikarene kunne ikke lastes. Prøv igjen.",
      });
    }
  } catch (cause) {
    return privateData({
      ...selection,
      scopes: null,
      board: null,
      error:
        nativeProblemFrom(cause)?.code === "authority.denied"
          ? "Du har ikke tilgang til vikaroversikten i noen avdeling."
          : "Vikaroversikten kunne ikke lastes. Prøv igjen.",
    });
  }
}

/** The fields of one outcome form, decoded as the SDK's record request. */
const RecordOutcomeRequest = Schema.Struct({
  params: Schema.Struct({ applicationId: PublicApplicationIdSchema }),
  headers: IdempotencyIfMatchHeaders,
  payload: AdmissionOutcomeCommand,
});

const failureMessage = (code: string | undefined) => {
  switch (code) {
    case "authority.denied":
      return "Du har ikke tilgang til å registrere opptaksutfall i denne avdelingen.";
    case "resource.not-found":
      return "Søknaden finnes ikke lenger. Last siden på nytt.";
    case "idempotency.in-flight":
      return "Utfallet lagres allerede. Vent litt og prøv igjen.";
    case "validation.failed":
      return "Velg et utfall før du lagrer.";
    default:
      return "Utfallet kunne ikke lagres nå. Ingen endring er bekreftet. Prøv igjen.";
  }
};

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  const applicationId = String(form.get("applicationId") ?? "");
  const commandId = String(form.get("commandId") ?? "");

  const command = Schema.decodeUnknownOption(RecordOutcomeRequest)({
    params: { applicationId: form.get("applicationId") },
    headers: { "if-match": form.get("etag"), "idempotency-key": form.get("commandId") },
    payload: { outcome: form.get("outcome") },
  });

  if (Option.isNone(command))
    return privateData(
      {
        success: false as const,
        applicationId,
        commandId,
        conflict: false,
        message: failureMessage("validation.failed"),
      },
      422,
    );

  try {
    await client.admissionOutcomes.recordOutcome(command.value);

    return privateData({
      success: true as const,
      applicationId,
      commandId,
      conflict: false,
      message: "Utfallet er lagret.",
    });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);

    const conflict =
      problem?.code === "precondition.failed" ||
      problem?.code === "transaction.conflict" ||
      problem?.code === "idempotency.digest-conflict";

    return privateData(
      {
        success: false as const,
        applicationId,
        commandId,
        conflict,
        message: conflict
          ? "Oversikten er endret av noen andre. Valget ditt er beholdt. Hent siste versjon før du lagrer på nytt."
          : failureMessage(problem?.code),
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

type Entry = typeof AdmissionOutcomeResource.Type;

type Outcome = (typeof AdmissionOutcomeCommand.Type)["outcome"];

const outcomeLabels: Readonly<Record<Outcome, string>> = {
  Admitted: "Tatt opp",
  Substitute: "Vikar",
  Rejected: "Ikke tatt opp",
};

const outcomes: ReadonlyArray<Outcome> = ["Admitted", "Substitute", "Rejected"];

function OutcomeForm({ entry }: { entry: Entry }) {
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
  const name = `${entry.firstName} ${entry.lastName}`;
  const feedback = busy ? undefined : fetcher.data;
  const refreshedBoard = refresh.state === "idle" ? refresh.data?.board : undefined;

  const refreshedEntries =
    refreshedBoard?._tag === "Decide" ? refreshedBoard.entries : undefined;

  const latest = refreshedEntries?.find((item) => item.applicationId === id);

  return (
    <fetcher.Form
      method="post"
      aria-label={`Opptaksutfall: ${name}`}
      className="space-y-3 rounded-lg border bg-card p-4"
      data-pending={busy ? "true" : "false"}
      onChange={() => setDirty(true)}
      onSubmit={(event) => {
        if (busy || event.currentTarget.dataset.pending === "true") {
          event.preventDefault();

          return;
        }

        event.currentTarget.dataset.pending = "true";
        setDirty(true);
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
      <h3 className="font-semibold">{name}</h3>
      <p className="break-words text-sm text-muted-foreground">
        {entry.email} · {entry.phone} · {entry.yearOfStudy}. studieår
      </p>
      <input type="hidden" name="applicationId" value={id} />
      <input type="hidden" name="etag" value={baseline} />
      <input type="hidden" name="commandId" value={commandId} />
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={`${id}-outcome`} className="min-w-48 flex-1 space-y-1 text-sm">
          Utfall
          <select
            key={fieldRevision}
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
        <Button type="submit" disabled={busy}>
          Lagre utfall
        </Button>
      </div>
      {busy && <p role="status">Lagrer …</p>}
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
                  {refreshedEntries === undefined
                    ? "Siste versjon kunne ikke hentes. Prøv igjen."
                    : latest === undefined
                      ? "Søknaden finnes ikke lenger i denne opptaksperioden."
                      : `Siste lagrede utfall: ${latest.outcome === null ? "ikke registrert" : outcomeLabels[latest.outcome]}.`}
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

export default function Vikarer() {
  const { scopes, board, error, departmentId, semesterId } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  const onCall =
    board === null
      ? []
      : Predicate.isTagged(board, "Decide")
        ? board.entries.filter((entry) => entry.outcome === "Substitute")
        : board.substitutes;

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
          En vikar er tatt opp uten skoleplassering og kan dekke fravær i semesteret.
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
                  {semesterLabel(item)}
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
      {board &&
        (board.admissionPeriodId === null ? (
          <p>Det finnes ingen opptaksperiode for valgt avdeling og semester.</p>
        ) : (
          <div key={`${board.departmentId}-${board.semesterId}`} className="space-y-8">
            <section aria-labelledby="on-call-title" className="space-y-3">
              <h2 id="on-call-title" className="font-semibold text-xl">
                Vikarer på vakt
              </h2>
              <p>
                Avtal dekning direkte med vikaren, for eksempel i Slack. Registrer hvem som dekket
                fraværet under{" "}
                <Link
                  to={`${href("/assistenter")}?${new URLSearchParams({ departmentId, semesterId })}`}
                  className="underline"
                >
                  Assistenter
                </Link>
                .
              </p>
              {onCall.length === 0 ? (
                <p>Ingen vikarer på vakt i valgt semester.</p>
              ) : (
                <ul aria-label="Vikarer på vakt" className="list-disc space-y-1 pl-5">
                  {onCall.map((substitute) => (
                    <li key={substitute.applicationId} className="break-words">
                      {substitute.firstName} {substitute.lastName},{" "}
                      <a href={`mailto:${substitute.email}`} className="underline">
                        {substitute.email}
                      </a>
                      ,{" "}
                      <a href={`tel:${substitute.phone.replaceAll(" ", "")}`} className="underline">
                        {substitute.phone}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {Predicate.isTagged(board, "Decide") && (
              <section aria-labelledby="outcome-title" className="space-y-4">
                <h2 id="outcome-title" className="font-semibold text-xl">
                  Opptaksutfall
                </h2>
                {board.entries.length === 0 ? (
                  <p>Ingen søknader i opptaksperioden.</p>
                ) : (
                  board.entries.map((entry) => (
                    <OutcomeForm key={entry.applicationId} entry={entry} />
                  ))
                )}
              </section>
            )}
          </div>
        ))}
    </section>
  );
}
