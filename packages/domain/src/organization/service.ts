import { Context, Effect } from "effect";
import type {
  CreateDepartmentCommand,
  CreateDepartmentResult,
  CreateFieldOfStudyCommand,
  CreateFieldOfStudyResult,
  CreateTeamCommand,
  CreateTeamResult,
  OrganizationActor,
} from "./administration-schema.js";
import type { OrganizationAuthorityInstant, OrganizationPersonAuthority } from "./authority.js";
import type {
  DepartmentNotFound,
  MembershipInvalidInterval,
  MembershipNotFound,
  MembershipRevisionConflict,
  MembershipStaleRevision,
  OrganizationDecodeError,
  OrganizationImportError,
  OrganizationPersistenceError,
  OrganizationCommandFailure,
  TeamNotFound,
} from "./errors.js";
import type {
  Department,
  DepartmentId,
  FieldOfStudy,
  Membership,
  MembershipId,
  PersonId,
  Team,
  TeamId,
} from "./schema.js";
import type { LegacyOrganizationSnapshot, OrganizationImportResult } from "./import.js";
import type { MembershipRevisionCommand } from "./transitions.js";

export type OrganizationListFailure = OrganizationDecodeError | OrganizationPersistenceError;
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
  readonly listDepartments: Effect.Effect<ReadonlyArray<Department>, OrganizationListFailure>;
  readonly readTeam: (teamId: TeamId) => Effect.Effect<Team, OrganizationReadError>;
  readonly listTeams: (
    departmentId?: DepartmentId,
  ) => Effect.Effect<ReadonlyArray<Team>, OrganizationListFailure>;
  readonly listFieldOfStudies: Effect.Effect<ReadonlyArray<FieldOfStudy>, OrganizationListFailure>;
  readonly createDepartment: (
    command: CreateDepartmentCommand,
    actor: OrganizationActor,
  ) => Effect.Effect<CreateDepartmentResult, OrganizationCommandFailure>;
  readonly createTeam: (
    command: CreateTeamCommand,
    actor: OrganizationActor,
  ) => Effect.Effect<CreateTeamResult, OrganizationCommandFailure>;
  readonly createFieldOfStudy: (
    command: CreateFieldOfStudyCommand,
    actor: OrganizationActor,
  ) => Effect.Effect<CreateFieldOfStudyResult, OrganizationCommandFailure>;
  readonly readMembership: (
    membershipId: MembershipId,
  ) => Effect.Effect<Membership, OrganizationReadError>;
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
  readonly resolvePersonAuthority: (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
  ) => Effect.Effect<
    OrganizationPersonAuthority,
    OrganizationDecodeError | OrganizationPersistenceError
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
  ) => Effect.Effect<
    OrganizationImportResult,
    OrganizationImportError | OrganizationPersistenceError
  >;
}

export class Organization extends Context.Service<Organization, OrganizationShape>()(
  "@vektorprogrammet/domain/Organization",
) {}
