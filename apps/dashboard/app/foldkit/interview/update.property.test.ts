import { expect, it } from "@effect/vitest"
import { CandidateInterviewView } from "@vektorprogrammet/sdk/effect"
import { Effect, Schema } from "effect"
import * as fc from "effect/testing/FastCheck"
import { FieldValidation } from "foldkit"
import type { InterviewResponseClient } from "./browser-client"
import { makeInterviewCommands } from "./command"
import { makeUpdate } from "./update"
import {
  ConfirmedCandidate,
  Message,
  RejectedCandidate,
  RequestedNewTimeCandidate,
} from "./message"
import { CandidateData, Model, makeInitialModel } from "./model"

const testClient: InterviewResponseClient = {
  interviewResponses: {
    read: () => Effect.die("not executed by transition tests"),
    confirm: () => Effect.die("not executed by transition tests"),
    reject: () => Effect.die("not executed by transition tests"),
    requestNewTime: () => Effect.die("not executed by transition tests"),
  },
}
const update = makeUpdate(makeInterviewCommands(testClient, null))
const candidateModel = () => ({
  ...makeInitialModel(),
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
