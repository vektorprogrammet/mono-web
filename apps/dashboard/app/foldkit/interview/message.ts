import { Schema as S } from "effect";
import { m } from "foldkit/message";
import {
  InvitationBridgeFailureSchema,
  InvitationResponseActionSchema,
  InvitationResponseObservationSchema,
  InvitationResponseRequestIdSchema,
} from "./bridge";

export const OpenedInvitationResponse = m("OpenedInvitationResponse");
export const SucceededReadInvitationResponse = m("SucceededReadInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  observation: InvitationResponseObservationSchema,
});
export const FailedReadInvitationResponse = m("FailedReadInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  failure: InvitationBridgeFailureSchema,
});
export const UpdatedResponseMessage = m("UpdatedResponseMessage", { value: S.String });
export const ConfirmedInvitation = m("ConfirmedInvitation");
export const RejectedInvitation = m("RejectedInvitation");
export const RequestedNewInvitationTime = m("RequestedNewInvitationTime");
export const SucceededInvitationResponse = m("SucceededInvitationResponse", {
  requestId: InvitationResponseRequestIdSchema,
  action: InvitationResponseActionSchema,
  observation: InvitationResponseObservationSchema,
});
export const FailedInvitationResponse = m("FailedInvitationResponse", {
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
