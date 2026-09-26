import { Database } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  Admissions,
  admissionOutcomePermission,
  onCallSubstitutes,
  type AdmissionOutcomeEntry,
  type AdmissionOutcomeOperationFailure,
} from "@vektorprogrammet/domain/admissions";
import { Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { OrganizationPersistenceError } from "@vektorprogrammet/domain/organization";
import {
  AdmissionOutcomeBoardResource,
  AdmissionOutcomeResource,
  ExternalNativeApi,
  ListAdmissionOutcomeScopesEndpoint,
  ReadAdmissionOutcomeEndpoint,
  ReadAdmissionOutcomesEndpoint,
  RecordAdmissionOutcomeEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, type Schema } from "effect";
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
  jsonText,
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

const outcomeResource = (entry: AdmissionOutcomeEntry) => ({
  ...entry,
  etag: deriveStrongETag({
    representationKind: "AdmissionOutcomeResource",
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
 * The one answer for every admission outcome and person-authority failure. A person
 * credential rejected inside the transaction is answered from the request's evidence.
 */
const outcomeProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | AdmissionOutcomeOperationFailure
    | UnauthenticatedActor
    | IdentityEngineError
    | OrganizationResolutionError
  >()({
    AdmissionOutcomeFailure: (failure) => Problem.make(failure.code),
    AdmissionOutcomePersistenceError: (failure) => Problem.make(failure.code),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: persistenceProblem,
  });

type Endpoint =
  | typeof ListAdmissionOutcomeScopesEndpoint
  | typeof ReadAdmissionOutcomesEndpoint
  | typeof ReadAdmissionOutcomeEndpoint
  | typeof RecordAdmissionOutcomeEndpoint;

/**
 * Grants the department's admission outcome permission, then evaluates the declared AccessSpec.
 */
const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: AdmissionOutcomeEntry["departmentId"],
  decide: boolean,
  auth: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const permission = admissionOutcomePermission(auth.authority, departmentId);

    if (permission === "Denied" || (decide && permission !== "Decide"))
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

export const AdmissionOutcomesApiHandlers = (input: { now?: () => string }) => {
  const personAuthority = (request: Request) =>
    resolveRequestPersonAuthorityInTransaction(request, { now: input.now });

  /**
   * Runs one read in a REPEATABLE READ snapshot, which resolves the credential
   * and authority on the same connection, and answers its failures.
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
      outcomeProblems(personPresentation(request)),
    );

  const listScopes = (request: Request) =>
    snapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const auth = yield* personAuthority(request);

        const scopes = yield* Admissions.use((admissions) =>
          admissions.listAdmissionOutcomeScopes(auth.authority),
        );

        for (const department of scopes.departments)
          yield* authorize(
            request,
            ListAdmissionOutcomeScopesEndpoint,
            department.departmentId,
            false,
            auth,
          );

        return json(yield* strictOutput(AdmissionOutcomeScopes)(scopes));
      }),
    );

  const readOutcomes = (request: Request) =>
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

        const scope = yield* decodeRequest(AdmissionOutcomeScope)(Object.fromEntries(parameters));
        const auth = yield* personAuthority(request);

        const permission = yield* authorize(
          request,
          ReadAdmissionOutcomesEndpoint,
          scope.departmentId,
          false,
          auth,
        );

        const { admissionPeriodId, entries } = yield* Admissions.use((admissions) =>
          admissions.readAdmissionOutcomes(scope),
        );

        return json(
          yield* strictOutput(AdmissionOutcomeBoardResource)(
            permission === "Decide"
              ? AdmissionOutcomeBoardResource.cases.Decide.make({
                  ...scope,
                  admissionPeriodId,
                  entries: entries.map(outcomeResource),
                })
              : AdmissionOutcomeBoardResource.cases.ReadOnly.make({
                  ...scope,
                  admissionPeriodId,
                  substitutes: onCallSubstitutes(entries),
                }),
          ),
        );
      }),
    );

  const readOutcome = (request: Request, applicationId: AdmissionOutcomeEntry["applicationId"]) =>
    snapshotRead(
      request,
      Effect.gen(function* () {
        yield* requireNoQuery(request);

        const entry = yield* Admissions.use((admissions) =>
          admissions.readAdmissionOutcome(applicationId),
        );

        const auth = yield* personAuthority(request);
        yield* authorize(request, ReadAdmissionOutcomeEndpoint, entry.departmentId, true, auth);
        const resource = yield* strictOutput(AdmissionOutcomeResource)(outcomeResource(entry));

        return yield* conditionalJson({
          request,
          body: resource,
          etag: resource.etag,
          cacheControl: PRIVATE_NO_STORE,
          contentType: "application/json",
        });
      }),
    );

  const recordOutcome = (request: Request, applicationId: AdmissionOutcomeEntry["applicationId"]) =>
    Effect.gen(function* () {
      yield* requireNoQuery(request);

      const body = yield* readJsonBody(
        request,
        /^application\/json(?:\s*;|$)/u,
        MAX_MUTATION_BYTES,
      );

      const command = yield* decodeRequest(AdmissionOutcomeCommand)(body);
      const ifMatch = yield* requiredIfMatchOf(request);
      const idempotencyKey = yield* idempotencyKeyOf(request);
      const operationId = "admissionOutcomes.recordOutcome";

      // Failures are answered after the executor, which rolls the whole command back on any of them.
      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const selected = yield* Admissions.use((admissions) =>
            admissions.readAdmissionOutcome(applicationId),
          );

          const auth = yield* personAuthority(request);

          yield* authorize(
            request,
            RecordAdmissionOutcomeEndpoint,
            selected.departmentId,
            true,
            auth,
          );

          const identity = yield* httpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/admission-outcomes/{applicationId}:record", {
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
              const changed = yield* Admissions.use((admissions) =>
                admissions.recordAdmissionOutcome(
                  {
                    applicationId,
                    command,
                    actor: auth.authority.personId,
                    now: auth.authorizationInstant,
                  },
                  (current) => requireCurrentETag(outcomeResource(current).etag, ifMatch),
                ),
              );

              const resource = yield* strictOutput(AdmissionOutcomeResource)(
                outcomeResource(changed),
              );

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag: resource.etag },
                bodyBytes: new TextEncoder().encode(yield* jsonText(resource)),
              };
            }),
          };
        }),
      ).pipe(outcomeProblems(personPresentation(request)), commandReceiptProblems);

      return yield* commandOutcomeResponse(outcome);
    });

  return HttpApiBuilder.group(ExternalNativeApi, "admissionOutcomes", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) => webHandler(request, listScopes))
        .handleRaw("readOutcomes", ({ request }) => webHandler(request, readOutcomes))
        .handleRaw("readOutcome", ({ request, params }) =>
          webHandler(request, (webRequest) => readOutcome(webRequest, params.applicationId)),
        )
        .handleRaw("recordOutcome", ({ request, params }) =>
          webHandler(request, (webRequest) => recordOutcome(webRequest, params.applicationId)),
        ),
    ),
  );
};
