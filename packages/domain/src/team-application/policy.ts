import { DateTime } from "effect";
import { allow, deny, type Decision } from "../authz/decision.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { TeamId } from "../organization/schema.js";
import { TeamApplicationActor, type TeamApplicationIntakeFacts } from "./schema.js";

/**
 * Intake is open only for an active team in an active department that explicitly
 * accepts applications, before its deadline. The deadline instant itself is closed.
 */
export const isTeamApplicationIntakeOpen = (
  facts: TeamApplicationIntakeFacts,
  now: DateTime.Utc,
): boolean =>
  facts.teamActive &&
  facts.departmentActive &&
  facts.acceptApplication === true &&
  (facts.deadline === null || DateTime.isLessThan(now, DateTime.makeUnsafe(facts.deadline)));

/**
 * Maps the Organization projection to one team's staff actor. An active membership
 * already excludes ended, suspended, and inactive-team or inactive-department
 * memberships. Global administration grants no implicit access.
 */
export const mapOrganizationAuthorityToTeamApplicationActor = (
  authority: OrganizationPersonAuthority,
  teamId: TeamId,
): Decision<TeamApplicationActor> => {
  let hasMembership = false;
  let activeMember = false;

  for (const membership of authority.memberships) {
    if (membership.teamId !== teamId) continue;
    hasMembership = true;

    if (membership.active && membership.teamLeader) {
      return allow<TeamApplicationActor>(
        TeamApplicationActor.cases.TeamLeader.make({ personId: authority.personId, teamId }),
      );
    }

    if (membership.active) activeMember = true;
  }

  if (activeMember) {
    return allow<TeamApplicationActor>(
      TeamApplicationActor.cases.TeamMember.make({ personId: authority.personId, teamId }),
    );
  }

  return deny<TeamApplicationActor>(hasMembership ? "AuthorityInactive" : "NotInScope");
};
