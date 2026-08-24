import { UserProfile } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import { ProfileBridgeFailure, ProfileRequestId } from "./bridge";

export const UpdatedProfileField = m("UpdatedProfileField", {
  field: S.Literals(["firstName", "lastName", "email", "phone"]),
  value: S.String,
});

export const SubmittedProfile = m("SubmittedProfile");

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
  UpdatedProfileField,
  SubmittedProfile,
  SucceededProfileSave,
  FailedProfileSave,
]);
export type Message = S.Schema.Type<typeof Message>;
