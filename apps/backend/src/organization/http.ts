import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  Organization,
  OrganizationCommandId,
  TeamJsonSchema,
  type DepartmentId,
  type OrganizationActor,
  type OrganizationPersonAuthority,
  type SemesterId,
  type TeamInterestFilter,
} from "@vektorprogrammet/domain/organization";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  CreateDepartmentEndpoint,
  CreateDepartmentRequest,
  CreateFieldOfStudyEndpoint,
  CreateFieldOfStudyRequest,
  CreateTeamEndpoint,
  CreateTeamRequest,
  ExternalNativeApi,
  ListDepartmentsEndpoint,
  ListFieldOfStudiesEndpoint,
  ListMailingListsEndpoint,
  ListTeamInterestEndpoint,
  ListTeamsEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  organizationActorFrom,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  PUBLIC_CACHE_CONTROL,
  deriveStrongETag,
  evaluateReadPreconditions,
  encodePathIdentity,
  jsonBodyBytes,
  deriveHttpIdentity,
  notModifiedResponse,
  parseIfNoneMatch,
  nativeProblemResponse,
  parseReadIfMatch,
  parseIdempotencyKey,
  semanticRequestDigest,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import type { OrganizationApiConfig } from "./config.js";

export interface OrganizationApiHttpOptions {
  readonly config: OrganizationApiConfig;
  /** Cookie -> Organization projection -> OrganizationAdministrator|Member. */
  readonly resolveActor: (
    request: Request,
  ) => Effect.Effect<
    OrganizationActor,
    IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
    Identity | OAuthCredentialAuthority | Organization
  >;
  /**
   * Cookie -> full 0055 authority projection for leader-scoped admin reads
   * (specs 0059/0060). One captured authorizationInstant per request.
   */
  readonly resolveAuthority: (
    request: Request,
  ) => Effect.Effect<
    OrganizationPersonAuthority,
    IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
    Identity | OAuthCredentialAuthority | Organization
  >;
}

type TaggedHttpError = Error & { readonly _tag: string };

const OrganizationHttpErrorTagSchema = Schema.Literals([
  "UnauthenticatedActor",
  "OrganizationRoleDenied",
  "OrganizationInvalidReference",
  "OrganizationCommandConflict",
  "OrganizationDecodeError",
  "RequestBodyTooLarge",
  "OrganizationPersistenceError",
]);
type OrganizationHttpErrorTag = typeof OrganizationHttpErrorTagSchema.Type;

/** Frozen fixture envelope for spec 0059: strict, no extra row fields. */
const TeamInterestEnvelopeSchema = Schema.Struct({
  "hydra:member": Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      userName: Schema.String,
      teamName: Schema.String,
    }),
  ),
  "hydra:totalItems": Schema.Number,
});

const taggedError = (tag: OrganizationHttpErrorTag): TaggedHttpError => {
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
      case "UnauthenticatedActor":
        return nativeProblemResponse("credential.invalid", 401, {
          "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
        });
      case "OrganizationRoleDenied":
        return nativeProblemResponse("authority.denied", 403);
      case "OrganizationInvalidReference":
        return nativeProblemResponse("organization.invalid-reference", 422);
      case "OrganizationCommandConflict":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "OrganizationDecodeError":
        return nativeProblemResponse("validation.failed", 422);
      case "RequestBodyTooLarge":
        return nativeProblemResponse("request.too-large", 413);
    }
  }
  return nativeProblemResponse("organization.unavailable", 503);
};

const assertNoQuery = (request: Request) =>
  new URL(request.url).search.length === 0
    ? Effect.void
    : Effect.fail(taggedError("OrganizationDecodeError"));

const transactionOrganizationAuthorityFor = (request: Request) =>
  resolveRequestPersonAuthorityInTransaction(request, {}).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        cause !== null && typeof cause === "object" && "_tag" in cause
          ? (cause as TaggedHttpError)
          : taggedError("UnauthenticatedActor"),
      ),
    ),
  );

const readBoundedBody = (request: Request, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null) {
        if (!/^\d+$/u.test(contentLength)) throw taggedError("OrganizationDecodeError");
        const declaredLength = Number(contentLength);
        if (!Number.isSafeInteger(declaredLength)) {
          throw taggedError("OrganizationDecodeError");
        }
        if (declaredLength > maxBytes) throw taggedError("RequestBodyTooLarge");
      }
      if (request.body === null) return "";

      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          totalBytes += next.value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw taggedError("RequestBodyTooLarge");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }

      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    },
    catch: (cause) =>
      cause !== null && typeof cause === "object" && "_tag" in cause
        ? (cause as TaggedHttpError)
        : taggedError("OrganizationDecodeError"),
  });

const decodeCommand = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  input: OrganizationApiHttpOptions,
): Effect.Effect<S["Type"], TaggedHttpError> =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(taggedError("OrganizationDecodeError"));
    }
    const raw = yield* readBoundedBody(request, input.config.maxBodyBytes);
    const body = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => taggedError("OrganizationDecodeError"),
    });
    return yield* Schema.decodeUnknownEffect(schema)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationDecodeError")));
  });

const strictJsonResponse = <S extends Schema.ConstraintDecoder<unknown, never>>(
  value: unknown,
  schema: S,
  status = 200,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => taggedError("OrganizationPersistenceError")),
    Effect.map((decoded) => jsonResponse(decoded, status)),
  );
const publicListResponse = (
  request: Request,
  body: unknown,
  representationKind: string,
  versions: ReadonlyArray<readonly [string, number]>,
): Response => {
  const etag = deriveStrongETag({
    representationKind,
    resourceIdentity: new URL(request.url).pathname,
    version: versions,
  });
  try {
    const ifMatchValue = request.headers.get("if-match");
    const decision = evaluateReadPreconditions({
      currentETag: etag,
      ifMatch: ifMatchValue === null ? null : parseReadIfMatch([ifMatchValue]),
      ifNoneMatch: parseIfNoneMatch(
        request.headers.get("if-none-match") === null
          ? []
          : [request.headers.get("if-none-match")!],
      ),
    });
    if (decision._tag === "Failed") {
      return nativeProblemResponse(decision.code, decision.status);
    }
    if (decision._tag === "NotModified") {
      return notModifiedResponse({
        etag,
        cacheControl: PUBLIC_CACHE_CONTROL,
        vary: "Origin",
      });
    }
  } catch (cause) {
    if (!(cause instanceof HttpSemanticFailure)) throw cause;
    return nativeProblemResponse(cause.code, cause.status);
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
      vary: "Origin",
    },
  });
};

const listDepartments = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymousNativeOperation(
      Option.getOrThrow(reflectAccessSpec(ListDepartmentsEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "organization",
            authorityVersion: "organization-public-departments",
          }),
        ],
      },
      new Date().toISOString(),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listDepartments }) => listDepartments);
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DepartmentJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationPersistenceError")));
    return publicListResponse(
      request,
      decoded,
      "DepartmentListResponse",
      decoded.map((row) => [row.departmentId, row.revision] as const),
    );
  });

const listTeams = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymousNativeOperation(
      Option.getOrThrow(reflectAccessSpec(ListTeamsEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "organization",
            authorityVersion: "organization-public-teams",
          }),
        ],
      },
      new Date().toISOString(),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listTeams }) => listTeams());
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TeamJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationPersistenceError")));
    return publicListResponse(
      request,
      decoded,
      "TeamListResponse",
      decoded.map((row) => [row.teamId, row.revision] as const),
    );
  });

const listFieldOfStudies = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymousNativeOperation(
      Option.getOrThrow(reflectAccessSpec(ListFieldOfStudiesEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "organization",
            authorityVersion: "organization-public-field-of-studies",
          }),
        ],
      },
      new Date().toISOString(),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listFieldOfStudies }) => listFieldOfStudies);
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(FieldOfStudyJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationPersistenceError")));
    return publicListResponse(
      request,
      decoded,
      "FieldOfStudyListResponse",
      decoded.map((row) => [row.fieldOfStudyId, row.revision] as const),
    );
  });

const createDepartment = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* assertNoQuery(request);
    const payload = yield* decodeCommand(request, CreateDepartmentRequest, input);
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "organization.createDepartment";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* transactionOrganizationAuthorityFor(request);
        const actor = organizationActorFrom(resolved.authority);
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(CreateDepartmentEndpoint)),
          credential: resolved.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "organization",
                authorityVersion: `organization:${actor._tag}`,
              }),
            ],
          },
          grantScopes: actor._tag === "OrganizationAdministrator" ? [{ _tag: "Global" }] : [],
          now: resolved.authorizationInstant,
        });
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/departments",
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
          execute: Organization.use((organization) =>
            Effect.gen(function* () {
              const created = yield* organization.createDepartment(
                {
                  _tag: "CreateDepartment",
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                },
                actor,
              );
              const department =
                created.observation._tag === "Replayed"
                  ? created.observation.original.department
                  : created.observation.department;
              const etag = deriveStrongETag({
                representationKind: "DepartmentJson",
                resourceIdentity: department.departmentId,
                version: department.revision,
              });
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/departments/${encodePathIdentity(department.departmentId)}`,
                  etag,
                },
                bodyBytes: jsonBodyBytes(department),
              };
            }),
          ),
        };
      }),
    );
    return nativeCommandOutcomeResponse(result);
  });

const createTeam = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* assertNoQuery(request);
    const payload = yield* decodeCommand(request, CreateTeamRequest, input);
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "organization.createTeam";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* transactionOrganizationAuthorityFor(request);
        const actor = organizationActorFrom(resolved.authority);
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(CreateTeamEndpoint)),
          credential: resolved.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "organization",
                authorityVersion: `organization:${actor._tag}`,
              }),
            ],
          },
          grantScopes: actor._tag === "OrganizationAdministrator" ? [{ _tag: "Global" }] : [],
          now: resolved.authorizationInstant,
        });
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/teams",
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
          execute: Organization.use((organization) =>
            Effect.gen(function* () {
              const created = yield* organization.createTeam(
                {
                  _tag: "CreateTeam",
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                },
                actor,
              );
              const team =
                created.observation._tag === "Replayed"
                  ? created.observation.original.team
                  : created.observation.team;
              const etag = deriveStrongETag({
                representationKind: "TeamJson",
                resourceIdentity: team.teamId,
                version: team.revision,
              });
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/teams/${encodePathIdentity(team.teamId)}`,
                  etag,
                },
                bodyBytes: jsonBodyBytes(team),
              };
            }),
          ),
        };
      }),
    );
    return nativeCommandOutcomeResponse(result);
  });

const createFieldOfStudy = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* assertNoQuery(request);
    const payload = yield* decodeCommand(request, CreateFieldOfStudyRequest, input);
    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) => cause,
    });
    const operationId = "organization.createFieldOfStudy";
    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* transactionOrganizationAuthorityFor(request);
        const actor = organizationActorFrom(resolved.authority);
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(CreateFieldOfStudyEndpoint)),
          credential: resolved.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "organization",
                authorityVersion: `organization:${actor._tag}`,
              }),
            ],
          },
          grantScopes: actor._tag === "OrganizationAdministrator" ? [{ _tag: "Global" }] : [],
          now: resolved.authorizationInstant,
        });
        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/field-of-studies",
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
          execute: Organization.use((organization) =>
            Effect.gen(function* () {
              const created = yield* organization.createFieldOfStudy(
                {
                  _tag: "CreateFieldOfStudy",
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                },
                actor,
              );
              const fieldOfStudy =
                created.observation._tag === "Replayed"
                  ? created.observation.original.fieldOfStudy
                  : created.observation.fieldOfStudy;
              const etag = deriveStrongETag({
                representationKind: "FieldOfStudyJson",
                resourceIdentity: fieldOfStudy.fieldOfStudyId,
                version: fieldOfStudy.revision,
              });
              return {
                status: 201,
                mediaType: "application/json",
                headers: {
                  "content-type": "application/json",
                  location: `/api/field-of-studies/${encodePathIdentity(fieldOfStudy.fieldOfStudyId)}`,
                  etag,
                },
                bodyBytes: jsonBodyBytes(fieldOfStudy),
              };
            }),
          ),
        };
      }),
    );
    return nativeCommandOutcomeResponse(result);
  });

const MailingListTypeSchema = Schema.Literals(["assistants", "team", "all"]);

const optionalDepartmentParam = (request: Request) => {
  const value = new URL(request.url).searchParams.get("department");
  if (value === null) return Effect.succeed<DepartmentId | undefined>(undefined);
  return value.trim().length === 0 || /[^a-zA-Z0-9._-]/u.test(value)
    ? Effect.fail(taggedError("OrganizationDecodeError"))
    : Effect.succeed(value as DepartmentId);
};

const optionalSemesterParam = (request: Request) => {
  const value = new URL(request.url).searchParams.get("semester");
  if (value === null) return Effect.succeed<SemesterId | undefined>(undefined);
  return value.trim().length === 0 || /[^a-zA-Z0-9._-]/u.test(value)
    ? Effect.fail(taggedError("OrganizationDecodeError"))
    : Effect.succeed(value as SemesterId);
};

/** Spec 0059/0060 gating: globalAdmin -> all departments, else active-leader union. */
const authorizedDepartmentScope = (authority: OrganizationPersonAuthority) =>
  Effect.gen(function* () {
    if (authority.globalAdministrator === "Active") {
      const departments = yield* Organization.use(({ listDepartments }) => listDepartments);
      return departments.map((department) => department.departmentId);
    }
    const departments = new Set<DepartmentId>();
    for (const membership of authority.memberships) {
      if (membership.active && membership.teamLeader) departments.add(membership.departmentId);
    }
    return [...departments];
  });

/** Narrows the authorized scope; out-of-scope known department denies with 403. */
const narrowScopeOrThrow = (
  authorized: ReadonlyArray<DepartmentId>,
  departmentId: DepartmentId | undefined,
) =>
  departmentId === undefined
    ? Effect.succeed(authorized)
    : authorized.some((authorizedId) => authorizedId === departmentId)
      ? Effect.succeed([departmentId])
      : Effect.fail(taggedError("OrganizationRoleDenied"));

/** Unknown department reference denies with 422 before any data leaves the store. */
const assertDepartmentsExist = (departmentIds: ReadonlyArray<DepartmentId>) =>
  Organization.use(({ listDepartments }) => listDepartments).pipe(
    Effect.flatMap((known) => {
      for (const requested of departmentIds) {
        if (!known.some((department) => department.departmentId === requested)) {
          return Effect.fail(taggedError("OrganizationInvalidReference"));
        }
      }
      return Effect.void;
    }),
  );

const authorizeOrganizationCollection = (input: {
  readonly request: Request;
  readonly authority: OrganizationPersonAuthority;
  readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
  readonly departmentIds: ReadonlyArray<DepartmentId>;
}) => {
  const global = input.authority.globalAdministrator === "Active";
  const contexts =
    global && input.departmentIds.length === 0
      ? [
          genericContext({
            domainId: "organization",
            facts: { departmentLeaderPersonIds: [input.authority.personId] },
            authorityVersion: `organization:${input.authority.evaluatedAt}`,
          }),
        ]
      : input.departmentIds.map((departmentId) =>
          genericContext({
            domainId: "organization",
            departmentId,
            facts: { departmentLeaderPersonIds: [input.authority.personId] },
            authorityVersion: `organization:${input.authority.evaluatedAt}`,
          }),
        );
  const scopes =
    global && input.departmentIds.length === 0
      ? [{ _tag: "Global" as const }]
      : input.departmentIds.map((departmentId) => ({
          _tag: "Department" as const,
          departmentId,
        }));
  return authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
    request: input.request,
    personId: input.authority.personId,
    resolution: { selection: "AllMatching", contexts },
    grantScopes: scopes,
    now: input.authority.evaluatedAt,
  });
};

const listTeamInterest = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    const authority = yield* input.resolveAuthority(request);
    const requested = yield* optionalDepartmentParam(request);
    // An authenticated caller with no active leader membership receives a typed
    // denial, never an empty success (spec 0059 authorization boundary). An
    // active global administrator is authorized for all departments even when
    // their membership list is empty.
    const leaderScope = yield* authorizedDepartmentScope(authority);
    if (leaderScope.length === 0 && authority.globalAdministrator !== "Active") {
      return yield* Effect.fail(taggedError("OrganizationRoleDenied"));
    }
    const authorized = yield* narrowScopeOrThrow(leaderScope, requested);
    yield* authorizeOrganizationCollection({
      request,
      authority,
      endpoint: ListTeamInterestEndpoint,
      departmentIds: authorized,
    });
    // Unknown department reference denies with 422 before any data leaves the store.
    if (requested !== undefined) yield* assertDepartmentsExist([requested]);
    const filter: TeamInterestFilter = {
      authorizedDepartmentIds: authorized,
      semesterId: yield* optionalSemesterParam(request),
    };
    const rows = yield* Organization.use(({ listTeamInterestRegistrations }) =>
      listTeamInterestRegistrations(filter),
    );
    const envelope = {
      "hydra:member": rows.map((row) => ({
        id: row.registrationId,
        userName: row.submitterName,
        teamName: row.teamName,
      })),
      "hydra:totalItems": rows.length,
    };
    return yield* strictJsonResponse(envelope, TeamInterestEnvelopeSchema);
  });

const listMailingLists = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    const rawType = new URL(request.url).searchParams.get("type") ?? "assistants";
    const decodedType = yield* Schema.decodeUnknownEffect(MailingListTypeSchema)(rawType, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationDecodeError")));
    const authority = yield* input.resolveAuthority(request);
    const requested = yield* optionalDepartmentParam(request);
    const leaderScope = yield* authorizedDepartmentScope(authority);
    if (leaderScope.length === 0 && authority.globalAdministrator !== "Active") {
      return yield* Effect.fail(taggedError("OrganizationRoleDenied"));
    }
    const authorized = yield* narrowScopeOrThrow(leaderScope, requested);
    if (requested !== undefined) yield* assertDepartmentsExist([requested]);
    yield* authorizeOrganizationCollection({
      request,
      authority,
      endpoint: ListMailingListsEndpoint,
      departmentIds: authorized,
    });
    const semesterId = yield* optionalSemesterParam(request);
    const lists = yield* Organization.use(({ projectMailingLists }) =>
      projectMailingLists({
        type: decodedType,
        authorizedDepartmentIds: authorized,
        semesterId,
      }),
    );
    return jsonResponse(lists);
  });

/** Native HttpApi implementations for organization endpoints. */
export const OrganizationApiHandlers = (input: OrganizationApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "organization", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listDepartments", ({ request }) =>
          toHttpApiResponse(request, listDepartments, errorResponse),
        )
        .handleRaw("listTeams", ({ request }) =>
          toHttpApiResponse(request, listTeams, errorResponse),
        )
        .handleRaw("listFieldOfStudies", ({ request }) =>
          toHttpApiResponse(request, listFieldOfStudies, errorResponse),
        )
        .handleRaw("listTeamInterest", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listTeamInterest(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("listMailingLists", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listMailingLists(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("createDepartment", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createDepartment(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("createTeam", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => createTeam(webRequest, input), errorResponse),
        )
        .handleRaw("createFieldOfStudy", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createFieldOfStudy(webRequest, input),
            errorResponse,
          ),
        ),
    ),
  );
