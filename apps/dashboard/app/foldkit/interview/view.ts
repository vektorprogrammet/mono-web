import { Button, Input, Select } from "@foldkit/ui"
import type { AssignedInterview, InterviewSchedulingStatus } from "@vektorprogrammet/sdk/effect"
import { AsyncData, FieldValidation } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  AcceptedCandidate,
  OpenedSchedule,
  SelectedDepartment,
  SelectedSemester,
  SubmittedContext,
  SubmittedSchedule,
  UpdatedCampus,
  UpdatedInterviewTime,
  UpdatedRoom,
  type Message,
} from "./message"
import type { Model } from "./model"

const DEPARTMENT_ID = "dep-trd-1"
const SEMESTER_ID = "sem-2026-høst"

const statusLabel = (status: InterviewSchedulingStatus): string => {
  switch (status) {
    case "created":
      return "Ikke planlagt"
    case "pending":
      return "Invitert"
    case "accepted":
      return "Akseptert"
    case "request_new_time":
      return "Ønsker nytt tidspunkt"
    case "cancelled":
      return "Avlyst"
    case "no_contact":
      return "Ikke oppnådd kontakt"
  }
}

const fieldError = (
  id: string,
  field: Model["departmentValidation"],
  h: HtmlBuilder<Message>,
): Html => field._tag === "Invalid"
  ? h.p([h.Id(`${id}-error`), h.Class("fk-field-error"), h.Role("alert")], [field.errors.join(" ")])
  : h.empty

const selectField = (
  config: {
    id: string
    label: string
    value: string
    field: Model["departmentValidation"]
    optionValue: string
    optionLabel: string
    onChange: (value: string) => Message
    isDisabled: boolean
  },
  h: HtmlBuilder<Message>,
): Html => Select.view({
  id: config.id,
  value: config.value,
  onChange: config.onChange,
  isDisabled: config.isDisabled,
  isInvalid: FieldValidation.isInvalid(config.field),
  toView: ({ select, label, description }) => h.div([h.Class("fk-field")], [
    h.label([...label, h.Class("fk-label")], [config.label]),
    h.select([...select, h.Class("fk-select")], [
      h.option([h.Value(""), ...(config.value === "" ? [h.Selected(true)] : [])], ["Velg …"]),
      h.option([h.Value(config.optionValue), ...(config.value === config.optionValue ? [h.Selected(true)] : [])], [config.optionLabel]),
    ]),
    h.p([...description, h.Class("fk-field-hint")], ["Påkrevd"]),
    fieldError(config.id, config.field, h),
  ]),
}, h)

const textField = (
  config: {
    id: string
    label: string
    value: string
    field: Model["interviewTime"]
    placeholder: string
    onInput: (value: string) => Message
    isDisabled: boolean
  },
  h: HtmlBuilder<Message>,
): Html => Input.view({
  id: config.id,
  value: config.value,
  onInput: config.onInput,
  placeholder: config.placeholder,
  isDisabled: config.isDisabled,
  isInvalid: FieldValidation.isInvalid(config.field),
  toView: ({ input, label, description }) => h.div([h.Class("fk-field")], [
    h.label([...label, h.Class("fk-label")], [config.label]),
    h.input([...input, h.Class("fk-input")]),
    h.p([...description, h.Class("fk-field-hint")], ["Påkrevd"]),
    fieldError(config.id, config.field, h),
  ]),
}, h)

const actionButton = (
  label: string,
  message: Message,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
  variant: "primary" | "secondary" = "primary",
): Html => Button.view({
  onClick: message,
  isDisabled,
  type: "button",
  toView: ({ button }) => h.button([...button, h.Class(`fk-button fk-button--${variant}`)], [label]),
}, h)

const feedbackView = (feedback: string | null, h: HtmlBuilder<Message>): Html => feedback === null
  ? h.empty
  : h.div([h.Class("fk-feedback"), h.Role("status"), h.AriaLive("polite")], [feedback])

const statusPill = (status: InterviewSchedulingStatus, h: HtmlBuilder<Message>): Html => h.span([
  h.Class(`fk-status fk-status--${status}`),
], [statusLabel(status)])

const scheduleForm = (model: Model, interview: AssignedInterview, h: HtmlBuilder<Message>): Html => {
  if (model.selectedInterviewId !== interview.id) return h.empty
  if (interview.schedulingStatus !== "created") {
    return h.div([h.Class("fk-inline-note")], ["Intervjuet kan ikke planlegges på nytt i denne tilstanden."])
  }

  return h.form([
    h.Class("fk-schedule-form"),
    h.OnSubmit(SubmittedSchedule()),
    h.AriaLabelledBy(`schedule-title-${interview.id}`),
  ], [
    h.div([h.Class("fk-section-heading")], [
      h.h3([h.Id(`schedule-title-${interview.id}`)], ["Planlegg intervju"]),
      h.p([], ["Fyll ut avtalt tid og sted. Kandidaten får en invitasjon når du lagrer."]),
    ]),
    h.div([h.Class("fk-form-grid")], [
      textField({
        id: `interview-time-${interview.id}`,
        label: "Tidspunkt",
        value: model.interviewTime.value,
        field: model.interviewTime,
        placeholder: "2026-09-14T15:00:00+02:00",
        onInput: (value) => UpdatedInterviewTime({ value }),
        isDisabled: model.isScheduling,
      }, h),
      textField({
        id: `room-${interview.id}`,
        label: "Rom",
        value: model.room.value,
        field: model.room,
        placeholder: "Rom 2",
        onInput: (value) => UpdatedRoom({ value }),
        isDisabled: model.isScheduling,
      }, h),
      textField({
        id: `campus-${interview.id}`,
        label: "Campus",
        value: model.campus.value,
        field: model.campus,
        placeholder: "Gløshaugen",
        onInput: (value) => UpdatedCampus({ value }),
        isDisabled: model.isScheduling,
      }, h),
    ]),
    h.div([h.Class("fk-actions")], [
      actionButton(model.isScheduling ? "Lagrer …" : "Lagre og send", SubmittedSchedule(), model.isScheduling, h),
    ]),
  ])
}

const interviewDetails = (interview: AssignedInterview, h: HtmlBuilder<Message>): Html => {
  if (interview.interviewTime === null || interview.room === null || interview.campus === null) return h.empty
  return h.dl([h.Class("fk-details")], [
    h.div([], [h.dt([], ["Tidspunkt"]), h.dd([], [interview.interviewTime])]),
    h.div([], [h.dt([], ["Rom"]), h.dd([], [interview.room])]),
    h.div([], [h.dt([], ["Campus"]), h.dd([], [interview.campus])]),
    h.div([], [h.dt([], ["Intervjuer"]), h.dd([], [interview.interviewerLabel])]),
  ])
}

const interviewCard = (model: Model, interview: AssignedInterview, h: HtmlBuilder<Message>): Html => h.article([
  h.Class("fk-interview"),
  h.AriaLabelledBy(`applicant-${interview.id}`),
], [
  h.div([h.Class("fk-interview__header")], [
    h.div([], [
      h.p([h.Class("fk-eyebrow")], ["Tildelt søker"]),
      h.h3([h.Id(`applicant-${interview.id}`)], [interview.applicantLabel]),
    ]),
    statusPill(interview.schedulingStatus, h),
  ]),
  h.dl([h.Class("fk-context-summary")], [
    h.div([], [h.dt([], ["Avdeling"]), h.dd([], ["Trondheim"])]),
    h.div([], [h.dt([], ["Semester"]), h.dd([], ["Høst 2026"])]),
  ]),
  interviewDetails(interview, h),
  interview.schedulingStatus === "created"
    ? h.div([h.Class("fk-actions")], [
      actionButton("Planlegg intervju", OpenedSchedule({ interviewId: interview.id }), model.isScheduling, h, "secondary"),
    ])
    : h.empty,
  scheduleForm(model, interview, h),
])

const successInterviews = (model: Model, interviews: ReadonlyArray<AssignedInterview>, h: HtmlBuilder<Message>): Html => h.section([
  h.Class("fk-results"),
  h.AriaLabelledBy("assigned-applicants-heading"),
], [
  h.div([h.Class("fk-section-heading")], [
    h.p([h.Class("fk-eyebrow")], ["Trondheim · Høst 2026"]),
    h.h2([h.Id("assigned-applicants-heading")], ["Tildelte søkere"]),
    h.p([], [interviews.length === 1 ? "1 søker i valgt opptak." : `${interviews.length} søkere i valgt opptak.`]),
  ]),
  interviews.length === 0
    ? h.div([h.Class("fk-empty")], [
      h.h3([], ["Ingen tildelte søkere"]),
      h.p([], ["Det finnes ingen tildelte søkere for denne avdelingen og dette semesteret."]),
    ])
    : h.div([h.Class("fk-interview-list")], interviews.map((interview) => interviewCard(model, interview, h))),
])

const interviewsView = (model: Model, h: HtmlBuilder<Message>): Html => AsyncData.match(model.interviews, {
  onIdle: () => h.div([h.Class("fk-guidance")], [
    h.p([], ["Velg avdeling og semester for å se tildelte søkere."]),
  ]),
  onLoading: () => h.div([h.Class("fk-loading"), h.Role("status"), h.AriaLive("polite")], [
    h.span([h.Class("fk-spinner"), h.AriaHidden(true)], []),
    h.span([], ["Henter tildelte søkere …"]),
  ]),
  onRefreshing: (interviews) => successInterviews(model, interviews, h),
  onFailure: (error) => h.div([h.Class("fk-error"), h.Role("alert")], [
    h.h2([], ["Kunne ikke hente søkere"]),
    h.p([], [error]),
  ]),
  onStale: ({ error }) => h.div([h.Class("fk-error"), h.Role("alert")], [
    h.h2([], ["Kunne ikke oppdatere søkerne"]),
    h.p([], [error]),
  ]),
  onSuccess: (interviews) => successInterviews(model, interviews, h),
})

const dashboardView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isLoading = AsyncData.isPending(model.interviews)
  return h.main([h.Class("foldkit-interview foldkit-interview--dashboard")], [
    h.header([h.Class("fk-page-header")], [
      h.p([h.Class("fk-eyebrow")], ["Opptak · Intervjuer"]),
      h.h1([], ["Planlegg intervjuer"]),
      h.p([h.Class("fk-lead")], ["Velg et opptak, finn tildelte søkere og send intervjuinvitasjonen."]),
    ]),
    h.section([h.Class("fk-context-panel"), h.AriaLabelledBy("context-heading")], [
      h.div([h.Class("fk-section-heading")], [
        h.h2([h.Id("context-heading")], ["Velg opptak"]),
        h.p([], ["Avdeling og semester brukes sammen og må velges eksplisitt."]),
      ]),
      h.form([h.OnSubmit(SubmittedContext()), h.Class("fk-context-form")], [
        h.div([h.Class("fk-form-grid fk-form-grid--context")], [
          selectField({
            id: "department",
            label: "Avdeling",
            value: model.departmentId,
            field: model.departmentValidation,
            optionValue: DEPARTMENT_ID,
            optionLabel: "Trondheim",
            onChange: (value) => SelectedDepartment({ value }),
            isDisabled: isLoading,
          }, h),
          selectField({
            id: "semester",
            label: "Semester",
            value: model.semesterId,
            field: model.semesterValidation,
            optionValue: SEMESTER_ID,
            optionLabel: "Høst 2026",
            onChange: (value) => SelectedSemester({ value }),
            isDisabled: isLoading,
          }, h),
        ]),
        h.div([h.Class("fk-actions")], [
          actionButton(isLoading ? "Henter …" : "Vis søkere", SubmittedContext(), isLoading, h),
        ]),
      ]),
    ]),
    feedbackView(model.feedback, h),
    interviewsView(model, h),
  ])
}

const candidateSuccess = (model: Model, h: HtmlBuilder<Message>): Html => {
  const candidate = AsyncData.getData(model.candidate)
  if (candidate._tag === "None") return h.empty
  const isAccepted = candidate.value.schedulingStatus === "accepted"
  const canAccept = candidate.value.schedulingStatus === "pending" && !model.isAccepting
  return h.article([h.Class("fk-response-card"), h.AriaLabelledBy("response-heading")], [
    h.div([h.Class("fk-response-card__header")], [
      h.div([], [
        h.p([h.Class("fk-eyebrow")], ["Intervjuinvitasjon"]),
        h.h1([h.Id("response-heading")], [isAccepted ? "Intervjutiden er akseptert" : "Svar på intervjutid"]),
      ]),
      statusPill(candidate.value.schedulingStatus, h),
    ]),
    h.p([h.Class("fk-lead")], [isAccepted
      ? "Takk. Vi har registrert svaret ditt."
      : "Se over tidspunkt og sted før du aksepterer invitasjonen."],
    ),
    h.dl([h.Class("fk-details fk-details--candidate")], [
      h.div([], [h.dt([], ["Tidspunkt"]), h.dd([], [candidate.value.interviewTime])]),
      h.div([], [h.dt([], ["Rom"]), h.dd([], [candidate.value.room])]),
      h.div([], [h.dt([], ["Campus"]), h.dd([], [candidate.value.campus])]),
    ]),
    !isAccepted
      ? h.div([h.Class("fk-actions")], [
        actionButton(
          model.isAccepting ? "Registrerer svar …" : "Aksepter intervjutid",
          AcceptedCandidate(),
          !canAccept,
          h,
        ),
      ])
      : h.div([h.Class("fk-confirmation"), h.Role("status")], ["Svaret er registrert. Du trenger ikke gjøre noe mer."]),
  ])
}

const candidateView = (model: Model, h: HtmlBuilder<Message>): Html => h.main([
  h.Class("foldkit-interview foldkit-interview--candidate"),
], [
  AsyncData.match(model.candidate, {
    onIdle: () => h.div([h.Class("fk-loading"), h.Role("status")], ["Forbereder invitasjonen …"]),
    onLoading: () => h.div([h.Class("fk-loading"), h.Role("status"), h.AriaLive("polite")], [
      h.span([h.Class("fk-spinner"), h.AriaHidden(true)], []),
      h.span([], ["Henter intervjutid …"]),
    ]),
    onRefreshing: () => candidateSuccess(model, h),
    onFailure: (error) => h.section([h.Class("fk-error fk-error--candidate"), h.Role("alert")], [
      h.p([h.Class("fk-eyebrow")], ["Intervjuinvitasjon"]),
      h.h1([], ["Invitasjonen er ikke tilgjengelig"]),
      h.p([], [error]),
    ]),
    onStale: ({ error }) => h.section([h.Class("fk-error fk-error--candidate"), h.Role("alert")], [
      h.h1([], ["Kunne ikke oppdatere svaret"]),
      h.p([], [error]),
    ]),
    onSuccess: () => candidateSuccess(model, h),
  }),
  feedbackView(model.feedback, h),
])

export const view = (model: Model, h: HtmlBuilder<Message>): Html => model.mode === "dashboard"
  ? dashboardView(model, h)
  : candidateView(model, h)
