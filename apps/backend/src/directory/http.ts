import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  Organization,
  resolveDirectoryGateScope,
  directoryRowInScope,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Profile, type ProfileFailure } from "@vektorprogrammet/domain/profile";
import {
  ExternalNativeApi,
  ListPeopleEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { OrganizationResolutionError } from "../authority.js";
import { genericContext } from "../native-operation.js";
import {
  authorizePerson,
  personPresentation,
  problemMapper,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import { listSchools, type SchoolsApiHttpOptions } from "../schools/http.js";
import {
  readSchoolManagementHttp,
  executeSchoolCommandHttp,
} from "../schools/administration-http.js";

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

const unavailable = () => Problem.make("directory.unavailable");

/**
 * The one answer for every people-directory failure. A read that cannot
 * complete, or a response that does not fit its schema, leaves the directory
 * unavailable.
 */
const directoryProblems = problemMapper<
  OrganizationResolutionError | ProfileFailure | Schema.SchemaError
>()({
  OrganizationDecodeError: unavailable,
  OrganizationPersistenceError: unavailable,
  ProfileDecodeError: unavailable,
  ProfileQueryLimitExceeded: unavailable,
  ProfileNotFound: unavailable,
  ProfileContactNotFound: unavailable,
  ProfileStaleRevision: unavailable,
  ProfileCommandConflict: unavailable,
  ProfilePersistenceError: unavailable,
  SchemaError: unavailable,
});

/**
 * A person credential rejected after ingress is answered from the request's
 * own evidence; an unavailable identity provider leaves the directory
 * unavailable.
 */
const directoryCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: unavailable,
  });

const listPeople = (request: Request, input: DirectoryApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    if (new URL(request.url).search !== "") {
      return yield* Problem.make("directory.cursor-malformed");
    }

    // One captured authorizationInstant drives the gate and every row
    // derivation; Profile and Organization read one database snapshot.
    const authority = yield* input.resolveAuthority(request);
    const decision = resolveDirectoryGateScope(authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* Problem.make("authority.denied");
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

    yield* authorizePerson(
      {
        request,
        personId: authority.personId,
        spec: Option.getOrThrow(reflectAccessSpec(ListPeopleEndpoint)),
        resolution: { selection: "AllMatching", contexts },
        grantScopes,
        now: authority.evaluatedAt,
      },
      presentation,
    );

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

      return yield* Schema.decodeEffect(DirectoryResponseSchema)(
        { activePeople, inactivePeople, nextCursor: cursor ?? null },
        { onExcessProperty: "error" },
      );
    });

    return privateJsonResponse(response);
  }).pipe(
    directoryProblems,
    directoryCredentialProblems(presentation),
    // A revealing AccessSpec answers every authority failure as a denial, never as 404.
    unreachable("resource.not-found"),
  );
};

/** Native HttpApi implementation for the people and school directories. */
export const DirectoryApiHandlers = (
  input: DirectoryApiHttpOptions,
  schools: SchoolsApiHttpOptions,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "directory", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readSchoolManagement", ({ request }) =>
          webHandler(request, readSchoolManagementHttp),
        )
        .handleRaw("executeSchoolCommand", ({ request }) =>
          webHandler(request, executeSchoolCommandHttp),
        )
        .handleRaw("listPeople", ({ request }) =>
          webHandler(request, (webRequest) => listPeople(webRequest, input)),
        )
        .handleRaw("listSchools", ({ request }) =>
          webHandler(request, (webRequest) => listSchools(webRequest, schools)),
        ),
    ),
  );
