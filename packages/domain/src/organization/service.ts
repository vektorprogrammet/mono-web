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
import type { OrganizationDirectoryFacts } from "./directory.js";
import type {
  SemesterId,
  TeamInterestRegistration,
} from "./schema.js";
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
import type { MailingList, MailingListType } from "./mailing-lists.js";
import type { ProfileFailure } from "../profile/errors.js";
import type { Profile } from "../profile/service.js";
import type { MembershipRevisionCommand } from "./transitions.js";

/** Spec 0059 read filter: the authorized scope is explicit input (0055). */
export interface TeamInterestFilter {
  readonly authorizedDepartmentIds: ReadonlyArray<DepartmentId>;
  readonly departmentId?: DepartmentId;
  readonly semesterId?: SemesterId;
}


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

/**
 * Spec 0059 read: durable team-interest registrations with the referenced
 * team name, inside the authorized department scope and ordered by
 * registration_id ASC. No authorization happens here; no narrowing may
 * exceed the authorized set.
 */
  readonly listTeamInterestRegistrations: (
    filter: TeamInterestFilter,
  ) => Effect.Effect<
    ReadonlyArray<TeamInterestRegistration>,
    OrganizationDecodeError | OrganizationPersistenceError
  >;

  /**
   * Spec 0060: pure mailing-list projection over injected member/contact
   * sources. The adapter supplies team members and assistant facts; Profile
   * supplies contacts. Zero persistence, stable ordering.
   */
  readonly projectMailingLists: (input: {
    readonly type: MailingListType;
    readonly authorizedDepartmentIds: ReadonlyArray<DepartmentId>;
    readonly departmentId?: DepartmentId;
    readonly semesterId?: SemesterId;
    readonly assistantsByDepartment?: ReadonlyMap<DepartmentId, ReadonlyArray<PersonId>>;
    readonly semesterWindow?: { readonly startAt: string; readonly endAt: string };
  }) => Effect.Effect<
    ReadonlyArray<MailingList>,
    OrganizationDecodeError | OrganizationPersistenceError | ProfileFailure,
    Profile
  >;

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
  /**
   * Same canonical projection without row locks, for a caller-owned
   * repeatable-read, read-only snapshot.
   */
  readonly resolvePersonAuthorityForRead: (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
  ) => Effect.Effect<
    OrganizationPersonAuthority,
    OrganizationDecodeError | OrganizationPersistenceError
  >;
  /** Spec 0057: per-person directory facts at one authorizationInstant. */
  readonly deriveDirectoryFacts: (
    personIds: ReadonlyArray<PersonId>,
    authorizationInstant: OrganizationAuthorityInstant,
  ) => Effect.Effect<
    OrganizationDirectoryFacts,
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
