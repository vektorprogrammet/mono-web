import {
  readSchoolsDirectory,
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  SchoolsDecodeError,
  type SchoolDirectoryQuery,
} from "@vektorprogrammet/domain/schools";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
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
  if (cause instanceof SchoolsHttpQueryDecodeError) {
    return jsonResponse({ error: { tag: cause._tag } }, cause.status);
  }

  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "SchoolsPersistenceError";
  switch (tag) {
    case "UnauthenticatedActor":
      return jsonResponse({ error: { tag } }, 401);
    case "AuthorityInactive":
    case "NotInScope":
    case "SchoolsDepartmentOutOfScope":
      return jsonResponse({ error: { tag } }, 403);
    case "SchoolsDepartmentNotFound":
      return jsonResponse({ error: { tag } }, 422);
    case "SchoolsDecodeError":
    case "SchoolsPersistenceError":
      return jsonResponse({ error: { tag } }, 503);
    default:
      return jsonResponse({ error: { tag: "SchoolsPersistenceError" } }, 503);
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
