/**
 * The DirectoryRpcs handlers: the people directory and the school directory and administration.
 *
 * The people directory resolves the caller's authority at one instant, gates it to the directory
 * reach, and reads every profile page, keeping the rows inside that reach. The school directory
 * evaluates its AccessSpec before the Schools journey reads under the caller's authority. School
 * management resolves the caller's credential in its transaction; a school command resolves it,
 * and the `SchoolCommandAuthorization` that Schools mints, inside the transaction that commits the
 * command, and stores its success as a command receipt.
 */
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  directoryRowInScope,
  Organization,
  resolveDirectoryGateScope,
} from "@vektorprogrammet/domain/organization";
import { Profile, type ProfileFailure } from "@vektorprogrammet/domain/profile";
import {
  SchoolCommandFailure,
  Schools,
  type ReadSchoolsDirectoryFailure,
} from "@vektorprogrammet/domain/schools";
import { readSchoolsDirectory } from "@vektorprogrammet/database/schools";
import {
  DirectoryRpcs,
  ExecuteSchoolCommand,
  ListPeople,
  ListSchools,
  type PeopleDirectoryEntry,
  PeopleDirectoryResponse,
  ReadSchoolManagement,
  reflectAccessSpec,
  SchoolCommandResult,
  SchoolDirectorySchema,
} from "@vektorprogrammet/rpc";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import {
  type OrganizationResolutionError,
  resolveRequestCredentialInTransaction,
  resolveRequestPersonAtInstant,
  resolveRequestPersonAuthority,
} from "../authority.js";
import { semanticRequestDigest } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  personPresentation,
  problemMapper,
  unreachable,
} from "../rpc/problem.js";
import { executeNativeHttpCommandPostgres, successCapsule } from "../rpc/receipt-transaction.js";

const DIRECTORY_PAGE_LIMIT = 200;

const directoryUnavailable = () => Problem.make("directory.unavailable");

/**
 * The one answer for every people-directory failure. A read that cannot complete, or a response
 * that does not fit its schema, leaves the directory unavailable.
 */
const directoryProblems = problemMapper<
  OrganizationResolutionError | ProfileFailure | Schema.SchemaError
>()({
  OrganizationDecodeError: directoryUnavailable,
  OrganizationPersistenceError: directoryUnavailable,
  ProfileDecodeError: directoryUnavailable,
  ProfileQueryLimitExceeded: directoryUnavailable,
  ProfileNotFound: directoryUnavailable,
  ProfileContactNotFound: directoryUnavailable,
  ProfileStaleRevision: directoryUnavailable,
  ProfileCommandConflict: directoryUnavailable,
  ProfilePersistenceError: directoryUnavailable,
  SchemaError: directoryUnavailable,
});

/**
 * A person credential rejected after ingress is answered from the request's own evidence; an
 * unavailable identity provider leaves the directory unavailable.
 */
const directoryCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: directoryUnavailable,
  });

/**
 * The one answer for every Schools failure. A representation that does not fit its schema leaves
 * Schools unavailable, as a failed Schools read does.
 */
const schoolsProblems = problemMapper<
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
 * A person credential rejected after ingress is answered from the request's own evidence; an
 * unavailable identity provider leaves Schools unavailable.
 */
const schoolsCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("schools.unavailable"),
  });

/**
 * Resolves the current Person credential of a school-management call and evaluates the RPC's
 * AccessSpec for it with a global grant: Schools itself scopes what the person manages.
 */
const authorizeSchoolManagement = Effect.fn("Schools.authorizeManagement")(function* (
  headers: Headers.Headers,
  rpc: Pick<Rpc.AnyWithProps, "annotations">,
) {
  const resolved = yield* resolveRequestCredentialInTransaction(
    credentialRequestOf(headers),
    "OAuthUserBearer",
  );

  if (!Predicate.isTagged(resolved.credential.principal, "Person"))
    return yield* Problem.unauthenticated(personPresentation(headers));

  const personId = resolved.credential.principal.personId;

  yield* authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(rpc)),
      credential: resolved.credential,
      personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [genericContext({ domainId: "schools", authorityVersion: "school-management" })],
      },
      grantScopes: [Scope.Global()],
      now: resolved.authorizationInstant,
    },
    personPresentation(headers),
  );

  return personId;
});

/** The DirectoryRpcs handlers. */
export const DirectoryRpcHandlers = (options: NativeRpcOptions) =>
  DirectoryRpcs.toLayer({
    "directory.listPeople": (_payload, { headers }) =>
      Effect.gen(function* () {
        // One captured authorization instant drives the gate and every row derivation.
        const authority = yield* resolveRequestPersonAuthority(credentialRequestOf(headers), {
          now: options.now,
        });

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
          ? [Scope.Global()]
          : scope.departmentIds.map((departmentId) => Scope.Department({ departmentId }));

        yield* authorizePerson(
          {
            request: credentialRequestOf(headers),
            personId: authority.personId,
            spec: Option.getOrThrow(reflectAccessSpec(ListPeople)),
            resolution: { selection: "AllMatching", contexts },
            grantScopes,
            now: authority.evaluatedAt,
          },
          personPresentation(headers),
        );

        const organization = yield* Organization;
        const profile = yield* Profile;
        const activePeople: Array<PeopleDirectoryEntry> = [];
        const inactivePeople: Array<PeopleDirectoryEntry> = [];
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

        return yield* Schema.decodeEffect(PeopleDirectoryResponse)(
          { activePeople, inactivePeople, nextCursor: cursor ?? null },
          { onExcessProperty: "error" },
        );
      }).pipe(
        directoryProblems,
        directoryCredentialProblems(personPresentation(headers)),
        // A revealing AccessSpec answers every authority failure as a denial, never as 404.
        unreachable("resource.not-found"),
      ),

    "directory.listSchools": (query, { headers }) =>
      Effect.gen(function* () {
        const actor = yield* resolveRequestPersonAtInstant(credentialRequestOf(headers), {
          now: options.now,
        });

        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(ListSchools)),
            request: credentialRequestOf(headers),
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
          personPresentation(headers),
        );

        const directory = yield* readSchoolsDirectory(
          actor.personId,
          actor.authorizationInstant,
          query,
        );

        return yield* Schema.decodeEffect(SchoolDirectorySchema)(directory, {
          onExcessProperty: "error",
        });
      }).pipe(
        schoolsProblems,
        schoolsCredentialProblems(personPresentation(headers)),
        // A revealing AccessSpec answers every authority failure as a denial, never as 404.
        unreachable("resource.not-found"),
      ),

    "directory.readSchoolManagement": (_payload, { headers }) =>
      Effect.gen(function* () {
        const personId = yield* authorizeSchoolManagement(headers, ReadSchoolManagement);

        return yield* Schools.use((schools) => schools.readManagement(personId));
      }).pipe(schoolsProblems, schoolsCredentialProblems(personPresentation(headers))),

    "directory.executeSchoolCommand": ({ idempotencyKey, request: command }, { headers }) =>
      Effect.gen(function* () {
        const operationId = "directory.executeSchoolCommand";

        if (idempotencyKey !== command.commandId)
          return yield* SchoolCommandFailure.make({ code: "Conflict" });

        // Domain and credential failures are mapped after the executor, whose retry reads their
        // causes.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const personId = yield* authorizeSchoolManagement(headers, ExecuteSchoolCommand);

            const authorization = yield* Schools.use((schools) =>
              schools.authorizeCommand(command, personId),
            );

            // The HTTP route stays the normalized target, so receipts and command IDs are stable.
            const identity = yield* commandIdentity({
              credentialSubject: `Person:${personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/schools/commands",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest({ body: command }),
                operationId,
              },
              execute: Schools.use((schools) => schools.executeCommand(authorization)).pipe(
                Effect.flatMap(successCapsule(SchoolCommandResult)),
              ),
            };
          }),
          { retry: "serialization-once" },
        );

        return yield* commandOutcome(SchoolCommandResult)(outcome);
      }).pipe(
        schoolsProblems,
        commandReceiptProblems,
        schoolsCredentialProblems(personPresentation(headers)),
      ),
  });
