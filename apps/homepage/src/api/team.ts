import { DEV_CONTENT, type TeamContent as DevTeamContent } from "~/lib/dev-content";


function cityTeams(city: DevTeamContent["city"]): DevTeamContent[] {
  return DEV_CONTENT.teams.filter((team) => team.city === city);
}

export function teamsTrondheim(): DevTeamContent[] {
  return cityTeams("Trondheim");
}

export function teamsAas(): DevTeamContent[] {
  return cityTeams("Ås");
}

export function teamsBergen(): DevTeamContent[] {
  return cityTeams("Bergen");
}

export function teamsHovedstyret(): DevTeamContent | undefined {
  return DEV_CONTENT.teams.find((team) => team.city === "Hovedstyret");
}
