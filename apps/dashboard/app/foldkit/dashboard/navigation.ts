import { TEAM_APPLICATIONS_CHOOSER_PATH } from "../team-applications/paths";
import type { DashboardRole } from "./model";

export type NavigationLink = Readonly<{
  label: string;
  href: string;
  requiredRole: "team-member" | "team-leader" | "department-administrator" | "global-administrator";
  external?: boolean;
}>;

export type NavigationEntry =
  | Readonly<{ kind: "link"; link: NavigationLink }>
  | Readonly<{
      kind: "admission-menu";
      label: "Opptak";
      links: ReadonlyArray<NavigationLink>;
    }>;

export type NavigationSection = Readonly<{
  label: string;
  entries: ReadonlyArray<NavigationEntry>;
}>;

const memberLink = (label: string, href: string): NavigationLink => ({
  label,
  href,
  requiredRole: "team-member",
});

/** Work within the own team: a team leader, and anyone who reaches a department. */
const leaderLink = (label: string, href: string): NavigationLink => ({
  label,
  href,
  requiredRole: "team-leader",
});

/** Department work: a board leadership or a delegation reaches it (O8-11). */
const departmentLink = (label: string, href: string): NavigationLink => ({
  label,
  href,
  requiredRole: "department-administrator",
});

export const controlPanelLink = memberLink("Kontrollpanel", "/dashboard");

export const admissionLinks = [
  memberLink("Nye søkere", "/dashboard/sokere"),
  memberLink("Tidligere assistenter", "/dashboard/tidligere-assistenter"),
  memberLink("Intervjufordeling", "/dashboard/intervjufordeling"),
  memberLink("Intervjuer", "/dashboard/intervjuer"),
  departmentLink("Fullførte intervjuer", "/dashboard/intervjuer/rapport"),
  departmentLink("Intervjubemanning", "/dashboard/intervjubemanning"),
  departmentLink("Søkerkontoer", "/dashboard/onboarding"),
] as const;

export const navigationSections: ReadonlyArray<NavigationSection> = [
  {
    label: "Opptak",
    entries: [
      {
        kind: "link",
        link: memberLink("Opptaksperioder", "/dashboard/opptaksperioder"),
      },
      { kind: "admission-menu", label: "Opptak", links: admissionLinks },
      {
        kind: "link",
        link: {
          label: "Intervjuskjema",
          href: "/dashboard/intervjusjema",
          requiredRole: "global-administrator",
        },
      },
      {
        kind: "link",
        link: memberLink("Opptaksstatistikk", "/dashboard/statistikk"),
      },
    ],
  },
  {
    label: "Assistenter",
    entries: [
      {
        kind: "link",
        link: memberLink("Assistenter", "/dashboard/assistenter"),
      },
      {
        kind: "link",
        link: memberLink("Vikarer", "/dashboard/vikarer"),
      },
      {
        kind: "link",
        link: departmentLink("Attester", "/dashboard/attester"),
      },
    ],
  },
  {
    label: "Team",
    entries: [
      { kind: "link", link: memberLink("Team", "/dashboard/team") },
      {
        kind: "link",
        link: memberLink("Team-søknader", TEAM_APPLICATIONS_CHOOSER_PATH),
      },
      {
        kind: "link",
        link: memberLink("Arrangementer", "/dashboard/arrangementer"),
      },
      {
        kind: "link",
        link: leaderLink("Teaminteresse", "/dashboard/teaminteresse"),
      },
      {
        kind: "link",
        link: departmentLink("Delegeringer", "/dashboard/delegeringer"),
      },
    ],
  },
  {
    label: "Brukere",
    entries: [
      {
        kind: "link",
        link: memberLink("Brukere", "/dashboard/brukere"),
      },
      {
        kind: "link",
        link: memberLink("Epostlister", "/dashboard/epostliste"),
      },
    ],
  },
  {
    label: "Økonomi",
    entries: [
      {
        kind: "link",
        link: memberLink("Sponsorer", "/dashboard/sponsorer"),
      },
      { kind: "link", link: memberLink("Utlegg", "/dashboard/utlegg") },
      { kind: "link", link: memberLink("Oppgjør", "/dashboard/utlegg/oppgjor") },
    ],
  },
  {
    label: "Annet",
    entries: [
      {
        kind: "link",
        link: memberLink("Avdelinger", "/dashboard/avdelinger"),
      },
      {
        kind: "link",
        link: memberLink("Skoler", "/dashboard/skoler"),
      },
      {
        kind: "link",
        link: memberLink("Artikler", "/dashboard/artikler"),
      },
      {
        kind: "link",
        link: departmentLink("Linjer", "/dashboard/linjer"),
      },
      {
        kind: "link",
        link: {
          ...memberLink("Slab", "https://vektorprogrammet.slab.com/"),
          external: true,
        },
      },
    ],
  },
];

export const profileLinks = [
  memberLink("Min profil", "/dashboard/profile"),
  memberLink("Mine utlegg", "/dashboard/mine-utlegg"),
] as const;

const roleRank: Record<DashboardRole, number> = {
  ROLE_TEAM_MEMBER: 0,
  ROLE_TEAM_LEADER: 1,
  ROLE_DEPARTMENT_ADMINISTRATOR: 2,
  ROLE_ADMIN: 3,
};

const requiredRank: Record<NavigationLink["requiredRole"], number> = {
  "team-member": 0,
  "team-leader": 1,
  "department-administrator": 2,
  "global-administrator": 3,
};

export const canViewLink = (role: DashboardRole | null, link: NavigationLink): boolean =>
  link.requiredRole === "team-member" ||
  (role !== null && roleRank[role] >= requiredRank[link.requiredRole]);

export const isActivePath = (activePath: string, href: string): boolean =>
  activePath === href || activePath.startsWith(`${href}/`);

export const isAdmissionPath = (activePath: string): boolean =>
  admissionLinks.some((link) => isActivePath(activePath, link.href));
