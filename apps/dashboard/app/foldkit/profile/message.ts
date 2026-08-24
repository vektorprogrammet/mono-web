import { Schema as S } from "effect";
import { m } from "foldkit/message";
import type { ProfileCommand } from "./model";
import {
  ProfileBridgeFailure,
  ProfileRequestId,
} from "./bridge";
import { UserProfile } from "@vektorprogrammet/sdk/effect";

export const OpenedProfileEditor = m("OpenedProfileEditor");

export const SucceededReadProfile = m("SucceededReadProfile", {
  requestId: ProfileRequestId,
  profile: UserProfile,
});

export const FailedReadProfile = m("FailedReadProfile", {
  requestId: ProfileRequestId,
  failure: ProfileBridgeFailure,
});

export const UpdatedProfileField = m("UpdatedProfileField", {
  field: S.Literals(["firstName", "lastName", "email", "phone"]),
  value: S.String,
});

export const SubmittedProfile = m("SubmittedProfile");

export const CancelledProfileEdit = m("CancelledProfileEdit");

export const SucceededProfileSave = m("SucceededProfileSave", {
  requestId: ProfileRequestId,
  commandId: S.String,
  profile: UserProfile,
});

export const FailedProfileSave = m("FailedProfileSave", {
  requestId: ProfileRequestId,
  failure: ProfileBridgeFailure,
});

export const Message = S.Union([
  OpenedProfileEditor,
  SucceededReadProfile,
  FailedReadProfile,
  UpdatedProfileField,
  SubmittedProfile,
  CancelledProfileEdit,
  SucceededProfileSave,
  FailedProfileSave,
]);
export type Message = S.Schema.Type<typeof Message>;

export type SubmittedProfilePayload = { command: ProfileCommand };
