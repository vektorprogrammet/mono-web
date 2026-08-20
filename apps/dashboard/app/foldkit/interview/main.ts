import { type EffectSdk } from "@vektorprogrammet/sdk/effect"
import { Runtime } from "foldkit"
import { makeInterviewCommands } from "./command"
import { OpenedCandidate } from "./message"
import { Model, makeInitialModel } from "./model"
import "./styles.css"
import { makeUpdate } from "./update"
import { view } from "./view"

export type InterviewMode = "dashboard" | "candidate"

export type InterviewRuntimeInput = {
  readonly mode: InterviewMode
  readonly responseCapability?: string | null
  readonly client: EffectSdk
}

export function embedInterview(
  container: HTMLElement,
  input: InterviewRuntimeInput,
): () => void {
  const client = input.client
  const commands = makeInterviewCommands(
    client,
    input.responseCapability ?? null,
  )
  const update = makeUpdate(commands)
  const initialModel = makeInitialModel(input.mode)
  const program = Runtime.makeElement({
    Model,
    container,
    init: () =>
      input.mode === "candidate"
        ? update(initialModel, OpenedCandidate())
        : [initialModel, [commands.LoadInterviews()]],
    update,
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section([
          h.Class("foldkit-interview fk-error fk-error--fatal"),
          h.Role("alert"),
        ], [
          h.h1([], ["Intervjuvisningen kunne ikke startes"]),
          h.p([], ["Last siden på nytt og prøv igjen."]),
        ]),
    },
  })

  const handle = Runtime.embed(program)
  return () => handle.dispose()
}
