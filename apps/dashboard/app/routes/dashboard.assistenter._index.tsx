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
  type PlacementDraftResource,
} from "@vektorprogrammet/http-api";
import { Record, Option, Schema, Match } from "effect";
import { createElement, type ReactNode, useState } from "react";
import { Form, data, useActionData, useFetcher, useLoaderData, useLocation } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import { semesterLabel } from "../lib/semester-label";
import { DATED_SERVICE_ELEMENT } from "../foldkit/dated-school-service/elements";
import type { Route } from "./+types/dashboard.assistenter._index";

const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "private, no-store" } });

/** One chosen draft placement: the JSON of the Create command that applies it. */
const DraftPlacementChoice = Schema.fromJsonString(PlacementCommand);

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
    let draft: typeof PlacementDraftResource.Type | null = null;

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

        if (q.get("draft") === "1") {
          draft = (await client.placements.readDraft({ query: scope })).body;
        }
      }
    }

    return privateData({
      scopes,
      own,
      board,
      draft,
      ownCoverage,
      coverage,
      departmentId,
      semesterId,
      error: null,
    });
  } catch {
    return privateData({
      scopes: null,
      own: null,
      board: null,
      draft: null,
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
    // RecordCoverage and WithdrawCoverage exist for both the owner and the coordinator.
    const mode = form.get("mode");

    if (action === "Request" || action === "Withdraw") {
      await client.placements.commandOwnAffiliation({
        query: Schema.decodeUnknownSync(AffiliationScope)({ departmentId }),
        headers,
        payload: Schema.decodeUnknownSync(OwnAffiliationCommand)(
          { action },
          { onExcessProperty: "error" },
        ),
      });
    } else if (mode === "ownCoverage") {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });

      const payload = Schema.decodeUnknownSync(OwnCoverageCommand)(
        Match.value(action).pipe(
          Match.when("ReportAbsence", (action) => ({
            action,
            commitmentId: form.get("commitmentId"),
          })),
          Match.when("RecordCoverage", (action) => ({
            action,
            absenceId: form.get("absenceId"),
            coveringPersonId: form.get("coveringPersonId"),
          })),
          Match.orElse((action) => ({ action, absenceId: form.get("absenceId") })),
        ),
        { onExcessProperty: "error" },
      );

      await client.placements.commandOwnCoverage({ query, headers, payload });
    } else if (mode === "coverage") {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });

      const payload = Schema.decodeUnknownSync(CoverageCommand)(
        Match.value(action).pipe(
          Match.when("ReportAbsenceForVolunteer", (action) => ({
            action,
            commitmentId: form.get("commitmentId"),
            personId: form.get("personId"),
          })),
          Match.when("RecordCoverage", (action) => ({
            action,
            absenceId: form.get("absenceId"),
            coveringPersonId: form.get("coveringPersonId"),
          })),
          Match.when("WithdrawCoverage", (action) => ({
            action,
            absenceId: form.get("absenceId"),
          })),
          Match.when("CompleteService", (action) => ({
            action,
            commitmentId: form.get("commitmentId"),
            evidenceSource: form.get("evidenceSource"),
          })),
          Match.orElse((action) => ({
            action,
            commitmentId: form.get("commitmentId"),
            reason: form.get("reason"),
            evidenceSource: form.get("evidenceSource"),
          })),
        ),
        { onExcessProperty: "error" },
      );

      await client.placements.commandCoverageBoard({ query, headers, payload });
    } else {
      const query = Schema.decodeUnknownSync(PlacementScope)({
        departmentId,
        semesterId: form.get("semesterId"),
      });

      if (action === "ApplyDraft") {
        const choices = form.getAll("draftPlacement");
        let etag = headers["if-match"];

        // Each chosen placement is one Create command against the board version the last one left.
        for (const [index, choice] of choices.entries()) {
          const payload = Schema.decodeUnknownSync(DraftPlacementChoice)(choice, {
            onExcessProperty: "error",
          });

          if (payload.action !== "Create") throw new Error("A draft choice creates a placement");

          const response = await client.placements.commandBoard({
            query,
            headers: Schema.decodeUnknownSync(IdempotencyIfMatchHeaders)({
              "if-match": etag,
              "idempotency-key": `${headers["idempotency-key"]}-${index}`,
            }),
            payload,
          });

          etag = response.body.etag;
        }

        return privateData({
          success: true as const,
          message: `${choices.length} ${choices.length === 1 ? "plassering" : "plasseringer"} fra utkastet er opprettet.`,
          conflict: false,
          commandId: String(form.get("commandId")),
        });
      }

      const values = {
        schoolId: Number(form.get("schoolId")),
        workdays: Number(form.get("workdays")),
        day: form.get("day"),
        block: form.get("block"),
      };

      const command = Match.value(action).pipe(
        Match.when("Affiliation", (action) => ({
          action,
          personId: form.get("personId"),
          transition: form.get("transition"),
        })),
        Match.when("Create", (action) => ({ action, personId: form.get("personId"), ...values })),
        Match.when("Edit", (action) => ({
          action,
          placementId: form.get("placementId"),
          ...values,
        })),
        Match.when("Remove", (action) => ({ action, placementId: form.get("placementId") })),
        Match.when("SetDemand", (action) => ({
          action,
          schoolId: Number(form.get("schoolId")),
          day: form.get("day"),
          block: form.get("block"),
          requiredVolunteers: Number(form.get("requiredVolunteers")),
        })),
        Match.when("GenerateProposal", (action) => ({ action })),
        Match.when("ConfirmProposal", (action) => ({
          action,
          proposalId: form.get("proposalId"),
          reviewedExceptionIds: form.getAll("reviewedExceptionId"),
        })),
        Match.when("ScheduleService", (action) => ({
          action,
          proposalId: form.get("proposalId"),
          schoolId: Number(form.get("schoolId")),
          day: form.get("day"),
          block: form.get("block"),
          serviceDate: form.get("serviceDate"),
          startTime: form.get("startTime"),
          endTime: form.get("endTime"),
        })),
        Match.orElse((action) => ({ action })),
      );

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
        case "ScheduleService":
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

    const messages = {
      "authority.denied": "Du har ikke lenger tilgang til denne avdelingen.",
      "resource.not-found":
        "Den valgte tjenesten eller fraværssaken finnes ikke lenger. Hent oppdatert oversikt.",
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
      "commitment.target-invalid":
        "Dato, skole, bolk eller tjenesteplan passer ikke med den bekreftede tjenesten.",
      "commitment.interval-invalid":
        "Velg et gyldig tidsrom samme skoledag. Starttid må være før sluttid.",
      "commitment.duplicate":
        "Det finnes allerede en datert tjeneste for denne skolen, datoen og bolken.",
      "commitment.closed": "Tjenesten har allerede en endelig beslutning og kan ikke endres.",
      "commitment.outcome-invalid":
        "Utfallet passer ikke. Gjennomført krever at oppmøtet dekker behovet, og Ikke oppfylt krever at det er under behovet. Begge kan først registreres når tidsrommet er over.",
      "absence.target-invalid":
        "Fravær kan bare meldes for en åpen, datert tjeneste der personen er planlagt.",
      "absence.duplicate": "Fravær er allerede meldt for dette oppmøtet. Hent oppdatert oversikt.",
      "absence.closed": "Denne fraværssaken er allerede avsluttet og kan ikke endres.",
      "coverage.owner-invalid":
        "Du kan bare registrere eller trekke tilbake dekning for ditt eget fravær.",
      "coverage.coverer-ineligible":
        "Personen kan ikke dekke dette fraværet. Velg en assistent eller vikar i avdelingen og semesteret, ikke den som er borte.",
      "coverage.coverer-unavailable":
        "Personen er allerede opptatt i samme tidsrom. Velg en annen person.",
      "coverage.not-recorded":
        "Det er ingen registrert dekning å trekke tilbake. Hent oppdatert oversikt.",
    };

    const conflict = problem?.status === 412 || problem?.code === "transaction.conflict";

    return privateData(
      {
        success: false as const,
        message: conflict
          ? "Oversikten er endret av noen andre. Hent oppdatert oversikt før du prøver igjen."
          : (Option.getOrUndefined(Record.get<string, string>(messages, problem?.code ?? "")) ??
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
      : "placements" in refreshed && !("rosterSlots" in refreshed)
        ? `Oppdatert oversikt: ${refreshed.placements.filter((placement) => placement.active).length} aktive plasseringer. ${refreshed.placements
            .filter((placement) => placement.active)
            .map(
              (placement) =>
                `${placement.firstName} ${placement.lastName}: ${placement.schoolName}, ${placement.day}, bolk ${placement.block}, ${placement.workdays} dager`,
            )
            .join("; ")}`
        : "rosterSlots" in refreshed
          ? `Oppdatert egen dekning: ${refreshed.rosterSlots.length} planlagte oppmøter, ${refreshed.absences.length} registrerte fravær og ${refreshed.coverage.length} registrerte dekninger.`
          : "rosterAssignments" in refreshed
            ? `Oppdatert dekningsoversikt: ${refreshed.absences.length} fravær, ${refreshed.coverage.length} registrerte dekninger og ${refreshed.closures.length} avsluttede fraværssaker.`
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

        const submitter =
          event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;

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

const weekdayLabel: Record<string, string> = {
  Monday: "Mandag",
  Tuesday: "Tirsdag",
  Wednesday: "Onsdag",
  Thursday: "Torsdag",
  Friday: "Fredag",
};

const draftBlockLabel: Record<string, string> = {
  "1": "bolk 1",
  "2": "bolk 2",
  Both: "begge bolker",
};

const unplacedReasonLabel = {
  NoAvailability: "ingen registrert tilgjengelighet",
  NoOpenPlace: "ingen ledig plass passer ukedagene og bolken",
} as const;

type DraftWishes = (typeof PlacementDraftResource.Type)["placements"][number]["wishes"];

/** The school that each teaching-language wish names. */
const schoolWishLabel = {
  Norsk: "norsk skole",
  Engelsk: "internasjonal skole",
  "Norsk og engelsk": "norsk eller internasjonal skole",
} as const satisfies { readonly [Language in DraftWishes["language"]]: string };

function DraftSchoolWishes({ wishes }: { wishes: DraftWishes }) {
  return (
    <span className="text-muted-foreground">
      {" "}
      (ønsker {schoolWishLabel[wishes.language]}
      {wishes.preferredSchool === null ? "" : `, helst ${wishes.preferredSchool}`})
    </span>
  );
}

/**
 * Generates a placement draft and applies the chosen placements through ordinary Create
 * commands. Unchecking a row leaves that placement for manual adjustment.
 */
function PlacementDraftPanel({
  draft,
  scope,
}: {
  draft: typeof PlacementDraftResource.Type | null;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="placement-draft-title">
      <h2 id="placement-draft-title" className="text-xl font-semibold">
        Utkast til skoleplassering
      </h2>
      <p className="text-sm text-muted-foreground">
        Utkastet fordeler aktive frivillige uten plassering på åpne skolebehov etter ukedager og
        bolk. Skoleønskene står ved hver person; utkastet tar ikke hensyn til dem. Ingenting lagres
        før du oppretter plasseringene.
      </p>
      <Form method="get">
        <input type="hidden" name="departmentId" value={scope.departmentId} />
        <input type="hidden" name="semesterId" value={scope.semesterId} />
        <input type="hidden" name="draft" value="1" />
        <Button type="submit" variant="outline">
          {draft ? "Lag utkastet på nytt" : "Lag utkast"}
        </Button>
      </Form>
      {draft && (
        <div className="space-y-3" data-placement-draft>
          <p>
            Utkastet fyller {draft.filledPlaces} av {draft.openPlaces} ledige plasser.
          </p>
          {draft.placements.length === 0 ? (
            <p>Utkastet har ingen nye plasseringer.</p>
          ) : (
            <CommandForm
              etag={draft.boardEtag}
              hidden={{ ...scope, action: "ApplyDraft" }}
              label="Opprett plasseringer fra utkastet"
            >
              <ul className="space-y-1">
                {draft.placements.map((placement) => (
                  <li key={placement.personId}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        name="draftPlacement"
                        defaultChecked
                        value={JSON.stringify({
                          action: "Create",
                          personId: placement.personId,
                          schoolId: placement.schoolId,
                          day: placement.day,
                          workdays: placement.workdays,
                          block: placement.block,
                        })}
                      />
                      <span>
                        {placement.firstName} {placement.lastName}: {placement.schoolName},{" "}
                        {weekdayLabel[placement.day]}, {draftBlockLabel[placement.block]},{" "}
                        {placement.workdays} dager
                        <DraftSchoolWishes wishes={placement.wishes} />
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <Button type="submit">Opprett valgte plasseringer</Button>
            </CommandForm>
          )}
          {draft.unplaced.length > 0 && (
            <div>
              <h3 className="font-medium">Uten plass i utkastet</h3>
              <ul className="list-disc pl-5">
                {draft.unplaced.map((person) => (
                  <li key={person.personId}>
                    {person.firstName} {person.lastName}: {unplacedReasonLabel[person.reason]}
                    {person.wishes !== null && <DraftSchoolWishes wishes={person.wishes} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draft.openSlots.length > 0 && (
            <div>
              <h3 className="font-medium">Ledige plasser etter utkastet</h3>
              <ul className="list-disc pl-5">
                {draft.openSlots.map((slot) => (
                  <li key={`${slot.schoolId}-${slot.day}-${slot.block}`}>
                    {slot.schoolName}, {weekdayLabel[slot.day]}, {draftBlockLabel[slot.block]}:{" "}
                    {slot.places}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
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
          )}
        </article>
      )}
      {board.occurrences.length > 0 && (
        <section aria-label="Historiske undervisningsregistreringer" className="space-y-2">
          <h3 className="font-medium">Historisk undervisning (kun lesing)</h3>
          <ul className="list-disc pl-5">
            {board.occurrences.map((occurrence) => (
              <li key={occurrence.occurrenceId}>
                {occurrence.schoolName}, {occurrence.occurredOn}, bolk {occurrence.block}:{" "}
                {occurrence.attendedPersonIds.length} møtte
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

const closureOutcomeLabel = { Covered: "Dekket", Uncovered: "Ikke dekket" } as const;

const covererKindLabel = { Assistant: "assistent", Substitute: "vikar" } as const;

type CoverageCoverer = (typeof CoverageBoardResource.Type)["coverers"][number];

type CoverageRecord = (typeof CoverageBoardResource.Type)["coverage"][number];

/**
 * Records who covered one absence and withdraws the current record. The people involved agree
 * on cover outside the system; the server checks eligibility and double booking on save.
 */
function CoverageForms({
  absenceId,
  current,
  coverers,
  etag,
  mode,
  scope,
  recordLabel,
  withdrawLabel,
}: {
  absenceId: string;
  current: CoverageRecord | undefined;
  coverers: ReadonlyArray<CoverageCoverer>;
  etag: string;
  mode: "ownCoverage" | "coverage";
  scope: { readonly departmentId: string; readonly semesterId: string };
  recordLabel: string;
  withdrawLabel: string;
}) {
  const selectId = `${mode}-coverer-${absenceId}`;

  return (
    <div className="space-y-3">
      {coverers.length === 0 ? (
        <p>Ingen assistenter eller vikarer kan registreres som dekning i valgt semester.</p>
      ) : (
        <CommandForm
          etag={etag}
          refreshResource={mode}
          hidden={{ ...scope, mode, action: "RecordCoverage", absenceId }}
          label={recordLabel}
        >
          <label htmlFor={selectId} className="min-w-0">
            Dekkes av
            <select
              id={selectId}
              name="coveringPersonId"
              required
              defaultValue=""
              className={selectClass}
            >
              <option value="" disabled>
                Velg person
              </option>
              {coverers.map((coverer) => (
                <option key={coverer.personId} value={coverer.personId}>
                  {`${coverer.firstName} ${coverer.lastName} (${covererKindLabel[coverer.kind]})`}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">Registrer dekning</Button>
        </CommandForm>
      )}
      {current && (
        <CommandForm
          etag={etag}
          refreshResource={mode}
          hidden={{ ...scope, mode, action: "WithdrawCoverage", absenceId }}
          label={withdrawLabel}
        >
          <Button type="submit" variant="outline">
            Trekk tilbake dekning
          </Button>
        </CommandForm>
      )}
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
  const recordsByAbsenceId = new Map(coverage.coverage.map((record) => [record.absenceId, record]));

  // The own view lists scheduled and covering commitments, and nobody covers a service they are
  // scheduled for, so each commitment without the person on its roster is one they cover.
  const covering = coverage.commitments.filter(
    (commitment) =>
      !commitment.assignments.some((assignment) => assignment.personId === coverage.personId),
  );

  return (
    <section
      className="min-w-0 space-y-5 rounded-lg border p-4 sm:p-6"
      aria-labelledby="own-coverage-title"
    >
      <header>
        <h2 id="own-coverage-title" className="text-xl font-semibold">
          Mine skoleplasseringer og dekning
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Her vises bare dine skoleplasseringer, fraværet ditt og fravær du dekker. Avtal dekning
          direkte med en assistent eller vikar, for eksempel i Slack, og registrer hvem som dekket.
        </p>
      </header>
      <section className="space-y-3" aria-labelledby="own-placements-title">
        <h3 id="own-placements-title" className="font-semibold">
          Mine skoleplasseringer
        </h3>
        <p className="text-sm text-muted-foreground">
          Daterte oppmøter avtales separat fra skoleplasseringen.
        </p>
        {coverage.placements.length === 0 && (
          <p>Du har ingen aktiv skoleplassering i valgt semester.</p>
        )}
        {coverage.placements.map((placement) => (
          <article
            key={placement.placementId}
            data-own-placement-id={placement.placementId}
            className="min-w-0 rounded-md border p-4"
          >
            <h4 className="font-semibold break-words">{placement.schoolName}</h4>
            <p>
              {placement.day}, bolk {placement.block}, {placement.workdays} undervisningsdager
            </p>
          </article>
        ))}
      </section>
      <section className="space-y-3" aria-labelledby="own-absences-title">
        <h3 id="own-absences-title" className="font-semibold">
          Registrerte fravær
        </h3>
        {coverage.absences.length === 0 && <p>Du har ikke registrert fravær i valgt semester.</p>}
        {coverage.absences.map((absence) => {
          const record = recordsByAbsenceId.get(absence.absenceId);

          const commitment = coverage.commitments.find(
            (row) => row.commitmentId === absence.commitmentId,
          );

          const slot = `${absence.schoolName}, ${absence.serviceDate}, bolk ${absence.block}`;

          return (
            <article key={absence.absenceId} className="min-w-0 space-y-3 rounded-md border p-4">
              <p className="break-words">
                {absence.schoolName}, {absence.serviceDate} — {absence.day}, bolk {absence.block}
              </p>
              <p className="[overflow-wrap:anywhere]">
                {record
                  ? `Dekket av: ${record.coveringFirstName} ${record.coveringLastName}`
                  : "Ingen dekning er registrert."}
              </p>
              {commitment?.decision === null && (
                <CoverageForms
                  absenceId={absence.absenceId}
                  current={record}
                  coverers={coverage.coverers}
                  etag={coverage.etag}
                  mode="ownCoverage"
                  scope={scope}
                  recordLabel={`Dekning for mitt fravær: ${slot}`}
                  withdrawLabel={`Trekk tilbake dekning: ${slot}`}
                />
              )}
            </article>
          );
        })}
      </section>
      <section className="space-y-3" aria-labelledby="own-covering-title">
        <h3 id="own-covering-title" className="font-semibold">
          Fravær jeg dekker
        </h3>
        {covering.length === 0 ? (
          <p>Du dekker ikke fravær i valgt semester.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {covering.map((commitment) => (
              <li key={commitment.commitmentId}>
                {`${commitment.schoolName}, ${commitment.serviceDate}, bolk ${commitment.block}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function CoordinatorCoveragePanel({
  coverage,
  scope,
}: {
  coverage: typeof CoverageBoardResource.Type;
  scope: { readonly departmentId: string; readonly semesterId: string };
}) {
  const recordsByAbsenceId = new Map(coverage.coverage.map((record) => [record.absenceId, record]));

  const closuresByAbsenceId = new Map(
    coverage.closures.map((closure) => [closure.absenceId, closure]),
  );

  const openCommitments = coverage.commitments.filter(
    (commitment) =>
      commitment.decision === null &&
      commitment.assignments.some(
        (assignment) =>
          !coverage.absences.some(
            (absence) =>
              absence.commitmentId === commitment.commitmentId &&
              absence.personId === assignment.personId,
          ),
      ),
  );

  return (
    <section
      className="min-w-0 space-y-5 rounded-lg border p-4 sm:p-6"
      aria-labelledby="coverage-board-title"
    >
      <header>
        <h2 id="coverage-board-title" className="text-xl font-semibold">
          Fravær og dekning
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Registrer fravær og hvem som dekket timen. Dekning avtales direkte med personen, for
          eksempel i Slack. Tjenesteutfallet registreres separat nedenfor.
        </p>
      </header>
      <section className="space-y-3" aria-labelledby="coordinator-absence-title">
        <h3 id="coordinator-absence-title" className="font-semibold">
          Rapporter fravær for frivillig
        </h3>
        {openCommitments.length === 0 ? (
          <p>Ingen åpne daterte tjenester med planlagte frivillige.</p>
        ) : (
          openCommitments.map((commitment) => (
            <CommandForm
              key={commitment.commitmentId}
              etag={coverage.etag}
              refreshResource="coverage"
              hidden={{
                ...scope,
                mode: "coverage",
                action: "ReportAbsenceForVolunteer",
                commitmentId: commitment.commitmentId,
              }}
              label={`Fravær: ${commitment.schoolName}, ${commitment.serviceDate}, bolk ${commitment.block}, koordinator`}
            >
              <p>
                {commitment.schoolName}, {commitment.serviceDate} kl. {commitment.startTime}–
                {commitment.endTime}
              </p>
              <label htmlFor={`coordinator-absence-person-${commitment.commitmentId}`}>
                Frivillig
                <select
                  id={`coordinator-absence-person-${commitment.commitmentId}`}
                  name="personId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    Velg frivillig
                  </option>
                  {commitment.assignments
                    .filter(
                      (assignment) =>
                        !coverage.absences.some(
                          (absence) =>
                            absence.commitmentId === commitment.commitmentId &&
                            absence.personId === assignment.personId,
                        ),
                    )
                    .map((assignment) => (
                      <option key={assignment.personId} value={assignment.personId}>
                        {assignment.firstName} {assignment.lastName}
                      </option>
                    ))}
                </select>
              </label>
              <Button type="submit">Rapporter fravær</Button>
            </CommandForm>
          ))
        )}
      </section>
      <section className="space-y-3" aria-labelledby="coverage-absences-title">
        <h3 id="coverage-absences-title" className="font-semibold">
          Registrert fravær og dekning
        </h3>
        {coverage.absences.length === 0 && <p>Det er ikke registrert fravær i valgt semester.</p>}
        {coverage.absences.map((absence) => {
          const record = recordsByAbsenceId.get(absence.absenceId);
          const closure = closuresByAbsenceId.get(absence.absenceId);

          const commitment = coverage.commitments.find(
            (row) => row.commitmentId === absence.commitmentId,
          );

          const assignment =
            absence.commitmentId === null
              ? coverage.rosterAssignments.find(
                  (row) =>
                    row.proposalId === absence.proposalId &&
                    row.personId === absence.personId &&
                    row.schoolId === absence.schoolId &&
                    row.day === absence.day &&
                    row.block === absence.block,
                )
              : commitment?.assignments.find((row) => row.personId === absence.personId);

          const absentName =
            (assignment ? `${assignment.firstName} ${assignment.lastName}`.trim() : "") ||
            absence.personId;

          const slot = `${absentName}, ${absence.schoolName}, ${absence.serviceDate}, bolk ${absence.block}`;

          return (
            <article key={absence.absenceId} className="min-w-0 space-y-3 rounded-md border p-4">
              <h4 className="break-words font-medium">
                {absence.schoolName}, {absence.serviceDate} — {absence.day}, bolk {absence.block}
              </h4>
              <p className="[overflow-wrap:anywhere]">Fraværende: {absentName}</p>
              <p className="[overflow-wrap:anywhere]">
                {record
                  ? `Dekket av: ${record.coveringFirstName} ${record.coveringLastName} (${covererKindLabel[record.covererKind]})`
                  : "Ingen dekning er registrert."}
              </p>
              {closure && (
                <p>
                  Fraværsutfall: {closureOutcomeLabel[closure.outcome]} (gjelder denne plassen, ikke
                  hele tjenesten).
                </p>
              )}
              {closure === undefined && commitment?.decision === null && (
                <CoverageForms
                  absenceId={absence.absenceId}
                  current={record}
                  coverers={coverage.coverers.filter(
                    (coverer) => coverer.personId !== absence.personId,
                  )}
                  etag={coverage.etag}
                  mode="coverage"
                  scope={scope}
                  recordLabel={`Dekning: ${slot}`}
                  withdrawLabel={`Trekk tilbake dekning: ${slot}`}
                />
              )}
            </article>
          );
        })}
      </section>
    </section>
  );
}

export default function Assistenter() {
  const { scopes, own, board, draft, ownCoverage, coverage, departmentId, semesterId, error } =
    useLoaderData<typeof loader>();

  const scope = { departmentId, semesterId };
  const actionResult = useActionData<typeof action>();

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
      {actionResult && (
        <p role={actionResult.success ? "status" : "alert"}>{actionResult.message}</p>
      )}
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
                  {semesterLabel(s)}
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
          <PlacementDraftPanel draft={draft} scope={scope} />
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
      {(board || ownCoverage || coverage) &&
        createElement(DATED_SERVICE_ELEMENT, {
          key: `${departmentId}-${semesterId}-${board?.etag ?? ""}-${ownCoverage?.etag ?? ""}-${coverage?.etag ?? ""}`,
          "data-state": JSON.stringify({ departmentId, semesterId, board, coverage, ownCoverage }),
        })}
    </section>
  );
}
