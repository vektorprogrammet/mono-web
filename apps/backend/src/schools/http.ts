import {
  readSchoolsDirectory,
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  SchoolsDecodeError,
  type SchoolDirectoryQuery,
} from "@vektorprogrammet/domain/schools";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { ListSchoolsEndpoint, reflectAccessSpec } from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";
import { authorizePersonNativeOperation, genericContext } from "../native-operation.js";
import type { BackendRun } from "../router.js";

export interface SchoolsRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

export interface SchoolsApiHttpOptions {
  /** Cookie -> PersonId and the request's single authorization instant. */
  readonly resolveActor: (request: Request) => Promise<SchoolsRequestActor>;
  readonly run: BackendRun;
}

class SchoolsHttpQueryDecodeError extends Error {
  readonly _tag = "SchoolsDecodeError";
  readonly status = 422;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const schoolsErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "SchoolsPersistenceError";
  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "AuthorityInactive":
    case "NotInScope":
    case "SchoolsDepartmentOutOfScope":
      return nativeProblemResponse("authority.denied", 403);
    case "SchoolsDepartmentNotFound":
      return nativeProblemResponse("schools.invalid-department", 422);
    default:
      return nativeProblemResponse("schools.unavailable", 503);
  }
};

const decodeQuery = (request: Request, run: BackendRun): Promise<SchoolDirectoryQuery> => {
  const parameters = [...new URL(request.url).searchParams];
  const encoded =
    parameters.length === 0
      ? {}
      : parameters.length === 1 && parameters[0]![0] === "department"
        ? { departmentId: parameters[0]![1] }
        : undefined;
  if (encoded === undefined) return Promise.reject(new SchoolsHttpQueryDecodeError());

  return run(
    Schema.decodeUnknownEffect(SchoolDirectoryQuerySchema)(encoded, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new SchoolsHttpQueryDecodeError())),
  );
};

/** Native Schools directory adapter. It owns transport only, never SQL or authority policy. */
export const listSchools = async (
  request: Request,
  options: SchoolsApiHttpOptions,
): Promise<Response> => {
  const query = await decodeQuery(request, options.run);
  const actor = await options.resolveActor(request);
  await authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ListSchoolsEndpoint)),
    request,
    personId: actor.personId,
    resolution: {
      selection: "AllMatching",
      contexts: [
        genericContext({
          domainId: "schools",
          departmentId: query.departmentId ?? null,
          authorityVersion: `schools:${actor.authorizationInstant}`,
        }),
      ],
    },
    grantScopes: [{ _tag: "Global" }],
    now: actor.authorizationInstant,
    run: options.run,
  });
  const directory = await options.run(
    readSchoolsDirectory(actor.personId, actor.authorizationInstant, query),
  );
  const response = await options.run(
    Schema.decodeUnknownEffect(SchoolDirectorySchema)(directory, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SchoolsDecodeError({
            operation: "decode Schools HTTP response",
            message: String(cause),
          }),
      ),
    ),
  );
  return jsonResponse(response);
};
