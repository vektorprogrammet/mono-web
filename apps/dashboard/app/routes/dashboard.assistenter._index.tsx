import {
  AffiliationScope,
  OwnAffiliationCommand,
  PlacementCommand,
  PlacementScope,
} from "@vektorprogrammet/http-api";
import {
  IdempotencyIfMatchHeaders,
  type OwnAffiliationResource,
  type PlacementBoardResource,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { type ReactNode, useState } from "react";
import { Form, data, useFetcher, useLoaderData, useLocation } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import { substituteSemesterLabel } from "../lib/substitute-form";
import type { Route } from "./+types/dashboard.assistenter._index";
const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const q = new URL(request.url).searchParams;
  const departmentId = q.get("departmentId") ?? "";
  const semesterId = q.get("semesterId") ?? "";
  try {
    const scopes = (await client.placements.listScopes()).body;
    let own: typeof OwnAffiliationResource.Type | null = null;
    let board: typeof PlacementBoardResource.Type | null = null;
    if (departmentId) {
      const scope = Schema.decodeUnknownSync(AffiliationScope)({ departmentId });
      own = (await client.placements.readOwnAffiliation({ query: scope })).body;
      if (
        semesterId &&
        scopes.departments.some((d) => d.departmentId === departmentId && d.canManage)
      )
        board = (
          await client.placements.readBoard({
            query: Schema.decodeUnknownSync(PlacementScope)({ departmentId, semesterId }),
          })
        ).body;
    }
    return privateData({
      scopes,
      own,
      board,
      departmentId,
      semesterId,
      error: null as string | null,
    });
  } catch {
    return privateData({
      scopes: null,
      own: null,
      board: null,
      departmentId,
      semesterId,
      error: "Oversikten kunne ikke lastes. Kontroller avdeling og semester, og prøv igjen.",
    });
  }
}
export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  try {
    const headers = Schema.decodeUnknownSync(IdempotencyIfMatchHeaders)({
      "if-match": form.get("etag"),
      "idempotency-key": form.get("commandId"),
    });
    const departmentId = form.get("departmentId");
    const action = form.get("action");
    if (action === "Request" || action === "Withdraw")
      await client.placements.commandOwnAffiliation({
        query: Schema.decodeUnknownSync(AffiliationScope)({ departmentId }),
        headers,
        payload: Schema.decodeUnknownSync(OwnAffiliationCommand)({ action }),
      });
    else {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });
      const values = {
        schoolId: Number(form.get("schoolId")),
        workdays: Number(form.get("workdays")),
        day: form.get("day"),
        block: form.get("block"),
      };
      const command =
        action === "Affiliation"
          ? { action, personId: form.get("personId"), transition: form.get("transition") }
          : action === "Create"
            ? { action, personId: form.get("personId"), ...values }
            : action === "Edit"
              ? { action, placementId: form.get("placementId"), ...values }
              : action === "Remove"
                ? { action, placementId: form.get("placementId") }
                : action === "SetDemand"
                  ? {
                      action,
                      schoolId: Number(form.get("schoolId")),
                      day: form.get("day"),
                      block: form.get("block"),
                      requiredVolunteers: Number(form.get("requiredVolunteers")),
                    }
                  : action === "GenerateProposal"
                    ? { action }
                    : action === "ConfirmProposal"
                      ? {
                          action,
                          proposalId: form.get("proposalId"),
                          reviewedExceptionIds: form.getAll("reviewedExceptionId"),
                        }
                      : {
                          action,
                          proposalId: form.get("proposalId"),
                          schoolId: Number(form.get("schoolId")),
                          day: form.get("day"),
                          block: form.get("block"),
                          occurredOn: form.get("occurredOn"),
                          attendedPersonIds: form.getAll("attendedPersonId"),
                        };
      const payload = Schema.decodeUnknownSync(PlacementCommand)(command, {
        onExcessProperty: "error",
      });
      switch (payload.action) {
        case "Affiliation":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "Create":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "Edit":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "Remove":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "SetDemand":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "GenerateProposal":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "ConfirmProposal":
          await client.placements.commandBoard({ query, headers, payload });
          break;
        case "RecordOccurrence":
          await client.placements.commandBoard({ query, headers, payload });
          break;
      }
    }
    return privateData({
      success: true as const,
      message: "Endringen er lagret.",
      conflict: false,
      commandId: String(form.get("commandId")),
    });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);
    const messages: Record<string, string> = {
      "authority.denied": "Du har ikke lenger tilgang til denne avdelingen.",
      "placement.overlap":
        "Denne personen har allerede en plassering ved skolen i samme semester og bolk.",
      "affiliation.inactive": "Personen har ikke aktiv frivilligtilknytning. Utkastet er beholdt.",
      "affiliation.transition-invalid":
        "Tilknytningen har endret status. Hent oppdaterte opplysninger.",
      "placement.inactive": "Plasseringen er fjernet. Utkastet er beholdt.",
      "scope.invalid": "Velg en aktiv skole i avdelingen og et gyldig semester.",
      "school-service.proposal-empty":
        "Det finnes ingen aktive plasseringer å lage en tjenesteplan fra.",
      "school-service.proposal-inactive":
        "Tjenesteplanen er ikke lenger et aktivt utkast. Hent oppdatert oversikt.",
      "school-service.exception-review-invalid":
        "Alle avvik må gjennomgås og bekreftes før planen kan låses.",
      "school-service.occurrence-invalid":
        "Oppmøtet må samsvare nøyaktig med den bekreftede planen for skole, dag og bolk.",
      "school-service.occurrence-duplicate":
        "Undervisningen er allerede registrert for denne datoen og bolken.",
    };
    const conflict = problem?.status === 412 || problem?.code === "transaction.conflict";
    return privateData(
      {
        success: false as const,
        message: conflict
          ? "Oversikten er endret av noen andre. Utkastet er beholdt. Hent og godta oppdatert oversikt før du prøver igjen."
          : (messages[problem?.code ?? ""] ??
            "Endringen kunne ikke lagres. Kontroller feltene og prøv igjen."),
        conflict,
        commandId: String(form.get("commandId")),
      },
      problem?.status ?? 422,
    );
  }
}
const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const statusLabel = {
  Absent: "Ikke forespurt",
  Pending: "Venter på godkjenning",
  Active: "Aktiv",
  Inactive: "Inaktiv",
};
function CommandForm({
  etag,
  own = false,
  children,
  label,
  hidden,
}: {
  etag: string;
  own?: boolean;
  children: ReactNode;
  label: string;
  hidden: Record<string, string>;
}) {
  const fetcher = useFetcher<typeof action>();
  const refresh = useFetcher<typeof loader>();
  const location = useLocation();
  const [baseline, setBaseline] = useState(etag);
  const [commandId, setCommandId] = useState("");
  const [signature, setSignature] = useState("");
  const [accepted, setAccepted] = useState("");
  const [dirty, setDirty] = useState(false);
  const [fieldRevision, setFieldRevision] = useState(etag);
  if (!dirty && baseline !== etag) setBaseline(etag);
  if (!dirty && fieldRevision !== etag) setFieldRevision(etag);
  const busy = fetcher.state !== "idle";
  const completed = fetcher.data?.success ? fetcher.data.commandId : "";
  if (completed && completed !== accepted) {
    setAccepted(completed);
    setDirty(false);
    setBaseline(etag);
    setCommandId("");
    setSignature("");
  }
  const refreshed = own ? refresh.data?.own : refresh.data?.board;
  return (
    <fetcher.Form
      aria-label={label}
      method="post"
      className="space-y-3"
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
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        if (submitter instanceof HTMLButtonElement && submitter.name)
          draft.set(submitter.name, submitter.value);
        draft.delete("commandId");
        const nextSignature = JSON.stringify([...draft]);
        const field = event.currentTarget.elements.namedItem("commandId");
        if (field instanceof HTMLInputElement && (!field.value || nextSignature !== signature)) {
          const key = crypto.randomUUID();
          field.value = key;
          setCommandId(key);
          setSignature(nextSignature);
        }
      }}
    >
      <input type="hidden" name="etag" value={baseline} />
      <input type="hidden" name="commandId" value={commandId} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset key={fieldRevision} disabled={busy} className="space-y-3">
        <legend className="sr-only">{label}</legend>
        {children}
      </fieldset>
      {busy && <p role="status">Lagrer …</p>}
      {!busy && fetcher.data && (
        <div
          role={fetcher.data.success ? "status" : "alert"}
          className="rounded-md border bg-muted p-3 text-sm"
        >
          {fetcher.data.message}
          {fetcher.data.conflict && (
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={refresh.state !== "idle"}
                onClick={() => void refresh.load(location.pathname + location.search)}
              >
                Hent oppdatert oversikt
              </Button>
              {refreshed && (
                <p>
                  {"placements" in refreshed
                    ? `Oppdatert oversikt: ${refreshed.placements.filter((p) => p.active).length} aktive plasseringer. ${refreshed.placements
                        .filter((p) => p.active)
                        .map(
                          (p) =>
                            `${p.firstName} ${p.lastName}: ${p.schoolName}, ${p.day}, bolk ${p.block}, ${p.workdays} dager`,
                        )
                        .join("; ")}`
                    : `Oppdatert status: ${statusLabel[refreshed.status]}`}
                </p>
              )}
              {refreshed && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setBaseline(refreshed.etag);
                    setCommandId("");
                    setSignature("");
                  }}
                >
                  Godta oppdatert versjon
                </Button>
              )}
              {refreshed && baseline === refreshed.etag && (
                <p>Oppdatert versjon er valgt. Kontroller utkastet og lagre på nytt.</p>
              )}
            </div>
          )}
        </div>
      )}
    </fetcher.Form>
  );
}
function PlacementFields({
  board,
  entry,
}: {
  board: typeof PlacementBoardResource.Type;
  entry?: (typeof PlacementBoardResource.Type)["placements"][number];
}) {
  const prefix = entry?.placementId ?? "new";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label htmlFor={`${prefix}-school`}>
        Skole
        <select
          id={`${prefix}-school`}
          name="schoolId"
          required
          defaultValue={entry?.schoolId ?? ""}
          className={selectClass}
        >
          <option value="" disabled>
            Velg skole
          </option>
          {board.schools.map((s) => (
            <option key={s.schoolId} value={s.schoolId}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${prefix}-day`}>
        Ukedag
        <select
          id={`${prefix}-day`}
          name="day"
          required
          defaultValue={entry?.day ?? ""}
          className={selectClass}
        >
          <option value="" disabled>
            Velg ukedag
          </option>
          {[
            ["Monday", "Mandag"],
            ["Tuesday", "Tirsdag"],
            ["Wednesday", "Onsdag"],
            ["Thursday", "Torsdag"],
            ["Friday", "Fredag"],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${prefix}-workdays`}>
        Antall undervisningsdager
        <Input
          id={`${prefix}-workdays`}
          name="workdays"
          type="number"
          min={1}
          max={8}
          step={1}
          required
          defaultValue={entry?.workdays ?? 4}
        />
      </label>
      <label htmlFor={`${prefix}-block`}>
        Bolk
        <select
          id={`${prefix}-block`}
          name="block"
          required
          defaultValue={entry?.block ?? ""}
          className={selectClass}
        >
          <option value="" disabled>
            Velg bolk
          </option>
          <option value="1">Bolk 1</option>
          <option value="2">Bolk 2</option>
          <option value="Both">Begge bolker</option>
        </select>
      </label>
    </div>
  );
}
function SchoolServicePanel({
  board,
  scope,
}: {
  board: typeof PlacementBoardResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  const proposal = board.proposal;
  const slots =
    proposal?.status === "Confirmed"
      ? [
          ...new Map(
            proposal.assignments.map((assignment) => [
              `${assignment.schoolId}:${assignment.day}:${assignment.block}`,
              {
                schoolId: assignment.schoolId,
                schoolName: assignment.schoolName,
                day: assignment.day,
                block: assignment.block,
                assignments: [
                  ...new Map(
                    proposal.assignments
                      .filter(
                        (candidate) =>
                          candidate.schoolId === assignment.schoolId &&
                          candidate.day === assignment.day &&
                          candidate.block === assignment.block,
                      )
                      .map((candidate) => [candidate.personId, candidate]),
                  ).values(),
                ],
              },
            ]),
          ).values(),
        ]
      : [];
  return (
    <section className="space-y-4" aria-labelledby="school-service-title">
      <div>
        <h2 id="school-service-title" className="text-xl font-semibold">
          Skolebehov og tjenesteplan
        </h2>
        <p className="text-sm text-muted-foreground">
          Registrer skolens behov, lag et forslag fra aktive plasseringer og bekreft alle avvik før
          planen sendes.
        </p>
      </div>
      {board.demands.map((demand, index) => (
        <CommandForm
          key={`${demand.schoolId}-${demand.day}-${demand.block}`}
          etag={board.etag}
          hidden={{
            ...scope,
            action: "SetDemand",
            schoolId: String(demand.schoolId),
            day: demand.day,
            block: demand.block,
          }}
          label={`Skolebehov ${index + 1}: ${board.schools.find((school) => school.schoolId === demand.schoolId)?.name ?? demand.schoolId}`}
        >
          <p className="font-medium">
            {board.schools.find((school) => school.schoolId === demand.schoolId)?.name ??
              demand.schoolId}{" "}
            — {demand.day}, bolk {demand.block}
          </p>
          <label htmlFor={`demand-${demand.schoolId}-${demand.day}-${demand.block}`}>
            Frivillige som trengs
            <Input
              id={`demand-${demand.schoolId}-${demand.day}-${demand.block}`}
              name="requiredVolunteers"
              type="number"
              min={0}
              step={1}
              required
              defaultValue={demand.requiredVolunteers}
            />
          </label>
          <Button type="submit">Lagre skolebehov</Button>
        </CommandForm>
      ))}
      <CommandForm
        etag={board.etag}
        hidden={{ ...scope, action: "SetDemand" }}
        label="Nytt skolebehov"
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <label htmlFor="demand-school">
            Skole
            <select id="demand-school" name="schoolId" required className={selectClass}>
              <option value="">Velg skole</option>
              {board.schools.map((school) => (
                <option key={school.schoolId} value={school.schoolId}>
                  {school.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="demand-day">
            Ukedag
            <select id="demand-day" name="day" required className={selectClass}>
              <option value="">Velg dag</option>
              {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day) => (
                <option key={day}>{day}</option>
              ))}
            </select>
          </label>
          <label htmlFor="demand-block">
            Bolk
            <select id="demand-block" name="block" required className={selectClass}>
              <option value="">Velg bolk</option>
              <option value="1">Bolk 1</option>
              <option value="2">Bolk 2</option>
            </select>
          </label>
          <label htmlFor="demand-count">
            Frivillige som trengs
            <Input
              id="demand-count"
              name="requiredVolunteers"
              type="number"
              min={0}
              step={1}
              required
            />
          </label>
        </div>
        <Button type="submit">Legg til skolebehov</Button>
      </CommandForm>
      <CommandForm
        etag={board.etag}
        hidden={{ ...scope, action: "GenerateProposal" }}
        label="Lag nytt tjenesteforslag"
      >
        <Button type="submit">Lag forslag fra aktive plasseringer</Button>
      </CommandForm>
      {proposal && (
        <article className="space-y-4 rounded-lg border p-4" data-proposal-id={proposal.proposalId}>
          <h3 className="font-semibold">
            Nyeste tjenesteforslag — {proposal.status === "Draft" ? "utkast" : "bekreftet"}
          </h3>
          <p>
            {proposal.assignments.length} planlagte oppmøter, {proposal.exceptions.length} avvik.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {proposal.assignments.map((assignment) => (
              <li
                key={`${assignment.schoolId}-${assignment.day}-${assignment.block}-${assignment.personId}`}
              >
                {assignment.schoolName}, {assignment.day}, bolk {assignment.block}:{" "}
                {assignment.firstName} {assignment.lastName}
              </li>
            ))}
          </ul>
          {proposal.status === "Draft" && (
            <CommandForm
              etag={board.etag}
              hidden={{ ...scope, action: "ConfirmProposal", proposalId: proposal.proposalId }}
              label="Bekreft tjenesteforslag"
            >
              {proposal.exceptions.map((exception) => (
                <label key={exception.exceptionId} className="flex items-start gap-2">
                  <input type="checkbox" name="reviewedExceptionId" value={exception.exceptionId} />
                  <span>
                    Gjennomgått: {exception.schoolName}, {exception.day}, bolk {exception.block} —{" "}
                    {exception.assignedVolunteers} av {exception.requiredVolunteers} frivillige.
                  </span>
                </label>
              ))}
              <Button type="submit">Bekreft og send tjenesteplan</Button>
            </CommandForm>
          )}
          {proposal.status === "Confirmed" && (
            <>
              <div>
                <h4 className="font-medium">Varslinger</h4>
                <ul className="list-disc pl-5">
                  {board.notifications.map((notification) => (
                    <li key={notification.effectId}>
                      {notification.personId}: {notification.status}
                      {notification.attempts > 0 ? ` (${notification.attempts} forsøk)` : ""}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-4">
                <h4 className="font-medium">Registrer gjennomført undervisning</h4>
                {slots.map((slot, index) => (
                  <CommandForm
                    key={`${slot.schoolId}-${slot.day}-${slot.block}`}
                    etag={board.etag}
                    hidden={{
                      ...scope,
                      action: "RecordOccurrence",
                      proposalId: proposal.proposalId,
                      schoolId: String(slot.schoolId),
                      day: slot.day,
                      block: slot.block,
                    }}
                    label={`Undervisning ${index + 1}: ${slot.schoolName}`}
                  >
                    <p>
                      {slot.schoolName} — {slot.day}, bolk {slot.block}
                    </p>
                    <label htmlFor={`occurred-${slot.schoolId}-${slot.day}-${slot.block}`}>
                      Dato
                      <Input
                        id={`occurred-${slot.schoolId}-${slot.day}-${slot.block}`}
                        name="occurredOn"
                        type="date"
                        required
                      />
                    </label>
                    {slot.assignments.map((assignment) => (
                      <label key={assignment.personId} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name="attendedPersonId"
                          value={assignment.personId}
                        />
                        {assignment.firstName} {assignment.lastName} møtte
                      </label>
                    ))}
                    <Button type="submit">Registrer undervisning</Button>
                  </CommandForm>
                ))}
              </div>
              {board.occurrences.length > 0 && (
                <div>
                  <h4 className="font-medium">Registrert undervisning</h4>
                  <ul className="list-disc pl-5">
                    {board.occurrences.map((occurrence) => (
                      <li key={occurrence.occurrenceId}>
                        {occurrence.schoolName}, {occurrence.occurredOn}, bolk {occurrence.block}:{" "}
                        {occurrence.attendedPersonIds.length} møtte
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </article>
      )}
    </section>
  );
}
export default function Assistenter() {
  const { scopes, own, board, departmentId, semesterId, error } = useLoaderData<typeof loader>();
  const scope = { departmentId, semesterId };
  return (
    <section
      aria-labelledby="placement-title"
      className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6"
    >
      <h1 id="placement-title" className="text-2xl font-semibold">
        Frivilligtilknytning og skoleplassering
      </h1>
      <p>
        Be om tilknytning til en avdeling. Avdelingens koordinator godkjenner forespørselen og
        fordeler frivillige på skoler.
      </p>
      {error && <p role="alert">{error}</p>}
      {scopes && (
        <Form method="get" className="grid gap-3 sm:grid-cols-3">
          <label htmlFor="department">
            Avdeling
            <select
              id="department"
              name="departmentId"
              required
              defaultValue={departmentId}
              className={selectClass}
            >
              <option value="" disabled>
                Velg avdeling
              </option>
              {scopes.departments.map((d) => (
                <option key={d.departmentId} value={d.departmentId}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="semester">
            Semester
            <select
              id="semester"
              name="semesterId"
              defaultValue={semesterId}
              className={selectClass}
            >
              <option value="">Velg semester for plassering</option>
              {scopes.semesters.map((s) => (
                <option key={s.semesterId} value={s.semesterId}>
                  {substituteSemesterLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" className="self-end">
            Vis valgt avdeling
          </Button>
        </Form>
      )}
      {own && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-lg font-semibold">Min frivilligtilknytning</h2>
          <p>Status: {statusLabel[own.status]}</p>
          <p className="text-sm text-muted-foreground">
            En forespørsel deler navnet ditt med avdelingens koordinatorer. Den endrer ikke
            brukerkontoen din.
          </p>
          <CommandForm
            key={`own-${departmentId}`}
            etag={own.etag}
            own
            hidden={{ departmentId }}
            label="Min tilknytning"
          >
            {(own.status === "Absent" || own.status === "Inactive") && (
              <Button name="action" value="Request">
                Be om tilknytning
              </Button>
            )}
            {own.status === "Pending" && (
              <Button name="action" value="Withdraw" variant="outline">
                Trekk forespørselen
              </Button>
            )}
          </CommandForm>
        </section>
      )}
      {board && (
        <div key={`${departmentId}-${semesterId}`} className="space-y-6">
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">Frivillige i avdelingen</h2>
            {!board.affiliations.length && <p>Ingen forespørsler eller tilknytninger ennå.</p>}
            {board.affiliations.map((a, index) => (
              <article key={a.personId} className="space-y-2 rounded-lg border p-4">
                <h3 className="font-semibold">
                  {a.firstName} {a.lastName}
                </h3>
                <p>{statusLabel[a.status]}</p>
                <CommandForm
                  etag={board.etag}
                  hidden={{ ...scope, action: "Affiliation", personId: a.personId }}
                  label={`Tilknytning ${index + 1}: ${a.firstName} ${a.lastName}`}
                >
                  <div className="flex flex-wrap gap-3">
                    {a.status === "Pending" && (
                      <>
                        <Button name="transition" value="Establish">
                          Godkjenn tilknytning
                        </Button>
                        <Button name="transition" value="Reject" variant="outline">
                          Avslå forespørsel
                        </Button>
                      </>
                    )}
                    {a.status === "Active" && (
                      <Button name="transition" value="Revoke" variant="outline">
                        Avslutt tilknytning
                      </Button>
                    )}
                  </div>
                </CommandForm>
              </article>
            ))}
          </section>
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="text-xl font-semibold">Ny skoleplassering</h2>
            <CommandForm
              etag={board.etag}
              hidden={{ ...scope, action: "Create" }}
              label="Ny skoleplassering"
            >
              <label htmlFor="new-person">
                Frivillig
                <select
                  id="new-person"
                  name="personId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    Velg aktiv frivillig
                  </option>
                  {board.affiliations
                    .filter((a) => a.status === "Active")
                    .map((a) => (
                      <option key={a.personId} value={a.personId}>
                        {a.firstName} {a.lastName}
                      </option>
                    ))}
                </select>
              </label>
              <PlacementFields board={board} />
              <Button type="submit">Opprett plassering</Button>
            </CommandForm>
          </section>
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">Plasseringer i valgt semester</h2>
            {!board.placements.length && <p>Ingen plasseringer i dette semesteret.</p>}
            {board.placements.map((p, index) => (
              <article
                key={p.placementId}
                data-placement-id={p.placementId}
                className="space-y-3 rounded-lg border p-4"
              >
                <h3 className="font-semibold">
                  {p.firstName} {p.lastName} — {p.schoolName}
                </h3>
                {!p.active && <p>Fjernet — historikken er bevart.</p>}
                <CommandForm
                  etag={board.etag}
                  hidden={{ ...scope, placementId: p.placementId }}
                  label={`Plassering ${index + 1}: ${p.firstName} ${p.lastName}, ${p.schoolName}, bolk ${p.block === "Both" ? "1 og 2" : p.block}, ${p.active ? "aktiv" : "fjernet"}`}
                >
                  <PlacementFields board={board} entry={p} />
                  <div className="flex flex-wrap gap-3">
                    <Button name="action" value="Edit" disabled={!p.active}>
                      Lagre plassering
                    </Button>
                    <Button
                      name="action"
                      value="Remove"
                      variant="outline"
                      formNoValidate
                      disabled={!p.active}
                    >
                      Fjern plassering
                    </Button>
                  </div>
                </CommandForm>
              </article>
            ))}
          </section>
          <SchoolServicePanel board={board} scope={scope} />
        </div>
      )}
    </section>
  );
}
