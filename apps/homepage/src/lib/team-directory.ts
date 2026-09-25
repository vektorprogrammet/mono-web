import type { HomepageDepartment, HomepageTeam, HomepageTeamIntake } from "./api-types";
import { contactDepartmentSlug } from "./contact-message";

/**
 * Public team page view model.
 *
 * One projection of three native reads: departments, teams, and intake state.
 * Only active departments and their active teams appear. A team gets an
 * application link only when the intake read reports it open now; a team
 * missing from that read, or a failed read, gets none.
 */

export type TeamDirectoryTeam = Pick<
  HomepageTeam,
  "teamId" | "name" | "shortDescription" | "email"
> & {
  /** Present only while the intake read reports the team open. */
  readonly applyHref: string | null;
  /** Deadline of the open intake; null when closed, unknown, or without a deadline. */
  readonly deadline: HomepageTeamIntake["deadline"];
};

export type TeamDirectoryDepartment = Pick<
  HomepageDepartment,
  "departmentId" | "name" | "shortName"
> & {
  /** Route segment of `/team/:department`, the same slug as `/kontakt/:department`. */
  readonly slug: string;
  readonly teams: readonly TeamDirectoryTeam[];
};

export type TeamDirectory = {
  readonly departments: readonly TeamDirectoryDepartment[];
  /** False when the intake read failed; no team then shows an application link. */
  readonly intakeAvailable: boolean;
};

/**
 * Departments and teams keep the order of the native reads, so `/team` selects
 * the same first department as `/kontakt`. `intakes` is null when the intake
 * read failed. Returns undefined when two active departments share a route slug
 * or a slug is empty, because the page cannot route to such a department.
 */
export function projectTeamDirectory(
  departments: readonly HomepageDepartment[],
  teams: readonly HomepageTeam[],
  intakes: readonly HomepageTeamIntake[] | null,
): TeamDirectory | undefined {
  const openDeadlines = new Map<HomepageTeam["teamId"], HomepageTeamIntake["deadline"]>();

  for (const intake of intakes ?? []) {
    if (intake.open) openDeadlines.set(intake.teamId, intake.deadline);
  }

  const teamsByDepartment = new Map<HomepageDepartment["departmentId"], TeamDirectoryTeam[]>();

  for (const team of teams) {
    if (!team.active) continue;
    const open = openDeadlines.has(team.teamId);

    const card: TeamDirectoryTeam = {
      teamId: team.teamId,
      name: team.name,
      shortDescription: team.shortDescription,
      email: team.email,
      applyHref: open ? `/team/${encodeURIComponent(team.teamId)}/soknad` : null,
      deadline: openDeadlines.get(team.teamId) ?? null,
    };

    const departmentTeams = teamsByDepartment.get(team.departmentId);

    if (departmentTeams === undefined) teamsByDepartment.set(team.departmentId, [card]);
    else departmentTeams.push(card);
  }

  const slugs = new Set<string>();
  const directoryDepartments: TeamDirectoryDepartment[] = [];

  for (const department of departments) {
    if (!department.active) continue;
    const slug = contactDepartmentSlug(department);

    if (slug.length === 0 || slugs.has(slug)) return undefined;

    slugs.add(slug);
    directoryDepartments.push({
      departmentId: department.departmentId,
      name: department.name,
      shortName: department.shortName,
      slug,
      teams: teamsByDepartment.get(department.departmentId) ?? [],
    });
  }

  return { departments: directoryDepartments, intakeAvailable: intakes !== null };
}
