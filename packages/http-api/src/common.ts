/**
 * Shared security, middleware, annotation, and error contracts for the native API.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import {
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";
import { problemUnion } from "./http-semantics.js";

/**
 * Request Cookie header marker for endpoints that perform authoritative session resolution.
 * Both Better Auth's local and secure-prefixed cookie names travel through this one header.
 *
 * @since 0.1.0
 * @category Security
 */
export const RequestCookieHeader = HttpApiSecurity.apiKey({
  key: "Cookie",
  in: "header",
}).pipe(
  HttpApiSecurity.annotateMerge(
    OpenApi.annotations({ description: "Cookie header resolved authoritatively by Identity." }),
  ),
);

/**
 * Bearer security declaration for delegated person credentials. Service
 * credentials are rejected by the backend credential authority.
 *
 * @since 0.1.0
 * @category Security
 */
export const OAuthUserBearer = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotateMerge(
    OpenApi.annotations({
      description: "Native OAuth delegated access token for a current Person principal.",
    }),
  ),
);

/** Bearer security declaration for service-principal OAuth access tokens. */
export const OAuthServiceBearer = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotateMerge(
    OpenApi.annotations({
      description: "Native OAuth service access token for a current ServicePrincipal.",
    }),
  ),
);

/**
 * Standard missing or invalid session response.
 *
 * @since 0.1.0
 * @category Schemas
 */
const SessionUnauthorizedBody = problemUnion("SessionUnauthorizedProblem", [
  ["credential.missing", 401],
  ["credential.invalid", 401],
]).pipe(
  HttpApiSchema.status(401),
  HttpApiSchema.asJson({ contentType: "application/problem+json" }),
);

export const SessionUnauthorizedResponse = HttpApiSchema.WithHeaders(SessionUnauthorizedBody, {
  "Cache-Control": Schema.Literal("no-store"),
  Vary: Schema.Literal("Origin"),
  "WWW-Authenticate": Schema.String,
});

/**
 * Contract security marker for session-authenticated native operations.
 * The backend implementation resolves the full Cookie header through Identity.
 *
 * @since 0.1.0
 * @category Security
 */
export class SessionSecurity extends HttpApiMiddleware.Service<SessionSecurity>()(
  "@vektorprogrammet/http-api/SessionSecurity",
  {
    security: {
      cookieHeader: RequestCookieHeader,
    },
    error: SessionUnauthorizedResponse,
  },
) {}

/**
 * Contract security marker for person-authenticated operations. The two
 * security entries are alternatives: a current Better Auth browser session or
 * a delegated OAuth user bearer. The backend resolves either mechanism to the
 * same canonical Person principal before current authorization is evaluated.
 *
 * @since 0.1.0
 * @category Security
 */
export class PersonSecurity extends HttpApiMiddleware.Service<PersonSecurity>()(
  "@vektorprogrammet/http-api/PersonSecurity",
  {
    security: {
      cookieHeader: RequestCookieHeader,
      oauthUserBearer: OAuthUserBearer,
    },
    error: SessionUnauthorizedResponse,
  },
) {}

/**
 * Contract marker for the one native operation that accepts either a person
 * credential or a service-principal bearer.
 */
export class PersonOrServiceSecurity extends HttpApiMiddleware.Service<PersonOrServiceSecurity>()(
  "@vektorprogrammet/http-api/PersonOrServiceSecurity",
  {
    security: {
      cookieHeader: RequestCookieHeader,
      oauthUserBearer: OAuthUserBearer,
      oauthServiceBearer: OAuthServiceBearer,
    },
    error: SessionUnauthorizedResponse,
  },
) {}

/**
 * Header security declaration for public recruitment invitation responses.
 *
 * @since 0.1.0
 * @category Security
 */
export const RecruitmentInvitationCapability = HttpApiSecurity.apiKey({
  key: "X-Recruitment-Invitation-Capability",
  in: "header",
}).pipe(
  HttpApiSecurity.annotateMerge(
    OpenApi.annotations({ description: "Opaque invitation response capability." }),
  ),
);

/**
 * Missing, malformed, or unknown invitation capability response.
 *
 * @since 0.1.0
 * @category Schemas
 */
const InvitationNotFoundBody = problemUnion("InvitationNotFoundProblem", [
  ["resource.not-found", 404],
]).pipe(
  HttpApiSchema.status(404),
  HttpApiSchema.asJson({ contentType: "application/problem+json" }),
);

export const InvitationNotFoundResponse = HttpApiSchema.WithHeaders(InvitationNotFoundBody, {
  "Cache-Control": Schema.Literal("no-store"),
  Vary: Schema.Literal("Origin"),
}) as unknown as Schema.Codec<unknown, unknown>;

/**
 * Contract security marker for invitation-capability operations.
 *
 * @since 0.1.0
 * @category Security
 */
export class InvitationCapabilitySecurity extends HttpApiMiddleware.Service<InvitationCapabilitySecurity>()(
  "@vektorprogrammet/http-api/InvitationCapabilitySecurity",
  {
    security: { invitationCapability: RecruitmentInvitationCapability },
    error: InvitationNotFoundResponse,
  },
) {}

/**
 * Contract marker that lets the backend translate automatic schema failures to
 * each group's frozen error envelope.
 *
 * @since 0.1.0
 * @category Middleware
 */
export class RequestSchemaErrorMiddleware extends HttpApiMiddleware.Service<RequestSchemaErrorMiddleware>()(
  "@vektorprogrammet/http-api/RequestSchemaErrorMiddleware",
) {}

/**
 * Machine-readable lineage shared by every native OpenAPI operation.
 *
 * @since 0.1.0
 * @category Annotations
 */
export const NativeOperationProvenance = {
  contract: "@vektorprogrammet/http-api/ExternalNativeApi",
  operationId: "HttpApiGroup.identifier.HttpApiEndpoint.identifier",
  tags: "HttpApiGroup.identifier",
  security: "HttpApiMiddleware.security",
  statuses: "HttpApiSchema.status",
  schemas: "Effect.Schema",
} as const;

/**
 * Adds stable OpenAPI operation metadata.
 *
 * @since 0.1.0
 * @category Annotations
 */
export const operationAnnotations = (summary: string, description: string) =>
  OpenApi.annotations({
    summary,
    description,
    transform: (operation) => ({
      ...operation,
      "x-vektorprogrammet-provenance": NativeOperationProvenance,
    }),
  });
