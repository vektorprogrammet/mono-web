import { RecruitmentInvitationResponseMessageSchema } from "@vektorprogrammet/domain/recruitment";
import { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import type { InvitationResponseClient } from "./browser-client";
import { InvitationResponseRequestIdSchema } from "./bridge";
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

export const makeInterviewCommands = (client: InvitationResponseClient): InterviewCommands => {
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

  const ConfirmInvitation = Command.define("ConfirmInvitation", {
    args: { requestId: InvitationResponseRequestIdSchema, etag: StrongETag },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, etag }) =>
      client.recruitment.confirmInvitation({ etag }).pipe(
        Effect.map(({ observation, etag }) =>
          SucceededInvitationResponse({ requestId, action: "Confirm", observation, etag }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedInvitationResponse({ requestId, action: "Confirm", failure })),
        ),
      ),
  });

  const RejectInvitation = Command.define("RejectInvitation", {
    args: {
      requestId: InvitationResponseRequestIdSchema,
      etag: StrongETag,
      message: S.NullOr(RecruitmentInvitationResponseMessageSchema),
    },
    messages: [SucceededInvitationResponse, FailedInvitationResponse],
    execute: ({ requestId, etag, message }) =>
      client.recruitment.rejectInvitation({ etag, message }).pipe(
        Effect.map(({ observation, etag }) =>
          SucceededInvitationResponse({ requestId, action: "Reject", observation, etag }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(FailedInvitationResponse({ requestId, action: "Reject", failure })),
        ),
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
      client.recruitment.requestNewInvitationTime({ etag, message }).pipe(
        Effect.map(({ observation, etag }) =>
          SucceededInvitationResponse({
            requestId,
            action: "RequestNewTime",
            observation,
            etag,
          }),
        ),
        Effect.catch((failure) =>
          Effect.succeed(
            FailedInvitationResponse({ requestId, action: "RequestNewTime", failure }),
          ),
        ),
      ),
  });

  return {
    ReadInvitationResponse,
    ConfirmInvitation,
    RejectInvitation,
    RequestNewInvitationTime,
  };
};
