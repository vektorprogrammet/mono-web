import { Scope } from "@vektorprogrammet/domain/authz";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { readSchoolsDirectory } from "@vektorprogrammet/database/schools";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  SchoolDirectoryQuerySchema,
  SchoolDirectorySchema,
  type ReadSchoolsDirectoryFailure,
  type SchoolCommandFailure,
  type SchoolDirectoryQuery,
} from "@vektorprogrammet/domain/schools";
import type { OrganizationAuthorityInstant, PersonId } from "@vektorprogrammet/domain/organization";
import { ListSchoolsEndpoint, reflectAccessSpec } from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Match, Option, Schema } from "effect";
import {
  authorizePerson,
  personPresentation,
  problemMapper,
  unreachable,
} from "../http-api/problem.js";
import { genericContext } from "../native-operation.js";

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

/**
 * The one answer for every Schools failure. A representation that does not
 * fit its schema leaves Schools unavailable, as a failed Schools read does.
 *
 * @construct http-problem
 */
export const schoolsProblems = problemMapper<
  ReadSchoolsDirectoryFailure | SchoolCommandFailure | Schema.SchemaError
>()({
  AuthorityInactive: () => Problem.make("authority.denied"),
  NotInScope: () => Problem.make("authority.denied"),
  SchoolsDepartmentOutOfScope: () => Problem.make("authority.denied"),
  SchoolsDepartmentNotFound: () => Problem.make("schools.invalid-department"),
  SchoolsDecodeError: () => Problem.make("schools.unavailable"),
  SchoolsPersistenceError: () => Problem.make("schools.unavailable"),
  SchemaError: () => Problem.make("schools.unavailable"),
  SchoolCommandFailure: ({ code }) =>
    Match.value(code).pipe(
      Match.when("Denied", () => Problem.make("authority.denied")),
      Match.when("NotFound", () => Problem.make("resource.not-found")),
      Match.when("Stale", () => Problem.make("precondition.failed")),
      Match.when("Conflict", () => Problem.make("idempotency.digest-conflict")),
      Match.when("AssociationInUse", () => Problem.make("schools.association-in-use")),
      Match.when("InactiveSchool", () => Problem.make("schools.inactive")),
      Match.when("CapacityExists", () => Problem.make("schools.capacity-exists")),
      Match.whenOr("InvalidReference", "Invalid", () => Problem.make("schools.invalid-command")),
      Match.exhaustive,
    ),
});

/**
 * A person credential rejected after ingress is answered from the request's
 * own evidence; an unavailable identity provider leaves Schools unavailable.
 *
 * @construct http-problem
 */
export const schoolsCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("schools.unavailable"),
  });

/** The directory accepts one optional department and no other query member. */
const decodeQuery = (
  request: Request,
): Effect.Effect<SchoolDirectoryQuery, Problem<"request.malformed">> => {
  const parameters = [...new URL(request.url).searchParams];

  const encoded =
    parameters.length === 0
      ? {}
      : parameters.length === 1 && parameters[0]![0] === "department"
        ? { departmentId: parameters[0]![1] }
        : undefined;

  if (encoded === undefined) return Effect.fail(Problem.make("request.malformed"));

  return Schema.decodeEffect(SchoolDirectoryQuerySchema)(encoded, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => Problem.make("request.malformed")));
};

/** Native Schools directory adapter. It owns transport only, never SQL or authority policy. */
export const listSchools = (request: Request, options: SchoolsApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const query = yield* decodeQuery(request);
    const actor = yield* options.resolveActor(request);

    yield* authorizePerson(
      {
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
      },
      presentation,
    );

    const directory = yield* readSchoolsDirectory(
      actor.personId,
      actor.authorizationInstant,
      query,
    );

    const response = yield* Schema.decodeEffect(SchoolDirectorySchema)(directory, {
      onExcessProperty: "error",
    });

    return privateJsonResponse(response);
  }).pipe(
    schoolsProblems,
    schoolsCredentialProblems(presentation),
    // A revealing AccessSpec answers every authority failure as a denial, never as 404.
    unreachable("resource.not-found"),
  );
};
