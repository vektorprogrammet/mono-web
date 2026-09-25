import {
  ListDepartmentsEndpoint,
  ListNewsEndpoint,
  ListTeamApplicationIntakesEndpoint,
  ListTeamsEndpoint,
  ReadApplicationCatalogEndpoint,
  ReadNewsArticleEndpoint,
  ReadTeamApplicationIntakeEndpoint,
  SubmitContactMessageEndpoint,
  SubmitTeamApplicationEndpoint,
} from "@vektorprogrammet/http-api";
import type { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";

type EndpointResponseBody<Response> =
  Response extends HttpApiSchema.WithHeaders<infer Body, infer _Headers> ? Body["Type"] : never;

type EndpointBody<Endpoint extends HttpApiEndpoint.Constraint> = Exclude<
  EndpointResponseBody<HttpApiEndpoint.Success<Endpoint>>,
  void
>;

export type HomepageDepartment = EndpointBody<typeof ListDepartmentsEndpoint>[number];

export type PublishedNewsListing = EndpointBody<typeof ListNewsEndpoint>;

export type PublishedNewsSummary = PublishedNewsListing["articles"][number];

export type PublishedNewsArticle = EndpointBody<typeof ReadNewsArticleEndpoint>;

export type PublicApplicationCatalog = EndpointBody<typeof ReadApplicationCatalogEndpoint>;

export type ContactMessagePayload = HttpApiEndpoint.Payload<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type ContactMessageHeaders = HttpApiEndpoint.Headers<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type NewsArticleSlug = HttpApiEndpoint.Params<typeof ReadNewsArticleEndpoint>["Type"]["slug"];

export type HomepageTeam = EndpointBody<typeof ListTeamsEndpoint>[number];

export type HomepageTeamIntake = EndpointBody<typeof ListTeamApplicationIntakesEndpoint>[number];

export type HomepageTeamApplicationIntake = EndpointBody<typeof ReadTeamApplicationIntakeEndpoint>;

export type TeamApplicationPayload = HttpApiEndpoint.Payload<
  typeof SubmitTeamApplicationEndpoint
>["Type"];

export type SubmittedTeamApplication = EndpointBody<typeof SubmitTeamApplicationEndpoint>;
