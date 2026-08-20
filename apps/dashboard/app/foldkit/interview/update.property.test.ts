import { expect, it } from "@effect/vitest"
import { InterviewId, type EffectSdk } from "@vektorprogrammet/sdk/effect"
import { Schema } from "effect"
import * as fc from "effect/testing/FastCheck"
import { FieldValidation } from "foldkit"
import {
  Message,
  OpenedSchedule,
  SubmittedSchedule,
  UpdatedDatetime,
  UpdatedMapLink,
} from "./message"
import { Model, makeInitialModel } from "./model"
import { makeUpdate } from "./update"

const update = makeUpdate(makeInterviewCommands({} as EffectSdk, null))
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
