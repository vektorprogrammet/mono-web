import { StrongETag, UserProfileResponse } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import { ProfileBridgeFailure, ProfileRequestId } from "./bridge";

export const UpdatedProfileField = taggedStruct("UpdatedProfileField", {
  field: S.Literals(["firstName", "lastName", "email", "phone"]),
  value: S.String,
});

export const SubmittedProfile = taggedStruct("SubmittedProfile", {});

export const SucceededProfileSave = taggedStruct("SucceededProfileSave", {
  requestId: ProfileRequestId,
  profile: UserProfileResponse,
  etag: StrongETag,
});

export const FailedProfileSave = taggedStruct("FailedProfileSave", {
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
