import { StrongETag } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import {
  InvitationBridgeFailureSchema,
  InvitationResponseActionSchema,
  InvitationResponseObservationSchema,
  InvitationResponseRequestIdSchema,
} from "./bridge";

export const OpenedInvitationResponse = taggedStruct("OpenedInvitationResponse", {});

export const SucceededReadInvitationResponse = taggedStruct("SucceededReadInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  observation: InvitationResponseObservationSchema,
  etag: StrongETag,
});

export const FailedReadInvitationResponse = taggedStruct("FailedReadInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  failure: InvitationBridgeFailureSchema,
});

export const UpdatedResponseMessage = taggedStruct("UpdatedResponseMessage", { value: S.String });

export const ConfirmedInvitation = taggedStruct("ConfirmedInvitation", {});

export const RejectedInvitation = taggedStruct("RejectedInvitation", {});

export const RequestedNewInvitationTime = taggedStruct("RequestedNewInvitationTime", {});

export const SucceededInvitationResponse = taggedStruct("SucceededInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  action: InvitationResponseActionSchema,
  observation: InvitationResponseObservationSchema,
  etag: StrongETag,
});

export const FailedInvitationResponse = taggedStruct("FailedInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  action: InvitationResponseActionSchema,
  failure: InvitationBridgeFailureSchema,
});

export const Message = S.Union([
  OpenedInvitationResponse,
  SucceededReadInvitationResponse,
  FailedReadInvitationResponse,
  UpdatedResponseMessage,
  ConfirmedInvitation,
  RejectedInvitation,
  RequestedNewInvitationTime,
  SucceededInvitationResponse,
  FailedInvitationResponse,
]);

export type Message = S.Schema.Type<typeof Message>;
