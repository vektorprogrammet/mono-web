import { Context, Effect } from "effect";
import type {
  DepartmentNotFound,
  MembershipInvalidInterval,
  MembershipNotFound,
  MembershipRevisionConflict,
  MembershipStaleRevision,
  OrganizationDecodeError,
  OrganizationImportError,
  OrganizationPersistenceError,
  TeamNotFound,
} from "./errors.js";
import type {
  Department,
  DepartmentId,
  Membership,
  MembershipId,
  Team,
  TeamId,
} from "./schema.js";
import type { LegacyOrganizationSnapshot, OrganizationImportResult } from "./import.js";
import type { MembershipRevisionCommand } from "./transitions.js";

export type OrganizationReadError =
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | DepartmentNotFound
  | TeamNotFound
  | MembershipNotFound;

export type OrganizationRevisionError =
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | MembershipNotFound
  | MembershipStaleRevision
  | MembershipInvalidInterval
  | MembershipRevisionConflict;

export interface OrganizationShape {
  readonly readDepartment: (
    departmentId: DepartmentId,
  ) => Effect.Effect<Department, OrganizationReadError>;
  readonly listDepartments: Effect.Effect<
    ReadonlyArray<Department>,
    OrganizationPersistenceError | OrganizationDecodeError
  >;
  readonly readTeam: (teamId: TeamId) => Effect.Effect<Team, OrganizationReadError>;
  readonly listTeams: (
    departmentId?: DepartmentId,
  ) => Effect.Effect<
    ReadonlyArray<Team>,
    OrganizationPersistenceError | OrganizationDecodeError
  >;
  readonly readMembership: (membershipId: MembershipId) => Effect.Effect<Membership, OrganizationReadError>;
  readonly listMembershipsForTeam: (
    teamId: TeamId,
  ) => Effect.Effect<
    ReadonlyArray<Membership>,
    OrganizationPersistenceError | OrganizationDecodeError
  >;
  readonly listHistoricalMemberships: Effect.Effect<
    ReadonlyArray<Membership>,
    OrganizationPersistenceError | OrganizationDecodeError
  >;
  readonly reviseMembership: (
    command: Extract<MembershipRevisionCommand, { readonly _tag: "ReviseMembership" }>,
  ) => Effect.Effect<Membership, OrganizationRevisionError>;
  readonly suspendMembership: (
    command: Extract<MembershipRevisionCommand, { readonly _tag: "SuspendMembership" }>,
  ) => Effect.Effect<Membership, OrganizationRevisionError>;
  readonly reinstateMembership: (
    command: Extract<MembershipRevisionCommand, { readonly _tag: "ReinstateMembership" }>,
  ) => Effect.Effect<Membership, OrganizationRevisionError>;
  readonly importLegacyOrganization: (
    snapshot: LegacyOrganizationSnapshot,
  ) => Effect.Effect<OrganizationImportResult, OrganizationImportError | OrganizationPersistenceError>;
}

export class Organization extends Context.Service<Organization, OrganizationShape>()(
  "@vektorprogrammet/domain/Organization",
) {}
