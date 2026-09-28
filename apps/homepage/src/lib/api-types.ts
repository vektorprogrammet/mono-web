import {
  ListTeamApplicationIntakesEndpoint,
  ReadTeamApplicationIntakeEndpoint,
  SubmitContactMessageEndpoint,
  SubmitTeamApplicationEndpoint,
} from "@vektorprogrammet/rpc";
import type {
  DepartmentJson,
  PublicApplicationCatalogSchema,
  TeamJson,
} from "@vektorprogrammet/rpc";
import type {
  NewsArticleQuery,
  PublishedNewsArticle as PublishedNewsArticleType,
  PublishedNewsListing as PublishedNewsListingType,
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

export type HomepageTeamIntake = EndpointBody<typeof ListTeamApplicationIntakesEndpoint>[number];

export type HomepageTeamApplicationIntake = EndpointBody<typeof ReadTeamApplicationIntakeEndpoint>;

export type TeamApplicationPayload = HttpApiEndpoint.Payload<
  typeof SubmitTeamApplicationEndpoint
>["Type"];

export type SubmittedTeamApplication = EndpointBody<typeof SubmitTeamApplicationEndpoint>;
