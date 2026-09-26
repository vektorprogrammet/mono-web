import { schoolServiceAttendance } from "@vektorprogrammet/domain/placements";
import { Match, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  ChangedEndTime, ChangedEvidenceSource, ChangedReason, ChangedScheduleDate,
  ChangedStartTime, SelectedCommitment, SelectedDecision,
  type Message,
} from "./message";
import { Model } from "./model";

type Coverage = NonNullable<Model["input"]["coverage"]>;

type Commitment = Coverage["commitments"][number];

const hidden = (h: HtmlBuilder<Message>, name: string, value: string): Html =>
  h.input([h.Type("hidden"), h.Name(name), h.Value(value)]);

const formFields = (model: Model, h: HtmlBuilder<Message>, etag: string, action: string, key: string): Html[] => [
  hidden(h, "departmentId", model.input.departmentId),
  hidden(h, "semesterId", model.input.semesterId),
  hidden(h, "etag", etag),
  hidden(h, "commandId", `dated-service-${model.commandSeed}-${key}`),
  hidden(h, "action", action),
];

const serviceTitle = (c: Commitment): string =>
  `${c.schoolName}, ${c.serviceDate} kl. ${c.startTime}–${c.endTime}, bolk ${c.block}`;

const outcomeLabel = (outcome: "Completed" | "Cancelled" | "Unfulfilled"): string =>
  Match.value(outcome).pipe(
Match.when("Completed", () => ("Gjennomført")),
Match.when("Cancelled", () => ("Avlyst")),
Match.orElse(() => ("Ikke oppfylt"))
);

const schedule = (model: Model, h: HtmlBuilder<Message>): Html => {
  const board = model.input.board;

  if (board === null) return h.empty;
  const proposal = board.proposal;

  if (proposal?.status !== "Confirmed") return h.p([], ["Bekreft tjenesteplanen før datoer kan planlegges."]);
  const existing = new Set(board.commitments.map((c) => `${c.schoolId}:${c.day}:${c.block}` + `:${c.serviceDate}`));

  return h.section([h.Class("dated-service__section")], [
    h.h3([], ["Planlegg datert skoletjeneste"]),
    h.p([], ["Tjenesteplanen er et gjentakende forslag. Hver dato og tidsperiode blir en egen, låst forpliktelse med behov og bemanning fra den bekreftede planen."]),
    ...proposal.demands.filter((demand) => demand.requiredVolunteers > 0).map((demand) => {
      const alreadyScheduled = existing.has(`${demand.schoolId}:${demand.day}:${demand.block}:${model.scheduleDate}`);
      const valid = Boolean(model.scheduleDate && model.startTime && model.endTime && model.startTime < model.endTime);
      const label = `${board.schools.find((s) => s.schoolId === demand.schoolId)?.name ?? demand.schoolId}, ${demand.day}, bolk ${demand.block}: ${demand.requiredVolunteers} trengs`;

      return h.form([h.Method("post"), h.Class("dated-service__card")], [
        ...formFields(model, h, board.etag, "ScheduleService", `schedule-${demand.schoolId}-${demand.day}-${demand.block}`),
        hidden(h, "proposalId", proposal.proposalId),
        hidden(h, "schoolId", String(demand.schoolId)),
        hidden(h, "day", demand.day),
        hidden(h, "block", demand.block),
        h.p([], [label]),
        h.div([h.Class("dated-service__fields")], [
          h.label([], ["Dato", h.input([h.Type("date"), h.Name("serviceDate"), h.Value(model.scheduleDate), h.OnInput((value) => ChangedScheduleDate({ value }))])]),
          h.label([], ["Fra (lokal skoletid)", h.input([h.Type("time"), h.Name("startTime"), h.Value(model.startTime), h.OnInput((value) => ChangedStartTime({ value }))])]),
          h.label([], ["Til (lokal skoletid)", h.input([h.Type("time"), h.Name("endTime"), h.Value(model.endTime), h.OnInput((value) => ChangedEndTime({ value }))])]),
        ]),
        h.button([h.Type("submit"), h.Disabled(!valid || alreadyScheduled)], [alreadyScheduled ? "Datoen er allerede planlagt" : "Planlegg denne datoen"]),
      ]);
    }),
  ]);
};

const own = (model: Model, h: HtmlBuilder<Message>): Html => {
  const ownCoverage = model.input.ownCoverage;

  if (ownCoverage === null) return h.empty;

  return h.section([h.Class("dated-service__section")], [
    h.h3([], ["Mine daterte skoletjenester"]),
    ownCoverage.commitments.length === 0 ? h.p([], ["Ingen daterte tjenester i valgt semester."]) : h.empty,
    ...ownCoverage.commitments.map((commitment) => {
      const absence = ownCoverage.absences.find((a) => a.commitmentId === commitment.commitmentId);
      const scheduled = commitment.assignments.some((a) => a.personId === ownCoverage.personId);

      return h.article([h.Class("dated-service__card")], [
        h.h4([], [serviceTitle(commitment)]),
        h.p([], [scheduled ? "Din rolle: planlagt frivillig." : "Din rolle: dekker fravær."]),
        h.p([], [`Behov: ${commitment.requiredVolunteers} frivillige. ${commitment.decision === null ? commitment.overdue ? "Forfalt – venter på beslutning." : "Åpen." : outcomeLabel(commitment.decision.outcome)}`]),
        absence ? h.p([], ["Du har meldt fravær for denne datoen."]) : commitment.decision === null && scheduled
          ? h.form([h.Method("post")], [
              ...formFields(model, h, ownCoverage.etag, "ReportAbsence", `absence-${commitment.commitmentId.slice(-32)}`),
              hidden(h, "mode", "ownCoverage"),
              hidden(h, "commitmentId", commitment.commitmentId),
              h.button([h.Type("submit")], ["Rapporter fravær for denne tjenesten"]),
            ]) : h.empty,
      ]);
    }),
  ]);
};

const coordinator = (model: Model, h: HtmlBuilder<Message>): Html => {
  const coverage = model.input.coverage;

  if (coverage === null) return h.empty;
  const selected = coverage.commitments.find((c) => c.commitmentId === model.selectedCommitmentId);

  return h.section([h.Class("dated-service__section")], [
    h.h3([], ["Daterte tjenester og beslutninger"]),
    coverage.commitments.length === 0 ? h.p([], ["Ingen datoer er planlagt i valgt semester."]) : h.empty,
    ...coverage.commitments.map((c) => h.article([h.Key(c.commitmentId), h.Class("dated-service__card"), h.DataAttribute("commitment-id", c.commitmentId)], [
      h.h4([], [serviceTitle(c)]),
      h.p([], [`Bekreftet behov: ${c.requiredVolunteers}; planlagt: ${c.assignments.length}.`]),
      c.decision === null
        ? h.p([h.Role("status")], [c.overdue ? "Forfalt – krever en dokumentert beslutning, ikke automatisk fullføring." : "Åpen – ingen tjenestebeslutning ennå."])
        : h.div([], [
            h.p([], [`Tjenesteutfall: ${outcomeLabel(c.decision.outcome)}. Besluttet ${c.decision.decidedAt}.`]),
            h.p([], [`Registrert av: ${c.decision.decidedBy}`]),
            h.p([], [`Kilde: ${c.decision.evidenceSource}. Faktisk møtte: ${c.decision.attendedPersonIds.length}.`]),
            c.decision.attendedPersonIds.length === 0
              ? h.p([], ["Ingen personer er registrert møtt."])
              : h.ul([h.Class("dated-service__attendees"), h.AriaLabel("Faktisk møtte")], c.decision.attendedPersonIds.map((personId) => h.li([], [attendeeName(coverage, c, personId)]))),
            c.decision.reason ? h.p([], [`Begrunnelse: ${c.decision.reason}`]) : h.empty,
          ]),
      c.decision === null ? h.button([h.Type("button"), h.OnClick(SelectedCommitment({ commitmentId: c.commitmentId }))], ["Registrer beslutning for denne datoen"]) : h.empty,
    ])),
    selected && selected.decision === null ? decisionForm(model, h, coverage, selected) : h.empty,
  ]);
};

/** Names an attendee from the commitment's roster, or from the coverage record that made them attend. */
const attendeeName = (coverage: Coverage, commitment: Commitment, personId: string): string => {
  const assignment = commitment.assignments.find((row) => row.personId === personId);

  if (assignment !== undefined) return `${assignment.firstName} ${assignment.lastName}`.trim() || personId;

  const record = coverage.coverage.find((row) => row.coveringPersonId === personId && coverage.absences.some((absence) =>
    absence.absenceId === row.absenceId && absence.commitmentId === commitment.commitmentId,
  ));

  return record === undefined ? personId : `${record.coveringFirstName} ${record.coveringLastName}`.trim() || personId;
};

const decisionForm = (model: Model, h: HtmlBuilder<Message>, coverage: Coverage, commitment: Commitment): Html => {
  // The backend derives the recorded attendance with the same rule; the form only shows it.
  const attendance = schoolServiceAttendance(commitment, coverage.absences, coverage.coverage);
  const cancellation = model.decision === "CancelService";
  const completed = model.decision === "CompleteService";

  const attendanceFits = Match.value(model.decision).pipe(
    Match.when("CompleteService", () => attendance.length >= commitment.requiredVolunteers),
    Match.when("MarkUnfulfilledService", () => attendance.length < commitment.requiredVolunteers),
    Match.orElse(() => true),
  );

  const valid = (cancellation || commitment.overdue) && attendanceFits && model.evidenceSource.trim().length > 0 && (completed || model.reason.trim().length > 0);
  const attendanceLabelId = `dated-service-attendance-${commitment.commitmentId.slice(-32)}`;

  return h.form([h.Method("post"), h.Class("dated-service__card"), h.AriaLabel("Beslutning for " + serviceTitle(commitment))], [
    h.h4([], ["Dokumenter faktisk tjeneste: " + serviceTitle(commitment)]),
    h.p([], ["Oppmøtet beregnes fra planlagte frivillige, meldt fravær og registrert dekning. Hvert fravær får i tillegg eget utfall: Dekket eller Ikke dekket."]),
    h.p([h.Role("status"), h.Hidden(cancellation || commitment.overdue)], ["Gjennomført og Ikke oppfylt kan først dokumenteres etter at tjenesteintervallet er slutt i norsk skoletid. Avlyst kan registreres nå. Last siden på nytt når intervallet er slutt."]),
    ...formFields(model, h, coverage.etag, model.decision, `decision-${commitment.commitmentId.slice(-32)}-${model.decision}`),
    hidden(h, "mode", "coverage"),
    hidden(h, "commitmentId", commitment.commitmentId),
    h.label([], ["Tjenesteutfall", h.select([h.Value(model.decision), h.OnChange((value) => SelectedDecision({ value: Schema.decodeUnknownSync(Model.fields.decision)(value) }))], [
      h.option([h.Value("CompleteService")], ["Gjennomført – behovet er dekket"]),
      h.option([h.Value("CancelService")], ["Avlyst – ingen undervisning eller oppmøte"]),
      h.option([h.Value("MarkUnfulfilledService")], ["Ikke oppfylt – faktisk oppmøte er under behovet"]),
    ])]),
    h.div([h.Hidden(cancellation)], [
      h.p([h.Id(attendanceLabelId)], ["Beregnet oppmøte"]),
      h.ul([h.Class("dated-service__attendees"), h.AriaLabelledBy(attendanceLabelId)], attendance.map((personId) => h.li([], [
        `${attendeeName(coverage, commitment, personId)} (${commitment.assignments.some((row) => row.personId === personId) ? "planlagt frivillig" : "dekker fravær"})`,
      ]))),
      h.p([], [`${attendance.length} møter av ${commitment.requiredVolunteers} som trengs.`]),
    ]),
    h.label([], ["Kilde for dokumentasjonen", h.input([h.Type("text"), h.Name("evidenceSource"), h.Value(model.evidenceSource), h.Attribute("maxlength", "500"), h.OnInput((value) => ChangedEvidenceSource({ value }))])]),
    h.label([h.Hidden(completed)], ["Begrunnelse", h.textarea([h.Name("reason"), h.Value(model.reason), h.Disabled(completed), h.Attribute("maxlength", "500"), h.OnInput((value) => ChangedReason({ value }))])]),
    h.button([h.Type("submit"), h.Disabled(!valid)], ["Lagre uforanderlig beslutning"]),
  ]);
};

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class("dated-service"), h.AriaLabel("Daterte skoletjenester")], [schedule(model, h), own(model, h), coordinator(model, h)]);
