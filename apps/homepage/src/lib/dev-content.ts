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
  readonly departments: readonly DepartmentContent[];
};

export type DevRouteCensus = {
  readonly paths: readonly string[];
  readonly departments: readonly {
    readonly id: string;
    readonly path: string;
    readonly memberCount: number;
    readonly contacts: readonly DepartmentContact[];
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
    "/nyheter",
    "/nyhet/:slug",
    "/om-oss",
    "/skoler",
    "/team",
    "/team/:department",
    "/team/:teamId/soknad",
    ...DEV_CONTENT.departments.map((department) => `/kontakt/${department.id}`),
  ].sort(),
  departments: DEV_CONTENT.departments
    .map((department) => ({
      id: department.id,
      path: `/kontakt/${department.id}`,
      memberCount: department.members,
      contacts: department.contacts,
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
};

export type DevProfileContent = {
  readonly name: string;
  readonly image: string;
  readonly imageAlt: string;
};

export function getDevProfile(): DevProfileContent {
  return {
    name: "DEV Member",
    image: localCardImage,
    imageAlt: "Nøytral DEV CONTENT-profilillustrasjon",
  };
}

for (const sponsor of DEV_CONTENT.sponsors) {
  if (!sponsor.image.startsWith("/")) {
    throw new Error(`DEV CONTENT sponsor image must be local: ${sponsor.id}`);
  }
}

for (const department of DEV_CONTENT.departments) {
  if (!department.image.startsWith("/")) {
    throw new Error(`DEV CONTENT department image must be local: ${department.id}`);
  }
}
