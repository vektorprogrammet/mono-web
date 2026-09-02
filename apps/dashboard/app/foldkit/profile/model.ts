import { ProfileMergePatch, StrongETag, UserProfileResponse } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { FieldValidation } from "foldkit";
import { ProfileBridgeFailure, ProfileRequestId } from "./bridge";

const StringField = FieldValidation.Field(S.String);

export const ProfileInput = S.Struct({
  profile: UserProfileResponse,
  etag: StrongETag,
});
export type ProfileInput = S.Schema.Type<typeof ProfileInput>;
export const ProfileInputJson = S.fromJsonString(ProfileInput);

export const ProfileCommand = S.Struct({
  commandId: S.NonEmptyString,
  etag: StrongETag,
  ...ProfileMergePatch.fields,
});
export type ProfileCommand = S.Schema.Type<typeof ProfileCommand>;

export const Model = S.Struct({
  profile: UserProfileResponse,
  etag: StrongETag,
  firstName: StringField,
  lastName: StringField,
  email: StringField,
  phone: StringField,
  isSaving: S.Boolean,
  requestId: ProfileRequestId,
  commandIdSeed: S.NonEmptyString,
  commandSequence: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  failure: S.NullOr(ProfileBridgeFailure),
  status: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const makeInitialModel = (input: ProfileInput, commandIdSeed: string): Model => ({
  profile: input.profile,
  etag: input.etag,
  firstName: FieldValidation.NotValidated({ value: input.profile.firstName }),
  lastName: FieldValidation.NotValidated({ value: input.profile.lastName }),
  email: FieldValidation.NotValidated({ value: input.profile.email }),
  phone: FieldValidation.NotValidated({ value: input.profile.phone }),
  isSaving: false,
  requestId: 0,
  commandIdSeed,
  commandSequence: 1,
  failure: null,
  status: null,
});

export type UserProfileObservation = typeof UserProfileResponse.Type;
