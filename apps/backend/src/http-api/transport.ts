import {
  InvitationCapabilitySecurity,
  PersonSecurity,
  RequestSchemaErrorMiddleware,
  SessionSecurity,
} from "@vektorprogrammet/http-api";
import { Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

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

const schemaErrorWebResponse = (group: string, endpoint: string): Response => {
  const tag =
    group === "organization"
      ? "OrganizationDecodeError"
      : group === "directory"
        ? "SchoolsDecodeError"
        : group === "admissions"
          ? endpoint === "readApplicationConfirmation"
            ? "PublicApplicationDecodeError"
            : "AdmissionPeriodDecodeError"
          : group === "recruitment"
            ? "RecruitmentDecodeError"
            : group === "receipts" || group === "internal"
              ? "ReceiptDecodeError"
              : group === "content"
                ? "ContentDecodeError"
                : group === "profile"
                  ? "ProfileDecodeError"
                  : "IdentityEngineError";
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (group !== "content" || endpoint !== "readContentWorkspace") {
    headers["cache-control"] = "no-store";
  }
  return new Response(JSON.stringify({ error: { tag } }), { status: 422, headers });
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
  (_error, { endpoint, group }) =>
    Effect.succeed(
      HttpServerResponse.fromWeb(schemaErrorWebResponse(group.identifier, endpoint.identifier)),
    ),
);

/** Contract middleware implementations shared by every native handler group. */
export const NativeHttpApiMiddlewareLive = Layer.mergeAll(
  SessionSecurityLive,
  PersonSecurityLive,
  InvitationCapabilitySecurityLive,
  RequestSchemaErrorLive,
);
