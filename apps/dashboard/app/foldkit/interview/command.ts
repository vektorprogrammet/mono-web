import { RecruitmentInvitationResponseMessageSchema } from "@vektorprogrammet/sdk/effect"
import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import type { InvitationResponseClient } from "./browser-client"
import { InvitationResponseRequestIdSchema } from "./bridge"
import {
  FailedInvitationResponse,
  FailedReadInvitationResponse,
  SucceededInvitationResponse,
  SucceededReadInvitationResponse,
  type Message,
} from "./message"

export interface InterviewCommands {
  readonly ReadInvitationResponse: (args: {
    readonly requestId: number
  }) => Command.Command<Message>
  readonly ConfirmInvitation: (args: {
    readonly requestId: number
  }) => Command.Command<Message>
  readonly RejectInvitation: (args: {
    readonly requestId: number
    readonly message: string | null
  }) => Command.Command<Message>
  readonly RequestNewInvitationTime: (args: {
    readonly requestId: number
    readonly message: string
  }) => Command.Command<Message>
}

export const makeInterviewCommands = (
  client: InvitationResponseClient,
): InterviewCommands => {
  const ReadInvitationResponse = Command.define("ReadInvitationResponse", {
    args: { requestId: InvitationResponseRequestIdSchema },
    messages: [SucceededReadInvitationResponse, FailedReadInvitationResponse],
    execute: ({ requestId }) =>
      client.recruitmentInvitationResponses.read().pipe(
        Effect.map((observation) =>
          SucceededReadInvitationResponse({ requestId, observation })
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedReadInvitationResponse({ requestId, failure }))
        ),
      ),
  })

  const ConfirmInvitation = Command.define("ConfirmInvitation", {
    args: { requestId: InvitationResponseRequestIdSchema },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId }) =>
      client.recruitmentInvitationResponses.confirm().pipe(
        Effect.flatMap(() => client.recruitmentInvitationResponses.read()),
        Effect.map((observation) =>
          SucceededInvitationResponse({ requestId, action: "Confirm", observation })
        ),
        Effect.catch((failure) =>
          Effect.succeed(
            FailedInvitationResponse({ requestId, action: "Confirm", failure }),
          )
        ),
      ),
  })

  const RejectInvitation = Command.define("RejectInvitation", {
    args: {
      requestId: InvitationResponseRequestIdSchema,
      message: S.NullOr(RecruitmentInvitationResponseMessageSchema),
    },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, message }) =>
      client.recruitmentInvitationResponses.reject({ message }).pipe(
        Effect.flatMap(() => client.recruitmentInvitationResponses.read()),
        Effect.map((observation) =>
          SucceededInvitationResponse({ requestId, action: "Reject", observation })
        ),
        Effect.catch((failure) =>
          Effect.succeed(
            FailedInvitationResponse({ requestId, action: "Reject", failure }),
          )
        ),
      ),
  })

  const RequestNewInvitationTime = Command.define("RequestNewInvitationTime", {
    args: {
      requestId: InvitationResponseRequestIdSchema,
      message: RecruitmentInvitationResponseMessageSchema,
    },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, message }) =>
      client.recruitmentInvitationResponses.requestNewTime({ message }).pipe(
        Effect.flatMap(() => client.recruitmentInvitationResponses.read()),
        Effect.map((observation) =>
          SucceededInvitationResponse({ requestId, action: "RequestNewTime", observation })
        ),
        Effect.catch((failure) =>
          Effect.succeed(
            FailedInvitationResponse({ requestId, action: "RequestNewTime", failure }),
          )
        ),
      ),
  })

  return {
    ReadInvitationResponse,
    ConfirmInvitation,
    RejectInvitation,
    RequestNewInvitationTime,
  }
}
