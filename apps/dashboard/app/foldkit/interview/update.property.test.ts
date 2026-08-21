import { expect, it } from "@effect/vitest"
import { CandidateInterviewView, InterviewId, type EffectSdk } from "@vektorprogrammet/sdk/effect"
import { Effect, Schema } from "effect"
import * as fc from "effect/testing/FastCheck"
import { FieldValidation } from "foldkit"
import { makeInterviewCommands } from "./command"
import {
  ConfirmedCandidate,
  Message,
  OpenedSchedule,
  RejectedCandidate,
  RequestedNewTimeCandidate,
  SubmittedSchedule,
  UpdatedDatetime,
  UpdatedMapLink,
} from "./message"
import { CandidateData, Model, makeInitialModel } from "./model"

const testClient = {
  admin: {
    interviews: {
      list: () => Effect.succeed({ items: [], totalItems: 0 }),
    },
  },
  interviewResponses: {
    read: () => Effect.succeed(null),
    confirm: () => Effect.succeed(undefined),
    reject: () => Effect.succeed(undefined),
    requestNewTime: () => Effect.succeed(undefined),
  },
} as unknown as EffectSdk
const update = makeUpdate(makeInterviewCommands(testClient, null))
const interviewId = Schema.decodeUnknownSync(InterviewId)(42)

const filledModel = () => ({
  ...makeInitialModel("dashboard"),
  selectedInterviewId: interviewId,
  datetime: FieldValidation.NotValidated({ value: "2026-09-14T15:00:00+02:00" }),
  room: FieldValidation.NotValidated({ value: "Rom 2" }),
  campus: FieldValidation.NotValidated({ value: "Gløshaugen" }),
  mapLink: FieldValidation.NotValidated({ value: "https://maps.example.com/interview" }),
  from: FieldValidation.NotValidated({ value: "interviewer@example.com" }),
  to: FieldValidation.NotValidated({ value: "applicant@example.com" }),
  message: FieldValidation.NotValidated({ value: "Vi ser frem til møtet." }),
})
const candidateModel = () => ({
  ...makeInitialModel("candidate"),
  candidate: CandidateData.Success({
    data: Schema.decodeUnknownSync(CandidateInterviewView)({
      schedulingStatus: "pending",
      interviewTime: "2026-09-14T15:00:00+02:00",
      room: "Rom 31",
      campus: "Gløshaugen",
    }),
  }),
})
it("emits a confirm transition command for a pending invitation", () => {
  const [next, commands] = update(candidateModel(), ConfirmedCandidate())
  expect(next.isConfirming).toBe(true)
  expect(commands).toHaveLength(1)
})

it("emits a reject transition command without changing status locally", () => {
  const model = {
    ...candidateModel(),
    responseMessage: FieldValidation.NotValidated({ value: "Jeg kan ikke delta." }),
  }
  const [next, commands] = update(model, RejectedCandidate())
  expect(next.isRejecting).toBe(true)
  expect(next.candidate).toBe(model.candidate)
  expect(commands).toHaveLength(1)
})

it("requires a message before requesting a new time", () => {
  const [invalid, invalidCommands] = update(candidateModel(), RequestedNewTimeCandidate())
  expect(invalid.feedback).toBe("Skriv en melding før du ber om nytt tidspunkt.")
  expect(invalidCommands).toHaveLength(0)

  const model = {
    ...candidateModel(),
    responseMessage: FieldValidation.NotValidated({ value: "Kan vi møtes torsdag?" }),
  }
  const [next, commands] = update(model, RequestedNewTimeCandidate())
  expect(next.isRequestingNewTime).toBe(true)
  expect(commands).toHaveLength(1)
})

it.prop(
  "every generated model and message preserves the model schema",
  {
    model: Schema.toArbitrary(Model)(fc),
    message: Schema.toArbitrary(Message)(fc),
  },
  ({ model, message }) => {
    const [next] = update(model, message)
    expect(() => Schema.decodeUnknownSync(Model)(next)).not.toThrow()
  },
  { fastCheck: { seed: 26082028, numRuns: 150 } },
)

it.prop(
  "pending scheduling suppresses duplicate schedule commands",
  { model: Schema.toArbitrary(Model)(fc) },
  ({ model }) => {
    const pendingModel = {
      ...model,
      mode: "dashboard" as const,
      selectedInterviewId: interviewId,
      isScheduling: true,
    }
    const [next, commands] = update(pendingModel, SubmittedSchedule())
    expect(next).toBe(pendingModel)
    expect(commands).toHaveLength(0)
  },
  { fastCheck: { seed: 26082029, numRuns: 150 } },
)

it("validates every schedule-event field before emitting a command", () => {
  const [next, commands] = update(filledModel(), SubmittedSchedule())
  expect(next.isScheduling).toBe(true)
  expect(commands).toHaveLength(1)
})

it("rejects an invalid datetime without emitting a schedule command", () => {
  const model = {
    ...filledModel(),
    datetime: FieldValidation.NotValidated({ value: "not-a-date" }),
  }
  const [next, commands] = update(model, SubmittedSchedule())
  expect(next.isScheduling).toBe(false)
  expect(next.feedback).toBe("Kontroller feltene.")
  expect(commands).toHaveLength(0)
})

it("updates each schedule field through its typed message", () => {
  const [afterDatetime] = update(makeInitialModel("dashboard"), UpdatedDatetime({
    value: "2026-09-14T15:00:00+02:00",
  }))
  const [afterMapLink] = update(afterDatetime, UpdatedMapLink({
    value: "https://maps.example.com/interview",
  }))
  expect(afterMapLink.datetime.value).toBe("2026-09-14T15:00:00+02:00")
  expect(afterMapLink.mapLink.value).toBe("https://maps.example.com/interview")
})

it("clears schedule form state when opening another interview", () => {
  const [next] = update(filledModel(), OpenedSchedule({ interviewId }))
  expect(next.datetime.value).toBe("")
  expect(next.mapLink.value).toBe("")
  expect(next.message.value).toBe("")
})
