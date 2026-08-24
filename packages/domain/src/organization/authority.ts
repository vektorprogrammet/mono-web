import { Schema } from "effect";
import type { AdmissionPeriodActor } from "../admission-period/schema.js";
import { allow, deny, type Decision } from "../authz/decision.js";
import type { RecruitmentActor } from "../recruitment/schema.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";
import type { OrganizationActor } from "./administration-schema.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
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

export const OrganizationGlobalAdministratorStatusSchema = Schema.Literals([
  "Active",
  "Inactive",
  "Absent",
]);
export type OrganizationGlobalAdministratorStatus =
  typeof OrganizationGlobalAdministratorStatusSchema.Type;

export const OrganizationAuthorityMembershipSchema = Schema.Struct({
  membershipId: MembershipId,
  teamId: TeamId,
  departmentId: DepartmentId,
  active: Schema.Boolean,
  teamLeader: Schema.Boolean,
});
export type OrganizationAuthorityMembership = typeof OrganizationAuthorityMembershipSchema.Type;

export const OrganizationPersonAuthoritySchema = Schema.Struct({
  personId: PersonId,
  evaluatedAt: OrganizationAuthorityInstantSchema,
  globalAdministrator: OrganizationGlobalAdministratorStatusSchema,
  memberships: Schema.Array(OrganizationAuthorityMembershipSchema),
});
export type OrganizationPersonAuthority = typeof OrganizationPersonAuthoritySchema.Type;

export const ProfileRoleSchema = Schema.Literals([
  "ROLE_ADMIN",
  "ROLE_TEAM_LEADER",
  "ROLE_TEAM_MEMBER",
]);
export type ProfileRole = typeof ProfileRoleSchema.Type;

/** Maps one explicit department scope without selecting a primary membership. */
export const mapOrganizationAuthorityToAdmissionPeriodActor = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): Decision<AdmissionPeriodActor> => {
  if (authority.globalAdministrator === "Active") {
    return allow<AdmissionPeriodActor>({
      _tag: "GlobalAdmin",
      personId: authority.personId,
      active: true,
    });
  }
  if (authority.globalAdministrator === "Inactive") {
    return deny<AdmissionPeriodActor>("AuthorityInactive");
  }

  let hasMembership = false;
  let hasActiveMembership = false;
  for (const membership of authority.memberships) {
    if (membership.departmentId !== departmentId) continue;
    hasMembership = true;
    if (membership.active && membership.teamLeader) {
      return allow<AdmissionPeriodActor>({
        _tag: "DepartmentLeader",
        personId: authority.personId,
        departmentId,
        active: true,
      });
    }
    if (membership.active) hasActiveMembership = true;
  }
  if (hasActiveMembership) {
    return allow<AdmissionPeriodActor>({
      _tag: "Member",
      personId: authority.personId,
      departmentId,
      active: true,
    });
  }
  return deny<AdmissionPeriodActor>(hasMembership ? "AuthorityInactive" : "NotInScope");
};

/** Recruitment shares Admission's department-scoped actor contract. */
export const mapOrganizationAuthorityToRecruitmentActor = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): Decision<RecruitmentActor> =>
  mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);

export const mapOrganizationAuthorityToOrganizationActor = (
  authority: OrganizationPersonAuthority,
): OrganizationActor =>
  authority.globalAdministrator === "Active"
    ? { _tag: "OrganizationAdministrator", personId: authority.personId }
    : { _tag: "OrganizationMember", personId: authority.personId };

export const mapOrganizationAuthorityToProfileRole = (
  authority: OrganizationPersonAuthority,
): Decision<ProfileRole> => {
  if (authority.globalAdministrator === "Active") {
    return allow<ProfileRole>("ROLE_ADMIN");
  }
  if (authority.memberships.some((membership) => membership.active && membership.teamLeader)) {
    return allow<ProfileRole>("ROLE_TEAM_LEADER");
  }
  if (authority.memberships.some((membership) => membership.active)) {
    return allow<ProfileRole>("ROLE_TEAM_MEMBER");
  }
  return deny<ProfileRole>(
    authority.globalAdministrator === "Absent" && authority.memberships.length === 0
      ? "NotInScope"
      : "AuthorityInactive",
  );
};
