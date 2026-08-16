import type { FieldOfStudy, Sponsor, Team } from "@vektorprogrammet/sdk";

export const fixtureFieldOfStudies: ReadonlyArray<FieldOfStudy> = [
  { id: 1, name: "Matematikk" },
  { id: 2, name: "Informatikk" },
];

export const fixtureSponsors: ReadonlyArray<Sponsor> = [
  {
    id: 1,
    name: "Eksempelpartner",
    logoUrl: null,
    url: "https://example.invalid/partner",
  },
];

export const fixtureTeams: ReadonlyArray<Team> = [
  { id: 1, name: "Rekruttering" },
  { id: 2, name: "IT" },
];
