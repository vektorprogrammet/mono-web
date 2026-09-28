import {
  SubmitContactMessageEndpoint,
} from "@vektorprogrammet/rpc";
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
import type { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";

type EndpointResponseBody<Response> =
  Response extends HttpApiSchema.WithHeaders<infer Body, infer _Headers> ? Body["Type"] : never;

type EndpointBody<Endpoint extends HttpApiEndpoint.Constraint> = Exclude<
  EndpointResponseBody<HttpApiEndpoint.Success<Endpoint>>,
  void
>;

export type HomepageDepartment = DepartmentJson;

export type PublishedNewsListing = PublishedNewsListingType;

export type PublishedNewsSummary = PublishedNewsListing["articles"][number];

export type PublishedNewsArticle = PublishedNewsArticleType;

export type PublicApplicationCatalog = typeof PublicApplicationCatalogSchema.Type;

export type ContactMessagePayload = HttpApiEndpoint.Payload<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type ContactMessageHeaders = HttpApiEndpoint.Headers<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type NewsArticleSlug = NewsArticleQuery["slug"];

export type HomepageTeam = TeamJson;

export type HomepageTeamIntake = TeamApplicationIntakeListItem;

export type HomepageTeamApplicationIntake = PublicTeamApplicationIntake;

export type TeamApplicationPayload = TeamApplicationInput;

export type SubmittedTeamApplication = TeamApplicationConfirmation;
