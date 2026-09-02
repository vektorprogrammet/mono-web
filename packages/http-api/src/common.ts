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

/**
 * Creates the stable JSON error envelope used by the native backend.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const errorBody = <const Tags extends readonly [string, ...Array<string>]>(
  identifier: string,
  tags: Tags,
  status: number,
) =>
  Schema.Struct({
    error: Schema.Struct({ tag: Schema.Literals(tags) }),
  })
    .pipe(HttpApiSchema.status(status))
    .annotate({
      identifier,
      description: `Native HTTP ${status} error response.`,
      examples: [{ error: { tag: tags[0] } }],
    });

/**
 * Creates the receipt error envelope that can include a stable denial message.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const receiptErrorBody = <const Tags extends readonly [string, ...Array<string>]>(
  identifier: string,
  tags: Tags,
  status: number,
) =>
  Schema.Struct({
    error: Schema.Struct({
      tag: Schema.Literals(tags),
      message: Schema.optional(Schema.String),
    }),
  })
    .pipe(HttpApiSchema.status(status))
    .annotate({
      identifier,
      description: `Receipt HTTP ${status} error response.`,
      examples: [{ error: { tag: tags[0] } }],
    });

/**
 * Response returned when no native route matches a request.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const RouteNotFoundResponse = Schema.Struct({
  error: Schema.Struct({ tag: Schema.Literals(["RouteNotFound"]) }),
}).annotate({
  identifier: "RouteNotFoundResponse",
  description: "No native route matched.",
  examples: [{ error: { tag: "RouteNotFound" } }],
});

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

/**
 * Standard missing or invalid session response.
 *
 * @since 0.1.0
 * @category Schemas
 */
const SessionUnauthorizedBody = errorBody(
  "SessionUnauthorizedResponse",
  ["UnauthenticatedActor"],
  401,
);

export const SessionUnauthorizedResponse = SessionUnauthorizedBody.pipe(
  HttpApiSchema.encodeToWithHeaders(
    {
      body: SessionUnauthorizedBody,
      headers: { "cache-control": Schema.Literal("no-store") },
    },
    {
      decode: ({ body }) => body,
      encode: (body) => ({ body, headers: { "cache-control": "no-store" as const } }),
    },
  ),
);

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
export const InvitationNotFoundResponse = errorBody(
  "InvitationNotFoundResponse",
  ["RecruitmentInvitationNotFound"],
  404,
);

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
    override: {
      "x-vektorprogrammet-provenance": NativeOperationProvenance,
    },
  });
