import {
  AffiliationScope,
  CoverageCommand,
  IdempotencyIfMatchHeaders,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementScope,
  type CoverageBoardResource,
  type OwnAffiliationResource,
  type OwnCoverageResource,
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
    let ownCoverage: typeof OwnCoverageResource.Type | null = null;
    let coverage: typeof CoverageBoardResource.Type | null = null;
    if (departmentId) {
      const scope = Schema.decodeUnknownSync(AffiliationScope)({ departmentId });
      own = (await client.placements.readOwnAffiliation({ query: scope })).body;
    }
    if (departmentId && semesterId) {
      const scope = Schema.decodeUnknownSync(PlacementScope)({ departmentId, semesterId });
      ownCoverage = (await client.placements.readOwnCoverage({ query: scope })).body;
      if (
        scopes.departments.some(
          (department) => department.departmentId === departmentId && department.canManage,
        )
      ) {
        const [placement, coverageBoard] = await Promise.all([
          client.placements.readBoard({ query: scope }),
          client.placements.readCoverageBoard({ query: scope }),
        ]);
        board = placement.body;
        coverage = coverageBoard.body;
      }
    }
    return privateData({
      scopes,
      own,
      board,
      ownCoverage,
      coverage,
      departmentId,
      semesterId,
      error: null as string | null,
    });
  } catch {
    return privateData({
      scopes: null,
      own: null,
      board: null,
      ownCoverage: null,
      coverage: null,
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
    if (action === "Request" || action === "Withdraw") {
      await client.placements.commandOwnAffiliation({
        query: Schema.decodeUnknownSync(AffiliationScope)({ departmentId }),
        headers,
        payload: Schema.decodeUnknownSync(OwnAffiliationCommand)(
          { action },
          { onExcessProperty: "error" },
        ),
      });
    } else if (action === "ReportAbsence" || action === "RespondToOffer") {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });
      const payload = Schema.decodeUnknownSync(OwnCoverageCommand)(
        action === "ReportAbsence"
          ? {
              action,
              proposalId: form.get("proposalId"),
              schoolId: Number(form.get("schoolId")),
              day: form.get("day"),
              block: form.get("block"),
              serviceDate: form.get("serviceDate"),
            }
          : {
              action,
              offerId: form.get("offerId"),
              response: form.get("response"),
            },
        { onExcessProperty: "error" },
      );
      switch (payload.action) {
        case "ReportAbsence":
          await client.placements.commandOwnCoverage({ query, headers, payload });
          break;
        case "RespondToOffer":
          await client.placements.commandOwnCoverage({ query, headers, payload });
          break;
      }
    } else if (
      action === "ReportAbsenceForVolunteer" ||
      action === "DispatchSubstituteOffer" ||
      action === "WithdrawSubstituteOffer" ||
      action === "AcknowledgeCoverage" ||
      action === "CloseCoverage"
    ) {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });
      const payload = Schema.decodeUnknownSync(CoverageCommand)(
        action === "ReportAbsenceForVolunteer"
          ? {
              action,
              personId: form.get("personId"),
              proposalId: form.get("proposalId"),
              schoolId: Number(form.get("schoolId")),
              day: form.get("day"),
              block: form.get("block"),
              serviceDate: form.get("serviceDate"),
            }
          : action === "DispatchSubstituteOffer"
            ? {
                action,
                absenceId: form.get("absenceId"),
                candidatePersonId: form.get("candidatePersonId"),
              }
            : action === "WithdrawSubstituteOffer" || action === "AcknowledgeCoverage"
              ? {
                  action,
                  offerId: form.get("offerId"),
                }
              : {
                  action,
                  proposalId: form.get("proposalId"),
                  schoolId: Number(form.get("schoolId")),
                  day: form.get("day"),
                  block: form.get("block"),
                  occurredOn: form.get("occurredOn"),
                  attendedPersonIds: form.getAll("attendedPersonId"),
                },
        { onExcessProperty: "error" },
      );
      switch (payload.action) {
        case "ReportAbsenceForVolunteer":
          await client.placements.commandCoverageBoard({ query, headers, payload });
          break;
        case "DispatchSubstituteOffer":
          await client.placements.commandCoverageBoard({ query, headers, payload });
          break;
        case "WithdrawSubstituteOffer":
          await client.placements.commandCoverageBoard({ query, headers, payload });
          break;
        case "AcknowledgeCoverage":
          await client.placements.commandCoverageBoard({ query, headers, payload });
          break;
        case "CloseCoverage":
          await client.placements.commandCoverageBoard({ query, headers, payload });
          break;
      }
    } else {
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
      "resource.not-found":
        "Den valgte fraværssaken eller det valgte vikartilbudet finnes ikke lenger. Hent oppdatert oversikt.",
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
      "absence.target-invalid": "Fravær kan bare meldes for et bekreftet oppmøte på riktig dato.",
      "absence.duplicate": "Fravær er allerede meldt for dette oppmøtet. Hent oppdatert oversikt.",
      "absence.closed": "Denne fraværssaken er allerede avsluttet og kan ikke endres.",
      "offer.candidate-ineligible":
        "Vikaren er ikke lenger kvalifisert for dette oppmøtet. Hent oppdatert oversikt.",
      "offer.unresolved":
        "Det finnes allerede et uavklart eller bekreftet vikartilbud for dette fraværet.",
      "offer.owner-invalid": "Dette vikartilbudet er adressert til en annen person.",
      "offer.response-invalid":
        "Tilbudet kan ikke besvares fordi det allerede er avsluttet eller trukket tilbake.",
      "offer.withdraw-invalid":
        "Bare et sendt eller akseptert tilbud kan trekkes tilbake før dekningen er bekreftet.",
      "coverage.acknowledgement-invalid":
        "Bare det gjeldende aksepterte tilbudet kan bekreftes som dekning.",
      "coverage.pending-offer":
        "Et sendt eller akseptert tilbud må avslås, trekkes tilbake eller bekreftes før tjenesten kan lukkes.",
      "coverage.attendance-invalid":
        "Oppmøtet må være nøyaktig den bekreftede planen minus fravær pluss bekreftede vikarer.",
      "coverage.occurrence-duplicate": "Tjenesten er allerede lukket for denne datoen og bolken.",
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
type RefreshResource = "own" | "board" | "ownCoverage" | "coverage";
function CommandForm({
  etag,
  refreshResource = "board",
  children,
  label,
  hidden,
}: {
  etag: string;
  refreshResource?: RefreshResource;
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
  const refreshed = refresh.data?.[refreshResource] ?? null;
  const refreshedSummary =
    refreshed === null
      ? null
      : "placements" in refreshed
        ? `Oppdatert oversikt: ${refreshed.placements.filter((placement) => placement.active).length} aktive plasseringer. ${refreshed.placements
            .filter((placement) => placement.active)
            .map(
              (placement) =>
                `${placement.firstName} ${placement.lastName}: ${placement.schoolName}, ${placement.day}, bolk ${placement.block}, ${placement.workdays} dager`,
            )
            .join("; ")}`
        : "rosterSlots" in refreshed
          ? `Oppdatert egen dekning: ${refreshed.rosterSlots.length} planlagte oppmøter, ${refreshed.absences.length} registrerte fravær og ${refreshed.offers.length} vikartilbud.`
          : "candidates" in refreshed
            ? `Oppdatert dekningsoversikt: ${refreshed.absences.length} fravær, ${refreshed.offers.length} tilbud og ${refreshed.closures.length} avsluttede dekninger.`
            : `Oppdatert status: ${statusLabel[refreshed.status]}`;
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
              {refreshedSummary && <p className="min-w-0 break-words">{refreshedSummary}</p>}
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
type PlacementProposal = NonNullable<(typeof PlacementBoardResource.Type)["proposal"]>;
type PlacementAssignment = PlacementProposal["assignments"][number];
type ConfirmedSlot = Pick<PlacementAssignment, "schoolId" | "schoolName" | "day" | "block"> & {
  readonly assignments: ReadonlyArray<PlacementAssignment>;
};
type ConfirmedSlotBuilder = Pick<
  PlacementAssignment,
  "schoolId" | "schoolName" | "day" | "block"
> & {
  readonly assignments: Map<PlacementAssignment["personId"], PlacementAssignment>;
};
function confirmedSlots(
  proposal: (typeof PlacementBoardResource.Type)["proposal"],
): ReadonlyArray<ConfirmedSlot> {
  if (proposal?.status !== "Confirmed") return [];
  const slots = new Map<string, ConfirmedSlotBuilder>();
  for (const assignment of proposal.assignments) {
    const key = `${assignment.schoolId}:${assignment.day}:${assignment.block}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        schoolId: assignment.schoolId,
        schoolName: assignment.schoolName,
        day: assignment.day,
        block: assignment.block,
        assignments: new Map(),
      };
      slots.set(key, slot);
    }
    slot.assignments.set(assignment.personId, assignment);
  }
  return [...slots.values()].map(({ assignments, ...slot }) => ({
    ...slot,
    assignments: [...assignments.values()],
  }));
}
function SchoolServicePanel({
  board,
  scope,
}: {
  board: typeof PlacementBoardResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  const proposal = board.proposal;
  const slots = confirmedSlots(proposal);
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
const deliveryStatusLabel = {
  Pending: "Venter på levering",
  Processing: "Leveres",
  Delivered: "Levert",
  Failed: "Levering feilet",
  Quarantined: "Levering stoppet",
} as const;
const offerStatusLabel = {
  Offered: "Sendt og venter på svar",
  Accepted: "Akseptert",
  Declined: "Avslått",
  Withdrawn: "Trukket tilbake",
  Acknowledged: "Bekreftet som dekning",
} as const;
const responseStatusLabel = {
  Accept: "Akseptert",
  Decline: "Avslått",
} as const;
const closureOutcomeLabel = {
  Covered: "Dekket",
  Uncovered: "Ikke dekket",
} as const;
type CoverageAbsence = (typeof CoverageBoardResource.Type)["absences"][number];
type CoverageOffer = (typeof CoverageBoardResource.Type)["offers"][number];
type CoverageResponse = (typeof CoverageBoardResource.Type)["responses"][number];
type CoverageAcknowledgement = (typeof CoverageBoardResource.Type)["acknowledgements"][number];
type CoverageClosure = (typeof CoverageBoardResource.Type)["closures"][number];
type CoverageCandidate = (typeof CoverageBoardResource.Type)["candidates"][number];
type CoverageNotification = (typeof CoverageBoardResource.Type)["dispatchNotifications"][number];
type CoverageSlotIdentity = Pick<CoverageAbsence, "proposalId" | "schoolId" | "day" | "block">;
type CoverageRosterAssignment = (typeof CoverageBoardResource.Type)["rosterAssignments"][number];
type CoverageConfirmedSlot = ConfirmedSlot & {
  readonly proposalId: CoverageRosterAssignment["proposalId"];
};
function coverageConfirmedSlots(
  assignments: ReadonlyArray<CoverageRosterAssignment>,
): ReadonlyArray<CoverageConfirmedSlot> {
  const slots = new Map<
    string,
    Omit<CoverageConfirmedSlot, "assignments"> & {
      readonly assignments: Map<CoverageRosterAssignment["personId"], CoverageRosterAssignment>;
    }
  >();
  for (const assignment of assignments) {
    const key = coverageSlotKey(assignment);
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        proposalId: assignment.proposalId,
        schoolId: assignment.schoolId,
        schoolName: assignment.schoolName,
        day: assignment.day,
        block: assignment.block,
        assignments: new Map(),
      };
      slots.set(key, slot);
    }
    slot.assignments.set(assignment.personId, assignment);
  }
  return [...slots.values()].map(({ assignments: slotAssignments, ...slot }) => ({
    ...slot,
    assignments: [...slotAssignments.values()],
  }));
}
const coverageSlotKey = (slot: CoverageSlotIdentity): string =>
  `${slot.proposalId}:${slot.schoolId}:${slot.day}:${slot.block}`;
function deliverySummary(notification: CoverageNotification | undefined): string {
  if (notification === undefined) return "Venter på leveringsstatus";
  const attempts = notification.attempts === 1 ? "1 forsøk" : `${notification.attempts} forsøk`;
  const failure =
    notification.lastFailureTag === null ? "" : `, siste feil: ${notification.lastFailureTag}`;
  return `${deliveryStatusLabel[notification.status]} (${attempts}${failure})`;
}
function OfferLifecycle({
  offer,
  response,
  notification,
  acknowledgement,
  showCandidate = false,
}: {
  offer: CoverageOffer;
  response: CoverageResponse | undefined;
  notification: CoverageNotification | undefined;
  acknowledgement: CoverageAcknowledgement | undefined;
  showCandidate?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1 break-words text-sm">
      {showCandidate && (
        <p>
          Vikar: {offer.candidateFirstName} {offer.candidateLastName}
        </p>
      )}
      <p>Tilbudstatus: {offerStatusLabel[offer.status]}</p>
      <p>Levering: {deliverySummary(notification)}</p>
      {response && <p>Endelig svar: {responseStatusLabel[response.response]}</p>}
      {acknowledgement && <p>Dekningen er bekreftet av koordinator.</p>}
    </div>
  );
}
function OwnCoveragePanel({
  coverage,
  scope,
}: {
  coverage: typeof OwnCoverageResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  const responsesByOfferId = new Map<string, CoverageResponse>();
  for (const response of coverage.responses) responsesByOfferId.set(response.offerId, response);
  const notificationsByOfferId = new Map<string, CoverageNotification>();
  for (const notification of coverage.dispatchNotifications)
    notificationsByOfferId.set(notification.offerId, notification);
  return (
    <section
      className="min-w-0 space-y-5 rounded-lg border p-4 sm:p-6"
      aria-labelledby="own-coverage-title"
    >
      <header>
        <h2 id="own-coverage-title" className="text-xl font-semibold">
          Min fravær og vikardekning
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Her vises bare dine bekreftede oppmøter, fravær og vikartilbud som er adressert til deg.
        </p>
      </header>
      <section className="space-y-3" aria-labelledby="own-roster-title">
        <h3 id="own-roster-title" className="font-semibold">
          Bekreftede oppmøter
        </h3>
        {coverage.rosterSlots.length === 0 && (
          <p>Du har ingen bekreftede oppmøter i valgt semester.</p>
        )}
        {coverage.rosterSlots.map((slot) => {
          const slotId = `${slot.proposalId}-${slot.schoolId}-${slot.day}-${slot.block}`;
          return (
            <article key={slotId} className="min-w-0 space-y-3 rounded-md border p-4">
              <h4 className="break-words font-medium">
                {slot.schoolName} — {slot.day}, bolk {slot.block}
              </h4>
              <CommandForm
                etag={coverage.etag}
                refreshResource="ownCoverage"
                hidden={{
                  ...scope,
                  action: "ReportAbsence",
                  proposalId: slot.proposalId,
                  schoolId: String(slot.schoolId),
                  day: slot.day,
                  block: slot.block,
                }}
                label={`Fravær: ${slot.schoolName}, ${slot.day}, bolk ${slot.block}, tjenesteplan ${slot.proposalId.slice(-8)}`}
              >
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <label htmlFor={`own-absence-date-${slotId}`} className="min-w-0">
                    Dato
                    <Input
                      id={`own-absence-date-${slotId}`}
                      name="serviceDate"
                      type="date"
                      required
                    />
                  </label>
                </div>
                <Button type="submit">Rapporter fravær</Button>
              </CommandForm>
            </article>
          );
        })}
      </section>
      <section className="space-y-3" aria-labelledby="own-absences-title">
        <h3 id="own-absences-title" className="font-semibold">
          Registrerte fravær
        </h3>
        {coverage.absences.length === 0 && <p>Du har ikke registrert fravær i valgt semester.</p>}
        {coverage.absences.map((absence) => (
          <article key={absence.absenceId} className="min-w-0 rounded-md border p-4">
            <p className="break-words">
              {absence.schoolName}, {absence.serviceDate} — {absence.day}, bolk {absence.block}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Fraværet er registrert.</p>
          </article>
        ))}
      </section>
      <section className="space-y-3" aria-labelledby="own-offers-title">
        <h3 id="own-offers-title" className="font-semibold">
          Mine vikartilbud
        </h3>
        {coverage.offers.length === 0 && <p>Du har ingen vikartilbud i valgt semester.</p>}
        {coverage.offers.map((offer) => {
          const response = responsesByOfferId.get(offer.offerId);
          const notification = notificationsByOfferId.get(offer.offerId);
          return (
            <article key={offer.offerId} className="min-w-0 space-y-3 rounded-md border p-4">
              <h4 className="break-words font-medium">
                {offer.schoolName}, {offer.serviceDate} — {offer.day}, bolk {offer.block}
              </h4>
              <OfferLifecycle
                offer={offer}
                response={response}
                notification={notification}
                acknowledgement={undefined}
              />
              {offer.status === "Offered" && (
                <CommandForm
                  etag={coverage.etag}
                  refreshResource="ownCoverage"
                  hidden={{ ...scope, action: "RespondToOffer", offerId: offer.offerId }}
                  label={`Vikartilbud: ${offer.schoolName}, ${offer.serviceDate}, bolk ${offer.block}`}
                >
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" name="response" value="Accept">
                      Aksepter tilbud
                    </Button>
                    <Button type="submit" name="response" value="Decline" variant="outline">
                      Avslå tilbud
                    </Button>
                  </div>
                </CommandForm>
              )}
            </article>
          );
        })}
      </section>
    </section>
  );
}
function CoverageCloseForm({
  coverage,
  scope,
  proposalId,
  slot,
  absences,
  offersById,
  closuresByAbsenceId,
}: {
  coverage: typeof CoverageBoardResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
  proposalId: CoverageAbsence["proposalId"];
  slot: ConfirmedSlot;
  absences: ReadonlyArray<CoverageAbsence>;
  offersById: ReadonlyMap<string, CoverageOffer>;
  closuresByAbsenceId: ReadonlyMap<string, CoverageClosure>;
}) {
  const serviceDate = absences[0]?.serviceDate;
  if (
    serviceDate === undefined ||
    absences.some((absence) => closuresByAbsenceId.has(absence.absenceId))
  ) {
    return null;
  }
  const absenceIds = new Set(absences.map((absence) => absence.absenceId));
  const absentPeople = new Set(absences.map((absence) => absence.personId));
  const expectedByPersonId = new Map<
    string,
    { readonly personId: string; readonly label: string }
  >();
  for (const assignment of slot.assignments) {
    if (!absentPeople.has(assignment.personId)) {
      expectedByPersonId.set(assignment.personId, {
        personId: assignment.personId,
        label: `${assignment.firstName} ${assignment.lastName}`,
      });
    }
  }
  for (const acknowledgement of coverage.acknowledgements) {
    if (!absenceIds.has(acknowledgement.absenceId)) continue;
    const offer = offersById.get(acknowledgement.offerId);
    expectedByPersonId.set(acknowledgement.candidatePersonId, {
      personId: acknowledgement.candidatePersonId,
      label:
        offer === undefined
          ? "Bekreftet vikar"
          : `${offer.candidateFirstName} ${offer.candidateLastName} (vikar)`,
    });
  }
  const pendingOffer = coverage.offers.some(
    (offer) =>
      absenceIds.has(offer.absenceId) &&
      (offer.status === "Offered" || offer.status === "Accepted"),
  );
  const attendance = [...expectedByPersonId.values()];
  const formId = `${slot.schoolId}-${slot.day}-${slot.block}-${serviceDate}`;
  return (
    <article className="min-w-0 space-y-3 rounded-md border p-4">
      <h4 className="break-words font-medium">
        {slot.schoolName}, {serviceDate} — {slot.day}, bolk {slot.block}
      </h4>
      {pendingOffer ? (
        <p role="status">
          Et sendt eller akseptert vikartilbud må avslås, trekkes tilbake eller bekreftes før
          tjenesten kan lukkes.
        </p>
      ) : (
        <CommandForm
          etag={coverage.etag}
          refreshResource="coverage"
          hidden={{
            ...scope,
            action: "CloseCoverage",
            proposalId,
            schoolId: String(slot.schoolId),
            day: slot.day,
            block: slot.block,
            occurredOn: serviceDate,
          }}
          label={`Tjenestelukking: ${slot.schoolName}, ${serviceDate}, bolk ${slot.block}, tjenesteplan ${proposalId.slice(-8)}`}
        >
          <p className="text-sm text-muted-foreground">
            Valgene er beregnet fra den bekreftede planen, registrert fravær og bekreftet
            vikardekning. Oppmøtet må være nøyaktig likt disse valgene.
          </p>
          {attendance.length === 0 ? (
            <p>Ingen skal registreres som møtt for denne tjenesten.</p>
          ) : (
            <div className="space-y-2">
              {attendance.map((person) => (
                <label
                  key={person.personId}
                  htmlFor={`coverage-attendance-${formId}-${person.personId}`}
                  className="flex min-w-0 items-start gap-2"
                >
                  <input
                    id={`coverage-attendance-${formId}-${person.personId}`}
                    type="checkbox"
                    name="attendedPersonId"
                    value={person.personId}
                    defaultChecked
                  />
                  <span className="min-w-0 break-words">{person.label} møtte</span>
                </label>
              ))}
            </div>
          )}
          <Button type="submit">Lukk tjeneste</Button>
        </CommandForm>
      )}
    </article>
  );
}
function CoordinatorCoveragePanel({
  coverage,
  scope,
}: {
  coverage: typeof CoverageBoardResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  const slots = coverageConfirmedSlots(coverage.rosterAssignments);
  const offersById = new Map<string, CoverageOffer>();
  const offersByAbsenceId = new Map<string, Array<CoverageOffer>>();
  for (const offer of coverage.offers) {
    offersById.set(offer.offerId, offer);
    const offers = offersByAbsenceId.get(offer.absenceId);
    if (offers === undefined) offersByAbsenceId.set(offer.absenceId, [offer]);
    else offers.push(offer);
  }
  const responsesByOfferId = new Map<string, CoverageResponse>();
  for (const response of coverage.responses) responsesByOfferId.set(response.offerId, response);
  const notificationsByOfferId = new Map<string, CoverageNotification>();
  for (const notification of coverage.dispatchNotifications)
    notificationsByOfferId.set(notification.offerId, notification);
  const acknowledgementsByOfferId = new Map<string, CoverageAcknowledgement>();
  for (const acknowledgement of coverage.acknowledgements)
    acknowledgementsByOfferId.set(acknowledgement.offerId, acknowledgement);
  const closuresByAbsenceId = new Map<string, CoverageClosure>();
  for (const closure of coverage.closures) closuresByAbsenceId.set(closure.absenceId, closure);
  const candidatesByAbsenceId = new Map<string, Array<CoverageCandidate>>();
  for (const candidate of coverage.candidates) {
    const candidates = candidatesByAbsenceId.get(candidate.absenceId);
    if (candidates === undefined) candidatesByAbsenceId.set(candidate.absenceId, [candidate]);
    else candidates.push(candidate);
  }
  const slotsByKey = new Map<string, ConfirmedSlot>(
    slots.map((slot) => [coverageSlotKey(slot), slot]),
  );
  const closureGroups = new Map<
    string,
    {
      readonly proposalId: CoverageAbsence["proposalId"];
      readonly serviceDate: CoverageAbsence["serviceDate"];
      readonly slot: ConfirmedSlot;
      readonly absences: CoverageAbsence[];
    }
  >();
  for (const absence of coverage.absences) {
    const slot = slotsByKey.get(coverageSlotKey(absence));
    if (slot === undefined) continue;
    const key = `${coverageSlotKey(absence)}:${absence.serviceDate}`;
    const group = closureGroups.get(key);
    if (group === undefined) {
      closureGroups.set(key, {
        proposalId: absence.proposalId,
        serviceDate: absence.serviceDate,
        slot,
        absences: [absence],
      });
    } else {
      group.absences.push(absence);
    }
  }
  const openClosureGroups = [...closureGroups.values()].filter((group) =>
    group.absences.every((absence) => !closuresByAbsenceId.has(absence.absenceId)),
  );
  return (
    <section
      className="min-w-0 space-y-5 rounded-lg border p-4 sm:p-6"
      aria-labelledby="coverage-board-title"
    >
      <header>
        <h2 id="coverage-board-title" className="text-xl font-semibold">
          Fravær og vikardekning
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Koordinatorer kan velge kvalifiserte vikarer, følge leveringen og lukke en tjeneste med
          nøyaktig oppmøte.
        </p>
      </header>
      <section className="space-y-3" aria-labelledby="coordinator-absence-title">
        <h3 id="coordinator-absence-title" className="font-semibold">
          Rapporter fravær for frivillig
        </h3>
        {slots.length === 0 ? (
          <p>En bekreftet tjenesteplan må være tilgjengelig før fravær kan rapporteres.</p>
        ) : (
          <>
            {slots.map((slot) => {
              const slotId = `${slot.proposalId}-${slot.schoolId}-${slot.day}-${slot.block}`;
              return (
                <CommandForm
                  key={slotId}
                  etag={coverage.etag}
                  refreshResource="coverage"
                  hidden={{
                    ...scope,
                    action: "ReportAbsenceForVolunteer",
                    proposalId: slot.proposalId,
                    schoolId: String(slot.schoolId),
                    day: slot.day,
                    block: slot.block,
                  }}
                  label={`Fravær: ${slot.schoolName}, ${slot.day}, bolk ${slot.block}, tjenesteplan ${slot.proposalId.slice(-8)}`}
                >
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <label htmlFor={`coordinator-absence-person-${slotId}`} className="min-w-0">
                      Frivillig
                      <select
                        id={`coordinator-absence-person-${slotId}`}
                        name="personId"
                        required
                        defaultValue=""
                        className={selectClass}
                      >
                        <option value="" disabled>
                          Velg frivillig
                        </option>
                        {slot.assignments.map((assignment) => (
                          <option key={assignment.personId} value={assignment.personId}>
                            {assignment.firstName} {assignment.lastName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label htmlFor={`coordinator-absence-date-${slotId}`} className="min-w-0">
                      Dato
                      <Input
                        id={`coordinator-absence-date-${slotId}`}
                        name="serviceDate"
                        type="date"
                        required
                      />
                    </label>
                  </div>
                  <Button type="submit">Rapporter fravær</Button>
                </CommandForm>
              );
            })}
          </>
        )}
      </section>
      <section className="space-y-3" aria-labelledby="coverage-absences-title">
        <h3 id="coverage-absences-title" className="font-semibold">
          Registrert fravær og kvalifiserte vikarer
        </h3>
        {coverage.absences.length === 0 && <p>Det er ikke registrert fravær i valgt semester.</p>}
        {coverage.absences.map((absence) => {
          const candidates = candidatesByAbsenceId.get(absence.absenceId) ?? [];
          const offers = offersByAbsenceId.get(absence.absenceId) ?? [];
          const activeOffer = offers.find(
            (offer) =>
              offer.status === "Offered" ||
              offer.status === "Accepted" ||
              offer.status === "Acknowledged",
          );
          const closure = closuresByAbsenceId.get(absence.absenceId);
          const absenceId = absence.absenceId;
          return (
            <article key={absenceId} className="min-w-0 space-y-3 rounded-md border p-4">
              <h4 className="break-words font-medium">
                {absence.schoolName}, {absence.serviceDate} — {absence.day}, bolk {absence.block}
              </h4>
              {closure ? (
                <p>Utfallet: {closureOutcomeLabel[closure.outcome]}</p>
              ) : activeOffer ? (
                <p>
                  {activeOffer.status === "Acknowledged"
                    ? "Vikardekningen er bekreftet."
                    : "Det finnes allerede et aktivt vikartilbud for dette fraværet."}
                </p>
              ) : candidates.length === 0 ? (
                <p>Ingen kvalifiserte vikarer er tilgjengelige for dette fraværet.</p>
              ) : (
                <CommandForm
                  etag={coverage.etag}
                  refreshResource="coverage"
                  hidden={{ ...scope, action: "DispatchSubstituteOffer", absenceId }}
                  label={`Vikardispatch: ${absenceId}`}
                >
                  <label htmlFor={`coverage-candidate-${absenceId}`} className="min-w-0">
                    Kvalifisert vikar
                    <select
                      id={`coverage-candidate-${absenceId}`}
                      name="candidatePersonId"
                      required
                      defaultValue=""
                      className={selectClass}
                    >
                      <option value="" disabled>
                        Velg kvalifisert vikar
                      </option>
                      {candidates.map((candidate) => (
                        <option key={candidate.personId} value={candidate.personId}>
                          {candidate.firstName} {candidate.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button type="submit">Send vikartilbud</Button>
                </CommandForm>
              )}
            </article>
          );
        })}
      </section>
      <section className="space-y-3" aria-labelledby="coverage-offers-title">
        <h3 id="coverage-offers-title" className="font-semibold">
          Vikartilbud og dekning
        </h3>
        {coverage.offers.length === 0 && <p>Det er ikke sendt vikartilbud i valgt semester.</p>}
        {coverage.offers.map((offer) => {
          const response = responsesByOfferId.get(offer.offerId);
          const notification = notificationsByOfferId.get(offer.offerId);
          const acknowledgement = acknowledgementsByOfferId.get(offer.offerId);
          return (
            <article key={offer.offerId} className="min-w-0 space-y-3 rounded-md border p-4">
              <h4 className="break-words font-medium">
                {offer.schoolName}, {offer.serviceDate} — {offer.day}, bolk {offer.block}
              </h4>
              <OfferLifecycle
                offer={offer}
                response={response}
                notification={notification}
                acknowledgement={acknowledgement}
                showCandidate
              />
              {(offer.status === "Offered" || offer.status === "Accepted") && (
                <CommandForm
                  etag={coverage.etag}
                  refreshResource="coverage"
                  hidden={{ ...scope, offerId: offer.offerId }}
                  label={`Dekningstilbud: ${offer.candidateFirstName} ${offer.candidateLastName}, ${offer.serviceDate}`}
                >
                  <div className="flex flex-wrap gap-3">
                    {offer.status === "Accepted" && (
                      <Button type="submit" name="action" value="AcknowledgeCoverage">
                        Bekreft dekning
                      </Button>
                    )}
                    <Button
                      type="submit"
                      name="action"
                      value="WithdrawSubstituteOffer"
                      variant="outline"
                    >
                      Trekk tilbake tilbud
                    </Button>
                  </div>
                </CommandForm>
              )}
            </article>
          );
        })}
      </section>
      <section className="space-y-3" aria-labelledby="coverage-closure-title">
        <h3 id="coverage-closure-title" className="font-semibold">
          Tjenestelukking
        </h3>
        {slots.length === 0 ? (
          <p>Oppmøtet kan ikke beregnes uten en bekreftet tjenesteplan.</p>
        ) : openClosureGroups.length === 0 ? (
          <p>Det er ingen åpne tjenester med registrert fravær å lukke.</p>
        ) : (
          openClosureGroups.map((group) => (
            <CoverageCloseForm
              key={`${group.proposalId}:${group.slot.schoolId}:${group.slot.day}:${group.slot.block}:${group.serviceDate}`}
              coverage={coverage}
              scope={scope}
              proposalId={group.proposalId}
              slot={group.slot}
              absences={group.absences}
              offersById={offersById}
              closuresByAbsenceId={closuresByAbsenceId}
            />
          ))
        )}
        {coverage.closures.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium">Avsluttede tjenester</h4>
            <ul className="space-y-1">
              {coverage.closures.map((closure) => {
                const absence = coverage.absences.find(
                  (candidate) => candidate.absenceId === closure.absenceId,
                );
                return (
                  <li key={closure.closureId} className="break-words">
                    {absence === undefined
                      ? "Fraværssak"
                      : `${absence.schoolName}, ${absence.serviceDate}, bolk ${absence.block}`}
                    : {closureOutcomeLabel[closure.outcome]}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </section>
  );
}
export default function Assistenter() {
  const { scopes, own, board, ownCoverage, coverage, departmentId, semesterId, error } =
    useLoaderData<typeof loader>();
  const scope = { departmentId, semesterId };
  return (
    <section
      aria-labelledby="placement-title"
      className="mx-auto w-full min-w-0 max-w-5xl space-y-6 p-4 sm:p-6"
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
            refreshResource="own"
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
      {ownCoverage && <OwnCoveragePanel coverage={ownCoverage} scope={scope} />}
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
      {coverage && <CoordinatorCoveragePanel coverage={coverage} scope={scope} />}
    </section>
  );
}
