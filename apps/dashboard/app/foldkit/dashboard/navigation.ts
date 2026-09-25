import { TEAM_APPLICATIONS_CHOOSER_PATH } from "../team-applications/paths";
import type { DashboardRole } from "./model";

export type NavigationLink = Readonly<{
  label: string;
  href: string;
  requiredRole: "team-member" | "team-leader" | "global-administrator";
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

const leaderLink = (label: string, href: string): NavigationLink => ({
  label,
  href,
  requiredRole: "team-leader",
});

export const controlPanelLink = memberLink("Kontrollpanel", "/dashboard");

export const admissionLinks = [
  memberLink("Nye søkere", "/dashboard/sokere"),
  memberLink("Tidligere assistenter", "/dashboard/tidligere-assistenter"),
  memberLink("Intervjufordeling", "/dashboard/intervjufordeling"),
  memberLink("Intervjuer", "/dashboard/intervjuer"),
  leaderLink("Fullførte intervjuer", "/dashboard/intervjuer/rapport"),
  leaderLink("Intervjubemanning", "/dashboard/intervjubemanning"),
  leaderLink("Søkerkontoer", "/dashboard/onboarding"),
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
        link: leaderLink("Attester", "/dashboard/attester"),
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
        link: leaderLink("Linjer", "/dashboard/linjer"),
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

export const hasTeamLeaderAccess = (role: DashboardRole | null): boolean =>
  role === "ROLE_TEAM_LEADER" || role === "ROLE_ADMIN";

export const canViewLink = (role: DashboardRole | null, link: NavigationLink): boolean =>
  link.requiredRole === "global-administrator"
    ? role === "ROLE_ADMIN"
    : link.requiredRole === "team-member" || hasTeamLeaderAccess(role);

export const isActivePath = (activePath: string, href: string): boolean =>
  activePath === href || activePath.startsWith(`${href}/`);

export const isAdmissionPath = (activePath: string): boolean =>
  admissionLinks.some((link) => isActivePath(activePath, link.href));
