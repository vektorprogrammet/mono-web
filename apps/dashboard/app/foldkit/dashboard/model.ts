import { Schema as S } from "effect"
import { isAdmissionPath } from "./navigation"

export const DashboardRole = S.Literals([
  "ROLE_TEAM_MEMBER",
  "ROLE_TEAM_LEADER",
  "ROLE_ADMIN",
])
export type DashboardRole = S.Schema.Type<typeof DashboardRole>

export const DashboardIdentity = S.Struct({
  name: S.String,
  avatar: S.NullOr(S.String),
})
export type DashboardIdentity = S.Schema.Type<typeof DashboardIdentity>

const AvailableLandingSummary = S.Struct({
  _tag: S.Literal("Available"),
  department: S.String,
  activeAssistants: S.Number,
  pendingApplications: S.Number,
  upcomingInterviews: S.Number,
})

const UnavailableLandingSummary = S.Struct({
  _tag: S.Literal("Unavailable"),
})

export const LandingSummary = S.Union([
  AvailableLandingSummary,
  UnavailableLandingSummary,
])
export type LandingSummary = S.Schema.Type<typeof LandingSummary>

export const DashboardInput = S.Struct({
  identity: DashboardIdentity,
  role: DashboardRole,
  activePath: S.String,
  summary: LandingSummary,
})
export type DashboardInput = S.Schema.Type<typeof DashboardInput>

export const DashboardInputJson = S.fromJsonString(DashboardInput)

const ReadyModel = S.Struct({
  _tag: S.Literal("Ready"),
  identity: DashboardIdentity,
  role: DashboardRole,
  activePath: S.String,
  summary: LandingSummary,
  isMobileNavigationOpen: S.Boolean,
  isAdmissionMenuOpen: S.Boolean,
  isProfileMenuOpen: S.Boolean,
})

const InvalidInputModel = S.Struct({
  _tag: S.Literal("InvalidInput"),
})

export const Model = S.Union([ReadyModel, InvalidInputModel])
export type Model = S.Schema.Type<typeof Model>
export type ReadyModel = S.Schema.Type<typeof ReadyModel>

export const makeInitialModel = (input: DashboardInput): Model => ({
  _tag: "Ready",
  ...input,
  isMobileNavigationOpen: false,
  isAdmissionMenuOpen: isAdmissionPath(input.activePath),
  isProfileMenuOpen: false,
})

export const makeInvalidInputModel = (): Model => ({
  _tag: "InvalidInput",
})

export const isDashboardRole = (role: string): role is DashboardRole =>
  role === "ROLE_TEAM_MEMBER" ||
  role === "ROLE_TEAM_LEADER" ||
  role === "ROLE_ADMIN"
