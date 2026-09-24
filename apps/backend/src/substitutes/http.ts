import { Scope } from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  SubstituteFailure,
  SubstituteMutation,
  SubstituteScope,
  SubstituteScopes,
  substitutePermission,
  type SubstituteEntry,
} from "@vektorprogrammet/domain/substitutes";
import {
  lockSubstituteApplication,
  mutateSubstitute,
  readSubstituteEntries,
  readSubstituteEntry,
  readSubstitutePeriod,
  readSubstituteScopes,
} from "@vektorprogrammet/database/substitutes";
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
import { flow, Match, Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveStrongETag,
  deriveHttpIdentity,
  normalizeTarget,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  semanticMutationRequest,
  semanticRequestDigest,
  evaluateMutationPrecondition,
  responseCapsule,
  nativeProblemResponse,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { conditionalJsonResponse } from "../recruitment/http.js";

const semantic = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new HttpSemanticFailure("internal.error", 500),
  });

const header = (request: Request, key: string) =>
  request.headers.has(key) ? [request.headers.get(key)!] : [];

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

const json = (body: Schema.Json, etag?: string) => {
  const nativeHeaders = new Headers();
  nativeHeaders.set("content-type", "application/json");
  nativeHeaders.set("cache-control", etag ? "no-store" : "private, no-store");
  nativeHeaders.set("vary", "Origin");

  if (etag) {
    nativeHeaders.set("etag", etag);
  }

  return new Response(JSON.stringify(body), {
    headers: nativeHeaders,
  });
};

const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
  );

const output = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: S["Type"]) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

const noQuery = (request: Request) =>
  semantic(() => {
    if (new URL(request.url).search) throw new HttpSemanticFailure("request.malformed", 400);
  });

type Endpoint =
  | typeof ActivateSubstituteEndpoint
  | typeof EditSubstituteEndpoint
  | typeof DeactivateSubstituteEndpoint
  | typeof ReadSubstituteEndpoint
  | typeof ReadSubstitutePoolEndpoint
  | typeof ListSubstituteScopesEndpoint;

const authorize = (
  request: Request,
  endpoint: Endpoint,
  departmentId: SubstituteEntry["departmentId"],
  manage: boolean,
  now?: () => string,
  captured?: TransactionPersonAuthority,
) =>
  Effect.gen(function* () {
    const auth = captured ?? (yield* resolveRequestPersonAuthorityInTransaction(request, { now }));
    const permission = substitutePermission(auth.authority, departmentId);

    if (permission === "Denied" || (manage && permission !== "Manage"))
      return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
    yield* authorizePersonNativeOperation({
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
    });

    return { ...auth, permission };
  });

const errorResponse = (cause: unknown) => {
  if (cause instanceof HttpSemanticFailure || cause instanceof SubstituteFailure)
    return nativeProblemResponse(cause.code, cause.status);

  const tag =
    (cause === null || Predicate.isObjectOrArray(cause)) && cause !== null && "_tag" in cause
      ? cause._tag
      : "";

  if (tag === "UnauthenticatedActor") return nativeProblemResponse("credential.invalid", 401);

  // SQLSTATE is preserved through the existing shared transaction error wrapper.
  const serialization = (cause: unknown, depth = 0): boolean =>
    depth < 6 &&
    (cause === null || Predicate.isObjectOrArray(cause)) &&
    cause !== null &&
    (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
      ("cause" in cause && serialization(cause.cause, depth + 1)));

  if (serialization(cause)) return nativeProblemResponse("transaction.conflict", 409);

  return nativeProblemResponse("internal.error", 500);
};

export const SubstitutesApiHandlers = (input: { now?: () => string }) => {
  const read = (request: Request, mode: "scopes" | "pool" | "entry", applicationId?: string) =>
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Database.use(
            (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );

          // Snapshot reads use the same canonical credential snapshot and SQL connection.
          if (mode === "scopes") {
            yield* noQuery(request);

            const auth = yield* resolveRequestPersonAuthorityInTransaction(request, {
              now: input.now,
            });

            const scopes = yield* readSubstituteScopes(auth.authority);

            for (const department of scopes.departments)
              yield* authorize(
                request,
                ListSubstituteScopesEndpoint,
                department.departmentId,
                false,
                input.now,
                auth,
              );

            return json(yield* output(SubstituteScopes, scopes));
          }

          if (mode === "pool") {
            const values = yield* semantic(() => {
              const url = new URL(request.url);

              if (
                [...url.searchParams.keys()].some(
                  (key) => !["departmentId", "semesterId"].includes(key),
                ) ||
                [...url.searchParams.keys()].some(
                  (key) => url.searchParams.getAll(key).length !== 1,
                )
              )
                throw new HttpSemanticFailure("request.malformed", 400);

              return Object.fromEntries(url.searchParams);
            });

            const scope = yield* decode(SubstituteScope)(values);

            const auth = yield* authorize(
              request,
              ReadSubstitutePoolEndpoint,
              scope.departmentId,
              false,
              input.now,
            );

            const admissionPeriodId = yield* readSubstitutePeriod(scope);
            const rows = admissionPeriodId === null ? [] : yield* readSubstituteEntries(scope);
            const entries = rows.flatMap((row) => (row.active ? [substituteResource(row)] : []));

            return json(
              yield* output(
                SubstituteBoard,
                auth.permission === "Manage"
                  ? SubstituteBoard.cases.Manage.make({
                      ...scope,
                      admissionPeriodId,
                      entries,
                      candidates: rows.flatMap((row) =>
                        !row.active ? [substituteResource(row)] : [],
                      ),
                    })
                  : SubstituteBoard.cases.ReadOnly.make({ ...scope, admissionPeriodId, entries }),
              ),
            );
          }

          yield* noQuery(request);
          const entry = yield* readSubstituteEntry(applicationId!);

          const auth = yield* authorize(
            request,
            ReadSubstituteEndpoint,
            entry.departmentId,
            false,
            input.now,
          );

          if (!entry.active && auth.permission !== "Manage")
            return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
          const resource = yield* output(SubstituteResource, substituteResource(entry));

          return yield* conditionalJsonResponse(request, resource, resource.etag);
        }),
      ),
    );

  const mutation = (
    request: Request,
    applicationId: string,
    action: "activate" | "edit" | "deactivate",
  ) =>
    Effect.gen(function* () {
      yield* noQuery(request);

      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
      const body = yield* readBoundedJson(request, 8192);

      if (action === "deactivate") yield* decode(Schema.Struct({}))(body);

      const command =
        action === "deactivate"
          ? ({ action } as const)
          : { action, input: yield* decode(SubstituteMutation)(body) };

      const ifMatch = yield* semantic(() => parseRequiredIfMatch(header(request, "if-match")));
      const key = yield* semantic(() => parseIdempotencyKey(header(request, "idempotency-key")));

      const endpoint = Match.value(action).pipe(
        Match.when("activate", () => ActivateSubstituteEndpoint),
        Match.when("edit", () => EditSubstituteEndpoint),
        Match.orElse(() => DeactivateSubstituteEndpoint),
      );

      const operationId = `substitutes.${action}`;

      const outcome = yield* executeNativeHttpCommandPostgres(
        Effect.gen(function* () {
          const selected = yield* readSubstituteEntry(applicationId);
          const auth = yield* authorize(request, endpoint, selected.departmentId, true, input.now);

          const identity = yield* semantic(() =>
            deriveHttpIdentity({
              credentialSubject: `Person:${auth.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: normalizeTarget(`/api/substitutes/{applicationId}:${action}`, {
                applicationId,
              }),
              idempotencyKey: key,
            }),
          );

          return {
            identity: {
              identitySha256: identity.identitySha256,
              requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
              operationId,
            },
            execute: Effect.gen(function* () {
              yield* lockSubstituteApplication(applicationId);
              const current = yield* readSubstituteEntry(applicationId);

              const precondition = evaluateMutationPrecondition(
                substituteResource(current).etag,
                ifMatch,
              );

              if (Predicate.isTagged(precondition, "Failed"))
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              const changed = yield* mutateSubstitute(current, command);

              const resource = yield* Schema.decodeUnknownEffect(SubstituteResource)(
                substituteResource(changed),
                { onExcessProperty: "error" },
              ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

              return yield* Effect.tryPromise({
                try: () => responseCapsule(json(resource, resource.etag)),
                catch: (cause) =>
                  cause instanceof HttpSemanticFailure
                    ? cause
                    : new HttpSemanticFailure("internal.error", 500),
              });
            }),
          };
        }),
      );

      return nativeCommandOutcomeResponse(outcome);
    });

  return HttpApiBuilder.group(ExternalNativeApi, "substitutes", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "scopes"), errorResponse),
        )
        .handleRaw("readPool", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => read(webRequest, "pool"), errorResponse),
        )
        .handleRaw("readEntry", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => read(webRequest, "entry", params.applicationId),
            errorResponse,
          ),
        )
        .handleRaw("activate", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => mutation(webRequest, params.applicationId, "activate"),
            errorResponse,
          ),
        )
        .handleRaw("edit", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => mutation(webRequest, params.applicationId, "edit"),
            errorResponse,
          ),
        )
        .handleRaw("deactivate", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => mutation(webRequest, params.applicationId, "deactivate"),
            errorResponse,
          ),
        ),
    ),
  );
};
