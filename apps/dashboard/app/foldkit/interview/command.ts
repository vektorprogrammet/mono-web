import { ResponseCapability } from "@vektorprogrammet/sdk/effect"
import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import type { InterviewResponseClient } from "./browser-client"
import {
  FailedCandidateResponse,
  FailedReadCandidate,
  SucceededCandidateResponse,
  SucceededReadCandidate,
  type Message,
} from "./message"

const candidateUnavailable = "Invitasjonen er ikke tilgjengelig."

export interface InterviewCommands {
  readonly ReadCandidate: () => Command.Command<Message>
  readonly ConfirmCandidate: () => Command.Command<Message>
  readonly RejectCandidate: (args: { readonly message: string }) => Command.Command<Message>
  readonly RequestNewTimeCandidate: (args: {
    readonly message: string
  }) => Command.Command<Message>
}

export const makeInterviewCommands = (
  client: InterviewResponseClient,
  rawResponseCapability: string | null,
): InterviewCommands => {
  const ReadCandidate = Command.define("ReadCandidate", {
    messages: [SucceededReadCandidate, FailedReadCandidate],
    execute: S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.read(capability)),
      Effect.map((candidate) => SucceededReadCandidate({ candidate })),
      Effect.catch(() =>
        Effect.succeed(FailedReadCandidate({ message: candidateUnavailable }))
      ),
    ),
  })

  const ConfirmCandidate = Command.define("ConfirmCandidate", {
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.confirm(capability)),
      Effect.as(SucceededCandidateResponse()),
      Effect.catch(() =>
        Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
      ),
    ),
  })

  const RejectCandidate = Command.define("RejectCandidate", {
    args: { message: S.String },
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: ({ message }) =>
      S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
        Effect.flatMap((capability) => client.interviewResponses.reject(capability, message)),
        Effect.as(SucceededCandidateResponse()),
        Effect.catch(() =>
          Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
        ),
      ),
  })

  const RequestNewTimeCandidate = Command.define("RequestNewTimeCandidate", {
    args: { message: S.String },
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: ({ message }) =>
      S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
        Effect.flatMap((capability) =>
          client.interviewResponses.requestNewTime(capability, message)
        ),
        Effect.as(SucceededCandidateResponse()),
        Effect.catch(() =>
          Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
        ),
      ),
  })

  return {
    ReadCandidate,
    ConfirmCandidate,
    RejectCandidate,
    RequestNewTimeCandidate,
  }
}
