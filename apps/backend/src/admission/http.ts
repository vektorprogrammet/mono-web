import { type Database } from "@vektorprogrammet/domain/database";
import { Effect, Option, Schema } from "effect";
import {
  InactiveActor,
  UnauthenticatedActor,
  AdmissionPeriodCommandId,
  AdmissionPeriodId,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { PublicApplicationCommandIdSchema } from "@vektorprogrammet/domain/application";
import {
  DepartmentId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodMergePatch,
  CreateAdmissionPeriodEndpoint,
  CreateAdmissionPeriodRequest,
  ExternalNativeApi,
  ListAdmissionPeriodsEndpoint,
  ListOpenAdmissionPeriodsEndpoint,
  ReadApplicationCatalogEndpoint,
  ReadApplicationConfirmationEndpoint,
  ReviseAdmissionPeriodEndpoint,
  SubmitApplicationEndpoint,
  SubmitApplicationRequest,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  admissionActorForDepartment,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  type ETagVersionSource,
  HttpSemanticFailure,
  PRIVATE_NO_STORE,
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  jsonBodyBytes,
  nativeProblemResponse,
  notModifiedResponse,
  parseIdempotencyKey,
  parseIfNoneMatch,
  parseReadIfMatch,
  parseRequiredIfMatch,
  semanticRequestDigest,
  semanticMutationRequest,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
  prepareNativeHttpCommand,
} from "../native-operation.js";
import type { BackendRun } from "../router.js";
import type { AdmissionApiConfig } from "./config.js";

export interface AdmissionApiHttpOptions {
  readonly config: AdmissionApiConfig;
  /**
   * Resolves the session cookie into a department-scoped actor (spec 0055).
   * `departmentScope` carries canonical request state (payload department or
   * the period's immutable department); undefined means global-only scope.
   */
  readonly resolveActor: (
    request: Request,
    departmentScope?: string,
  ) => Promise<AdmissionPeriodActor>;
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

const errorTag = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : "AdmissionPeriodPersistenceError";

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }
  if (cause !== null && typeof cause === "object" && "_tag" in cause) {
    switch (cause._tag) {
      case "NativeHttpReceiptInFlightError":
        return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
      case "NativeHttpReceiptDigestConflictError":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "NativeHttpReceiptExpiredError":
        return nativeProblemResponse("idempotency.response-expired", 409);
      case "NativeHttpReceiptPersistenceError":
        return nativeProblemResponse("idempotency.unavailable", 503);
    }
  }
  const tag = errorTag(cause);
  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "InactiveActor":
    case "AdmissionRoleDenied":
    case "AdmissionScopeDenied":
      return nativeProblemResponse("authority.denied", 403);
    case "AdmissionPeriodNotFound":
      return nativeProblemResponse("admission-period.not-found", 404);
    case "PublicApplicationNotFound":
      return nativeProblemResponse("application.not-found", 404);
    case "RequestBodyTooLarge":
      return nativeProblemResponse("request.too-large", 413);
    case "PublicApplicationRateLimitExceeded":
      return nativeProblemResponse("rate-limit.exceeded", 429, { "retry-after": "60" });
    case "PublicApplicationDecodeError":
    case "AdmissionPeriodDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "FieldOfStudyNotFound":
    case "FieldOfStudyInactive":
    case "FieldOfStudyDepartmentMismatch":
      return nativeProblemResponse("application.invalid-field-of-study", 422);
    case "InvalidAdmissionPeriodWindow":
    case "AdmissionWindowOutsideSemester":
      return nativeProblemResponse("admission-period.invalid-window", 422);
    case "NoEligibleAdmissionPeriod":
      return nativeProblemResponse("application.no-eligible-period", 409);
    case "AmbiguousAdmissionPeriod":
      return nativeProblemResponse("application.ambiguous-period", 409);
    case "DuplicatePublicApplication":
      return nativeProblemResponse("application.duplicate", 409);
    case "AdmissionPeriodAlreadyExists":
      return nativeProblemResponse("admission-period.already-exists", 409);
    case "StaleAdmissionPeriodRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "DuplicatePublicApplicationCommandConflict":
    case "DuplicateAdmissionPeriodCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    default:
      return nativeProblemResponse("admissions.unavailable", 503);
  }
};

const runDatabase = <A, E>(
  effect: Effect.Effect<A, E, Database | Admissions>,
  run: AdmissionApiHttpOptions["run"],
): Promise<A> => run(effect);

const requireActive = (actor: AdmissionPeriodActor): AdmissionPeriodActor => {
  if (!actor.active) throw new InactiveActor({ personId: actor.personId });
  return actor;
};

const actorFor = async (
  request: Request,
  input: AdmissionApiHttpOptions,
  departmentScope?: string,
): Promise<AdmissionPeriodActor> => {
  try {
    return await input.resolveActor(request, departmentScope);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw new UnauthenticatedActor({ message: "authentication required" });
  }
};

const admissionActorForAuthority = (
  authority: OrganizationPersonAuthority,
  departmentScope?: string,
): AdmissionPeriodActor => {
  if (departmentScope !== undefined) {
    return requireActive(
      admissionActorForDepartment(authority, DepartmentId.make(departmentScope)),
    );
  }
  if (authority.globalAdministrator !== "Active") {
    throw authority.globalAdministrator === "Inactive"
      ? new InactiveActor({ personId: authority.personId })
      : new UnauthenticatedActor({ message: "no authority for unscoped management route" });
  }
  return {
    _tag: "GlobalAdmin",
    personId: authority.personId,
    active: true,
  };
};

const requireNoQuery = (request: Request, tag = "AdmissionPeriodDecodeError"): void => {
  if (new URL(request.url).search !== "") {
    throw taggedError(tag);
  }
};

const readBoundedBody = async (
  request: Request,
  maxBytes: number,
  decodeTag: string,
): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw taggedError(decodeTag);
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw taggedError("RequestBodyTooLarge");
    }
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw taggedError("RequestBodyTooLarge");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const decodeJson = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
  tag: string,
): Promise<S["Type"]> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw taggedError(tag);
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, maxBodyBytes, tag)) as unknown;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError(tag);
  }
  try {
    return await Schema.decodeUnknownPromise(schema)(body, { onExcessProperty: "error" });
  } catch {
    throw taggedError(tag);
  }
};

const decodeAdmissionPeriodPatch = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<typeof AdmissionPeriodMergePatch.Type> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/merge-patch\+json(?:\s*;|$)/iu.test(contentType)) {
    throw new HttpSemanticFailure("media-type.unsupported", 415);
  }
  let body: unknown;
  try {
    body = JSON.parse(
      await readBoundedBody(request, input.config.maxBodyBytes, "AdmissionPeriodDecodeError"),
    ) as unknown;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  const patch = await Schema.decodeUnknownPromise(AdmissionPeriodMergePatch)(body, {
    onExcessProperty: "error",
  }).catch(() => {
    throw new HttpSemanticFailure("validation.failed", 422);
  });
  if (!Object.hasOwn(patch, "startAt") && !Object.hasOwn(patch, "endAt")) {
    throw new HttpSemanticFailure("validation.no-change", 422);
  }
  if (patch.startAt === null || patch.endAt === null) {
    throw new HttpSemanticFailure("validation.field-not-deletable", 422);
  }
  return patch;
};

const conditionalJsonResponse = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly representationKind: string;
  readonly version: ETagVersionSource;
  readonly cacheControl: string;
}): Response => {
  const etag = deriveStrongETag({
    representationKind: input.representationKind,
    resourceIdentity: "collection",
    version: input.version,
  });
  const decision = evaluateReadPreconditions({
    currentETag: etag,
    ifMatch: parseReadIfMatch(
      input.request.headers.get("if-match") === null
        ? []
        : [input.request.headers.get("if-match")!],
    ),
    ifNoneMatch: parseIfNoneMatch(
      input.request.headers.get("if-none-match") === null
        ? []
        : [input.request.headers.get("if-none-match")!],
    ),
  });
  if (decision._tag === "Failed") {
    return nativeProblemResponse(decision.code, decision.status);
  }
  if (decision._tag === "NotModified") {
    return notModifiedResponse({
      etag,
      cacheControl: input.cacheControl,
      vary: "Origin",
    });
  }
  return new Response(JSON.stringify(input.body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": input.cacheControl,
      etag,
      vary: "Origin",
    },
  });
};

const dynamicAdmissionCache = (now: string, boundaries: ReadonlyArray<string>): string => {
  const nowMillis = Date.parse(now);
  const next = boundaries
    .map(Date.parse)
    .filter((boundary) => Number.isFinite(boundary) && boundary >= nowMillis)
    .sort((left, right) => left - right)[0];
  const ttl =
    next === undefined ? 30 : Math.max(0, Math.min(30, Math.floor((next - nowMillis) / 1_000)));
  return `public, max-age=${ttl}, s-maxage=${ttl}, must-revalidate`;
};

const admissionGrantScopes = (actor: AdmissionPeriodActor) =>
  actor._tag === "GlobalAdmin"
    ? ([{ _tag: "Global" }] as const)
    : actor._tag === "DepartmentLeader"
      ? ([{ _tag: "Department", departmentId: actor.departmentId }] as const)
      : [];

const listManagement = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request);
  const actor = requireActive(await actorFor(request, input));
  const now = input.config.now();
  await authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ListAdmissionPeriodsEndpoint)),
    request,
    personId: actor.personId,
    resolution: {
      selection: "AllMatching",
      contexts: [
        genericContext({
          domainId: "admissions",
          departmentId: actor._tag === "DepartmentLeader" ? actor.departmentId : null,
          authorityVersion: `admissions:${actor._tag}`,
        }),
      ],
    },
    grantScopes: admissionGrantScopes(actor),
    now,
    run: input.run as never,
  });
  const rows = await runDatabase(
    Admissions.use(({ listAdmissionPeriodsForManagement }) =>
      listAdmissionPeriodsForManagement({ actor, now }),
    ),
    input.run,
  );
  const items = rows.map((row) => ({
    id: row.id,
    departmentId: row.departmentId,
    semesterId: row.semesterId,
    startAt: row.startAt,
    endAt: row.endAt,
    revision: row.revision,
    etag: deriveStrongETag({
      representationKind: "AdmissionPeriodManagementItem",
      resourceIdentity: row.id,
      version: row.revision,
    }),
  }));
  const body = await Schema.decodeUnknownPromise(
    Schema.Struct({ items: Schema.Array(AdmissionPeriodManagementItem), totalItems: Schema.Int }),
  )({ items, totalItems: items.length }, { onExcessProperty: "error" });
  return conditionalJsonResponse({
    request,
    body,
    representationKind: "AdmissionPeriodManagementListResponse",
    version: rows.map((row) => [row.id, row.revision] as const),
    cacheControl: PRIVATE_NO_STORE,
  });
};

const create = async (request: Request, input: AdmissionApiHttpOptions): Promise<Response> => {
  requireNoQuery(request);
  const payload = await decodeJson(
    request,
    CreateAdmissionPeriodRequest,
    input.config.maxBodyBytes,
    "AdmissionPeriodDecodeError",
  );
  const admissionPeriodId = input.config.nextAdmissionPeriodId();
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key") === null
      ? []
      : [request.headers.get("idempotency-key")!],
  );
  const operationId = "admissions.createAdmissionPeriod";
  const result = await input.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(input.run, async (txRun) => {
        const authorization = await resolveRequestPersonAuthorityInTransaction(request, {
          run: txRun,
          now: input.config.now,
        });
        const actor = admissionActorForAuthority(
          authorization.authority,
          payload.departmentId,
        );
        const now = authorization.authorizationInstant;
        await authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(CreateAdmissionPeriodEndpoint)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId:
                  actor._tag === "DepartmentLeader"
                    ? actor.departmentId
                    : (payload.departmentId ?? null),
                resourceKind: "admission-period",
                resourceId: admissionPeriodId,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes:
            actor._tag === "GlobalAdmin"
              ? [{ _tag: "Global" }]
              : actor._tag === "DepartmentLeader"
                ? [{ _tag: "Department", departmentId: actor.departmentId }]
                : [],
          now,
          run: txRun,
        });
        const derived = deriveHttpIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/admission-periods",
          idempotencyKey,
        });
        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const created = yield* admissions.executeAdmissionPeriod(
                {
                  _tag: "CreateAdmissionPeriod",
                  commandId: AdmissionPeriodCommandId.make(derived.commandId),
                  ...payload,
                },
                { actor, now, admissionPeriodId },
              );
              const period = created.period;
              const etag = deriveStrongETag({
                representationKind: "AdmissionPeriodManagementItem",
                resourceIdentity: period.id,
                version: period.revision,
              });
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/admission-periods/${encodePathIdentity(period.id)}`,
                  etag,
                },
                bodyBytes: jsonBodyBytes({
                  id: period.id,
                  departmentId: period.departmentId,
                  semesterId: period.semesterId,
                  startAt: period.startAt,
                  endAt: period.endAt,
                  revision: period.revision,
                  etag,
                }),
              };
            }),
          ),
        };
      }),
    ),
  );
  return nativeCommandOutcomeResponse(result);
};

const revise = async (
  request: Request,
  admissionPeriodId: string,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request);
  const typedAdmissionPeriodId = AdmissionPeriodId.make(admissionPeriodId);
  const ifMatch = parseRequiredIfMatch(
    request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
  );
  const patch = await decodeAdmissionPeriodPatch(request, input);
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key") === null
      ? []
      : [request.headers.get("idempotency-key")!],
  );
  const normalizedTarget = `/api/admission-periods/${encodePathIdentity(typedAdmissionPeriodId)}`;
  const operationId = "admissions.reviseAdmissionPeriod";
  const result = await input.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(input.run, async (txRun) => {
        const authorization = await resolveRequestPersonAuthorityInTransaction(request, {
          run: txRun,
          now: input.config.now,
        });
        const actor = admissionActorForAuthority(authorization.authority);
        const now = authorization.authorizationInstant;
        const periods = await runDatabase(
          Admissions.use(({ listAdmissionPeriodsForManagement }) =>
            listAdmissionPeriodsForManagement({ actor, now }),
          ),
          txRun,
        );
        const current = periods.find((period) => period.id === typedAdmissionPeriodId);
        if (current === undefined) throw taggedError("AdmissionPeriodNotFound");
        await authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(ReviseAdmissionPeriodEndpoint)),
          credential: authorization.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                departmentId: current.departmentId,
                resourceKind: "admission-period",
                resourceId: current.id,
                authorityVersion: `admissions:${actor._tag}`,
              }),
            ],
          },
          grantScopes: admissionGrantScopes(actor),
          now,
          run: txRun,
        });
        const currentETag = deriveStrongETag({
          representationKind: "AdmissionPeriodManagementItem",
          resourceIdentity: current.id,
          version: current.revision,
        });
        const precondition = evaluateMutationPrecondition(currentETag, ifMatch);
        if (precondition._tag === "Failed") {
          throw new HttpSemanticFailure(precondition.code, precondition.status);
        }
        const derived = deriveHttpIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget,
          idempotencyKey,
        });
        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const revised = yield* admissions.executeAdmissionPeriod(
                {
                  _tag: "ReviseAdmissionPeriod",
                  commandId: AdmissionPeriodCommandId.make(derived.commandId),
                  admissionPeriodId: typedAdmissionPeriodId,
                  expectedRevision: current.revision,
                  startAt: patch.startAt ?? current.startAt,
                  endAt: patch.endAt ?? current.endAt,
                },
                { actor, now, admissionPeriodId: typedAdmissionPeriodId },
              );
              const period = revised.period;
              const etag = deriveStrongETag({
                representationKind: "AdmissionPeriodManagementItem",
                resourceIdentity: period.id,
                version: period.revision,
              });
              const body = {
                id: period.id,
                departmentId: period.departmentId,
                semesterId: period.semesterId,
                startAt: period.startAt,
                endAt: period.endAt,
                revision: period.revision,
                etag,
              };
              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag },
                bodyBytes: jsonBodyBytes(body),
              };
            }),
          ),
        };
      }),
    ),
  );
  return nativeCommandOutcomeResponse(result);
};

const listOpen = async (request: Request, input: AdmissionApiHttpOptions): Promise<Response> => {
  requireNoQuery(request);
  const now = input.config.now();
  await authorizeAnonymousNativeOperation(
    Option.getOrThrow(reflectAccessSpec(ListOpenAdmissionPeriodsEndpoint)),
    {
      selection: "AllMatching",
      contexts: [
        genericContext({
          domainId: "admissions",
          authorityVersion: `admissions-open:${now}`,
        }),
      ],
    },
    now,
    input.run as never,
  );
  const rows = await runDatabase(
    Admissions.use(({ listOpenAdmissionPeriods }) => listOpenAdmissionPeriods(now)),
    input.run,
  );
  const body = {
    items: rows.map((row) => ({
      id: row.id,
      departmentId: row.departmentId,
      semesterId: row.semesterId,
      startAt: row.startAt,
      endAt: row.endAt,
    })),
    totalItems: rows.length,
  };
  return conditionalJsonResponse({
    request,
    body,
    representationKind: "OpenAdmissionPeriodListResponse",
    version: rows.map((row) => [row.id, row.revision] as const),
    cacheControl: dynamicAdmissionCache(
      now,
      rows.flatMap((row) => [row.startAt, row.endAt]),
    ),
  });
};

/**
 * The Fetch Request does not expose a verified peer address. Treat all public
 * callers as one trust boundary instead of trusting spoofable forwarding headers.
 */
const publicRateLimitKey = (_request: Request): string => "public";

const listPublicCatalog = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  const now = input.config.now();
  await authorizeAnonymousNativeOperation(
    Option.getOrThrow(reflectAccessSpec(ReadApplicationCatalogEndpoint)),
    {
      selection: "AllMatching",
      contexts: [
        genericContext({
          domainId: "admissions",
          authorityVersion: `admissions-catalog:${now}`,
        }),
      ],
    },
    now,
    input.run as never,
  );
  const source = await runDatabase(
    Admissions.use(({ listPublicApplicationCatalog }) => listPublicApplicationCatalog({ now })),
    input.run,
  );
  return conditionalJsonResponse({
    request,
    body: source.catalog,
    representationKind: "PublicApplicationCatalog",
    version: {
      intervalIdentity: source.validatorSource.intervalIdentity,
      itemRevisions: source.validatorSource.itemRevisions,
    },
    cacheControl: dynamicAdmissionCache(
      now,
      source.catalog.departments.map((department) => department.closesAt),
    ),
  });
};

const submitApplication = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  const now = input.config.now();
  if (!input.config.rateLimit.consume(publicRateLimitKey(request), now)) {
    throw taggedError("PublicApplicationRateLimitExceeded");
  }
  const payload = await decodeJson(
    request,
    SubmitApplicationRequest,
    input.config.maxBodyBytes,
    "PublicApplicationDecodeError",
  );
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key") === null
      ? []
      : [request.headers.get("idempotency-key")!],
  );
  const operationId = "admissions.submitApplication";
  const result = await input.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(input.run, async (txRun) => {
        await authorizeAnonymousNativeOperation(
          Option.getOrThrow(reflectAccessSpec(SubmitApplicationEndpoint)),
          {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                authorityVersion: `admissions-application-create:${now}`,
              }),
            ],
          },
          now,
          txRun,
        );
        const derived = deriveHttpIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: "/api/applications",
          idempotencyKey,
        });
        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Admissions.use((admissions) =>
            Effect.gen(function* () {
              const submitted = yield* admissions.executePublicApplication(
                {
                  commandId: PublicApplicationCommandIdSchema.make(derived.commandId),
                  ...payload,
                },
                {
                  now,
                  applicationId: input.config.nextApplicationId(),
                  applicantId: input.config.nextApplicantId(),
                  activationToken: input.config.nextActivationToken(),
                },
              );
              const confirmation = {
                _tag: "ApplicationConfirmed" as const,
                applicationId: submitted.observation.applicationId,
              };
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/applications/${encodePathIdentity(confirmation.applicationId)}`,
                  etag: deriveStrongETag({
                    representationKind: "PublicApplicationConfirmation",
                    resourceIdentity: confirmation.applicationId,
                    version: 0,
                  }),
                },
                bodyBytes: jsonBodyBytes(confirmation),
              };
            }),
          ),
        };
      }),
    ),
  );
  return nativeCommandOutcomeResponse(result);
};

const publicConfirmation = async (
  request: Request,
  applicationId: string,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  const now = input.config.now();
  await authorizeAnonymousNativeOperation(
    Option.getOrThrow(reflectAccessSpec(ReadApplicationConfirmationEndpoint)),
    {
      selection: "ExactlyOne",
      contexts: [
        genericContext({
          domainId: "admissions",
          resourceKind: "application",
          resourceId: applicationId,
          authorityVersion: `admissions-application:${applicationId}`,
        }),
      ],
    },
    now,
    input.run as never,
  );
  const confirmation = await runDatabase(
    Admissions.use(({ findPublicApplicationConfirmation }) =>
      findPublicApplicationConfirmation(applicationId),
    ),
    input.run,
  );
  return jsonResponse(confirmation);
};

/** Native HttpApi implementations for admission and public application endpoints. */
export const AdmissionsApiHandlers = (input: AdmissionApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "admissions", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listManagement(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("createAdmissionPeriod", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => create(webRequest, input), errorResponse),
        )
        .handleRaw("reviseAdmissionPeriod", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => revise(webRequest, params.admissionPeriodId, input),
            errorResponse,
          ),
        )
        .handleRaw("listOpenAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => listOpen(webRequest, input), errorResponse),
        )
        .handleRaw("listApplicationOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listPublicCatalog(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("submitApplication", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submitApplication(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("readApplicationConfirmation", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => publicConfirmation(webRequest, params.applicationId, input),
            errorResponse,
          ),
        ),
    ),
  );
