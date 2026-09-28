/**
 * The OrganizationRpcs handlers.
 *
 * The public directories evaluate their anonymous AccessSpecs and read the store. The scoped reads
 * resolve the caller's authority at one instant, require the team-interest or people reach, and
 * evaluate the RPC's AccessSpec over the scope that they read. A create command resolves the
 * caller's authority inside the transaction that commits it, mints
 * `OrganizationAdministratorEvidence`, and stores its success as a command receipt, so a retry with
 * the same idempotency key replays the first answer. Appointment and delegation commands commit
 * their authority, history, and receipts in that transaction too.
 */
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  reachedDepartments,
  ReachedDepartments,
  ResourceId,
  ResourceKind,
  Scope,
} from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  CreateDepartmentCommandSchema,
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  type DepartmentId,
  mapOrganizationAuthorityToOrganizationActor,
  Organization,
  OrganizationCommandId,
  type OrganizationCommandFailure,
  type OrganizationLifecycleFailure,
  type OrganizationPersonAuthority,
  type PersonId,
  requireOrganizationAdministrator,
  requireTeamInterestScope,
  type TeamId,
} from "@vektorprogrammet/domain/organization";
import type { ProfileFailure } from "@vektorprogrammet/domain/profile";
import {
  AppointmentManagement,
  BoardRosters,
  CreateDepartment,
  CreateFieldOfStudy,
  CreateTeam,
  DelegationManagement,
  DelegationResult,
  DepartmentJsonSchema,
  ExecuteDelegation,
  ExecuteLifecycle,
  FieldOfStudyJsonSchema,
  ListDepartments,
  ListFieldOfStudies,
  ListMailingLists,
  ListTeamInterest,
  ListTeams,
  MailingListResponse,
  OrganizationLifecycleResult,
  OrganizationRpcs,
  ReadAppointmentManagement,
  ReadBoardRosters,
  ReadDelegationManagement,
  reflectAccessSpec,
  TeamInterestResponse,
  TeamJsonSchema,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  Problem,
} from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, flow, Match, Option, Predicate, Result, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import {
  resolveRequestCredentialInTransaction,
  resolveRequestPersonAuthority,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import { semanticRequestDigest } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizeAnonymous,
  authorizePerson,
  commandIdentity,
  commandOutcome,
  commandReceiptProblems,
  personPresentation,
  problemMapper,
  requestInvalid,
  unreachable,
} from "../rpc/problem.js";
import { executeNativeHttpCommandPostgres, successCapsule } from "../rpc/receipt-transaction.js";

type AnnotatedRpc = Pick<Rpc.AnyWithProps, "annotations">;

const organizationUnavailable = () => Problem.make("organization.unavailable");

/**
 * The one answer for every organization failure. The store answers organization.unavailable
 * whether it could not be reached or refused its own record; mailing lists read their recipients
 * through the profile store.
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
 * A person credential rejected after ingress is answered from the request's own evidence; a
 * failed identity engine leaves organization unavailable.
 */
const credentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: organizationUnavailable,
  });

/**
 * Reads a response value through its contract schema. Domain layers return model instances; the
 * contract decode yields the plain resource. A value outside the contract leaves organization
 * unavailable.
 */
const responseJson = <S extends Schema.ConstraintDecoder<Schema.Json, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(organizationUnavailable),
  );

/** Evaluates the anonymous AccessSpec of one public directory at the current instant. */
const authorizePublicList = (rpc: AnnotatedRpc, authorityVersion: string) =>
  Effect.gen(function* () {
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(rpc)),
      {
        selection: "AllMatching",
        contexts: [genericContext({ domainId: "organization", authorityVersion })],
      },
      DateTime.formatIso(yield* DateTime.now),
    );
  });

/**
 * Resolves the caller's current authority inside the command transaction, evaluates the create
 * AccessSpec for it, mints the administrator evidence, and derives the command identity.
 */
const authorizeCreate = (input: {
  readonly headers: Headers.Headers;
  readonly options: NativeRpcOptions;
  readonly rpc: AnnotatedRpc;
  readonly operationId: string;
  readonly target: string;
  readonly idempotencyKey: IdempotencyKey;
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveRequestPersonAuthorityInTransaction(
      credentialRequestOf(input.headers),
      { now: input.options.now },
    );

    const personId = resolved.authority.personId;
    const administrator = requireOrganizationAdministrator(resolved.authority);

    // The AccessSpec answers a denial; the evidence is what the command takes.
    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
        credential: resolved.credential,
        personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "organization",
              authorityVersion: `organization:${mapOrganizationAuthorityToOrganizationActor(resolved.authority)._tag}`,
            }),
          ],
        },
        grantScopes: Result.isSuccess(administrator) ? [Scope.Global()] : [],
        now: resolved.authorizationInstant,
      },
      personPresentation(input.headers),
    );

    const evidence = yield* Effect.fromResult(administrator);

    // The HTTP route stays the normalized target, so receipts and command IDs are stable.
    const identity = yield* commandIdentity({
      credentialSubject: `Person:${personId}`,
      qualifiedOperationId: input.operationId,
      normalizedTarget: input.target,
      idempotencyKey: input.idempotencyKey,
    });

    return { administrator: evidence, identity };
  });

/**
 * The departments where the person holds the capability through a board leadership, a delegation
 * or the global-administrator grant. A reach over the whole organization authorizes every
 * department, also while there is none.
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

/** Narrows the authorized scope to one department; a department outside it is denied. */
const narrowScope = (
  authorized: ReadonlyArray<DepartmentId>,
  departmentId: DepartmentId | undefined,
) =>
  departmentId === undefined
    ? Effect.succeed(authorized)
    : authorized.some((authorizedId) => authorizedId === departmentId)
      ? Effect.succeed([departmentId])
      : Effect.fail(Problem.make("authority.denied"));

/** An unknown department answers organization.invalid-reference before data leaves the store. */
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

/** Evaluates a scoped collection read's AccessSpec over every department and team it reads. */
const authorizeOrganizationCollection = (input: {
  readonly headers: Headers.Headers;
  readonly authority: OrganizationPersonAuthority;
  readonly rpc: AnnotatedRpc;
  readonly departmentIds: ReadonlyArray<DepartmentId>;
  readonly teams?: ReadonlyArray<{ readonly teamId: TeamId; readonly departmentId: DepartmentId }>;
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
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      request: credentialRequestOf(input.headers),
      personId: input.authority.personId,
      resolution: { selection: "AllMatching", contexts },
      grantScopes: scopes,
      now: input.authority.evaluatedAt,
    },
    personPresentation(input.headers),
  );
};

/**
 * Resolves the reader's current credential, reads one management snapshot for that person, and
 * evaluates the RPC's AccessSpec with a global grant: the snapshot holds only what the person
 * manages.
 */
const readManagement = <S extends Schema.ConstraintDecoder<Schema.Json, never>>(input: {
  readonly headers: Headers.Headers;
  readonly rpc: AnnotatedRpc;
  readonly authorityVersion: string;
  readonly response: S;
  readonly read: (
    personId: PersonId,
  ) => Effect.Effect<unknown, OrganizationLifecycleFailure, Organization>;
}) => {
  const presentation = personPresentation(input.headers);

  return Effect.gen(function* () {
    const resolved = yield* resolveRequestCredentialInTransaction(
      credentialRequestOf(input.headers),
      "OAuthUserBearer",
    );

    if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
      return yield* Problem.unauthenticated(presentation);
    }

    const personId = resolved.credential.principal.personId;
    const snapshot = yield* input.read(personId);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
        credential: resolved.credential,
        personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({ domainId: "organization", authorityVersion: input.authorityVersion }),
          ],
        },
        grantScopes: [Scope.Global()],
        now: resolved.authorizationInstant,
      },
      presentation,
    );

    return yield* responseJson(input.response)(snapshot);
  }).pipe(organizationProblems, credentialProblems(presentation));
};

/**
 * Runs one appointment or delegation command. The domain commits authority, history, and its own
 * receipt in the command transaction, and the RPC's AccessSpec is evaluated against the
 * credential as it stands after the command.
 */
const executeManagementCommand = <S extends Schema.Codec<unknown, unknown, never, never>>(input: {
  readonly headers: Headers.Headers;
  readonly rpc: AnnotatedRpc;
  readonly operationId: string;
  readonly target: string;
  readonly authorityVersion: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandId: string;
  readonly request: Schema.Json;
  readonly success: S;
  readonly execute: (
    personId: PersonId,
  ) => Effect.Effect<S["Type"], OrganizationLifecycleFailure, Organization>;
}) =>
  Effect.gen(function* () {
    // A command replays under its own identifier only.
    if (input.commandId !== input.idempotencyKey) {
      return yield* Problem.make("idempotency.digest-conflict");
    }

    const presentation = personPresentation(input.headers);
    const request = credentialRequestOf(input.headers);

    // Domain and credential failures are mapped after the executor, whose serialization retry
    // reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

        if (!Predicate.isTagged(resolved.credential.principal, "Person")) {
          return yield* Problem.unauthenticated(presentation);
        }

        const personId = resolved.credential.principal.personId;

        // Authority, history and both receipts commit in this ambient transaction.
        const result = yield* input.execute(personId);

        const current = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
            credential: current.credential,
            personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                genericContext({
                  domainId: "organization",
                  authorityVersion: input.authorityVersion,
                }),
              ],
            },
            grantScopes: [Scope.Global()],
            now: current.authorizationInstant,
          },
          presentation,
        );

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: `Person:${personId}`,
          qualifiedOperationId: input.operationId,
          normalizedTarget: input.target,
          idempotencyKey: input.idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: input.request }),
            operationId: input.operationId,
          },
          execute: successCapsule(input.success)(result),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(organizationProblems, commandReceiptProblems, credentialProblems(presentation));

    return yield* commandOutcome(input.success)(outcome);
  });

/** The OrganizationRpcs handlers. */
export const OrganizationRpcHandlers = (options: NativeRpcOptions) =>
  OrganizationRpcs.toLayer({
    "organization.listDepartments": () =>
      Effect.gen(function* () {
        yield* authorizePublicList(ListDepartments, "organization-public-departments");

        return yield* Organization.use(({ listDepartments }) => listDepartments).pipe(
          organizationProblems,
          Effect.flatMap(responseJson(Schema.Array(DepartmentJsonSchema))),
        );
      }),

    "organization.listTeams": () =>
      Effect.gen(function* () {
        yield* authorizePublicList(ListTeams, "organization-public-teams");

        return yield* Organization.use(({ listTeams }) => listTeams()).pipe(
          organizationProblems,
          Effect.flatMap(responseJson(Schema.Array(TeamJsonSchema))),
        );
      }),

    "organization.listFieldOfStudies": () =>
      Effect.gen(function* () {
        yield* authorizePublicList(ListFieldOfStudies, "organization-public-field-of-studies");

        return yield* Organization.use(({ listFieldOfStudies }) => listFieldOfStudies).pipe(
          organizationProblems,
          Effect.flatMap(responseJson(Schema.Array(FieldOfStudyJsonSchema))),
        );
      }),

    "organization.listTeamInterest": ({ departmentId, semesterId }, { headers }) =>
      Effect.gen(function* () {
        const authority = yield* resolveRequestPersonAuthority(credentialRequestOf(headers), {
          now: options.now,
        });

        const departments = yield* Organization.use(({ listDepartments }) => listDepartments);

        // An authenticated caller without team-interest reach receives a typed denial, never an
        // empty success. A team's current leader reads the registrations of that team;
        // department reach reads the whole department.
        const scope = yield* Effect.fromResult(
          requireTeamInterestScope(authority, {
            requested: departmentId,
            departments: departments.map((department) => department.departmentId),
          }),
        ).pipe(Effect.mapError(() => Problem.make("authority.denied")));

        yield* authorizeOrganizationCollection({
          headers,
          authority,
          rpc: ListTeamInterest,
          departmentIds: scope.departmentIds,
          teams: scope.teams,
        });

        // An unknown department reference is refused before any data leaves the store.
        if (departmentId !== undefined) yield* assertDepartmentsExist([departmentId]);

        const rows = yield* Organization.use(({ listTeamInterestRegistrations }) =>
          listTeamInterestRegistrations(scope, semesterId),
        );

        return yield* responseJson(TeamInterestResponse)({
          "hydra:member": rows.map((row) => ({
            id: row.registrationId,
            userName: row.submitterName,
            teamName: row.teamName,
          })),
          "hydra:totalItems": rows.length,
        });
      }).pipe(
        organizationProblems,
        credentialProblems(personPresentation(headers)),
        // A person AccessSpec reveals every denial; none is concealed as absent.
        unreachable("resource.not-found"),
      ),

    "organization.listMailingLists": ({ departmentId, semesterId, type }, { headers }) =>
      Effect.gen(function* () {
        const authority = yield* resolveRequestPersonAuthority(credentialRequestOf(headers), {
          now: options.now,
        });

        const scope = yield* authorizedDepartmentScope(authority, "people.read");

        if (!scope.organizationWide && scope.departmentIds.length === 0) {
          return yield* Problem.make("authority.denied");
        }

        const authorized = yield* narrowScope(scope.departmentIds, departmentId);

        if (departmentId !== undefined) yield* assertDepartmentsExist([departmentId]);

        yield* authorizeOrganizationCollection({
          headers,
          authority,
          rpc: ListMailingLists,
          departmentIds: authorized,
        });

        const lists = yield* Organization.use(({ projectMailingLists }) =>
          projectMailingLists({
            type: type ?? "assistants",
            actorPersonId: authority.personId,
            authorizationInstant: authority.evaluatedAt,
            departmentId,
            semesterId,
          }),
        );

        return yield* responseJson(MailingListResponse)(lists);
      }).pipe(
        organizationProblems,
        credentialProblems(personPresentation(headers)),
        // A person AccessSpec reveals every denial; none is concealed as absent.
        unreachable("resource.not-found"),
      ),

    "organization.createDepartment": ({ idempotencyKey, request }, { headers }) =>
      Effect.gen(function* () {
        const operationId = "organization.createDepartment";

        // Domain and credential failures are mapped after the executor, with its receipt failures.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const { administrator, identity } = yield* authorizeCreate({
              headers,
              options,
              rpc: CreateDepartment,
              operationId,
              target: "/api/departments",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest({ body: request }),
                operationId,
              },
              execute: Organization.use((organization) =>
                organization.createDepartment(
                  CreateDepartmentCommandSchema.make({
                    commandId: OrganizationCommandId.make(identity.commandId),
                    ...request,
                  }),
                  administrator,
                ),
              ).pipe(
                Effect.flatMap(({ observation }) =>
                  responseJson(DepartmentJsonSchema)(
                    Predicate.isTagged(observation, "Replayed")
                      ? observation.original.department
                      : observation.department,
                  ),
                ),
                Effect.flatMap(successCapsule(DepartmentJsonSchema)),
              ),
            };
          }),
        ).pipe(
          organizationProblems,
          commandReceiptProblems,
          credentialProblems(personPresentation(headers)),
          // A person AccessSpec reveals every denial; none is concealed as absent.
          unreachable("resource.not-found"),
        );

        return yield* commandOutcome(DepartmentJsonSchema)(outcome);
      }),

    "organization.createTeam": ({ idempotencyKey, request }, { headers }) =>
      Effect.gen(function* () {
        const operationId = "organization.createTeam";

        // Domain and credential failures are mapped after the executor, with its receipt failures.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const { administrator, identity } = yield* authorizeCreate({
              headers,
              options,
              rpc: CreateTeam,
              operationId,
              target: "/api/teams",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest({ body: request }),
                operationId,
              },
              execute: Organization.use((organization) =>
                organization.createTeam(
                  CreateTeamCommandSchema.make({
                    commandId: OrganizationCommandId.make(identity.commandId),
                    ...request,
                  }),
                  administrator,
                ),
              ).pipe(
                Effect.flatMap(({ observation }) =>
                  responseJson(TeamJsonSchema)(
                    Predicate.isTagged(observation, "Replayed")
                      ? observation.original.team
                      : observation.team,
                  ),
                ),
                Effect.flatMap(successCapsule(TeamJsonSchema)),
              ),
            };
          }),
        ).pipe(
          organizationProblems,
          commandReceiptProblems,
          credentialProblems(personPresentation(headers)),
          // A person AccessSpec reveals every denial; none is concealed as absent.
          unreachable("resource.not-found"),
        );

        return yield* commandOutcome(TeamJsonSchema)(outcome);
      }),

    "organization.createFieldOfStudy": ({ idempotencyKey, request }, { headers }) =>
      Effect.gen(function* () {
        const operationId = "organization.createFieldOfStudy";

        // Domain and credential failures are mapped after the executor, with its receipt failures.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const { administrator, identity } = yield* authorizeCreate({
              headers,
              options,
              rpc: CreateFieldOfStudy,
              operationId,
              target: "/api/field-of-studies",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest({ body: request }),
                operationId,
              },
              execute: Organization.use((organization) =>
                organization.createFieldOfStudy(
                  CreateFieldOfStudyCommandSchema.make({
                    commandId: OrganizationCommandId.make(identity.commandId),
                    ...request,
                  }),
                  administrator,
                ),
              ).pipe(
                Effect.flatMap(({ observation }) =>
                  responseJson(FieldOfStudyJsonSchema)(
                    Predicate.isTagged(observation, "Replayed")
                      ? observation.original.fieldOfStudy
                      : observation.fieldOfStudy,
                  ),
                ),
                Effect.flatMap(successCapsule(FieldOfStudyJsonSchema)),
              ),
            };
          }),
        ).pipe(
          organizationProblems,
          commandReceiptProblems,
          credentialProblems(personPresentation(headers)),
          // A person AccessSpec reveals every denial; none is concealed as absent.
          unreachable("resource.not-found"),
        );

        return yield* commandOutcome(FieldOfStudyJsonSchema)(outcome);
      }),

    "organization.readAppointmentManagement": (_payload, { headers }) =>
      readManagement({
        headers,
        rpc: ReadAppointmentManagement,
        authorityVersion: "appointment-management",
        response: AppointmentManagement,
        read: (personId) =>
          Organization.use((service) => service.readAppointmentManagement(personId)),
      }),

    "organization.readBoardRosters": (_payload, { headers }) =>
      readManagement({
        headers,
        rpc: ReadBoardRosters,
        authorityVersion: "appointment-management",
        response: BoardRosters,
        read: (personId) => Organization.use((service) => service.readBoardRosters(personId)),
      }),

    "organization.executeLifecycle": ({ idempotencyKey, request }, { headers }) =>
      executeManagementCommand({
        headers,
        rpc: ExecuteLifecycle,
        operationId: "organization.executeLifecycle",
        target: "/api/organization/appointments/commands",
        authorityVersion: "appointment-management",
        idempotencyKey,
        commandId: request.commandId,
        request,
        success: OrganizationLifecycleResult,
        execute: (personId) =>
          Organization.use((service) => service.executeLifecycle(request, personId)),
      }),

    "organization.readDelegationManagement": (_payload, { headers }) =>
      readManagement({
        headers,
        rpc: ReadDelegationManagement,
        authorityVersion: "delegation-management",
        response: DelegationManagement,
        read: (personId) =>
          Organization.use((service) => service.readDelegationManagement(personId)),
      }),

    "organization.executeDelegation": ({ idempotencyKey, request }, { headers }) =>
      executeManagementCommand({
        headers,
        rpc: ExecuteDelegation,
        operationId: "organization.executeDelegation",
        target: "/api/organization/delegations/commands",
        authorityVersion: "delegation-management",
        idempotencyKey,
        commandId: request.commandId,
        request,
        success: DelegationResult,
        execute: (personId) =>
          Organization.use((service) => service.executeDelegation(request, personId)),
      }),
  });
