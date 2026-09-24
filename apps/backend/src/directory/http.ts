import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  Organization,
  resolveDirectoryGateScope,
  directoryRowInScope,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { ProfileDecodeError, Profile } from "@vektorprogrammet/domain/profile";
import {
  ExternalNativeApi,
  ListPeopleEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { OrganizationResolutionError } from "../authority.js";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";
import { authorizePersonNativeOperation, genericContext } from "../native-operation.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import { listSchools, schoolsErrorResponse, type SchoolsApiHttpOptions } from "../schools/http.js";

/**
 * GET /api/people — the native people directory.
 *
 * The adapter only decodes transport data, resolves authority through the
 * shared spec 0055 helpers, and maps typed results. It imports no SQL and
 * implements no domain transition.
 */

export interface DirectoryApiHttpOptions {
  /** Cookie -> PersonId + one authorizationInstant -> caller projection. */
  readonly resolveAuthority: (
    request: Request,
  ) => Effect.Effect<
    OrganizationPersonAuthority,
    IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
    Organization | Identity | OAuthCredentialAuthority
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

const DirectoryEntrySchema = Schema.Struct({
  personId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  /** Null until spec 0058 adds the Organization-owned association. */
  studyProgramme: Schema.Null,
  departments: Schema.Array(Schema.String),
  isActive: Schema.Boolean,
});

const DirectoryResponseSchema = Schema.Struct({
  activePeople: Schema.Array(DirectoryEntrySchema),
  inactivePeople: Schema.Array(DirectoryEntrySchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const DIRECTORY_PAGE_LIMIT = 200;

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  const tag =
    cause !== null &&
    (cause === null || Predicate.isObjectOrArray(cause)) &&
    "_tag" in cause &&
    Predicate.isString(cause._tag)
      ? cause._tag
      : "ProfilePersistenceError";

  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "InactiveActor":
    case "NotInScope":
      return nativeProblemResponse("authority.denied", 403);
    case "DirectoryCursorMalformed":
      return nativeProblemResponse("directory.cursor-malformed", 422);
    default:
      return nativeProblemResponse("directory.unavailable", 503);
  }
};

const listPeople = (request: Request, input: DirectoryApiHttpOptions) =>
  Effect.gen(function* () {
    if (new URL(request.url).search !== "") {
      return nativeProblemResponse("directory.cursor-malformed", 422);
    }

    // One captured authorizationInstant drives the gate and every row
    // derivation; Profile and Organization read one database snapshot.
    const authority = yield* input.resolveAuthority(request);
    const decision = resolveDirectoryGateScope(authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* Effect.fail(
        decision.reason === "AuthorityInactive"
          ? new HttpSemanticFailure("authority.denied", 403)
          : new HttpSemanticFailure("authority.denied", 403),
      );
    }

    const scope = decision.value;

    const contexts = !Predicate.isTagged(scope, "Departments")
      ? [
          genericContext({
            domainId: "profile",
            authorityVersion: `directory:${authority.evaluatedAt}`,
          }),
        ]
      : scope.departmentIds.map((departmentId) =>
          genericContext({
            domainId: "profile",
            departmentId,
            authorityVersion: `directory:${authority.evaluatedAt}`,
          }),
        );

    const grantScopes = !Predicate.isTagged(scope, "Departments")
      ? [{ _tag: "Global" as const }]
      : scope.departmentIds.map((departmentId) => ({
          _tag: "Department" as const,
          departmentId,
        }));

    yield* authorizePersonNativeOperation({
      request,
      personId: authority.personId,
      spec: Option.getOrThrow(reflectAccessSpec(ListPeopleEndpoint)),
      resolution: { selection: "AllMatching", contexts },
      grantScopes,
      now: authority.evaluatedAt,
    });

    const response = yield* Effect.gen(function* () {
      const organization = yield* Organization;
      const profile = yield* Profile;
      const activePeople: Array<typeof DirectoryEntrySchema.Type> = [];
      const inactivePeople: Array<typeof DirectoryEntrySchema.Type> = [];
      let cursor: string | undefined;

      while (true) {
        const page = yield* profile.readDirectoryPage({ limit: DIRECTORY_PAGE_LIMIT, cursor });

        if (page.entries.length > 0) {
          const facts = yield* organization.deriveDirectoryFacts(
            page.entries.map((entry) => entry.personId),
            authority.evaluatedAt,
          );

          for (const entry of page.entries) {
            const fact = facts.get(entry.personId);

            if (fact === undefined || !directoryRowInScope(scope, fact.departments)) continue;

            const row = {
              personId: entry.personId,
              firstName: entry.firstName,
              lastName: entry.lastName,
              email: entry.email,
              phone: entry.phone,
              studyProgramme: null,
              departments: [...fact.departmentNames],
              isActive: fact.isActive,
            };

            if (fact.isActive) activePeople.push(row);
            else inactivePeople.push(row);
          }
        }

        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }

      return yield* Schema.decodeUnknownEffect(DirectoryResponseSchema)(
        { activePeople, inactivePeople, nextCursor: cursor ?? null },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(() => new ProfileDecodeError({ message: "Invalid directory response" })),
      );
    });

    return privateJsonResponse(response);
  });

/** Native HttpApi implementation for the people and school directories. */
export const DirectoryApiHandlers = (
  input: DirectoryApiHttpOptions,
  schools: SchoolsApiHttpOptions,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "directory", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listPeople", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => listPeople(webRequest, input), errorResponse),
        )
        .handleRaw("listSchools", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listSchools(webRequest, schools),
            schoolsErrorResponse,
          ),
        ),
    ),
  );
