import { Scope } from "@vektorprogrammet/domain/authz";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  DepartmentId,
  SemesterId,
  OrganizationDecodeError,
  OrganizationPersistenceError,
  AppointmentManagement,
  OrganizationLifecycleCommand,
  OrganizationLifecycleFailure,
  CreateDepartmentCommandSchema,
  CreateTeamCommandSchema,
  CreateFieldOfStudyCommandSchema,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  Organization,
  OrganizationCommandId,
  TeamJsonSchema,
  type OrganizationActor,
  type OrganizationPersonAuthority,
  type TeamInterestFilter,
} from "@vektorprogrammet/domain/organization";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";

import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  ReadAppointmentManagementEndpoint,
  ExecuteOrganizationLifecycleEndpoint,
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
  MailingListResponse,
  ListTeamInterestEndpoint,
  ListTeamsEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { flow, DateTime, Match, Cause, Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveRequestCredentialInTransaction,
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

type TaggedHttpError = OrganizationDecodeError | HttpSemanticFailure;

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

const jsonResponse = (body: Schema.Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const errorResponse = (cause: unknown): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  if (cause instanceof OrganizationLifecycleFailure) {
    switch (cause.code) {
      case "Denied":
      case "SelfDisable":
      case "LastAdministrator":
        return nativeProblemResponse("authority.denied", 403);
      case "NotFound":
        return nativeProblemResponse("resource.not-found", 404);
      case "Stale":
        return nativeProblemResponse("precondition.failed", 412);
      case "Conflict":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "Invalid":
        return nativeProblemResponse("validation.failed", 422);
      case "Unavailable":
        return nativeProblemResponse("organization.unavailable", 503);
    }
  }

  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  if (
    cause instanceof HttpSemanticFailure ||
    (cause instanceof Error && "_tag" in cause && Predicate.isString(cause._tag))
  ) {
    const response = Match.value(cause).pipe(
      Match.when(Predicate.isTagged("NativeHttpReceiptInFlightError"), () => {
        return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptDigestConflictError"), () => {
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptExpiredError"), () => {
        return nativeProblemResponse("idempotency.response-expired", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptPersistenceError"), () => {
        return nativeProblemResponse("idempotency.unavailable", 503);
      }),
      Match.when(Predicate.isTagged("UnauthenticatedActor"), () => {
        return nativeProblemResponse("credential.invalid", 401, {
          "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
        });
      }),
      Match.when(Predicate.isTagged("OrganizationRoleDenied"), () => {
        return nativeProblemResponse("authority.denied", 403);
      }),
      Match.when(Predicate.isTagged("OrganizationInvalidReference"), () => {
        return nativeProblemResponse("organization.invalid-reference", 422);
      }),
      Match.when(Predicate.isTagged("OrganizationCommandConflict"), () => {
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      }),
      Match.when(Predicate.isTagged("OrganizationDecodeError"), () => {
        return nativeProblemResponse("validation.failed", 422);
      }),
      Match.when(Predicate.isTagged("RequestBodyTooLarge"), () => {
        return nativeProblemResponse("request.too-large", 413);
      }),
      Match.orElse(() => undefined),
    );

    if (response !== undefined) return response;
  }

  return nativeProblemResponse("organization.unavailable", 503);
};

const assertNoQuery = (request: Request) =>
  new URL(request.url).search.length === 0
    ? Effect.void
    : Effect.fail(new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }));

const transactionOrganizationAuthorityFor = (request: Request) =>
  resolveRequestPersonAuthorityInTransaction(request, {});

const readBoundedBody = (request: Request, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const contentLength = request.headers.get("content-length");

      if (contentLength !== null) {
        if (!/^\d+$/u.test(contentLength))
          throw new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" });
        const declaredLength = Number(contentLength);

        if (!Number.isSafeInteger(declaredLength)) {
          throw new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" });
        }

        if (declaredLength > maxBytes) throw new HttpSemanticFailure("request.too-large", 413);
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
            throw new HttpSemanticFailure("request.too-large", 413);
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
      cause instanceof HttpSemanticFailure || cause instanceof OrganizationDecodeError
        ? cause
        : new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
  });

const decodeCommand = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  input: OrganizationApiHttpOptions,
): Effect.Effect<S["Type"], TaggedHttpError> =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";

    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(
        new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
      );
    }

    const raw = yield* readBoundedBody(request, input.config.maxBodyBytes);

    const body = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(raw)),
      catch: () => new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
    });

    return yield* Schema.decodeUnknownEffect(schema)(body, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
      ),
    );
  });

const strictJsonResponse = <S extends Schema.ConstraintDecoder<Schema.Json, never>>(
  schema: S,
  status = 200,
) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(
      () => new OrganizationPersistenceError({ operation: "HTTP", message: "Invalid response" }),
    ),
    Effect.map((decoded) => jsonResponse(decoded, status)),
  );

const publicListResponse = (
  request: Request,
  body: Schema.Json,
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

    if (Predicate.isTagged(decision, "Failed")) {
      return nativeProblemResponse(decision.code, decision.status);
    }

    if (Predicate.isTagged(decision, "NotModified")) {
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
      DateTime.formatIso(yield* DateTime.now),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listDepartments }) => listDepartments);

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DepartmentJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new OrganizationPersistenceError({ operation: "HTTP", message: "Invalid response" }),
      ),
    );

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
      DateTime.formatIso(yield* DateTime.now),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listTeams }) => listTeams());

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TeamJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new OrganizationPersistenceError({ operation: "HTTP", message: "Invalid response" }),
      ),
    );

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
      DateTime.formatIso(yield* DateTime.now),
    );
    yield* assertNoQuery(request);
    const rows = yield* Organization.use(({ listFieldOfStudies }) => listFieldOfStudies);

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(FieldOfStudyJsonSchema))(rows, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new OrganizationPersistenceError({ operation: "HTTP", message: "Invalid response" }),
      ),
    );

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
      catch: (cause) =>
        cause instanceof UnauthenticatedActor ||
        cause instanceof OrganizationLifecycleFailure ||
        cause instanceof HttpSemanticFailure
          ? cause
          : new Cause.UnknownError(cause),
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
          grantScopes: Predicate.isTagged(actor, "OrganizationAdministrator")
            ? [Scope.Global()]
            : [],
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
          catch: (cause) =>
            cause instanceof UnauthenticatedActor ||
            cause instanceof OrganizationLifecycleFailure ||
            cause instanceof HttpSemanticFailure
              ? cause
              : new Cause.UnknownError(cause),
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
                CreateDepartmentCommandSchema.make({
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                }),
                actor,
              );

              const department = Predicate.isTagged(created.observation, "Replayed")
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
      catch: (cause) =>
        cause instanceof UnauthenticatedActor ||
        cause instanceof OrganizationLifecycleFailure ||
        cause instanceof HttpSemanticFailure
          ? cause
          : new Cause.UnknownError(cause),
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
          grantScopes: Predicate.isTagged(actor, "OrganizationAdministrator")
            ? [Scope.Global()]
            : [],
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
          catch: (cause) =>
            cause instanceof UnauthenticatedActor ||
            cause instanceof OrganizationLifecycleFailure ||
            cause instanceof HttpSemanticFailure
              ? cause
              : new Cause.UnknownError(cause),
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
                CreateTeamCommandSchema.make({
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                }),
                actor,
              );

              const team = Predicate.isTagged(created.observation, "Replayed")
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
      catch: (cause) =>
        cause instanceof UnauthenticatedActor ||
        cause instanceof OrganizationLifecycleFailure ||
        cause instanceof HttpSemanticFailure
          ? cause
          : new Cause.UnknownError(cause),
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
          grantScopes: Predicate.isTagged(actor, "OrganizationAdministrator")
            ? [Scope.Global()]
            : [],
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
          catch: (cause) =>
            cause instanceof UnauthenticatedActor ||
            cause instanceof OrganizationLifecycleFailure ||
            cause instanceof HttpSemanticFailure
              ? cause
              : new Cause.UnknownError(cause),
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
                CreateFieldOfStudyCommandSchema.make({
                  commandId: OrganizationCommandId.make(derived.commandId),
                  ...payload,
                }),
                actor,
              );

              const fieldOfStudy = Predicate.isTagged(created.observation, "Replayed")
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

  return Schema.decodeUnknownEffect(DepartmentId)(value).pipe(
    Effect.mapError(
      () => new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
    ),
  );
};

const optionalSemesterParam = (request: Request) => {
  const value = new URL(request.url).searchParams.get("semester");

  if (value === null) return Effect.succeed<SemesterId | undefined>(undefined);

  return Schema.decodeUnknownEffect(SemesterId)(value).pipe(
    Effect.mapError(
      () => new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
    ),
  );
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
      : Effect.fail(new HttpSemanticFailure("authority.denied", 403));

/** Unknown department reference denies with 422 before any data leaves the store. */
const assertDepartmentsExist = (departmentIds: ReadonlyArray<DepartmentId>) =>
  Organization.use(({ listDepartments }) => listDepartments).pipe(
    Effect.flatMap((known) => {
      for (const requested of departmentIds) {
        if (!known.some((department) => department.departmentId === requested)) {
          return Effect.fail(new HttpSemanticFailure("organization.invalid-reference", 422));
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
      ? [Scope.Global()]
      : input.departmentIds.map((departmentId) => Scope.Department({ departmentId }));

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
      return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
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

    return yield* strictJsonResponse(TeamInterestEnvelopeSchema)(envelope);
  });

const listMailingLists = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    const rawType = new URL(request.url).searchParams.get("type") ?? "assistants";

    const decodedType = yield* Schema.decodeUnknownEffect(MailingListTypeSchema)(rawType, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new OrganizationDecodeError({ operation: "HTTP", message: "Invalid request" }),
      ),
    );

    const authority = yield* input.resolveAuthority(request);
    const requested = yield* optionalDepartmentParam(request);
    const leaderScope = yield* authorizedDepartmentScope(authority);

    if (leaderScope.length === 0 && authority.globalAdministrator !== "Active") {
      return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
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
        actorPersonId: authority.personId,
        authorizationInstant: authority.evaluatedAt,
        departmentId: requested,
        semesterId,
      }),
    );

    const response = yield* strictJsonResponse(MailingListResponse)(lists);
    response.headers.set("cache-control", "private, no-store");

    return response;
  });

/** Native HttpApi implementations for organization endpoints. */
const readAppointmentManagement = (request: Request) =>
  Effect.gen(function* () {
    yield* assertNoQuery(request);
    const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

    if (!Predicate.isTagged(resolved.credential.principal, "Person"))
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    const personId = resolved.credential.principal.personId;

    const snapshot = yield* Organization.use((service) =>
      service.readAppointmentManagement(personId),
    );

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadAppointmentManagementEndpoint)),
      credential: resolved.credential,
      personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({ domainId: "organization", authorityVersion: "appointment-management" }),
        ],
      },
      grantScopes: [Scope.Global()],
      now: resolved.authorizationInstant,
    });
    const response = yield* strictJsonResponse(AppointmentManagement)(snapshot);
    response.headers.set("cache-control", "private, no-store");

    return response;
  });

const executeLifecycle = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* assertNoQuery(request);
    const command = yield* decodeCommand(request, OrganizationLifecycleCommand, input);

    const idempotencyKey = yield* Effect.try({
      try: () =>
        parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
      catch: (cause) =>
        cause instanceof UnauthenticatedActor ||
        cause instanceof OrganizationLifecycleFailure ||
        cause instanceof HttpSemanticFailure
          ? cause
          : new Cause.UnknownError(cause),
    });

    if (command.commandId !== idempotencyKey)
      return yield* new OrganizationLifecycleFailure({ code: "Conflict" });

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

        if (!Predicate.isTagged(resolved.credential.principal, "Person"))
          return yield* new UnauthenticatedActor({ message: "authentication required" });
        const personId = resolved.credential.principal.personId;

        // Authority, history and both receipts commit in this ambient transaction.
        const result = yield* Organization.use((service) =>
          service.executeLifecycle(command, personId),
        );

        const current = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");
        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(ExecuteOrganizationLifecycleEndpoint)),
          credential: current.credential,
          personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "organization",
                authorityVersion: "appointment-management",
              }),
            ],
          },
          grantScopes: [Scope.Global()],
          now: current.authorizationInstant,
        });

        const identity = deriveHttpIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: "organization.executeLifecycle",
          normalizedTarget: "/api/organization/appointments/commands",
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId: "organization.executeLifecycle",
          },
          execute: Effect.succeed({
            status: 200,
            mediaType: "application/json",
            headers: {
              "content-type": "application/json",
              etag: deriveStrongETag({
                representationKind: "OrganizationLifecycleResult",
                resourceIdentity: result.subjectId,
                version: result.revision,
              }),
            },
            bodyBytes: jsonBodyBytes(result),
          }),
        };
      }),
      { retry: "serialization-once" },
    );

    return nativeCommandOutcomeResponse(outcome);
  });

export const OrganizationApiHandlers = (input: OrganizationApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "organization", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readAppointmentManagement", ({ request }) =>
          toHttpApiResponse(request, readAppointmentManagement, errorResponse),
        )
        .handleRaw("executeLifecycle", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => executeLifecycle(webRequest, input),
            errorResponse,
          ),
        )
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
