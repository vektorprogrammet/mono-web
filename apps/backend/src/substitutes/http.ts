import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { OrganizationPersistenceError } from "@vektorprogrammet/domain/organization";
import {
  SubstituteMutation,
  SubstituteScope,
  SubstituteScopes,
  substitutePermission,
  Substitutes,
  type SubstituteEntry,
  type SubstituteOperationFailure,
} from "@vektorprogrammet/domain/substitutes";
import {
  ExternalNativeApi,
  SubstituteBoard,
  SubstituteResource,
  ActivateSubstituteEndpoint,
  EditSubstituteEndpoint,
  DeactivateSubstituteEndpoint,
  ReadSubstituteEndpoint,
  ReadSubstitutePoolEndpoint,
  ListSubstituteScopesEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Match, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
  type TransactionPersonAuthority,
} from "../authority.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  conditionalJson,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  isSerializationConflict,
  personPresentation,
  problemMapper,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  strictOutput,
  webHandler,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  normalizeTarget,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";

const MAX_MUTATION_BYTES = 8192;

export const substituteResource = <A extends SubstituteEntry>(
  entry: A,
): A & { readonly etag: (typeof SubstituteResource.Type)["etag"] } => ({
  ...entry,
  etag: deriveStrongETag({
    representationKind: "SubstituteResource",
    resourceIdentity: entry.applicationId,
    version: JSON.stringify(entry),
  }),
});

const json = (body: Schema.Json) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": PRIVATE_NO_STORE,
      vary: "Origin",
    },
  });

/** A lost serialization or deadlock race may be retried; any other storage failure may not. */
const persistenceProblem = (failure: OrganizationPersistenceError | SqlError) =>
  isSerializationConflict(failure)
    ? Problem.make("transaction.conflict")
    : Problem.make("internal.error");

/**
 * The one answer for every substitute and person-authority failure. A person
 * credential rejected inside the transaction is answered from the request's evidence.
 *
 * @construct http-problem
 */
const substituteProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | SubstituteOperationFailure
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationResolutionError
  >()({
    SubstituteFailure: (failure) => Problem.make(failure.code),
    SubstitutePersistenceError: (failure) => Problem.make(failure.code),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: persistenceProblem,
  });

type Endpoint =
  | typeof ActivateSubstituteEndpoint
  | typeof EditSubstituteEndpoint
  | typeof DeactivateSubstituteEndpoint
  | typeof ReadSubstituteEndpoint
  | typeof ReadSubstitutePoolEndpoint
  | typeof ListSubstituteScopesEndpoint;

/**
 * Grants the department's substitute permission, then evaluates the declared AccessSpec.
 *
 * @construct http-problem
 */
const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: SubstituteEntry["departmentId"],
  manage: boolean,
  auth: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const permission = substitutePermission(auth.authority, departmentId);

    if (permission === "Denied" || (manage && permission !== "Manage"))
      return yield* Problem.make("authority.denied");

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
        credential: auth.credential,
        personId: auth.authority.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "admissions",
              departmentId,
              authorityVersion: auth.authorizationInstant,
            }),
          ],
        },
        grantScopes: [Scope.Department({ departmentId })],
        now: auth.authorizationInstant,
      },
      personPresentation(request),
    );

    return permission;
  });

export const SubstitutesApiHandlers = (input: { now?: () => string }) => {
  const personAuthority = (request: Request) =>
    resolveRequestPersonAuthorityInTransaction(request, { now: input.now });

  /**
   * Runs one read in a REPEATABLE READ snapshot, which resolves the credential
   * and authority on the same connection, and answers its failures.
   *
   * @construct sql-lifecycle
   */
  const snapshotRead = <A, E, R>(request: Request, effect: Effect.Effect<A, E, R>) =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

          return yield* effect;
        }),
      ),
    ).pipe(
      Effect.catchIf(isSqlError, (failure) => Effect.fail(persistenceProblem(failure))),
      substituteProblems(personPresentation(request)),
    );

  const listScopes = (request: Request) =>
    snapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const auth = yield* personAuthority(request);

        const scopes = yield* Substitutes.use((substitutes) =>
          substitutes.listScopes(auth.authority),
        );

        for (const department of scopes.departments)
          yield* authorize(
            request,
            ListSubstituteScopesEndpoint,
            department.departmentId,
            false,
            auth,
          );

        return json(yield* strictOutput(SubstituteScopes)(scopes));
      }),
    );

  const readPool = (request: Request) =>
    snapshotRead(
      request,
      Effect.gen(function* () {
        const parameters = new URL(request.url).searchParams;
        const keys = [...parameters.keys()];

        if (
          keys.some((key) => key !== "departmentId" && key !== "semesterId") ||
          keys.some((key) => parameters.getAll(key).length !== 1)
        )
          return yield* Problem.make("request.malformed");

        const scope = yield* decodeRequest(SubstituteScope)(Object.fromEntries(parameters));
        const auth = yield* personAuthority(request);

        const permission = yield* authorize(
          request,
          ReadSubstitutePoolEndpoint,
          scope.departmentId,
          false,
          auth,
        );

        const { admissionPeriodId, entries: rows } = yield* Substitutes.use((substitutes) =>
          substitutes.readPool(scope),
        );

        const entries = rows.flatMap((row) => (row.active ? [substituteResource(row)] : []));

        return json(
          yield* strictOutput(SubstituteBoard)(
            permission === "Manage"
              ? SubstituteBoard.cases.Manage.make({
                  ...scope,
                  admissionPeriodId,
                  entries,
                  candidates: rows.flatMap((row) => (!row.active ? [substituteResource(row)] : [])),
                })
              : SubstituteBoard.cases.ReadOnly.make({ ...scope, admissionPeriodId, entries }),
          ),
        );
      }),
    );

  const readEntry = (request: Request, applicationId: SubstituteEntry["applicationId"]) =>
    snapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const entry = yield* Substitutes.use((substitutes) => substitutes.readEntry(applicationId));
        const auth = yield* personAuthority(request);

        const permission = yield* authorize(
          request,
          ReadSubstituteEndpoint,
          entry.departmentId,
          false,
          auth,
        );

        // Inactive candidates are concealed from read-only members.
        if (!entry.active && permission !== "Manage")
          return yield* Problem.make("authority.denied");

        const resource = yield* strictOutput(SubstituteResource)(substituteResource(entry));

        return yield* conditionalJson({
          request,
          body: resource,
          etag: resource.etag,
          cacheControl: PRIVATE_NO_STORE,
          contentType: "application/json",
        });
      }),
    );

  const mutation = (
    request: Request,
    applicationId: SubstituteEntry["applicationId"],
    action: "activate" | "edit" | "deactivate",
  ) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* readJsonBody(
        request,
        /^application\/json(?:\s*;|$)/u,
        MAX_MUTATION_BYTES,
      );

      if (action === "deactivate") yield* decodeRequest(Schema.Struct({}))(body);

      const command =
        action === "deactivate"
          ? ({ action } as const)
          : { action, input: yield* decodeRequest(SubstituteMutation)(body) };

      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);

      const endpoint = Match.value(action).pipe(
        Match.when("activate", () => ActivateSubstituteEndpoint),
        Match.when("edit", () => EditSubstituteEndpoint),
        Match.orElse(() => DeactivateSubstituteEndpoint),
      );

      const operationId = `substitutes.${action}`;

      // Failures are answered after the executor, which rolls the whole command back on any of them.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const selected = yield* Substitutes.use((substitutes) =>
            substitutes.readEntry(applicationId),
          );

          const auth = yield* personAuthority(request);

          yield* authorize(request, endpoint, selected.departmentId, true, auth);

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget(`/api/substitutes/{applicationId}:${action}`, {
              applicationId,
            }),
            idempotencyKey,
          });

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              const changed = yield* Substitutes.use((substitutes) =>
                substitutes.execute(applicationId, command, (current) =>
                  requireCurrentETag(substituteResource(current).etag, ifMatch),
                ),
              );

              const resource = yield* strictOutput(SubstituteResource)(substituteResource(changed));

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag: resource.etag },
                bodyBytes: new TextEncoder().encode(JSON.stringify(resource)),
              };
            }),
          };
        }),
      ).pipe(substituteProblems(personPresentation(request)), commandReceiptProblems);

      return yield* commandOutcomeResponse(outcome);
    });

  return HttpApiBuilder.group(ExternalNativeApi, "substitutes", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) => webHandler(request, listScopes))
        .handleRaw("readPool", ({ request }) => webHandler(request, readPool))
        .handleRaw("readEntry", ({ request, params }) =>
          webHandler(request, (webRequest) => readEntry(webRequest, params.applicationId)),
        )
        .handleRaw("activate", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            mutation(webRequest, params.applicationId, "activate"),
          ),
        )
        .handleRaw("edit", ({ request, params }) =>
          webHandler(request, (webRequest) => mutation(webRequest, params.applicationId, "edit")),
        )
        .handleRaw("deactivate", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            mutation(webRequest, params.applicationId, "deactivate"),
          ),
        ),
    ),
  );
};
