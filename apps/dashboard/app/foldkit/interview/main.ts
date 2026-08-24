import { Runtime } from "foldkit"
import type { InvitationResponseClient } from "./browser-client"
import { makeInterviewCommands } from "./command"
import { OpenedInvitationResponse } from "./message"
import { Model, makeInitialModel } from "./model"
import "./styles.css"
import { makeUpdate } from "./update"
import { view } from "./view"

export interface InterviewRuntimeInput {
  readonly client: InvitationResponseClient
}

export function embedInterview(
  container: HTMLElement,
  input: InterviewRuntimeInput,
): () => void {
  const commands = makeInterviewCommands(input.client)
  const update = makeUpdate(commands)
  const initialModel = makeInitialModel()
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => update(initialModel, OpenedInvitationResponse()),
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
