import {
  Organization,
  resolveDirectoryGateScope,
  directoryRowInScope,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import {
  ExternalNativeApi,
  ListAdminUsersEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";
import { authorizePersonNativeOperation, genericContext } from "../native-operation.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import { listSchools, schoolsErrorResponse, type SchoolsApiHttpOptions } from "../schools/http.js";
import type { BackendRun } from "../router.js";

/**
 * GET /api/admin/users — the native admin user directory (spec 0057).
 *
 * The adapter only decodes transport data, resolves authority through the
 * shared spec 0055 helpers, and maps typed results. It imports no SQL and
 * implements no domain transition.
 */

export interface AdminUsersApiHttpOptions {
  /** Cookie -> PersonId + one authorizationInstant -> caller projection. */
  readonly resolveAuthority: (request: Request) => Promise<OrganizationPersonAuthority>;
  readonly run: BackendRun;
}

type TaggedHttpError = Error & { readonly _tag: string };

const taggedError = (tag: string): TaggedHttpError => {
  const error = new Error(tag) as TaggedHttpError;
  Object.defineProperty(error, "_tag", { value: tag, enumerable: true });
  return error;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
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

const listAdminUsers = async (
  request: Request,
  input: AdminUsersApiHttpOptions,
): Promise<Response> => {
  if (new URL(request.url).search !== "") {
    return jsonResponse({ error: { tag: "DirectoryCursorMalformed" } }, 422);
  }
  // One captured authorizationInstant drives the gate and every row
  // derivation; Profile and Organization read one database snapshot.
  const authority = await input.resolveAuthority(request);
  const decision = resolveDirectoryGateScope(authority);
  if (decision._tag === "Deny") {
    throw decision.reason === "AuthorityInactive"
      ? taggedError("InactiveActor")
      : taggedError("NotInScope");
  }
  const scope = decision.value;
  const contexts =
    scope._tag === "AllDepartments"
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
  const grantScopes =
    scope._tag === "AllDepartments"
      ? [{ _tag: "Global" as const }]
      : scope.departmentIds.map((departmentId) => ({
          _tag: "Department" as const,
          departmentId,
        }));
  await authorizePersonNativeOperation({
    request,
    personId: authority.personId,
    spec: Option.getOrThrow(reflectAccessSpec(ListAdminUsersEndpoint)),
    resolution: { selection: "AllMatching", contexts },
    grantScopes,
    now: authority.evaluatedAt,
    run: input.run,
  });
  const response = await input.run(
    Effect.gen(function* () {
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
      ).pipe(Effect.mapError(() => taggedError("ProfileDecodeError")));
    }),
  );
  return jsonResponse(response);
};

/** Native HttpApi implementation for the administrative user directory. */
export const AdminUsersApiHandlers = (
  input: AdminUsersApiHttpOptions,
  schools: SchoolsApiHttpOptions,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "directory", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listPeople", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listAdminUsers(webRequest, input),
            errorResponse,
          ),
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
