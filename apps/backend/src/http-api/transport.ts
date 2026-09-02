import {
  InvitationCapabilitySecurity,
  PersonSecurity,
  RequestSchemaErrorMiddleware,
  SessionSecurity,
} from "@vektorprogrammet/http-api";
import { Effect, Layer, type SchemaIssue } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";
import { nativeProblemResponse } from "../http-semantics.js";

/**
 * Runs one existing Web transport operation and returns an Effect HTTP response.
 * The caller supplies the group's frozen error translation.
 */
export const toHttpApiResponse = (
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Promise<Response>,
  mapError: (cause: unknown) => Response,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((webRequest) =>
      Effect.tryPromise({
        try: () => handle(webRequest),
        catch: (cause) => cause,
      }),
    ),
    Effect.catch((cause) => Effect.succeed(mapError(cause))),
    Effect.map(HttpServerResponse.fromWeb),
  );

const issueAtHeader = (
  issue: SchemaIssue.Issue,
  headerName: string,
  leafTag?: SchemaIssue.Leaf["_tag"],
  path: ReadonlyArray<PropertyKey> = [],
): boolean => {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
      return issueAtHeader(issue.issue, headerName, leafTag, path);
    case "Pointer":
      return issueAtHeader(issue.issue, headerName, leafTag, [...path, ...issue.path]);
    case "Composite":
    case "AnyOf":
      return issue.issues.some((nested) => issueAtHeader(nested, headerName, leafTag, path));
    default:
      return (
        path.some((segment) => segment === headerName) &&
        (leafTag === undefined || issue._tag === leafTag)
      );
  }
};

/** Maps automatic request decoding failures to the frozen transport problem families. */
export const requestSchemaErrorResponse = (error: HttpApiError.HttpApiSchemaError): Response => {
  if (error.kind === "Headers") {
    if (issueAtHeader(error.cause.issue, "if-match")) {
      return issueAtHeader(error.cause.issue, "if-match", "MissingKey")
        ? nativeProblemResponse("precondition.required", 428)
        : nativeProblemResponse("precondition.invalid", 400);
    }
    if (issueAtHeader(error.cause.issue, "if-none-match")) {
      return nativeProblemResponse("precondition.invalid", 400);
    }
    if (issueAtHeader(error.cause.issue, "idempotency-key")) {
      return nativeProblemResponse("idempotency-key.invalid", 400);
    }
    return nativeProblemResponse("header.malformed", 400);
  }
  if (error.kind === "Params" || error.kind === "Query") {
    return nativeProblemResponse("request.malformed", 400);
  }
  return nativeProblemResponse("internal.error", 500);
};

const SessionSecurityLive = Layer.succeed(
  SessionSecurity,
  SessionSecurity.of({
    cookieHeader: (httpEffect) => httpEffect,
  }),
);

const PersonSecurityLive = Layer.succeed(
  PersonSecurity,
  PersonSecurity.of({
    cookieHeader: (httpEffect) => httpEffect,
    oauthUserBearer: (httpEffect) => httpEffect,
  }),
);

const InvitationCapabilitySecurityLive = Layer.succeed(
  InvitationCapabilitySecurity,
  InvitationCapabilitySecurity.of({
    invitationCapability: (httpEffect) => httpEffect,
  }),
);

const RequestSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestSchemaErrorMiddleware,
  (error) => Effect.succeed(HttpServerResponse.fromWeb(requestSchemaErrorResponse(error))),
);

/** Contract middleware implementations shared by every native handler group. */
export const NativeHttpApiMiddlewareLive = Layer.mergeAll(
  SessionSecurityLive,
  PersonSecurityLive,
  InvitationCapabilitySecurityLive,
  RequestSchemaErrorLive,
);
