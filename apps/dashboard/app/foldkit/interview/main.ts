import { Runtime } from "foldkit"
import type { InterviewResponseClient } from "./browser-client"
import { makeInterviewCommands } from "./command"
import { OpenedCandidate } from "./message"
import { Model, makeInitialModel } from "./model"
import "./styles.css"
import { makeUpdate } from "./update"
import { view } from "./view"

export interface InterviewRuntimeInput {
  readonly responseCapability: string | null
  readonly client: InterviewResponseClient
}

export function embedInterview(
  container: HTMLElement,
  input: InterviewRuntimeInput,
): () => void {
  const commands = makeInterviewCommands(input.client, input.responseCapability)
  const update = makeUpdate(commands)
  const initialModel = makeInitialModel()
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => update(initialModel, OpenedCandidate()),
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
