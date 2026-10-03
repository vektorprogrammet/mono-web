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
  listPeople as listPeopleEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Predicate, Effect, Option, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import type { HttpApiGroup } from "effect/unstable/httpapi";
import {
  DirectoryApiHandlers as GeneratedDirectoryApiHandlers,
  type DirectoryGuards,
  type DirectoryRawHandlers,
} from "../../.effx/generated/directory-handlers.js";
import type { OrganizationResolutionError } from "../authority.js";
import { genericContext } from "../native-operation.js";
import {
  authorizePerson,
  personPresentation,
  problemMapper,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import { CurrentRawWebRequest, currentRawWebRequest } from "../http-api/raw-web-request.js";
import {
  authorizeSchoolsDirectory,
  listSchools,
  schoolsCredentialProblems,
  schoolsProblems,
  type SchoolsApiHttpOptions,
} from "../schools/http.js";
import {
  authorizeSchoolManagement,
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

const authorizePeopleDirectory = (request: Request, input: DirectoryApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    // One captured authorizationInstant drives the gate and every row derivation.
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
        spec: Option.getOrThrow(reflectAccessSpec(listPeopleEndpoint)),
        resolution: { selection: "AllMatching", contexts },
        grantScopes,
        now: authority.evaluatedAt,
      },
      presentation,
    );

    return { authority, scope };
  }).pipe(
    directoryProblems,
    directoryCredentialProblems(presentation),
    // A revealing AccessSpec answers every authority failure as a denial, never as 404.
    unreachable("resource.not-found"),
  );
};

const listPeople = (
  request: Request,
  authorize: () => ReturnType<typeof authorizePeopleDirectory>,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    if (new URL(request.url).search !== "") {
      return yield* Problem.make("directory.cursor-malformed");
    }

    const { authority, scope } = yield* authorize();

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

type DirectoryEndpoints = HttpApiGroup.Endpoints<(typeof ExternalNativeApi)["groups"]["directory"]>;

const schoolManagementGuard = (mutation: boolean) =>
  Effect.gen(function* () {
    const request = yield* currentRawWebRequest;
    const presentation = personPresentation(request);

    return yield* authorizeSchoolManagement(request, mutation, presentation).pipe(
      schoolsProblems,
      schoolsCredentialProblems(presentation),
    );
  });

const makeDirectoryGuards = (input: DirectoryApiHttpOptions, schools: SchoolsApiHttpOptions) =>
  ({
    "directory.executeSchoolCommand": (_nativeRequest: HttpServerRequest.HttpServerRequest) =>
      schoolManagementGuard(true),
    "directory.listPeople": (_nativeRequest: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const request = yield* currentRawWebRequest;

        return yield* authorizePeopleDirectory(request, input);
      }),
    "directory.listSchools": (_nativeRequest: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const request = yield* currentRawWebRequest;

        return yield* authorizeSchoolsDirectory(request, schools);
      }),
    "directory.readSchoolManagement": (_nativeRequest: HttpServerRequest.HttpServerRequest) =>
      schoolManagementGuard(false),
  }) satisfies DirectoryGuards<DirectoryEndpoints>;

/** One complete generated Directory group keeps People, Schools and their separate authority. */
export const DirectoryApiHandlers = (
  input: DirectoryApiHttpOptions,
  schools: SchoolsApiHttpOptions,
) => {
  const guards = makeDirectoryGuards(input, schools);

  const raw = {
    executeSchoolCommand: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        executeSchoolCommandHttp(webRequest, authorize).pipe(
          Effect.provideService(CurrentRawWebRequest, webRequest),
        ),
      ),
    listPeople: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        listPeople(webRequest, authorize).pipe(
          Effect.provideService(CurrentRawWebRequest, webRequest),
        ),
      ),
    listSchools: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        listSchools(webRequest, authorize).pipe(
          Effect.provideService(CurrentRawWebRequest, webRequest),
        ),
      ),
    readSchoolManagement: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        readSchoolManagementHttp(webRequest, authorize).pipe(
          Effect.provideService(CurrentRawWebRequest, webRequest),
        ),
      ),
  } satisfies DirectoryRawHandlers<DirectoryEndpoints, typeof guards>;

  return GeneratedDirectoryApiHandlers({ raw, guards });
};
