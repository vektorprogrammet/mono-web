import { StrongETag } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import {
  InvitationBridgeFailureSchema,
  InvitationResponseActionSchema,
  InvitationResponseObservationSchema,
  InvitationResponseRequestIdSchema,
} from "./bridge";

export const InvitationResponseData = AsyncData.Schema(
  InvitationResponseObservationSchema,
  InvitationBridgeFailureSchema,
);

const StringField = FieldValidation.Field(S.String);

export const Model = S.Struct({
  responseMessage: StringField,
  invitationResponse: InvitationResponseData.schema,
  etag: S.NullOr(StrongETag),
  selectedAction: S.NullOr(InvitationResponseActionSchema),
  requestId: InvitationResponseRequestIdSchema,
  failure: S.NullOr(InvitationBridgeFailureSchema),
  validationFeedback: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const makeInitialModel = (): Model => ({
  responseMessage: FieldValidation.NotValidated({ value: "" }),
  invitationResponse: AsyncData.Idle(),
  etag: null,
  selectedAction: null,
  requestId: 0,
  failure: null,
  validationFeedback: null,
});
