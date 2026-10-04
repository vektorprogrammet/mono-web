import {
  listDepartments,
  listTeams,
  listApplicationOptions,
  submitContactMessage,
  listNews,
  listTeamApplicationIntakes,
  readNewsArticle,
  readTeamApplicationIntake,
  submitTeamApplication,
} from "@vektorprogrammet/http-api";
import type { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";

type EndpointResponseBody<Response> =
  Response extends HttpApiSchema.WithHeaders<infer Body, infer _Headers> ? Body["Type"] : never;

type EndpointBody<Endpoint extends HttpApiEndpoint.Constraint> = Exclude<
  EndpointResponseBody<HttpApiEndpoint.Success<Endpoint>>,
  void
>;

export type HomepageDepartment = EndpointBody<typeof listDepartments>[number];

export type PublishedNewsListing = EndpointBody<typeof listNews>;

export type PublishedNewsSummary = PublishedNewsListing["articles"][number];

export type PublishedNewsArticle = EndpointBody<typeof readNewsArticle>;

export type PublicApplicationCatalog = EndpointBody<typeof listApplicationOptions>;

export type ContactMessagePayload = HttpApiEndpoint.Payload<
  typeof submitContactMessage
>["Type"];

export type ContactMessageHeaders = HttpApiEndpoint.Headers<
  typeof submitContactMessage
>["Type"];

export type NewsArticleSlug = HttpApiEndpoint.Params<typeof readNewsArticle>["Type"]["slug"];

export type HomepageTeam = EndpointBody<typeof listTeams>[number];

export type HomepageTeamIntake = EndpointBody<typeof listTeamApplicationIntakes>[number];

export type HomepageTeamApplicationIntake = EndpointBody<typeof readTeamApplicationIntake>;

export type TeamApplicationPayload = HttpApiEndpoint.Payload<
  typeof submitTeamApplication
>["Type"];

export type SubmittedTeamApplication = EndpointBody<typeof submitTeamApplication>;
