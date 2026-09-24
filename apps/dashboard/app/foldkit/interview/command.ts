import { RecruitmentInvitationResponseMessageSchema } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import type { InvitationResponseClient } from "./browser-client";
import {
  InvitationResponseRequestIdSchema,
  type InvitationBridgeFailure,
  type InvitationResponseAction,
} from "./bridge";
import {
  FailedInvitationResponse,
  FailedReadInvitationResponse,
  SucceededInvitationResponse,
  SucceededReadInvitationResponse,
  type Message,
} from "./message";

export interface InterviewCommands {
  readonly ReadInvitationResponse: (args: {
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly ConfirmInvitation: (args: {
    readonly requestId: number;
    readonly etag: typeof StrongETag.Type;
  }) => Command.Command<Message>;
  readonly RejectInvitation: (args: {
    readonly requestId: number;
    readonly etag: typeof StrongETag.Type;
    readonly message: string | null;
  }) => Command.Command<Message>;
  readonly RequestNewInvitationTime: (args: {
    readonly requestId: number;
    readonly etag: typeof StrongETag.Type;
    readonly message: string;
  }) => Command.Command<Message>;
}

export const commandsFor = (client: InvitationResponseClient): InterviewCommands => {
  const ReadInvitationResponse = Command.define("ReadInvitationResponse", {
    args: { requestId: InvitationResponseRequestIdSchema },
    messages: [SucceededReadInvitationResponse, FailedReadInvitationResponse],
    execute: ({ requestId }) =>
      client.recruitment.readInvitationResponse().pipe(
        Effect.map(({ observation, etag }) =>
          SucceededReadInvitationResponse({ requestId, observation, etag }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedReadInvitationResponse({ requestId, failure })),
        ),
      ),
  });

  const mutationWithFreshRead = (
    mutation: Effect.Effect<void, InvitationBridgeFailure>,
    requestId: number,
    action: InvitationResponseAction,
  ) =>
    mutation.pipe(
      Effect.flatMap(() => client.recruitment.readInvitationResponse()),
      Effect.map(({ observation, etag }) =>
        SucceededInvitationResponse({ requestId, action, observation, etag }),
      ),
      Effect.catch((failure) =>
        Effect.succeed(FailedInvitationResponse({ requestId, action, failure })),
      ),
    );

  const ConfirmInvitation = Command.define("ConfirmInvitation", {
    args: { requestId: InvitationResponseRequestIdSchema, etag: StrongETag },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, etag }) =>
      mutationWithFreshRead(client.recruitment.confirmInvitation({ etag }), requestId, "Confirm"),
  });

  const RejectInvitation = Command.define("RejectInvitation", {
    args: {
      requestId: InvitationResponseRequestIdSchema,
      etag: StrongETag,
      message: S.NullOr(RecruitmentInvitationResponseMessageSchema),
    },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, etag, message }) =>
      mutationWithFreshRead(
        client.recruitment.rejectInvitation({ etag, message }),
        requestId,
        "Reject",
      ),
  });

  const RequestNewInvitationTime = Command.define("RequestNewInvitationTime", {
    args: {
      requestId: InvitationResponseRequestIdSchema,
      etag: StrongETag,
      message: RecruitmentInvitationResponseMessageSchema,
    },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, etag, message }) =>
      mutationWithFreshRead(
        client.recruitment.requestNewInvitationTime({ etag, message }),
        requestId,
        "RequestNewTime",
      ),
  });

  return {
    ReadInvitationResponse,
    ConfirmInvitation,
    RejectInvitation,
    RequestNewInvitationTime,
  };
};
