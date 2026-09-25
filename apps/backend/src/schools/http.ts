import { Scope } from "@vektorprogrammet/domain/authz";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { readSchoolsDirectory } from "@vektorprogrammet/database/schools";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  SchoolCommandFailure,
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  SchoolsDecodeError,
  type SchoolDirectoryQuery,
} from "@vektorprogrammet/domain/schools";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { ListSchoolsEndpoint, reflectAccessSpec } from "@vektorprogrammet/http-api";
import { Predicate, Effect, Option, Schema } from "effect";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";
import { authorizePersonNativeOperation, genericContext } from "../native-operation.js";

export interface SchoolsRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

export interface SchoolsApiHttpOptions {
  /** Cookie -> PersonId and the request's single authorization instant. */
  readonly resolveActor: (
    request: Request,
  ) => Effect.Effect<
    SchoolsRequestActor,
    IdentityEngineError | UnauthenticatedActor,
    Identity | OAuthCredentialAuthority
  >;
}

const privateJsonResponse = (body: Schema.Json): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      vary: "Origin",
    },
  });

export const schoolsErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  if (cause instanceof SchoolCommandFailure) {
    switch (cause.code) {
      case "Denied":
        return nativeProblemResponse("authority.denied", 403);
      case "NotFound":
        return nativeProblemResponse("resource.not-found", 404);
      case "Stale":
        return nativeProblemResponse("precondition.failed", 412);
      case "Conflict":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "AssociationInUse":
        return nativeProblemResponse("schools.association-in-use", 409);
      case "InactiveSchool":
        return nativeProblemResponse("schools.inactive", 409);
      case "CapacityExists":
        return nativeProblemResponse("schools.capacity-exists", 409);
      case "InvalidReference":
      case "Invalid":
        return nativeProblemResponse("schools.invalid-command", 422);
    }
  }

  const tag =
    (cause === null || Predicate.isObjectOrArray(cause)) && cause !== null && "_tag" in cause
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

/** The directory accepts one optional department and no other query member. */
const decodeQuery = (
  request: Request,
): Effect.Effect<SchoolDirectoryQuery, HttpSemanticFailure> => {
  const parameters = [...new URL(request.url).searchParams];

  const encoded =
    parameters.length === 0
      ? {}
      : parameters.length === 1 && parameters[0]![0] === "department"
        ? { departmentId: parameters[0]![1] }
        : undefined;

  if (encoded === undefined) return Effect.fail(new HttpSemanticFailure("request.malformed", 400));

  return Schema.decodeUnknownEffect(SchoolDirectoryQuerySchema)(encoded, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new HttpSemanticFailure("request.malformed", 400)));
};

/** Native Schools directory adapter. It owns transport only, never SQL or authority policy. */
export const listSchools = (request: Request, options: SchoolsApiHttpOptions) =>
  Effect.gen(function* () {
    const query = yield* decodeQuery(request);
    const actor = yield* options.resolveActor(request);
    yield* authorizePersonNativeOperation({
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
      grantScopes: [Scope.Global()],
      now: actor.authorizationInstant,
    });

    const directory = yield* readSchoolsDirectory(
      actor.personId,
      actor.authorizationInstant,
      query,
    );

    const response = yield* Schema.decodeUnknownEffect(SchoolDirectorySchema)(directory, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SchoolsDecodeError({
            operation: "decode Schools HTTP response",
            message: String(cause),
          }),
      ),
    );

    return privateJsonResponse(response);
  });
