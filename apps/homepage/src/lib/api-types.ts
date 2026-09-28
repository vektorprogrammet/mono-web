import {
  ListNewsEndpoint,
  ReadNewsArticleEndpoint,
  SubmitContactMessageEndpoint,
} from "@vektorprogrammet/rpc";
import type {
  DepartmentJson,
  PublicApplicationCatalogSchema,
  TeamJson,
} from "@vektorprogrammet/rpc";
import type {
  PublicTeamApplicationIntake,
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

export type PublishedNewsListing = EndpointBody<typeof ListNewsEndpoint>;

export type PublishedNewsSummary = PublishedNewsListing["articles"][number];

export type PublishedNewsArticle = EndpointBody<typeof ReadNewsArticleEndpoint>;

export type PublicApplicationCatalog = typeof PublicApplicationCatalogSchema.Type;

export type ContactMessagePayload = HttpApiEndpoint.Payload<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type ContactMessageHeaders = HttpApiEndpoint.Headers<
  typeof SubmitContactMessageEndpoint
>["Type"];

export type NewsArticleSlug = HttpApiEndpoint.Params<typeof ReadNewsArticleEndpoint>["Type"]["slug"];

export type HomepageTeam = TeamJson;

export type HomepageTeamIntake = TeamApplicationIntakeListItem;

export type HomepageTeamApplicationIntake = PublicTeamApplicationIntake;

export type TeamApplicationPayload = TeamApplicationInput;

export type SubmittedTeamApplication = TeamApplicationConfirmation;
