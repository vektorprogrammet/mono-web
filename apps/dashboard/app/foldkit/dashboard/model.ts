import { Schema as S } from "effect";
import { UserRoleSchema } from "@vektorprogrammet/http-api";
import { RecruitmentInput } from "../recruitment/model";
import { SchedulingInput } from "../scheduling/model";
import { isAdmissionPath } from "./navigation";

/** The profile's navigation role: a projection of authority, never authority itself. */
export const DashboardRole = UserRoleSchema;

export type DashboardRole = S.Schema.Type<typeof DashboardRole>;

export const DashboardIdentity = S.Struct({
  name: S.String,
  avatar: S.NullOr(S.String),
});

export type DashboardIdentity = S.Schema.Type<typeof DashboardIdentity>;

export const LandingSummary = S.TaggedStruct("Unavailable", {});

export type LandingSummary = S.Schema.Type<typeof LandingSummary>;

export const DashboardInput = S.Struct({
  user: S.NullOr(DashboardIdentity),
  role: S.NullOr(DashboardRole),
  activePath: S.String,
  summary: LandingSummary,
  recruitment: S.NullOr(RecruitmentInput),
  scheduling: S.NullOr(SchedulingInput),
});

export type DashboardInput = S.Schema.Type<typeof DashboardInput>;

export const DashboardInputJson = S.fromJsonString(DashboardInput);

export const ReadyModel = S.TaggedStruct("Ready", {user: S.NullOr(DashboardIdentity),
role: S.NullOr(DashboardRole),
activePath: S.String,
summary: LandingSummary,
recruitment: S.NullOr(RecruitmentInput),
scheduling: S.NullOr(SchedulingInput),
isMobileNavigationOpen: S.Boolean,
isAdmissionMenuOpen: S.Boolean,
isProfileMenuOpen: S.Boolean});

export const InvalidInputModel = S.TaggedStruct("InvalidInput", {});

export const Model = S.Union([ReadyModel, InvalidInputModel]);

export type Model = S.Schema.Type<typeof Model>;

export type ReadyModel = S.Schema.Type<typeof ReadyModel>;

type DashboardInitialInput = Omit<DashboardInput, "scheduling"> & {
  readonly scheduling?: DashboardInput["scheduling"];
};

export const init = (input: DashboardInitialInput): Model => (ReadyModel.make({
  ...input,
  scheduling: input.scheduling ?? null,
  isMobileNavigationOpen: false,
  isAdmissionMenuOpen: isAdmissionPath(input.activePath),
  isProfileMenuOpen: false,
}));

export const invalidInputModel = (): Model => (InvalidInputModel.make({}));

export const isDashboardRole = S.is(DashboardRole);
