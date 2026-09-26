import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  reachedDepartments,
  ReachedDepartments,
  reachedTeams,
  ResourceId,
  ResourceKind,
  Scope,
} from "@vektorprogrammet/domain/authz";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  AppointmentManagement,
  CreateDepartmentCommandSchema,
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  Organization,
  OrganizationCommandId,
  OrganizationLifecycleCommand,
  SemesterId,
  type TeamId,
  TeamJsonSchema,
  type OrganizationActor,
  type OrganizationCommandFailure,
  type OrganizationLifecycleFailure,
  type OrganizationPersonAuthority,
  type TeamInterestFilter,
} from "@vektorprogrammet/domain/organization";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { ProfileFailure } from "@vektorprogrammet/domain/profile";
import {
  CreateDepartmentEndpoint,
  CreateDepartmentRequest,
  CreateFieldOfStudyEndpoint,
  CreateFieldOfStudyRequest,
  CreateTeamEndpoint,
  CreateTeamRequest,
  DelegationCommand,
  DelegationManagement,
  ExecuteDelegationEndpoint,
  ExecuteOrganizationLifecycleEndpoint,
  ExternalNativeApi,
  ListDepartmentsEndpoint,
  ListFieldOfStudiesEndpoint,
  ListMailingListsEndpoint,
  ListTeamInterestEndpoint,
  ListTeamsEndpoint,
  MailingListResponse,
  ReadAppointmentManagementEndpoint,
  ReadDelegationManagementEndpoint,
  reflectAccessSpec,
  TeamInterestResponse,
} from "@vektorprogrammet/http-api";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/http-api/http-semantics";
import { DateTime, Effect, flow, Match, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  organizationActorFrom,
  resolveRequestCredentialInTransaction,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import {
  authorizeAnonymous,
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  conditionalJson,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  requestInvalid,
  requireNoQuery,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  PRIVATE_NO_STORE,
  PUBLIC_CACHE_CONTROL,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
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

const organizationUnavailable = () => Problem.make("organization.unavailable");

/**
 * The one answer for every organization failure. The store answers
 * organization.unavailable whether it could not be reached or refused its own
 * record; mailing lists read their recipients through the profile store.
 */
const organizationProblems = problemMapper<
  OrganizationCommandFailure | OrganizationLifecycleFailure | ProfileFailure
>()({
  OrganizationLifecycleFailure: ({ code }) =>
    Match.value(code).pipe(
      Match.whenOr("Denied", "SelfDisable", "LastAdministrator", () =>
        Problem.make("authority.denied"),
      ),
      Match.when("NotFound", () => Problem.make("resource.not-found")),
      Match.when("Stale", () => Problem.make("precondition.failed")),
      Match.when("Conflict", () => Problem.make("idempotency.digest-conflict")),
      Match.when("Invalid", requestInvalid),
      Match.when("Unavailable", organizationUnavailable),
      Match.exhaustive,
    ),
  OrganizationRoleDenied: () => Problem.make("authority.denied"),
  OrganizationInvalidReference: () => Problem.make("organization.invalid-reference"),
  OrganizationCommandConflict: () => Problem.make("idempotency.digest-conflict"),
  OrganizationDecodeError: organizationUnavailable,
  OrganizationPersistenceError: organizationUnavailable,
  ProfileDecodeError: organizationUnavailable,
  ProfileQueryLimitExceeded: organizationUnavailable,
  ProfileNotFound: organizationUnavailable,
  ProfileContactNotFound: organizationUnavailable,
  ProfileStaleRevision: organizationUnavailable,
  ProfileCommandConflict: organizationUnavailable,
  ProfilePersistenceError: organizationUnavailable,
});

/**
 * A person credential rejected after ingress is answered from the request's
 * own evidence; a failed identity engine leaves organization unavailable.
 */
const credentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: organizationUnavailable,
  });

/**
 * Commands and appointment management answer any query as an invalid request.
 */
const rejectQuery = (request: Request) =>
  requireNoQuery(request).pipe(Effect.mapError(requestInvalid));

/** The UTF-8 text of a body of at most `maxBytes`, or undefined past that bound. */
const readBoundedText = async (request: Request, maxBytes: number) => {
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

        return undefined;
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
};

/**
 * Reads one bounded JSON command body. Organization commands answer every
 * body they cannot read, including one of another media type, as an invalid
 * request.
 */
const readCommandBody = (request: Request, maxBytes: number) =>
  Effect.gen(function* () {
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) {
      return yield* requestInvalid();
    }

    const declared = request.headers.get("content-length");

    if (declared !== null) {
      if (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared))) {
        return yield* requestInvalid();
      }

      if (Number(declared) > maxBytes) return yield* Problem.make("request.too-large");
    }

    const text = yield* Effect.tryPromise({
      try: () => readBoundedText(request, maxBytes),
      catch: requestInvalid,
    });

    if (text === undefined) return yield* Problem.make("request.too-large");

    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
      Effect.mapError(requestInvalid),
    );
  });

/**
 * Reads a response value through its contract schema. Domain layers return model instances,
 * which canonical JSON refuses; the contract decode yields the plain resource. A value outside
 * the contract leaves organization unavailable.
 */
const responseJson = <S extends Schema.ConstraintDecoder<Schema.Json, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(organizationUnavailable),
  );

/**
 * Encodes a private read through its contract schema; no shared cache may store it.
 */
const privateReadJson = <S extends Schema.ConstraintDecoder<Schema.Json, never>>(schema: S) =>
  flow(
    responseJson(schema),
    Effect.map(
      (decoded) =>
        new Response(JSON.stringify(decoded), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": PRIVATE_NO_STORE,
          },
        }),
    ),
  );

const listDepartments = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymous(
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
    yield* requireNoQuery(request);

    const departments = yield* Organization.use(({ listDepartments }) => listDepartments).pipe(
      organizationProblems,
      Effect.flatMap(responseJson(Schema.Array(DepartmentJsonSchema))),
    );

    return yield* conditionalJson({
      request,
      body: departments,
      etag: deriveStrongETag({
        representationKind: "DepartmentListResponse",
        resourceIdentity: new URL(request.url).pathname,
        version: departments.map((row) => [row.departmentId, row.revision] as const),
      }),
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  });

const listTeams = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymous(
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
    yield* requireNoQuery(request);

    const teams = yield* Organization.use(({ listTeams }) => listTeams()).pipe(
      organizationProblems,
      Effect.flatMap(responseJson(Schema.Array(TeamJsonSchema))),
    );

    return yield* conditionalJson({
      request,
      body: teams,
      etag: deriveStrongETag({
        representationKind: "TeamListResponse",
        resourceIdentity: new URL(request.url).pathname,
        version: teams.map((row) => [row.teamId, row.revision] as const),
      }),
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  });

const listFieldOfStudies = (request: Request) =>
  Effect.gen(function* () {
    yield* authorizeAnonymous(
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
    yield* requireNoQuery(request);

    const fieldOfStudies = yield* Organization.use(
      ({ listFieldOfStudies }) => listFieldOfStudies,
    ).pipe(
      organizationProblems,
      Effect.flatMap(responseJson(Schema.Array(FieldOfStudyJsonSchema))),
    );

    return yield* conditionalJson({
      request,
      body: fieldOfStudies,
      etag: deriveStrongETag({
        representationKind: "FieldOfStudyListResponse",
        resourceIdentity: new URL(request.url).pathname,
        version: fieldOfStudies.map((row) => [row.fieldOfStudyId, row.revision] as const),
      }),
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  });

/** The 201 receipt of one created organization resource. */
const createdCapsule = (
  resource: Schema.Json,
  location: string,
  etag: StrongETag,
): NativeHttpResponseCapsule => ({
  status: 201,
  mediaType: "application/json",
  headers: { "content-type": "application/json", location, etag },
  bodyBytes: jsonBodyBytes(resource),
});

/**
 * Resolves the caller's current authority inside the command transaction,
 * evaluates the create AccessSpec for it, and derives the command identity.
 */
const authorizeCreate = (input: {
  readonly request: Request;
  readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
  readonly operationId: string;
  readonly target: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly presentation: CredentialPresentation;
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveRequestPersonAuthorityInTransaction(input.request, {});
    const actor = organizationActorFrom(resolved.authority);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
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
        grantScopes: Predicate.isTagged(actor, "OrganizationAdministrator") ? [Scope.Global()] : [],
        now: resolved.authorizationInstant,
      },
      input.presentation,
    );

    const identity = yield* httpIdentity({
      credentialSubject: `Person:${actor.personId}`,
      qualifiedOperationId: input.operationId,
      normalizedTarget: input.target,
      idempotencyKey: input.idempotencyKey,
    });

    return { actor, identity };
  });

const createDepartment = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQuery(request);

    const payload = yield* readCommandBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(CreateDepartmentRequest)),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);
    const operationId = "organization.createDepartment";

    // Domain and credential failures are mapped after the executor, with its receipt failures.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const { actor, identity } = yield* authorizeCreate({
          request,
          endpoint: CreateDepartmentEndpoint,
          operationId,
          target: "/api/departments",
          idempotencyKey,
          presentation,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Organization.use((organization) =>
            organization.createDepartment(
              CreateDepartmentCommandSchema.make({
                commandId: OrganizationCommandId.make(identity.commandId),
                ...payload,
              }),
              actor,
            ),
          ).pipe(
            Effect.flatMap(({ observation }) =>
              responseJson(DepartmentJsonSchema)(
                Predicate.isTagged(observation, "Replayed")
                  ? observation.original.department
                  : observation.department,
              ),
            ),
            Effect.map((department) =>
              createdCapsule(
                department,
                `/api/departments/${encodePathIdentity(department.departmentId)}`,
                deriveStrongETag({
                  representationKind: "DepartmentJson",
                  resourceIdentity: department.departmentId,
                  version: department.revision,
                }),
              ),
            ),
          ),
        };
      }),
    ).pipe(
      organizationProblems,
      commandReceiptProblems,
      credentialProblems(presentation),
      // A person AccessSpec reveals every denial; none is concealed as absent.
      unreachable("resource.not-found"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const createTeam = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQuery(request);

    const payload = yield* readCommandBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(CreateTeamRequest)),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);
    const operationId = "organization.createTeam";

    // Domain and credential failures are mapped after the executor, with its receipt failures.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const { actor, identity } = yield* authorizeCreate({
          request,
          endpoint: CreateTeamEndpoint,
          operationId,
          target: "/api/teams",
          idempotencyKey,
          presentation,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Organization.use((organization) =>
            organization.createTeam(
              CreateTeamCommandSchema.make({
                commandId: OrganizationCommandId.make(identity.commandId),
                ...payload,
              }),
              actor,
            ),
          ).pipe(
            Effect.flatMap(({ observation }) =>
              responseJson(TeamJsonSchema)(
                Predicate.isTagged(observation, "Replayed")
                  ? observation.original.team
                  : observation.team,
              ),
            ),
            Effect.map((team) =>
              createdCapsule(
                team,
                `/api/teams/${encodePathIdentity(team.teamId)}`,
                deriveStrongETag({
                  representationKind: "TeamJson",
                  resourceIdentity: team.teamId,
                  version: team.revision,
                }),
              ),
            ),
          ),
        };
      }),
    ).pipe(
      organizationProblems,
      commandReceiptProblems,
      credentialProblems(presentation),
      // A person AccessSpec reveals every denial; none is concealed as absent.
      unreachable("resource.not-found"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const createFieldOfStudy = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQuery(request);

    const payload = yield* readCommandBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(CreateFieldOfStudyRequest)),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);
    const operationId = "organization.createFieldOfStudy";

    // Domain and credential failures are mapped after the executor, with its receipt failures.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const { actor, identity } = yield* authorizeCreate({
          request,
          endpoint: CreateFieldOfStudyEndpoint,
          operationId,
          target: "/api/field-of-studies",
          idempotencyKey,
          presentation,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: payload }),
            operationId,
          },
          execute: Organization.use((organization) =>
            organization.createFieldOfStudy(
              CreateFieldOfStudyCommandSchema.make({
                commandId: OrganizationCommandId.make(identity.commandId),
                ...payload,
              }),
              actor,
            ),
          ).pipe(
            Effect.flatMap(({ observation }) =>
              responseJson(FieldOfStudyJsonSchema)(
                Predicate.isTagged(observation, "Replayed")
                  ? observation.original.fieldOfStudy
                  : observation.fieldOfStudy,
              ),
            ),
            Effect.map((fieldOfStudy) =>
              createdCapsule(
                fieldOfStudy,
                `/api/field-of-studies/${encodePathIdentity(fieldOfStudy.fieldOfStudyId)}`,
                deriveStrongETag({
                  representationKind: "FieldOfStudyJson",
                  resourceIdentity: fieldOfStudy.fieldOfStudyId,
                  version: fieldOfStudy.revision,
                }),
              ),
            ),
          ),
        };
      }),
    ).pipe(
      organizationProblems,
      commandReceiptProblems,
      credentialProblems(presentation),
      // A person AccessSpec reveals every denial; none is concealed as absent.
      unreachable("resource.not-found"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

const MailingListTypeSchema = Schema.Literals(["assistants", "team", "all"]);

/**
 * One optional query identity; a value outside its schema is a malformed request.
 */
const optionalQueryIdentity = <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  name: "department" | "semester",
  schema: S,
): Effect.Effect<S["Type"] | undefined, Problem<"request.malformed">> => {
  const value = new URL(request.url).searchParams.get(name);

  return value === null
    ? Effect.undefined
    : Schema.decodeEffect(schema)(value).pipe(
        Effect.mapError(() => Problem.make("request.malformed")),
      );
};

/**
 * Spec 0059/0060 gating: the departments where the person holds the capability through a board
 * leadership, a delegation or the global-administrator grant. A reach over the whole organization
 * authorizes every department, also while there is none.
 */
const authorizedDepartmentScope = (
  authority: OrganizationPersonAuthority,
  capability: "people.read" | "team-interest.read",
) =>
  Effect.gen(function* () {
    const reached = reachedDepartments(authority, capability);

    if (ReachedDepartments.$is("Departments")(reached))
      return { organizationWide: false, departmentIds: reached.departmentIds };

    const departments = yield* Organization.use(({ listDepartments }) => listDepartments);

    return {
      organizationWide: true,
      departmentIds: departments.map((department) => department.departmentId),
    };
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
      : Effect.fail(Problem.make("authority.denied"));

/** Unknown department reference denies with 422 before any data leaves the store. */
const assertDepartmentsExist = (departmentIds: ReadonlyArray<DepartmentId>) =>
  Organization.use(({ listDepartments }) => listDepartments).pipe(
    Effect.flatMap((known) => {
      for (const requested of departmentIds) {
        if (!known.some((department) => department.departmentId === requested)) {
          return Effect.fail(Problem.make("organization.invalid-reference"));
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
  readonly teams?: ReadonlyArray<{ readonly teamId: TeamId; readonly departmentId: DepartmentId }>;
  readonly presentation: CredentialPresentation;
}) => {
  const global = input.authority.globalAdministrator === "Active";
  const teams = input.teams ?? [];
  const authorityVersion = `organization:${input.authority.evaluatedAt}`;
  const unscoped = global && input.departmentIds.length === 0 && teams.length === 0;

  const contexts = unscoped
    ? [
        genericContext({
          domainId: "organization",
          facts: { departmentAdministratorPersonIds: [input.authority.personId] },
          authorityVersion,
        }),
      ]
    : [
        ...input.departmentIds.map((departmentId) =>
          genericContext({
            domainId: "organization",
            departmentId,
            facts: { departmentAdministratorPersonIds: [input.authority.personId] },
            authorityVersion,
          }),
        ),
        ...teams.map(({ teamId, departmentId }) =>
          genericContext({
            domainId: "organization",
            departmentId,
            resourceKind: "organization-team",
            resourceId: teamId,
            authorityVersion,
          }),
        ),
      ];

  const scopes = unscoped
    ? [Scope.Global()]
    : [
        ...input.departmentIds.map((departmentId) => Scope.Department({ departmentId })),
        ...teams.map(({ teamId }) =>
          Scope.Resource({
            resource: {
              kind: ResourceKind.make("organization-team"),
              id: ResourceId.make(teamId),
            },
          }),
        ),
      ];

  return authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
      request: input.request,
      personId: input.authority.personId,
      resolution: { selection: "AllMatching", contexts },
      grantScopes: scopes,
      now: input.authority.evaluatedAt,
    },
    input.presentation,
  );
};

const listTeamInterest = (request: Request, input: OrganizationApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const authority = yield* input.resolveAuthority(request);
    const requested = yield* optionalQueryIdentity(request, "department", DepartmentId);
    // An authenticated caller without team-interest reach receives a typed denial, never an
    // empty success (spec 0059 authorization boundary). A team's current leader reads the
    // registrations of that team; department reach reads the whole department.
    const scope = yield* authorizedDepartmentScope(authority, "team-interest.read");
    const departmentScope = scope.departmentIds;

    const teamScope = reachedTeams(authority, "team-interest.read").flatMap((teamId) => {
      const membership = authority.memberships.find((entry) => entry.teamId === teamId);

      return membership === undefined ? [] : [{ teamId, departmentId: membership.departmentId }];
    });

    if (!scope.organizationWide && departmentScope.length === 0 && teamScope.length === 0) {
      return yield* Problem.make("authority.denied");
    }

    const authorizedTeams = teamScope.filter(
      (team) =>
        (requested === undefined || team.departmentId === requested) &&
        !departmentScope.includes(team.departmentId),
    );

    const authorized =
      requested === undefined
        ? departmentScope
        : departmentScope.includes(requested)
          ? [requested]
          : authorizedTeams.length > 0
            ? []
            : yield* Problem.make("authority.denied");

    yield* authorizeOrganizationCollection({
      request,
      authority,
      endpoint: ListTeamInterestEndpoint,
      departmentIds: authorized,
      teams: authorizedTeams,
      presentation,
    });

    // Unknown department reference denies with 422 before any data leaves the store.
    if (requested !== undefined) yield* assertDepartmentsExist([requested]);

    const filter: TeamInterestFilter = {
      authorizedDepartmentIds: authorized,
      authorizedTeamIds: authorizedTeams.map(({ teamId }) => teamId),
      semesterId: yield* optionalQueryIdentity(request, "semester", SemesterId),
    };

    const rows = yield* Organization.use(({ listTeamInterestRegistrations }) =>
      listTeamInterestRegistrations(filter),
    );

    return yield* privateReadJson(TeamInterestResponse)({
      "hydra:member": rows.map((row) => ({
        id: row.registrationId,
        userName: row.submitterName,
        teamName: row.teamName,
      })),
      "hydra:totalItems": rows.length,
    });
  }).pipe(
    organizationProblems,
    credentialProblems(presentation),
    // A person AccessSpec reveals every denial; none is concealed as absent.
    unreachable("resource.not-found"),
  );
};

const listMailingLists = (request: Request, input: OrganizationApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const type = yield* Schema.decodeUnknownEffect(MailingListTypeSchema)(
      new URL(request.url).searchParams.get("type") ?? "assistants",
    ).pipe(Effect.mapError(() => Problem.make("request.malformed")));

    const authority = yield* input.resolveAuthority(request);
    const requested = yield* optionalQueryIdentity(request, "department", DepartmentId);
    const scope = yield* authorizedDepartmentScope(authority, "people.read");

    if (!scope.organizationWide && scope.departmentIds.length === 0) {
      return yield* Problem.make("authority.denied");
    }

    const authorized = yield* narrowScopeOrThrow(scope.departmentIds, requested);

    if (requested !== undefined) yield* assertDepartmentsExist([requested]);
    yield* authorizeOrganizationCollection({
      request,
      authority,
      endpoint: ListMailingListsEndpoint,
      departmentIds: authorized,
      presentation,
    });
    const semesterId = yield* optionalQueryIdentity(request, "semester", SemesterId);

    const lists = yield* Organization.use(({ projectMailingLists }) =>
      projectMailingLists({
        type,
        actorPersonId: authority.personId,
        authorizationInstant: authority.evaluatedAt,
        departmentId: requested,
        semesterId,
      }),
    );

    return yield* privateReadJson(MailingListResponse)(lists);
  }).pipe(
    organizationProblems,
    credentialProblems(presentation),
    // A person AccessSpec reveals every denial; none is concealed as absent.
    unreachable("resource.not-found"),
  );
};

const readAppointmentManagement = (request: Request) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* rejectQuery(request);
    const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

    if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
      return yield* Problem.unauthenticated(presentation);
    }

    const personId = resolved.credential.principal.personId;

    const snapshot = yield* Organization.use((service) =>
      service.readAppointmentManagement(personId),
    );

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadAppointmentManagementEndpoint)),
        credential: resolved.credential,
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
        now: resolved.authorizationInstant,
      },
      presentation,
    );

    return yield* privateReadJson(AppointmentManagement)(snapshot);
  }).pipe(organizationProblems, credentialProblems(presentation));
};

const executeLifecycle = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQuery(request);

    const command = yield* readCommandBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(OrganizationLifecycleCommand)),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    // A command replays under its own identifier only.
    if (command.commandId !== idempotencyKey) {
      return yield* Problem.make("idempotency.digest-conflict");
    }

    const presentation = personPresentation(request);

    // Domain and credential failures are mapped after the executor, whose serialization
    // retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

        if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
          return yield* Problem.unauthenticated(presentation);
        }

        const personId = resolved.credential.principal.personId;

        // Authority, history and both receipts commit in this ambient transaction.
        const result = yield* Organization.use((service) =>
          service.executeLifecycle(command, personId),
        );

        const current = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");
        yield* authorizePerson(
          {
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
          },
          presentation,
        );

        // An accepted person, the decoded key, and the fixed operation and target always derive one.
        const identity = yield* httpIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: "organization.executeLifecycle",
          normalizedTarget: "/api/organization/appointments/commands",
          idempotencyKey,
        }).pipe(unreachable("request.malformed", "idempotency-key.invalid"));

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId: "organization.executeLifecycle",
          },
          execute: Effect.succeed<NativeHttpResponseCapsule>({
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
    ).pipe(organizationProblems, commandReceiptProblems, credentialProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

const readDelegationManagement = (request: Request) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* rejectQuery(request);
    const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

    if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
      return yield* Problem.unauthenticated(presentation);
    }

    const personId = resolved.credential.principal.personId;

    const snapshot = yield* Organization.use((service) =>
      service.readDelegationManagement(personId),
    );

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadDelegationManagementEndpoint)),
        credential: resolved.credential,
        personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "organization",
              authorityVersion: "delegation-management",
            }),
          ],
        },
        grantScopes: [Scope.Global()],
        now: resolved.authorizationInstant,
      },
      presentation,
    );

    return yield* privateReadJson(DelegationManagement)(snapshot);
  }).pipe(organizationProblems, credentialProblems(presentation));
};

const executeDelegation = (request: Request, input: OrganizationApiHttpOptions) =>
  Effect.gen(function* () {
    yield* rejectQuery(request);

    const command = yield* readCommandBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(DelegationCommand)),
    );

    const idempotencyKey = yield* idempotencyKeyOf(request);

    // A command replays under its own identifier only.
    if (command.commandId !== idempotencyKey) {
      return yield* Problem.make("idempotency.digest-conflict");
    }

    const presentation = personPresentation(request);

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

        if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
          return yield* Problem.unauthenticated(presentation);
        }

        const personId = resolved.credential.principal.personId;

        // Authority, history and both receipts commit in this ambient transaction.
        const result = yield* Organization.use((service) =>
          service.executeDelegation(command, personId),
        );

        const current = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");
        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(ExecuteDelegationEndpoint)),
            credential: current.credential,
            personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                genericContext({
                  domainId: "organization",
                  authorityVersion: "delegation-management",
                }),
              ],
            },
            grantScopes: [Scope.Global()],
            now: current.authorizationInstant,
          },
          presentation,
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: "organization.executeDelegation",
          normalizedTarget: "/api/organization/delegations/commands",
          idempotencyKey,
        }).pipe(unreachable("request.malformed", "idempotency-key.invalid"));

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: command }),
            operationId: "organization.executeDelegation",
          },
          execute: Effect.succeed<NativeHttpResponseCapsule>({
            status: 200,
            mediaType: "application/json",
            headers: {
              "content-type": "application/json",
              etag: deriveStrongETag({
                representationKind: "DelegationResult",
                resourceIdentity: result.delegationId,
                version: result.revision,
              }),
            },
            bodyBytes: jsonBodyBytes(result),
          }),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(organizationProblems, commandReceiptProblems, credentialProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

/** Native HttpApi implementations for organization endpoints. */
export const OrganizationApiHandlers = (input: OrganizationApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "organization", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readAppointmentManagement", ({ request }) =>
          webHandler(request, readAppointmentManagement),
        )
        .handleRaw("executeLifecycle", ({ request }) =>
          webHandler(request, (webRequest) => executeLifecycle(webRequest, input)),
        )
        .handleRaw("readDelegationManagement", ({ request }) =>
          webHandler(request, readDelegationManagement),
        )
        .handleRaw("executeDelegation", ({ request }) =>
          webHandler(request, (webRequest) => executeDelegation(webRequest, input)),
        )
        .handleRaw("listDepartments", ({ request }) => webHandler(request, listDepartments))
        .handleRaw("listTeams", ({ request }) => webHandler(request, listTeams))
        .handleRaw("listFieldOfStudies", ({ request }) => webHandler(request, listFieldOfStudies))
        .handleRaw("listTeamInterest", ({ request }) =>
          webHandler(request, (webRequest) => listTeamInterest(webRequest, input)),
        )
        .handleRaw("listMailingLists", ({ request }) =>
          webHandler(request, (webRequest) => listMailingLists(webRequest, input)),
        )
        .handleRaw("createDepartment", ({ request }) =>
          webHandler(request, (webRequest) => createDepartment(webRequest, input)),
        )
        .handleRaw("createTeam", ({ request }) =>
          webHandler(request, (webRequest) => createTeam(webRequest, input)),
        )
        .handleRaw("createFieldOfStudy", ({ request }) =>
          webHandler(request, (webRequest) => createFieldOfStudy(webRequest, input)),
        ),
    ),
  );
