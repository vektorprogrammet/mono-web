import type {
  DepartmentJson,
  PublicApplicationCatalogSchema,
  TeamJson,
} from "@vektorprogrammet/rpc";
import type {
  NewsArticleQuery,
  PublicTeamApplicationIntake,
  PublishedNewsArticle as PublishedNewsArticleType,
  PublishedNewsListing as PublishedNewsListingType,
  TeamApplicationConfirmation,
  TeamApplicationInput,
  TeamApplicationIntakeListItem,
} from "@vektorprogrammet/rpc";

export type HomepageDepartment = DepartmentJson;

export type PublishedNewsListing = PublishedNewsListingType;

export type PublishedNewsSummary = PublishedNewsListing["articles"][number];

export type PublishedNewsArticle = PublishedNewsArticleType;

export type PublicApplicationCatalog = typeof PublicApplicationCatalogSchema.Type;

export type NewsArticleSlug = NewsArticleQuery["slug"];

export type HomepageTeam = TeamJson;

export type HomepageTeamIntake = TeamApplicationIntakeListItem;

export type HomepageTeamApplicationIntake = PublicTeamApplicationIntake;

export type TeamApplicationPayload = TeamApplicationInput;

export type SubmittedTeamApplication = TeamApplicationConfirmation;
