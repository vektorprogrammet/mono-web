import { UpdateOwnProfileCommand, UserProfile } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import { ProfileBridgeFailure, ProfileRequestId } from "./bridge";
export const ProfileObservationData = AsyncData.Schema(UserProfile, ProfileBridgeFailure);

const StringField = FieldValidation.Field(S.String);

export const Model = S.Struct({
  profile: ProfileObservationData.schema,
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

export const makeInitialModel = (
  profile: S.Schema.Type<typeof UserProfile>,
  commandIdSeed: string,
): Model => ({
  profile: ProfileObservationData.Success({ data: profile }),
  firstName: FieldValidation.NotValidated({ value: profile.firstName }),
  lastName: FieldValidation.NotValidated({ value: profile.lastName }),
  email: FieldValidation.NotValidated({ value: profile.email }),
  phone: FieldValidation.NotValidated({ value: profile.phone ?? "" }),
  isSaving: false,
  requestId: 0,
  commandIdSeed,
  commandSequence: 1,
  failure: null,
  status: null,
});

export type ProfileCommand = S.Schema.Type<typeof UpdateOwnProfileCommand>;

export const ProfileInputJson = S.fromJsonString(UserProfile);

export type UserProfileObservation = S.Schema.Type<typeof UserProfile>;