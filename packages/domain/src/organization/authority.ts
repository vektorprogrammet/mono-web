import { Data, Result, Schema } from "effect";
import { dual } from "effect/Function";
import {
  type AdmissionPeriodActor,
  AdmissionPeriodActorSchema,
} from "../admission-period/schema.js";
import { allow, deny, type Decision } from "../authz/decision.js";
import {
  Delegation,
  type OrganizationCapability,
  TeamScope,
  UnitKind,
} from "../authz/delegation.js";
import {
  holdsDepartmentReach,
  leadsAnyTeam,
  ReachedDepartments,
  reachedDepartments,
  reachedTeams,
  reaches,
  ReachTarget,
} from "../authz/reach.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";
import {
  OrganizationMemberSchema,
  type OrganizationActor,
  type OrganizationAdministrator,
  OrganizationAdministratorSchema,
} from "./administration-schema.js";
import { OrganizationRoleDenied } from "./errors.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.trim() === value, {
      message: "a trimmed non-empty string",
    }),
  ),
);

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const OrganizationGlobalAdministratorGrantId = NonEmpty.pipe(
  Schema.brand("OrganizationGlobalAdministratorGrantId"),
);

export type OrganizationGlobalAdministratorGrantId =
  typeof OrganizationGlobalAdministratorGrantId.Type;

export const OrganizationAuthorityInstantSchema = Rfc3339InstantSchema;

export type OrganizationAuthorityInstant = typeof OrganizationAuthorityInstantSchema.Type;

const OrganizationGlobalAdministratorGrantFields = Schema.Struct({
  grantId: OrganizationGlobalAdministratorGrantId,
  personId: PersonId,
  startAt: OrganizationAuthorityInstantSchema,
  endAt: Schema.NullOr(OrganizationAuthorityInstantSchema),
  revision: Revision,
});

export const OrganizationGlobalAdministratorGrantSchema =
  OrganizationGlobalAdministratorGrantFields.pipe(
    Schema.check(
      Schema.makeFilter(
        (grant) => grant.endAt === null || compareRfc3339Instants(grant.endAt, grant.startAt) > 0,
        { message: "a half-open global-administrator grant interval" },
      ),
    ),
  );

export type OrganizationGlobalAdministratorGrant =
  typeof OrganizationGlobalAdministratorGrantSchema.Type;

export const CreateOrganizationGlobalAdministratorGrantInputSchema = Schema.Struct({
  grantId: OrganizationGlobalAdministratorGrantId,
  personId: PersonId,
  startAt: OrganizationAuthorityInstantSchema,
  endAt: Schema.NullOr(OrganizationAuthorityInstantSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (grant) => grant.endAt === null || compareRfc3339Instants(grant.endAt, grant.startAt) > 0,
      { message: "a half-open global-administrator grant interval" },
    ),
  ),
);

export type CreateOrganizationGlobalAdministratorGrantInput =
  typeof CreateOrganizationGlobalAdministratorGrantInputSchema.Type;

export const EndOrganizationGlobalAdministratorGrantInputSchema = Schema.Struct({
  grantId: OrganizationGlobalAdministratorGrantId,
  endAt: OrganizationAuthorityInstantSchema,
  expectedRevision: Revision,
});

export type EndOrganizationGlobalAdministratorGrantInput =
  typeof EndOrganizationGlobalAdministratorGrantInputSchema.Type;

export const RemoveOrganizationGlobalAdministratorGrantInputSchema = Schema.Struct({
  grantId: OrganizationGlobalAdministratorGrantId,
  expectedRevision: Revision,
});

export type RemoveOrganizationGlobalAdministratorGrantInput =
  typeof RemoveOrganizationGlobalAdministratorGrantInputSchema.Type;

export const OrganizationGlobalAdministratorStatusSchema = Schema.Literals([
  "Active",
  "Inactive",
  "Absent",
]);

export type OrganizationGlobalAdministratorStatus =
  typeof OrganizationGlobalAdministratorStatusSchema.Type;

/**
 * One appointment on a team or a department board, with the facts of its unit that reach depends
 * on. `active` means started, not ended, not suspended, and an active unit and department.
 * `unitLeader` is the unit's leadership: a team's leader, or a department board's leader.
 */
export const OrganizationAuthorityMembershipSchema = Schema.Struct({
  membershipId: MembershipId,
  teamId: TeamId,
  departmentId: DepartmentId,
  active: Schema.Boolean,
  unitLeader: Schema.Boolean,
  unitKind: UnitKind,
  teamScope: TeamScope,
  departmentIndependent: Schema.Boolean,
});

export type OrganizationAuthorityMembership = typeof OrganizationAuthorityMembershipSchema.Type;

/** One seat on the national board (Hovedstyret). */
export const OrganizationAuthorityBoardSeatSchema = Schema.Struct({
  membershipId: MembershipId,
  boardId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  active: Schema.Boolean,
  unitLeader: Schema.Boolean,
});

export type OrganizationAuthorityBoardSeat = typeof OrganizationAuthorityBoardSeatSchema.Type;

/**
 * Everything that decides a person's organisational authority at one instant: the
 * global-administrator grant, team and board appointments, national board seats, and the
 * delegations of the person's teams. `authz/reach.ts` interprets it.
 */
export const OrganizationPersonAuthoritySchema = Schema.Struct({
  personId: PersonId,
  evaluatedAt: OrganizationAuthorityInstantSchema,
  globalAdministrator: OrganizationGlobalAdministratorStatusSchema,
  memberships: Schema.Array(OrganizationAuthorityMembershipSchema),
  nationalBoardSeats: Schema.Array(OrganizationAuthorityBoardSeatSchema),
  delegations: Schema.Array(Delegation),
});

export type OrganizationPersonAuthority = typeof OrganizationPersonAuthoritySchema.Type;

/**
 * The coarse dashboard role, a projection for navigation only. A department administrator holds a
 * capability beyond one team through a board leadership or a delegation; a team leader leads an
 * ordinary team and acts within it.
 */
export const ProfileRoleSchema = Schema.Literals([
  "ROLE_ADMIN",
  "ROLE_DEPARTMENT_ADMINISTRATOR",
  "ROLE_TEAM_LEADER",
  "ROLE_TEAM_MEMBER",
]);

export type ProfileRole = typeof ProfileRoleSchema.Type;

/**
 * Maps one explicit department scope and one capability without selecting a primary membership.
 * An active global administrator acts as today (O8-13). Otherwise the capability's reach decides
 * department administration: a board leadership or a delegation, never a team leadership. An
 * active membership in the department without that reach is a member. Roles and grants are
 * independent: an ended global-administrator grant removes no role authority, and only names the
 * denial where nothing reaches the department.
 */
export const mapOrganizationAuthorityToDepartmentActor: {
  (
    capability: OrganizationCapability,
    departmentId: DepartmentId,
  ): (authority: OrganizationPersonAuthority) => Decision<AdmissionPeriodActor>;
  (
    authority: OrganizationPersonAuthority,
    capability: OrganizationCapability,
    departmentId: DepartmentId,
  ): Decision<AdmissionPeriodActor>;
} = dual(
  3,
  (
    authority: OrganizationPersonAuthority,
    capability: OrganizationCapability,
    departmentId: DepartmentId,
  ): Decision<AdmissionPeriodActor> => {
    if (authority.globalAdministrator === "Active") {
      return allow<AdmissionPeriodActor>(
        AdmissionPeriodActorSchema.cases.GlobalAdmin.make({
          personId: authority.personId,
          active: true,
        }),
      );
    }

    if (reaches(authority, capability, ReachTarget.Department({ departmentId }))) {
      return allow<AdmissionPeriodActor>(
        AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
          personId: authority.personId,
          departmentId,
          active: true,
        }),
      );
    }

    const memberships = authority.memberships.filter(
      (membership) => membership.departmentId === departmentId,
    );

    if (memberships.some((membership) => membership.active)) {
      return allow<AdmissionPeriodActor>(
        AdmissionPeriodActorSchema.cases.Member.make({
          personId: authority.personId,
          departmentId,
          active: true,
        }),
      );
    }

    return deny<AdmissionPeriodActor>(
      memberships.length > 0 || authority.globalAdministrator === "Inactive"
        ? "AuthorityInactive"
        : "NotInScope",
    );
  },
);

export const mapOrganizationAuthorityToOrganizationActor = (
  authority: OrganizationPersonAuthority,
): OrganizationActor =>
  authority.globalAdministrator === "Active"
    ? OrganizationAdministratorSchema.make({ personId: authority.personId })
    : OrganizationMemberSchema.make({ personId: authority.personId });

/** Type-only brand. No module exports a value of it, so no module outside this one can build evidence. */
declare const OrganizationAdministratorEvidenceBrand: unique symbol;

/**
 * Proof that a person held active global administration when their authority was resolved.
 * `actor` is the audit identity that the command records.
 */
export interface OrganizationAdministratorEvidence {
  readonly [OrganizationAdministratorEvidenceBrand]: "OrganizationAdministratorEvidence";
  readonly actor: OrganizationAdministrator;
}

/**
 * Checks that a resolved authority holds active global administration, and returns the evidence
 * that the Organization administration commands require.
 *
 * @remarks
 * It is the only constructor of {@link OrganizationAdministratorEvidence}. An active global
 * administrator yields evidence whose actor names the same person; an inactive or absent grant
 * yields `OrganizationRoleDenied` for that person. It reads only `globalAdministrator` and
 * `personId`: memberships, board seats, and delegations confer no organization administration.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const administrator = yield* Effect.fromResult(requireOrganizationAdministrator(authority));
 * yield* organization.createDepartment(command, administrator);
 * ```
 *
 * @avoid Passing an `OrganizationActor` to a create command, or checking its tag at the call site:
 * any module can build an actor, so the command could not trust it. Resolve the authority and
 * require the evidence here.
 *
 * @construct authority-evidence
 */
export const requireOrganizationAdministrator = (
  /** The person's authority, resolved from current facts inside the command transaction. */
  authority: OrganizationPersonAuthority,
): /** Evidence for an active global administrator, or the typed denial. */
Result.Result<OrganizationAdministratorEvidence, OrganizationRoleDenied> =>
  authority.globalAdministrator === "Active"
    ? Result.succeed(
        // SAFETY: the one constructor of the evidence brand; the branch above is the check it proves.
        {
          actor: OrganizationAdministratorSchema.make({ personId: authority.personId }),
        } as OrganizationAdministratorEvidence,
      )
    : Result.fail(
        OrganizationRoleDenied.make({
          actorPersonId: authority.personId,
          requiredRole: "OrganizationAdministrator",
        }),
      );

export const mapOrganizationAuthorityToProfileRole = (
  authority: OrganizationPersonAuthority,
): Decision<ProfileRole> => {
  if (authority.globalAdministrator === "Active") {
    return allow<ProfileRole>("ROLE_ADMIN");
  }

  if (holdsDepartmentReach(authority)) {
    return allow<ProfileRole>("ROLE_DEPARTMENT_ADMINISTRATOR");
  }

  if (leadsAnyTeam(authority)) {
    return allow<ProfileRole>("ROLE_TEAM_LEADER");
  }

  if (
    authority.memberships.some((membership) => membership.active) ||
    authority.nationalBoardSeats.some((seat) => seat.active)
  ) {
    return allow<ProfileRole>("ROLE_TEAM_MEMBER");
  }

  return deny<ProfileRole>(
    authority.globalAdministrator === "Absent" &&
      authority.memberships.length === 0 &&
      authority.nationalBoardSeats.length === 0
      ? "NotInScope"
      : "AuthorityInactive",
  );
};

/** Type-only brand. Only {@link requireTeamInterestScope} builds this evidence. */
declare const TeamInterestReadScopeBrand: unique symbol;

/**
 * The registrations that a person may read now: whole departments that `team-interest.read`
 * reaches, and the teams that it reaches outside them. The listing reads nothing else.
 */
export interface TeamInterestReadScope {
  readonly [TeamInterestReadScopeBrand]: "TeamInterestReadScope";
  readonly personId: PersonId;
  readonly departmentIds: ReadonlyArray<DepartmentId>;
  readonly teams: ReadonlyArray<{ readonly teamId: TeamId; readonly departmentId: DepartmentId }>;
}

/** The person reads no team interest, or none in the requested department. */
export class TeamInterestScopeDenied extends Data.TaggedError("TeamInterestScopeDenied")<{
  readonly personId: PersonId;
  readonly departmentId: DepartmentId | undefined;
}> {}

/**
 * Checks what team interest a resolved authority may read, narrowed to one requested department,
 * and returns the scope that the listing requires.
 *
 * @remarks
 * It is the only constructor of {@link TeamInterestReadScope}. A reach over the organization
 * reads every department in `departments`, also while there is none; a department reach reads
 * that department; a team leader's reach reads the team where no department reach covers it. A
 * person with no reach, or with none in the requested department or its teams, is denied.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const scope = yield* Effect.fromResult(
 *   requireTeamInterestScope(authority, { requested, departments }),
 * );
 * yield* organization.listTeamInterestRegistrations(scope, semesterId);
 * ```
 *
 * @avoid Computing the departments and teams in a handler and passing them to the listing as a
 * filter: the listing then reads whatever scope a caller names. Require the scope here.
 *
 * @construct authority-evidence
 */
export const requireTeamInterestScope: {
  (input: {
    /** The department the request names, if any. */
    readonly requested: DepartmentId | undefined;
    /** Every current department, which an organization-wide reach reads. */
    readonly departments: ReadonlyArray<DepartmentId>;
  }): (
    /** The person's authority, resolved from current facts at the request's instant. */
    authority: OrganizationPersonAuthority,
  ) => /** The readable scope, or the typed denial. */
  Result.Result<TeamInterestReadScope, TeamInterestScopeDenied>;
  (
    /** The person's authority, resolved from current facts at the request's instant. */
    authority: OrganizationPersonAuthority,
    input: {
      /** The department the request names, if any. */
      readonly requested: DepartmentId | undefined;
      /** Every current department, which an organization-wide reach reads. */
      readonly departments: ReadonlyArray<DepartmentId>;
    },
  ): /** The readable scope, or the typed denial. */
  Result.Result<TeamInterestReadScope, TeamInterestScopeDenied>;
} = dual(
  2,
  (
    /** The person's authority, resolved from current facts at the request's instant. */
    authority: OrganizationPersonAuthority,
    input: {
      /** The department the request names, if any. */
      readonly requested: DepartmentId | undefined;
      /** Every current department, which an organization-wide reach reads. */
      readonly departments: ReadonlyArray<DepartmentId>;
    },
  ): /** The readable scope, or the typed denial. */
  Result.Result<TeamInterestReadScope, TeamInterestScopeDenied> => {
    const reached = reachedDepartments(authority, "team-interest.read");
    const organizationWide = ReachedDepartments.$is("All")(reached);
    const departmentScope = organizationWide ? input.departments : reached.departmentIds;

    const teamScope = reachedTeams(authority, "team-interest.read").flatMap((teamId) => {
      const membership = authority.memberships.find((entry) => entry.teamId === teamId);

      return membership === undefined ? [] : [{ teamId, departmentId: membership.departmentId }];
    });

    const denied = new TeamInterestScopeDenied({
      personId: authority.personId,
      departmentId: input.requested,
    });

    if (!organizationWide && departmentScope.length === 0 && teamScope.length === 0)
      return Result.fail(denied);

    const teams: TeamInterestReadScope["teams"] = teamScope.filter(
      (team) =>
        (input.requested === undefined || team.departmentId === input.requested) &&
        !departmentScope.includes(team.departmentId),
    );

    const departmentIds =
      input.requested === undefined
        ? departmentScope
        : departmentScope.includes(input.requested)
          ? [input.requested]
          : teams.length > 0
            ? []
            : undefined;

    return departmentIds === undefined
      ? Result.fail(denied)
      : Result.succeed(
          // SAFETY: the one constructor of the evidence brand; the scope above is what it proves.
          { personId: authority.personId, departmentIds, teams } as TeamInterestReadScope,
        );
  },
);
