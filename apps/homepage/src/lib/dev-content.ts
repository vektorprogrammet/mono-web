export const DEV_CONTENT_SOURCE = "dev-content" as const;

export type SponsorContent = {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly href: string;
  readonly featured: boolean;
};

export type StatisticContent = {
  readonly assistantCount: number;
  readonly teamMemberCount: number;
};

export type TeamContent = {
  readonly id: string;
  readonly city: "Trondheim" | "Bergen" | "Ås" | "Hovedstyret";
  readonly title: string;
  readonly text: string;
  readonly email: string;
  readonly numberOfMembers: number;
  readonly url: string;
  readonly image: string;
  readonly imageAlt: string;
};
export type DevTeamMember = {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly role: string;
};

export type DepartmentContact = {
  readonly name: string;
  readonly title?: string;
  readonly mail: string;
};

export type DepartmentContent = {
  readonly id: string;
  readonly name: "Trondheim" | "Bergen" | "Ås" | "Hovedstyret";
  readonly shortName: string;
  readonly email: string;
  readonly address: string;
  readonly city: string;
  readonly description: string;
  readonly members: number;
  readonly contacts: readonly DepartmentContact[];
  readonly openForContact: boolean;
  readonly image: string;
  readonly imageAlt: string;
};

export type DevContent = {
  readonly sponsors: readonly SponsorContent[];
  readonly statistics: StatisticContent;
  readonly teams: readonly TeamContent[];
  readonly departments: readonly DepartmentContent[];
};

export type DevRouteCensus = {
  readonly paths: readonly string[];
  readonly teams: readonly {
    readonly id: string;
    readonly path: string;
    readonly memberCount: number;
  }[];
  readonly departments: readonly {
    readonly id: string;
    readonly path: string;
    readonly memberCount: number;
    readonly contacts: readonly DepartmentContact[];
  }[];
  readonly people: readonly {
    readonly id: string;
    readonly teamId: string;
    readonly name: string;
    readonly role: string;
  }[];
};

const localSponsorImage = "/images/vektor-logo.svg";
const localCardImage = "/images/teacher2.png";
const localContactImage = "/images/vektor-logo-circle.svg";

export const DEV_CONTENT = {
  sponsors: [
    {
      id: "dev-abelprisen",
      name: "Abelprisen (DEV)",
      image: localSponsorImage,
      href: "https://example.invalid/dev-sponsors/abelprisen",
      featured: true,
    },
    {
      id: "dev-sparebank",
      name: "Sparebankstiftelsen (DEV)",
      image: localSponsorImage,
      href: "https://example.invalid/dev-sponsors/sparebankstiftelsen",
      featured: true,
    },
    {
      id: "dev-tekna",
      name: "Tekna (DEV)",
      image: localSponsorImage,
      href: "https://example.invalid/dev-sponsors/tekna",
      featured: false,
    },
    {
      id: "dev-ntnu",
      name: "NTNU realfag (DEV)",
      image: localSponsorImage,
      href: "https://example.invalid/dev-sponsors/ntnu",
      featured: false,
    },
  ],
  statistics: {
    assistantCount: 42,
    teamMemberCount: 16,
  },
  teams: [
    {
      id: "trondheim-styre",
      city: "Trondheim",
      title: "Styret",
      text: "Det syntetiske Trondheim-styret samler den lokale DEV CONTENT-planen.",
      email: "trondheim-styre@example.invalid",
      numberOfMembers: 4,
      url: "/team/trondheim/styret",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Trondheim-styret",
    },
    {
      id: "trondheim-evaluering",
      city: "Trondheim",
      title: "Evaluering",
      text: "Det syntetiske evalueringsteamet lager trygge, lokale eksempelrapporter.",
      email: "trondheim-evaluering@example.invalid",
      numberOfMembers: 3,
      url: "/team/trondheim/evaluering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for evaluering",
    },
    {
      id: "trondheim-rekruttering",
      city: "Trondheim",
      title: "Rekruttering",
      text: "Det syntetiske rekrutteringsteamet holder DEV CONTENT-siden oversiktlig.",
      email: "trondheim-rekruttering@example.invalid",
      numberOfMembers: 3,
      url: "/team/trondheim/rekruttering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for rekruttering",
    },
    {
      id: "trondheim-skole",
      city: "Trondheim",
      title: "Skolekoordinering",
      text: "Det syntetiske skolekoordineringsteamet viser en stabil kontaktflate.",
      email: "trondheim-skole@example.invalid",
      numberOfMembers: 2,
      url: "/team/trondheim/skolekoordinering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for skolekoordinering",
    },
    {
      id: "trondheim-sponsor",
      city: "Trondheim",
      title: "Sponsor",
      text: "Det syntetiske sponsorteamet viser en inert lenkeprojeksjon.",
      email: "trondheim-sponsor@example.invalid",
      numberOfMembers: 2,
      url: "/team/trondheim/sponsor",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for sponsorteamet",
    },
    {
      id: "trondheim-okonomi",
      city: "Trondheim",
      title: "Økonomi",
      text: "Det syntetiske økonomiteamet viser et lokalt eksempel uten transport.",
      email: "trondheim-okonomi@example.invalid",
      numberOfMembers: 2,
      url: "/team/trondheim/okonomi",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for økonomiteamet",
    },
    {
      id: "trondheim-it",
      city: "Trondheim",
      title: "IT",
      text: "Det syntetiske IT-teamet holder denne DEV CONTENT-overflaten enkel.",
      email: "trondheim-it@example.invalid",
      numberOfMembers: 2,
      url: "/team/trondheim/it",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for IT-teamet",
    },
    {
      id: "trondheim-profilering",
      city: "Trondheim",
      title: "Profilering",
      text: "Det syntetiske profileringsteamet viser lokal presentasjonstekst.",
      email: "trondheim-profilering@example.invalid",
      numberOfMembers: 2,
      url: "/team/trondheim/profilering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for profilering",
    },
    {
      id: "aas-styre",
      city: "Ås",
      title: "Styret",
      text: "Det syntetiske Ås-styret viser en stabil lokal teamprojeksjon.",
      email: "aas-styre@example.invalid",
      numberOfMembers: 3,
      url: "/team/aas/styret",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Ås-styret",
    },
    {
      id: "aas-sponsor",
      city: "Ås",
      title: "Sponsor",
      text: "Det syntetiske Ås-sponsorteamet viser en inert lenkeprojeksjon.",
      email: "aas-sponsor@example.invalid",
      numberOfMembers: 2,
      url: "/team/aas/sponsor-okonomi",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Ås-sponsorteamet",
    },
    {
      id: "aas-skole",
      city: "Ås",
      title: "Skolekoordinering",
      text: "Det syntetiske Ås-skoleteamet viser en stabil kontaktflate.",
      email: "aas-skole@example.invalid",
      numberOfMembers: 2,
      url: "/team/aas/skolekoordinering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Ås-skolekoordinering",
    },
    {
      id: "aas-evaluering",
      city: "Ås",
      title: "Evaluering",
      text: "Det syntetiske Ås-evalueringsteamet viser lokal innholdstekst.",
      email: "aas-evaluering@example.invalid",
      numberOfMembers: 2,
      url: "/team/aas/evaluering-rekruttering-profilering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Ås-evaluering",
    },
    {
      id: "aas-sosialt",
      city: "Ås",
      title: "Sosialt",
      text: "Det syntetiske Ås-sosialteamet viser en stabil lokal projeksjon.",
      email: "aas-sosialt@example.invalid",
      numberOfMembers: 2,
      url: "/team/aas/sosialt",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Ås-sosialteamet",
    },
    {
      id: "bergen-styre",
      city: "Bergen",
      title: "Styret",
      text: "Det syntetiske Bergen-styret viser en stabil lokal teamprojeksjon.",
      email: "bergen-styre@example.invalid",
      numberOfMembers: 2,
      url: "/team/bergen/styret",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Bergen-styret",
    },
    {
      id: "bergen-skole",
      city: "Bergen",
      title: "Skolekoordinering",
      text: "Det syntetiske Bergen-skoleteamet viser en stabil kontaktflate.",
      email: "bergen-skole@example.invalid",
      numberOfMembers: 2,
      url: "/team/bergen/skolekoordinering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Bergen-skolekoordinering",
    },
    {
      id: "bergen-rekruttering",
      city: "Bergen",
      title: "Rekruttering",
      text: "Det syntetiske Bergen-rekrutteringsteamet viser lokal innholdstekst.",
      email: "bergen-rekruttering@example.invalid",
      numberOfMembers: 2,
      url: "/team/bergen/rekruttering",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for Bergen-rekruttering",
    },
    {
      id: "hovedstyret",
      city: "Hovedstyret",
      title: "Hovedstyret",
      text: "Det syntetiske hovedstyret viser en overordnet DEV CONTENT-projeksjon.",
      email: "hovedstyret@example.invalid",
      numberOfMembers: 4,
      url: "/team/hovedstyret",
      image: localCardImage,
      imageAlt: "Nøytral illustrasjon for hovedstyret",
    },
  ],
  departments: [
    {
      id: "trondheim",
      name: "Trondheim",
      shortName: "Trondheim",
      email: "kontakt-trondheim@example.invalid",
      address: "DEV CONTENT, Trondheim",
      city: "Trondheim",
      description: "Syntetisk kontaktinformasjon for lokal utvikling.",
      members: 4,
      contacts: [
        {
          name: "Koordinator",
          title: "Lokal kontakt",
          mail: "koordinator-trondheim@example.invalid",
        },
      ],
      openForContact: false,
      image: localContactImage,
      imageAlt: "Nøytral kontaktillustrasjon for Trondheim",
    },
    {
      id: "bergen",
      name: "Bergen",
      shortName: "Bergen",
      email: "kontakt-bergen@example.invalid",
      address: "DEV CONTENT, Bergen",
      city: "Bergen",
      description: "Syntetisk kontaktinformasjon for lokal utvikling.",
      members: 2,
      contacts: [
        { name: "Koordinator", title: "Lokal kontakt", mail: "koordinator-bergen@example.invalid" },
      ],
      openForContact: false,
      image: localContactImage,
      imageAlt: "Nøytral kontaktillustrasjon for Bergen",
    },
    {
      id: "aas",
      name: "Ås",
      shortName: "Ås",
      email: "kontakt-aas@example.invalid",
      address: "DEV CONTENT, Ås",
      city: "Ås",
      description: "Syntetisk kontaktinformasjon for lokal utvikling.",
      members: 3,
      contacts: [
        { name: "Koordinator", title: "Lokal kontakt", mail: "koordinator-aas@example.invalid" },
      ],
      openForContact: false,

      image: localContactImage,
      imageAlt: "Nøytral kontaktillustrasjon for Ås",
    },
    {
      id: "hovedstyret",
      name: "Hovedstyret",
      shortName: "Hovedstyret",
      email: "kontakt-hovedstyret@example.invalid",
      address: "DEV CONTENT, Norge",
      city: "Norge",
      description: "Syntetisk kontaktinformasjon for lokal utvikling.",
      members: 4,
      contacts: [
        { name: "Sekretariat", title: "Lokal kontakt", mail: "sekretariat@example.invalid" },
      ],
      openForContact: false,
      image: localContactImage,
      imageAlt: "Nøytral kontaktillustrasjon for hovedstyret",
    },
  ],
} as const satisfies DevContent;

function createDevTeamMembers(team: TeamContent): readonly DevTeamMember[] {
  return Array.from({ length: team.numberOfMembers }, (_, index) => ({
    id: `${team.id}-member-${index + 1}`,
    name: `DEV Member ${index + 1}`,
    image: team.image,
    role: index === 0 ? "Leder" : "Medlem",
  }));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const DEV_ROUTE_CENSUS: DevRouteCensus = {
  paths: [
    "/",
    "/assistenter",
    "/foreldre",
    "/kontakt",
    "/kontakt/:department",
    "/om-oss",
    "/skoler",
    "/team",
    "/team/:department",
    ...DEV_CONTENT.departments.map((department) => `/kontakt/${department.id}`),
    ...DEV_CONTENT.teams.map((team) => team.url),
  ].sort(),
  teams: DEV_CONTENT.teams
    .map((team) => ({
      id: team.id,
      path: team.url,
      memberCount: team.numberOfMembers,
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
  departments: DEV_CONTENT.departments
    .map((department) => ({
      id: department.id,
      path: `/kontakt/${department.id}`,
      memberCount: department.members,
      contacts: department.contacts,
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
  people: DEV_CONTENT.teams
    .flatMap((team) =>
      createDevTeamMembers(team).map((member) => ({
        id: member.id,
        teamId: team.id,
        name: member.name,
        role: member.role,
      })),
    )
    .sort((left, right) => compareStrings(left.id, right.id)),
};

export type DevTeamId = (typeof DEV_CONTENT.teams)[number]["id"];

export function getDevTeamMembers(teamId: DevTeamId): readonly DevTeamMember[] {
  const team = DEV_CONTENT.teams.find((item) => item.id === teamId);
  if (!team) throw new Error(`Unknown DEV CONTENT team: ${teamId}`);
  return createDevTeamMembers(team);
}

export type DevProfileContent = {
  readonly name: string;
  readonly image: string;
  readonly imageAlt: string;
};

export function getDevProfile(): DevProfileContent {
  const team = DEV_CONTENT.teams[0];
  if (!team) throw new Error("DEV CONTENT must define a profile projection");
  return {
    name: "DEV Member",
    image: team.image,
    imageAlt: "Nøytral DEV CONTENT-profilillustrasjon",
  };
}

for (const sponsor of DEV_CONTENT.sponsors) {
  if (!sponsor.image.startsWith("/")) {
    throw new Error(`DEV CONTENT sponsor image must be local: ${sponsor.id}`);
  }
}
for (const team of DEV_CONTENT.teams) {
  if (!team.url.startsWith("/") || !team.image.startsWith("/")) {
    throw new Error(`DEV CONTENT team projection must be local: ${team.id}`);
  }
}
for (const department of DEV_CONTENT.departments) {
  if (!department.image.startsWith("/")) {
    throw new Error(`DEV CONTENT department image must be local: ${department.id}`);
  }
}
