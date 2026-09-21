import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Database } from "@vektorprogrammet/database";
import { Effect, Option, Schema } from "effect";
import {
  InactiveActor,
  UnauthenticatedActor,
  AdmissionPeriodCommandId,
  AdmissionPeriodId,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import {
  ApplicantProgressResponseSchema,
  ReturningAssistants,
  ReturningAssistantOptionsSchema,
  ReturningAssistantRegistrationInputSchema,
  ReturningCommandIdSchema,
  PublicApplicationCommandIdSchema,
} from "@vektorprogrammet/domain/application";
import { ResourceId, ResourceKind } from "@vektorprogrammet/domain/authz";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  type Organization,
} from "@vektorprogrammet/domain/organization";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  CreateAdmissionPeriodEndpoint,
  CreateAdmissionPeriodRequest,
  ExternalNativeApi,
  ListAdmissionPeriodsEndpoint,
  ListOpenAdmissionPeriodsEndpoint,
  ReadApplicantProgressEndpoint,
  ReadApplicationCatalogEndpoint,
  ReadApplicationConfirmationEndpoint,
  ReadReturningAssistantOptionsEndpoint,
  RegisterReturningAssistantEndpoint,
  ReviseAdmissionPeriodEndpoint,
  SubmitApplicationEndpoint,
  SubmitApplicationRequest,
  AdmissionPeriodMergePatch,
  AdmissionPeriodManagementItem,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  admissionActorForDepartment,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
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
} from "../native-operation.js";
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
  ) => Effect.Effect<
    AdmissionPeriodActor,
    | IdentityEngineError
    | UnauthenticatedActor
    | InactiveActor
    | OrganizationResolutionError
    | TaggedHttpError,
    Identity | OAuthCredentialAuthority | Organization
  >;
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
    case "ReturningAssistantDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "ReturningAssistantUnauthenticated":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "ReturningAssistantIdentityMissing":
      return nativeProblemResponse("returning.identity-missing", 404);
    case "ReturningAssistantHistoryMissing":
      return nativeProblemResponse("returning.history-missing", 404);
    case "ReturningAssistantIdentityAmbiguous":
      return nativeProblemResponse("returning.identity-ambiguous", 409);
    case "ReturningAssistantStudyMappingInvalid":
      return nativeProblemResponse("returning.study-invalid", 409);
    case "ReturningAssistantPeriodUnavailable":
      return nativeProblemResponse("returning.period-unavailable", 409);
    case "ReturningAssistantTeamScopeDenied":
      return nativeProblemResponse("returning.team-scope-denied", 403);
    case "ReturningAssistantDuplicate":
      return nativeProblemResponse("returning.period-unavailable", 409);
    case "ReturningAssistantRevisionConflict":
      return nativeProblemResponse("returning.revision-conflict", 412);
    case "ReturningAssistantCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "ReturningAssistantPersistenceError":
      return nativeProblemResponse("returning.unavailable", 503);
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

const returningPersonResource = (personId: string) => ({
  _tag: "Resource" as const,
  resource: {
    kind: ResourceKind.make("person-profile"),
    id: ResourceId.make(personId),
  },
});

const returningAuthorization = (
  request: Request,
  input: AdmissionApiHttpOptions,
  endpoint:
    | typeof ReadReturningAssistantOptionsEndpoint
    | typeof RegisterReturningAssistantEndpoint,
) =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });
    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: authorization.credential,
      personId: authorization.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "admissions",
            resourceKind: "person-profile",
            resourceId: authorization.authority.personId,
            facts: { ownerPersonId: authorization.authority.personId },
            authorityVersion: "admissions:returning-assistant",
          }),
        ],
      },
      grantScopes: [returningPersonResource(authorization.authority.personId)],
      now: authorization.authorizationInstant,
    });
    return authorization;
  });

const readReturningAssistantOptions = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const authorization = yield* returningAuthorization(
      request,
      input,
      ReadReturningAssistantOptionsEndpoint,
    );
    const options = yield* ReturningAssistants.use(({ readOptions }) =>
      readOptions({
        personId: authorization.authority.personId,
        now: authorization.authorizationInstant,
      }),
    );
    const body = yield* Schema.decodeUnknownEffect(ReturningAssistantOptionsSchema)(options, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("ReturningAssistantDecodeError")));
    return jsonResponse(body);
  });

const registerReturningAssistant = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }
    const payload = yield* decodeJson(
      request,
      ReturningAssistantRegistrationInputSchema,
      input.config.maxBodyBytes,
      "ReturningAssistantDecodeError",
    );
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "admissions.registerReturningAssistant";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* returningAuthorization(
          request,
          input,
          RegisterReturningAssistantEndpoint,
        );
        yield* ReturningAssistants.use(({ preflight }) =>
          preflight(
            {
              admissionPeriodId: payload.admissionPeriodId,
              teamIds: payload.teamIds,
            },
            {
              personId: authorization.authority.personId,
              now: input.config.now,
            },
          ),
        );
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${authorization.authority.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/returning-assistant/registrations",
              idempotencyKey,
            }),
          catch: (cause) => cause,
        });
        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: ReturningAssistants.use((returning) =>
            Effect.gen(function* () {
              const registered = yield* returning.register(
                {
                  ...payload,
                  commandId: ReturningCommandIdSchema.make(derived.commandId),
                },
                {
                  personId: authorization.authority.personId,
                  now: input.config.now,
                },
              );
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/returning-assistant/registrations/${encodePathIdentity(registered.observation.registrationId)}`,
                  etag: deriveStrongETag({
                    representationKind: "ReturningAssistantRegistration",
                    resourceIdentity: registered.observation.registrationId,
                    version: registered.observation.revision,
                  }),
                },
                bodyBytes: jsonBodyBytes(registered),
              };
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    );
    return nativeCommandOutcomeResponse(result);
  });

const requireActive = (actor: AdmissionPeriodActor) =>
  actor.active
    ? Effect.succeed(actor)
    : Effect.fail(new InactiveActor({ personId: actor.personId }));

const actorFor = (
  request: Request,
  input: AdmissionApiHttpOptions,
  departmentScope?: string,
) =>
  input.resolveActor(request, departmentScope).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        cause !== null && typeof cause === "object" && "_tag" in cause
          ? cause
          : new UnauthenticatedActor({ message: "authentication required" }),
      ),
    ),
  );

const admissionActorForAuthority = (
  authority: OrganizationPersonAuthority,
  departmentScope?: string,
) =>
  Effect.try({
    try: () => {
      if (departmentScope !== undefined) {
        return admissionActorForDepartment(authority, DepartmentId.make(departmentScope));
      }
      if (authority.globalAdministrator !== "Active") {
        throw authority.globalAdministrator === "Inactive"
          ? new InactiveActor({ personId: authority.personId })
          : new UnauthenticatedActor({ message: "no authority for unscoped management route" });
      }
      return {
        _tag: "GlobalAdmin" as const,
        personId: authority.personId,
        active: true,
      };
    },
    catch: (cause) => cause,
  }).pipe(Effect.flatMap(requireActive));

const requireNoQuery = (request: Request, tag = "AdmissionPeriodDecodeError") =>
  new URL(request.url).search === "" ? Effect.void : Effect.fail(taggedError(tag));

const boundedJsonWithTag = (request: Request, maxBytes: number, tag: string) =>
  readBoundedJson(request, maxBytes).pipe(
    Effect.mapError((cause) =>
      cause instanceof HttpSemanticFailure && cause.code === "request.too-large"
        ? taggedError("RequestBodyTooLarge")
        : taggedError(tag),
    ),
  );

const decodeJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
  tag: string,
): Effect.Effect<S["Type"], TaggedHttpError> =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(taggedError(tag));
    }
    const body = yield* boundedJsonWithTag(request, maxBodyBytes, tag);
    return yield* Schema.decodeUnknownEffect(schema)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError(tag)));
  });

const decodeAdmissionPeriodPatch = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/merge-patch\+json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }
    const body = yield* readBoundedJson(request, input.config.maxBodyBytes).pipe(
      Effect.mapError((cause) =>
        cause instanceof HttpSemanticFailure && cause.code === "request.too-large"
          ? taggedError("RequestBodyTooLarge")
          : new HttpSemanticFailure("request.malformed", 400),
      ),
    );
    const patch = yield* Schema.decodeUnknownEffect(AdmissionPeriodMergePatch)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));
    if (!Object.hasOwn(patch, "startAt") && !Object.hasOwn(patch, "endAt")) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.no-change", 422));
    }
    if (patch.startAt === null || patch.endAt === null) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.field-not-deletable", 422));
    }
    return patch;
  });

const conditionalJsonResponse = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly representationKind: string;
  readonly version: ETagVersionSource;
  readonly cacheControl: string;
}) =>
  Effect.try({
    try: () => {
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
    },
    catch: (cause) => cause,
  });

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

const listManagement = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const actor = yield* actorFor(request, input).pipe(Effect.flatMap(requireActive));
    const now = input.config.now();
    yield* authorizePersonNativeOperation({
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
    });
    const rows = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
      listAdmissionPeriodsForManagement({ actor, now }),
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
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ items: Schema.Array(AdmissionPeriodManagementItem), totalItems: Schema.Int }),
    )({ items, totalItems: items.length }, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => taggedError("AdmissionPeriodPersistenceError")),
    );
    return yield* conditionalJsonResponse({
      request,
      body,
      representationKind: "AdmissionPeriodManagementListResponse",
      version: rows.map((row) => [row.id, row.revision] as const),
      cacheControl: PRIVATE_NO_STORE,
    });
  });

const create = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const payload = yield* decodeJson(
      request,
      CreateAdmissionPeriodRequest,
      input.config.maxBodyBytes,
      "AdmissionPeriodDecodeError",
    );
    const admissionPeriodId = input.config.nextAdmissionPeriodId();
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "admissions.createAdmissionPeriod";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });
        const actor = yield* admissionActorForAuthority(
          authorization.authority,
          payload.departmentId,
        );
        const now = authorization.authorizationInstant;
        yield* authorizePersonNativeOperation({
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
        });
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/admission-periods",
              idempotencyKey,
            }),
          catch: (cause) => cause,
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
    );
    return nativeCommandOutcomeResponse(result);
  });

const revise = (
  request: Request,
  admissionPeriodId: string,
  input: AdmissionApiHttpOptions,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const { typedAdmissionPeriodId, ifMatch, idempotencyKey, normalizedTarget } =
      yield* Effect.try({
        try: () => {
          const typedAdmissionPeriodId = AdmissionPeriodId.make(admissionPeriodId);
          return {
            typedAdmissionPeriodId,
            ifMatch: parseRequiredIfMatch(
              request.headers.get("if-match") === null
                ? []
                : [request.headers.get("if-match")!],
            ),
            idempotencyKey: parseIdempotencyKey(
              request.headers.get("idempotency-key") === null
                ? []
                : [request.headers.get("idempotency-key")!],
            ),
            normalizedTarget: `/api/admission-periods/${encodePathIdentity(typedAdmissionPeriodId)}`,
          };
        },
        catch: (cause) => cause,
      });
    const patch = yield* decodeAdmissionPeriodPatch(request, input);
    const operationId = "admissions.reviseAdmissionPeriod";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });
        const actor = yield* admissionActorForAuthority(authorization.authority);
        const now = authorization.authorizationInstant;
        const periods = yield* Admissions.use(({ listAdmissionPeriodsForManagement }) =>
          listAdmissionPeriodsForManagement({ actor, now }),
        );
        const current = periods.find((period) => period.id === typedAdmissionPeriodId);
        if (current === undefined) {
          return yield* Effect.fail(taggedError("AdmissionPeriodNotFound"));
        }
        yield* authorizePersonNativeOperation({
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
        });
        const currentETag = deriveStrongETag({
          representationKind: "AdmissionPeriodManagementItem",
          resourceIdentity: current.id,
          version: current.revision,
        });
        const precondition = yield* Effect.try({
          try: () => evaluateMutationPrecondition(currentETag, ifMatch),
          catch: (cause) => cause,
        });
        if (precondition._tag === "Failed") {
          return yield* Effect.fail(
            new HttpSemanticFailure(precondition.code, precondition.status),
          );
        }
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget,
              idempotencyKey,
            }),
          catch: (cause) => cause,
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
    );
    return nativeCommandOutcomeResponse(result);
  });

const listOpen = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const now = input.config.now();
    yield* authorizeAnonymousNativeOperation(
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
    );
    const rows = yield* Admissions.use(({ listOpenAdmissionPeriods }) =>
      listOpenAdmissionPeriods(now),
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
    return yield* conditionalJsonResponse({
      request,
      body,
      representationKind: "OpenAdmissionPeriodListResponse",
      version: rows.map((row) => [row.id, row.revision] as const),
      cacheControl: dynamicAdmissionCache(
        now,
        rows.flatMap((row) => [row.startAt, row.endAt]),
      ),
    });
  });

/**
 * The Fetch Request does not expose a verified peer address. Treat all public
 * callers as one trust boundary instead of trusting spoofable forwarding headers.
 */
const publicRateLimitKey = (_request: Request): string => "public";

const listPublicCatalog = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request, "PublicApplicationDecodeError");
    const now = input.config.now();
    yield* authorizeAnonymousNativeOperation(
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
    );
    const source = yield* Admissions.use(({ listPublicApplicationCatalog }) =>
      listPublicApplicationCatalog({ now }),
    );
    return yield* conditionalJsonResponse({
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
  });

const submitApplication = (request: Request, input: AdmissionApiHttpOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request, "PublicApplicationDecodeError");
    const now = input.config.now();
    if (!input.config.rateLimit.consume(publicRateLimitKey(request), now)) {
      return yield* Effect.fail(taggedError("PublicApplicationRateLimitExceeded"));
    }
    const payload = yield* decodeJson(
      request,
      SubmitApplicationRequest,
      input.config.maxBodyBytes,
      "PublicApplicationDecodeError",
    );
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "admissions.submitApplication";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        yield* authorizeAnonymousNativeOperation(
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
        );
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: "Anonymous",
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/applications",
              idempotencyKey,
            }),
          catch: (cause) => cause,
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
    );
    return nativeCommandOutcomeResponse(result);
  });

const publicConfirmation = (
  request: Request,
  applicationId: string,
  input: AdmissionApiHttpOptions,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request, "PublicApplicationDecodeError");
    const now = input.config.now();
    yield* authorizeAnonymousNativeOperation(
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
    );
    const confirmation = yield* Admissions.use(({ findPublicApplicationConfirmation }) =>
      findPublicApplicationConfirmation(applicationId),
    );
    return jsonResponse(confirmation);
  });

const applicantProgress = (request: Request, input: AdmissionApiHttpOptions) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (new URL(request.url).search !== "") {
          return yield* Effect.fail(new HttpSemanticFailure("request.malformed", 400));
        }
        yield* Database.use(
          (transaction) => transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
        );
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
          now: input.config.now,
        });
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(ReadApplicantProgressEndpoint)),
          credential: authorization.credential,
          personId: authorization.authority.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "admissions",
                resourceKind: "person-profile",
                resourceId: authorization.authority.personId,
                facts: { ownerPersonId: authorization.authority.personId },
                authorityVersion: "admissions:applicant-progress",
              }),
            ],
          },
          grantScopes: [returningPersonResource(authorization.authority.personId)],
          now: authorization.authorizationInstant,
        });
        const body = yield* Admissions.use(({ readApplicantProgress }) =>
          readApplicantProgress(
            authorization.authority.personId,
            authorization.authorizationInstant,
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(ApplicantProgressResponseSchema)(body, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => taggedError("PublicApplicationPersistenceError")));
        return new Response(JSON.stringify(decoded), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            vary: "Origin",
          },
        });
      }),
    ),
  );

/** Native HttpApi implementations for admission and public application endpoints. */
export const AdmissionsApiHandlers = (input: AdmissionApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "admissions", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => listManagement(webRequest, input), errorResponse),
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
          toHttpApiResponse(request, (webRequest) => submitApplication(webRequest, input), errorResponse),
        )
        .handleRaw("readApplicationConfirmation", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => publicConfirmation(webRequest, params.applicationId, input),
            errorResponse,
          ),
        )
        .handleRaw("readApplicantProgress", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => applicantProgress(webRequest, input), errorResponse),
        )
        .handleRaw("readReturningAssistantOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readReturningAssistantOptions(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("registerReturningAssistant", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => registerReturningAssistant(webRequest, input),
            errorResponse,
          ),
        ),
    ),
  );
