import { Database } from "@vektorprogrammet/domain/database";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import {
  SubstituteFailure,
  SubstituteMutation,
  SubstituteScope,
  lockSubstituteApplication,
  mutateSubstitute,
  readSubstituteEntries,
  readSubstituteEntry,
  readSubstitutePeriod,
  readSubstituteScopes,
  substitutePermission,
  type SubstituteEntry,
} from "@vektorprogrammet/domain/substitutes";
import {
  ExternalNativeApi,
  ActivateSubstituteEndpoint,
  EditSubstituteEndpoint,
  DeactivateSubstituteEndpoint,
  ReadSubstituteEndpoint,
  ReadSubstitutePoolEndpoint,
  ListSubstituteScopesEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
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
  withNativeHttpRuntime,
  prepareNativeHttpCommand,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { conditionalJsonResponse } from "../recruitment/http.js";
import type { BackendRun } from "../router.js";

type BackendRequirements =
  Parameters<BackendRun>[0] extends Effect.Effect<unknown, unknown, infer R> ? R : never;
const header = (request: Request, key: string) =>
  request.headers.has(key) ? [request.headers.get(key)!] : [];
export const substituteResource = (entry: SubstituteEntry) => ({
  ...entry,
  etag: deriveStrongETag({
    representationKind: "SubstituteResource",
    resourceIdentity: entry.applicationId,
    version: JSON.stringify(entry),
  }),
});
const json = (body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": etag ? "no-store" : "private, no-store",
      vary: "Origin",
      ...(etag ? { etag } : {}),
    },
  });
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: BackendRun,
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)),
    ),
  );
const noQuery = (request: Request) => {
  if (new URL(request.url).search) throw new HttpSemanticFailure("request.malformed", 400);
};
type Endpoint =
  | typeof ActivateSubstituteEndpoint
  | typeof EditSubstituteEndpoint
  | typeof DeactivateSubstituteEndpoint
  | typeof ReadSubstituteEndpoint
  | typeof ReadSubstitutePoolEndpoint
  | typeof ListSubstituteScopesEndpoint;
const authorize = async (
  request: Request,
  run: BackendRun,
  endpoint: Endpoint,
  departmentId: SubstituteEntry["departmentId"],
  manage: boolean,
  now?: () => string,
) => {
  const auth = await resolveRequestPersonAuthorityInTransaction(request, { run, now });
  const permission = substitutePermission(auth.authority, departmentId);
  if (permission === "Denied" || (manage && permission !== "Manage"))
    throw new HttpSemanticFailure("authority.denied", 403);
  await authorizePersonNativeOperation({
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
    grantScopes: [{ _tag: "Department", departmentId }],
    now: auth.authorizationInstant,
    run,
  });
  return { ...auth, permission };
};
const errorResponse = (cause: unknown) => {
  if (cause instanceof HttpSemanticFailure || cause instanceof SubstituteFailure)
    return nativeProblemResponse(cause.code, cause.status);
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : "";
  if (tag === "UnauthenticatedActor") return nativeProblemResponse("credential.invalid", 401);
  // SQLSTATE is preserved through the existing shared transaction error wrapper.
  const serialization = (value: unknown, depth = 0): boolean =>
    depth < 6 &&
    typeof value === "object" &&
    value !== null &&
    (("code" in value && (value.code === "40001" || value.code === "40P01")) ||
      ("cause" in value && serialization(value.cause, depth + 1)));
  if (serialization(cause)) return nativeProblemResponse("transaction.conflict", 409);
  return nativeProblemResponse("internal.error", 500);
};
export const SubstitutesApiHandlers = (input: { run: BackendRun; now?: () => string }) => {
  const read = (request: Request, mode: "scopes" | "pool" | "entry", applicationId?: string) =>
    input.run(
      Database.use((sql) =>
        sql.withTransaction(
          withNativeHttpRuntime(input.run, async (run) => {
            // Snapshot reads use the same canonical credential snapshot and SQL connection.
            if (mode === "scopes") {
              noQuery(request);
              const auth = await resolveRequestPersonAuthorityInTransaction(request, {
                run,
                now: input.now,
              });
              const scopes = await run(readSubstituteScopes(auth.authority));
              await authorize(
                request,
                run,
                ListSubstituteScopesEndpoint,
                scopes.departments[0]!.departmentId,
                false,
                input.now,
              );
              return json(scopes);
            }
            if (mode === "pool") {
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
              const scope = await decode(
                SubstituteScope,
                Object.fromEntries(url.searchParams),
                run,
              );
              const auth = await authorize(
                request,
                run,
                ReadSubstitutePoolEndpoint,
                scope.departmentId,
                false,
                input.now,
              );
              const admissionPeriodId = await run(readSubstitutePeriod(scope));
              const rows =
                admissionPeriodId === null ? [] : await run(readSubstituteEntries(scope));
              const entries = rows.filter((row) => row.active).map(substituteResource);
              return json(
                auth.permission === "Manage"
                  ? {
                      _tag: "Manage",
                      ...scope,
                      admissionPeriodId,
                      entries,
                      candidates: rows.filter((row) => !row.active).map(substituteResource),
                    }
                  : { _tag: "ReadOnly", ...scope, admissionPeriodId, entries },
              );
            }
            noQuery(request);
            const entry = await run(readSubstituteEntry(applicationId!));
            const auth = await authorize(
              request,
              run,
              ReadSubstituteEndpoint,
              entry.departmentId,
              false,
              input.now,
            );
            if (!entry.active && auth.permission !== "Manage")
              throw new HttpSemanticFailure("authority.denied", 403);
            const resource = substituteResource(entry);
            return conditionalJsonResponse(request, resource, resource.etag);
          }),
        ),
      ),
    );
  const mutation = async (
    request: Request,
    applicationId: string,
    action: "activate" | "edit" | "deactivate",
  ) => {
    noQuery(request);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new HttpSemanticFailure("media-type.unsupported", 415);
    const body = await readBoundedJson(request, 8192);
    const command =
      action === "deactivate"
        ? (await decode(Schema.Struct({}), body, input.run), { action } as const)
        : { action, input: await decode(SubstituteMutation, body, input.run) };
    const ifMatch = parseRequiredIfMatch(header(request, "if-match"));
    const key = parseIdempotencyKey(header(request, "idempotency-key"));
    const endpoint =
      action === "activate"
        ? ActivateSubstituteEndpoint
        : action === "edit"
          ? EditSubstituteEndpoint
          : DeactivateSubstituteEndpoint;
    const operationId = `substitutes.${action}`;
    const outcome = await input.run(
      executeNativeHttpCommandPostgres<unknown, BackendRequirements>(
        prepareNativeHttpCommand(input.run, async (run) => {
          const selected = await run(readSubstituteEntry(applicationId));
          const auth = await authorize(
            request,
            run,
            endpoint,
            selected.departmentId,
            true,
            input.now,
          );
          const identity = deriveHttpIdentity({
            credentialSubject: `Person:${auth.authority.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget(`/api/substitutes/{applicationId}:${action}`, {
              applicationId,
            }),
            idempotencyKey: key,
          });
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
              if (precondition._tag === "Failed")
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              const changed = yield* mutateSubstitute(current, command);
              const resource = substituteResource(changed);
              return yield* Effect.promise(() => responseCapsule(json(resource, resource.etag)));
            }),
          };
        }),
      ),
    );
    return nativeCommandOutcomeResponse(outcome);
  };
  return HttpApiBuilder.group(ExternalNativeApi, "substitutes", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listScopes", ({ request }) =>
          toHttpApiResponse(request, (r) => read(r, "scopes"), errorResponse),
        )
        .handleRaw("readPool", ({ request }) =>
          toHttpApiResponse(request, (r) => read(r, "pool"), errorResponse),
        )
        .handleRaw("readEntry", ({ request, params }) =>
          toHttpApiResponse(request, (r) => read(r, "entry", params.applicationId), errorResponse),
        )
        .handleRaw("activate", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (r) => mutation(r, params.applicationId, "activate"),
            errorResponse,
          ),
        )
        .handleRaw("edit", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (r) => mutation(r, params.applicationId, "edit"),
            errorResponse,
          ),
        )
        .handleRaw("deactivate", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (r) => mutation(r, params.applicationId, "deactivate"),
            errorResponse,
          ),
        ),
    ),
  );
};
