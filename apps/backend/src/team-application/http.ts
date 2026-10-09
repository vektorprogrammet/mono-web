/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Database } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ResourceId,
  ResourceKind,
  Scope,
  type CanonicalScopeResolution,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationAction,
  TeamApplicationCommandId,
  TeamApplications,
  ReviseTeamApplicationIntakeCommand,
  type TeamApplicationActor,
  type TeamApplicationDeleteFailure,
  type TeamApplicationId,
  type TeamApplicationIntake,
  type TeamApplicationPrincipal,
  type TeamApplicationPublicReadFailure,
  type TeamApplicationReadFailure,
  type TeamApplicationReviseFailure,
  type TeamApplicationSubmitFailure,
} from "@vektorprogrammet/domain/team-application";
import {
  deleteTeamApplication,
  ExternalNativeApi,
  listTeamApplicationIntakes,
  listTeamApplications,
  readTeamApplication,
  readTeamApplicationIntake,
  reflectAccessSpec,
  reviseTeamApplicationIntake,
  submitTeamApplication,
  TeamApplicationInput,
  TeamApplicationIntakeMergePatch,
  TeamApplicationsApi,
} from "@vektorprogrammet/http-api";
import {
  type CredentialPresentation,
  makeNativeValidationError,
  type NativeValidationError,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Context, Effect, Option, Predicate, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import type { HttpApiGroup } from "effect/http-api";
import {
  TeamApplicationsApiHandlers as GeneratedTeamApplicationsApiHandlers,
  type TeamApplicationsGuards,
  type TeamApplicationsRawHandlers,
} from "../../.effx/generated/team-applications-handlers.js";
import { currentInstant, resolveRequestCredentialInTransaction } from "../authority.js";
import type { TeamApplicationApiConfig } from "../config.js";
import {
  authorizeAnonymous,
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  readJsonBody,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import { publicRateLimitKey } from "../http-api/public-rate-limit.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "../http-api/receipt-transaction.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  normalizeTarget,
  NO_STORE,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";

/** Seven bounded fields; the free-text fields dominate at 10 000 characters each. */
const MAX_SUBMISSION_BYTES = 131_072;

const MAX_INTAKE_PATCH_BYTES = 4_096;

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

interface StaffPrincipal {
  readonly credential: AcceptedCredential;
  readonly principal: TeamApplicationPrincipal;
}

type TeamApplicationsEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["team-applications"]
>;

type TeamApplicationsEndpoint = HttpApiGroup.Endpoints<typeof TeamApplicationsApi>;

type StaffEndpoint =
  | typeof listTeamApplications
  | typeof readTeamApplication
  | typeof deleteTeamApplication
  | typeof reviseTeamApplicationIntake;

const teamOperationId = (endpoint: TeamApplicationsEndpoint) =>
  `${TeamApplicationsApi.identifier}.${endpoint.identifier}` as const;

/** A guard reads only the decision created for this raw request at the original access point. */
type TeamApplicationAccessFrame =
  | {
      readonly kind: "Public";
      readonly operation: ReturnType<typeof teamOperationId>;
      readonly source: HttpServerRequest.HttpServerRequest;
      readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
      readonly now: string;
    }
  | {
      readonly kind: "Staff";
      readonly operation: ReturnType<typeof teamOperationId>;
      readonly source: HttpServerRequest.HttpServerRequest;
      readonly request: Request;
      readonly staff: StaffPrincipal;
      readonly actor: TeamApplicationActor;
      readonly selection: "ExactlyOne" | "AllMatching";
    };

const CurrentTeamApplicationAccess = Context.Reference<TeamApplicationAccessFrame | undefined>(
  "@vektorprogrammet/backend/team-application/current-access",
  { defaultValue: () => undefined },
);

/** The one answer for every team-application domain failure. */
const teamApplicationProblems = problemMapper<
  | TeamApplicationPublicReadFailure
  | TeamApplicationSubmitFailure
  | TeamApplicationReadFailure
  | TeamApplicationDeleteFailure
  | TeamApplicationReviseFailure
>()({
  TeamApplicationTeamNotFound: () => Problem.make("resource.not-found"),
  TeamApplicationNotFound: () => Problem.make("resource.not-found"),
  TeamApplicationIntakeClosed: () => Problem.make("team-application.intake-closed"),
  TeamApplicationAccessDenied: () => Problem.make("authority.denied"),
  TeamApplicationCommandConflict: () => Problem.make("idempotency.digest-conflict"),
  TeamApplicationInvalidCursor: () => Problem.make("request.malformed"),
  TeamApplicationPersistenceError: (failure) =>
    failure.conflict ? Problem.make("transaction.conflict") : Problem.make("internal.error"),
});

/** A staff credential rejected inside the transaction is answered from the request's evidence. */
const staffCredentialProblems = (presentation: CredentialPresentation) =>
  problemMapper<UnauthenticatedActor | IdentityEngineError>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
  });

const json = (body: Schema.Json, cacheControl: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
      vary: "Origin",
    },
  });

const intakeETag = (teamId: TeamId, revision: number) =>
  deriveStrongETag({
    representationKind: "TeamApplicationIntake",
    resourceIdentity: teamId,
    version: revision,
  });

const intakeResource = (teamId: TeamId, intake: TeamApplicationIntake) => ({
  ...intake,
  etag: intakeETag(teamId, intake.revision),
});

const jsonCapsule = (
  status: 200 | 201,
  body: Schema.Json,
  headers: { readonly etag: string; readonly location?: string },
): NativeHttpResponseCapsule => ({
  status,
  mediaType: "application/json",
  headers: { ...headers, "content-type": "application/json" },
  bodyBytes: jsonBodyBytes(body),
});

/** Resolves the current Person credential through the caller's transaction at one instant. */
const staffPrincipal = (request: Request) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(request, "OAuthUserBearer");

    const principal = authenticated.credential.principal;

    if (!Predicate.isTagged(principal, "Person")) {
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    }

    return {
      credential: authenticated.credential,
      principal: {
        personId: principal.personId,
        authorizationInstant: authenticated.authorizationInstant,
      },
    } satisfies StaffPrincipal;
  });

/** Evaluates the declared AccessSpec against the team the domain actor was resolved for. */
const authorizeStaff = (
  endpoint: StaffEndpoint,
  staff: StaffPrincipal,
  actor: TeamApplicationActor,
  selection: "ExactlyOne" | "AllMatching",
  presentation: CredentialPresentation,
) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: staff.credential,
      personId: staff.principal.personId,
      resolution: {
        selection,
        contexts: [
          genericContext({
            domainId: "team-applications",
            resourceKind: "organization-team",
            resourceId: actor.teamId,
            authorityVersion: `team-applications:${actor._tag}:${staff.principal.authorizationInstant}`,
          }),
        ],
      },
      grantScopes: [
        Scope.Resource({
          resource: {
            kind: ResourceKind.make("organization-team"),
            id: ResourceId.make(actor.teamId),
          },
        }),
      ],
      now: staff.principal.authorizationInstant,
    },
    presentation,
  );

/** Public authority is evaluated by the generated callback, never at raw-handler entry. */
const publicGuard = (
  endpoint:
    | typeof readTeamApplicationIntake
    | typeof listTeamApplicationIntakes
    | typeof submitTeamApplication,
  source: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const frame = yield* CurrentTeamApplicationAccess;

    if (
      frame === undefined ||
      frame.kind !== "Public" ||
      frame.operation !== teamOperationId(endpoint) ||
      frame.source !== source
    ) {
      return yield* Effect.die(
        new TypeError("TeamApplications public guard has no matching request decision"),
      );
    }

    return yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(endpoint)),
      frame.resolution,
      frame.now,
    );
  });

/** Staff authority uses the actor resolved in this request's read snapshot or write prepare. */
const staffGuard = (endpoint: StaffEndpoint, source: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const frame = yield* CurrentTeamApplicationAccess;

    if (
      frame === undefined ||
      frame.kind !== "Staff" ||
      frame.operation !== teamOperationId(endpoint) ||
      frame.source !== source
    ) {
      return yield* Effect.die(
        new TypeError("TeamApplications staff guard has no matching request decision"),
      );
    }

    return yield* authorizeStaff(
      endpoint,
      frame.staff,
      frame.actor,
      frame.selection,
      personPresentation(frame.request),
    );
  });

const teamApplicationGuards = {
  "team-applications.deleteTeamApplication": (request) =>
    staffGuard(deleteTeamApplication, request),
  "team-applications.listTeamApplicationIntakes": (request) =>
    publicGuard(listTeamApplicationIntakes, request),
  "team-applications.listTeamApplications": (request) => staffGuard(listTeamApplications, request),
  "team-applications.readTeamApplication": (request) => staffGuard(readTeamApplication, request),
  "team-applications.readTeamApplicationIntake": (request) =>
    publicGuard(readTeamApplicationIntake, request),
  "team-applications.reviseTeamApplicationIntake": (request) =>
    staffGuard(reviseTeamApplicationIntake, request).pipe(unreachable("resource.not-found")),
  "team-applications.submitTeamApplication": (request) =>
    publicGuard(submitTeamApplication, request),
} satisfies TeamApplicationsGuards<TeamApplicationsEndpoints>;

type Authorize<Operation extends keyof typeof teamApplicationGuards> = () => ReturnType<
  (typeof teamApplicationGuards)[Operation]
>;

const snapshotRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        return yield* effect;
      }),
    ),
  ).pipe(Effect.catchTag("SqlError", () => Effect.fail(Problem.make("internal.error"))));

const JsonObject = Schema.Record(Schema.String, Schema.Json);

/** Field-level pointers for a rejected submission, without echoing rejected values. */
const submissionErrors = (body: Schema.Json): ReadonlyArray<NativeValidationError> => {
  const record = Schema.decodeUnknownOption(JsonObject)(body);

  if (Option.isNone(record)) return [makeNativeValidationError("", "invalid")];

  const errors: Array<NativeValidationError> = [];

  if (Object.keys(record.value).some((key) => !Object.hasOwn(TeamApplicationInput.fields, key))) {
    errors.push(makeNativeValidationError("", "unknown"));
  }

  for (const [field, schema] of Object.entries(TeamApplicationInput.fields)) {
    if (!Object.hasOwn(record.value, field)) {
      errors.push(makeNativeValidationError(`/${field}`, "missing"));
    } else if (!Schema.is(schema)(record.value[field])) {
      errors.push(makeNativeValidationError(`/${field}`, "invalid"));
    }
  }

  return errors;
};

const readIntake = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  teamId: TeamId,
  authorize: Authorize<"team-applications.readTeamApplicationIntake">,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorize().pipe(
      Effect.provideService(CurrentTeamApplicationAccess, {
        kind: "Public",
        operation: teamOperationId(readTeamApplicationIntake),
        source,
        resolution: {
          selection: "ExactlyOne",
          contexts: [
            genericContext({
              domainId: "team-applications",
              resourceKind: "organization-team",
              resourceId: teamId,
              authorityVersion: `team-application-intake:${instant}`,
            }),
          ],
        },
        now: instant,
      }),
    );

    // A public read runs no serializable transaction, so it cannot lose a conflict.
    const intake = yield* TeamApplications.use((service) => service.readPublicIntake(teamId)).pipe(
      teamApplicationProblems,
      unreachable("transaction.conflict"),
    );

    return json(intake, NO_STORE);
  });

const listIntakes = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  authorize: Authorize<"team-applications.listTeamApplicationIntakes">,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorize().pipe(
      Effect.provideService(CurrentTeamApplicationAccess, {
        kind: "Public",
        operation: teamOperationId(listTeamApplicationIntakes),
        source,
        resolution: {
          selection: "AllMatching",
          contexts: [
            genericContext({
              domainId: "team-applications",
              authorityVersion: `team-application-intakes:${instant}`,
            }),
          ],
        },
        now: instant,
      }),
    );

    const intakes = yield* TeamApplications.use((service) => service.listPublicIntakes).pipe(
      teamApplicationProblems,
      unreachable("transaction.conflict"),
    );

    return json(intakes, NO_STORE);
  });

const submit = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  teamId: TeamId,
  config: TeamApplicationApiConfig,
  authorize: Authorize<"team-applications.submitTeamApplication">,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const arrivedAt = yield* currentInstant(undefined);

    // Counted before the body is read, so an over-limit caller costs no parsing or storage.
    if (!config.rateLimit.consume(publicRateLimitKey(request), arrivedAt)) {
      return yield* Problem.rateLimited(config.retryAfterSeconds);
    }

    const body = yield* readJsonBody(
      request,
      /^application\/json(?:\s*;|$)/iu,
      MAX_SUBMISSION_BYTES,
    );

    const decoded = Schema.decodeUnknownOption(TeamApplicationInput)(body, {
      onExcessProperty: "error",
    });

    if (Option.isNone(decoded)) {
      return yield* Problem.validation("validation.failed", submissionErrors(body));
    }

    const idempotencyKey = yield* idempotencyKeyOf(request);

    const operationId = teamOperationId(submitTeamApplication);

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const instant = yield* currentInstant(undefined);

        yield* authorize().pipe(
          Effect.provideService(CurrentTeamApplicationAccess, {
            kind: "Public",
            operation: operationId,
            source,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                genericContext({
                  domainId: "team-applications",
                  resourceKind: "organization-team",
                  resourceId: teamId,
                  authorityVersion: `team-application-create:${instant}`,
                }),
              ],
            },
            now: instant,
          }),
        );

        const identity = yield* httpIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget("/api/teams/{teamId}/applications", { teamId }),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: decoded.value }),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.submit({
              commandId: TeamApplicationCommandId.make(identity.commandId),
              teamId,
              application: decoded.value,
            }),
          ).pipe(
            Effect.map(({ confirmation }) =>
              jsonCapsule(201, confirmation, {
                etag: deriveStrongETag({
                  representationKind: "TeamApplicationConfirmation",
                  resourceIdentity: confirmation.applicationId,
                  version: 0,
                }),
                location: `/api/team-applications/${encodePathIdentity(confirmation.applicationId)}`,
              }),
            ),
          ),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(teamApplicationProblems, commandReceiptProblems);

    return yield* commandOutcomeResponse(outcome);
  });

const cursorQuery = (request: Request) =>
  Effect.suspend(() => {
    const parameters = new URL(request.url).searchParams;
    const keys = [...parameters.keys()];

    return keys.some((key) => key !== "cursor") || parameters.getAll("cursor").length > 1
      ? Effect.fail(Problem.make("request.malformed"))
      : Effect.succeed(parameters.get("cursor") ?? undefined);
  });

const listApplications = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  teamId: TeamId,
  authorize: Authorize<"team-applications.listTeamApplications">,
) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      const cursor = yield* cursorQuery(request);
      const staff = yield* staffPrincipal(request);

      // A read-only snapshot cannot lose a serialization conflict.
      const page = yield* TeamApplications.use((service) =>
        service.listApplications(staff.principal, teamId, cursor),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict"));

      yield* authorize().pipe(
        Effect.provideService(CurrentTeamApplicationAccess, {
          kind: "Staff",
          operation: teamOperationId(listTeamApplications),
          source,
          request,
          staff,
          actor: page.actor,
          selection: "AllMatching",
        }),
      );

      const body = {
        teamId: page.teamId,
        teamName: page.teamName,
        items: page.items,
        intake: intakeResource(page.teamId, page.intake),
        canManage: Predicate.isTagged(page.actor, "TeamLeader"),
      };

      return json(
        page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
        PRIVATE_NO_STORE,
      );
    }),
  ).pipe(staffCredentialProblems(presentation));
};

const readApplication = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  applicationId: TeamApplicationId,
  authorize: Authorize<"team-applications.readTeamApplication">,
) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      yield* requireNoQuery(request);
      const staff = yield* staffPrincipal(request);

      // A read-only snapshot cannot lose a serialization conflict.
      const view = yield* TeamApplications.use((service) =>
        service.readApplication(staff.principal, applicationId),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict"));

      yield* authorize().pipe(
        Effect.provideService(CurrentTeamApplicationAccess, {
          kind: "Staff",
          operation: teamOperationId(readTeamApplication),
          source,
          request,
          staff,
          actor: view.actor,
          selection: "ExactlyOne",
        }),
      );

      return json(
        {
          ...view.application,
          teamName: view.teamName,
          canManage: Predicate.isTagged(view.actor, "TeamLeader"),
        },
        PRIVATE_NO_STORE,
      );
    }),
  ).pipe(staffCredentialProblems(presentation));
};

const deleteApplication = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  applicationId: TeamApplicationId,
  authorize: Authorize<"team-applications.deleteTeamApplication">,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);

    const operationId = teamOperationId(deleteTeamApplication);

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const staff = yield* staffPrincipal(request);

        // Authority is current before any stored response can be replayed.
        const actor = yield* TeamApplications.use((service) =>
          service.authorize(
            staff.principal,
            TeamApplicationAction.DeleteTeamApplication({ applicationId }),
          ),
        );

        yield* authorize().pipe(
          Effect.provideService(CurrentTeamApplicationAccess, {
            kind: "Staff",
            operation: operationId,
            source,
            request,
            staff,
            actor,
            selection: "ExactlyOne",
          }),
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${staff.principal.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget("/api/team-applications/{applicationId}", {
            applicationId,
          }),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({}),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.deleteApplication(
              { commandId: TeamApplicationCommandId.make(identity.commandId), applicationId },
              staff.principal,
            ),
          ).pipe(
            Effect.as<NativeHttpResponseCapsule>({
              status: 204,
              mediaType: null,
              headers: {},
              bodyBytes: null,
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(teamApplicationProblems, commandReceiptProblems, staffCredentialProblems(presentation));

    return yield* commandOutcomeResponse(outcome);
  });

const reviseIntake = (
  request: Request,
  source: HttpServerRequest.HttpServerRequest,
  teamId: TeamId,
  authorize: Authorize<"team-applications.reviseTeamApplicationIntake">,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readJsonBody(
      request,
      /^application\/merge-patch\+json(?:\s*;|$)/iu,
      MAX_INTAKE_PATCH_BYTES,
    );

    const decoded = Schema.decodeUnknownOption(TeamApplicationIntakeMergePatch)(body, {
      onExcessProperty: "error",
    });

    if (Option.isNone(decoded)) {
      return yield* Problem.validation("validation.failed", [
        makeNativeValidationError("", "invalid"),
      ]);
    }

    const patch = decoded.value;

    if (patch.acceptApplication === undefined && patch.deadline === undefined) {
      return yield* Problem.validation("validation.no-change", [
        makeNativeValidationError("", "no-change"),
      ]);
    }

    if (patch.acceptApplication === null) {
      return yield* Problem.validation("validation.field-not-deletable", [
        makeNativeValidationError("/acceptApplication", "field-not-deletable"),
      ]);
    }

    const ifMatch = yield* requiredIfMatchOf(request);

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);

    const operationId = teamOperationId(reviseTeamApplicationIntake);

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const staff = yield* staffPrincipal(request);

        // Authority is current before any stored response can be replayed.
        const actor = yield* TeamApplications.use((service) =>
          service.authorize(
            staff.principal,
            TeamApplicationAction.ReviseTeamApplicationIntake({ teamId }),
          ),
        );

        yield* authorize().pipe(
          Effect.provideService(CurrentTeamApplicationAccess, {
            kind: "Staff",
            operation: operationId,
            source,
            request,
            staff,
            actor,
            selection: "ExactlyOne",
          }),
        );

        const identity = yield* httpIdentity({
          credentialSubject: `Person:${staff.principal.personId}`,
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget("/api/teams/{teamId}/application-intake", {
            teamId,
          }),
          idempotencyKey,
        });

        const command = yield* Schema.decodeUnknownEffect(ReviseTeamApplicationIntakeCommand)(
          { ...patch, commandId: identity.commandId, teamId },
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(() =>
            Problem.validation("validation.failed", [makeNativeValidationError("", "invalid")]),
          ),
        );

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.reviseIntake(command, staff.principal, (current) =>
              requireCurrentETag(intakeETag(teamId, current.revision), ifMatch),
            ),
          ).pipe(
            Effect.map(({ intake }) => {
              const resource = intakeResource(teamId, intake);

              return jsonCapsule(200, resource, { etag: resource.etag });
            }),
          ),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(
      teamApplicationProblems,
      commandReceiptProblems,
      staffCredentialProblems(presentation),
      // authorize answers an unknown team on revise with an authority denial.
      unreachable("resource.not-found"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

/** Each raw endpoint runs its generated guard at the original domain decision point. */
const makeTeamApplicationsRawHandlers = (config: TeamApplicationApiConfig) =>
  ({
    deleteTeamApplication: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        deleteApplication(webRequest, request, params.applicationId, authorize),
      ),
    listTeamApplicationIntakes: ({ request }, authorize) =>
      webHandler(request, (webRequest) => listIntakes(webRequest, request, authorize)),
    listTeamApplications: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        listApplications(webRequest, request, params.teamId, authorize),
      ),
    readTeamApplication: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        readApplication(webRequest, request, params.applicationId, authorize),
      ),
    readTeamApplicationIntake: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        readIntake(webRequest, request, params.teamId, authorize),
      ),
    reviseTeamApplicationIntake: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        reviseIntake(webRequest, request, params.teamId, authorize),
      ),
    submitTeamApplication: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        submit(webRequest, request, params.teamId, config, authorize),
      ),
  }) satisfies TeamApplicationsRawHandlers<TeamApplicationsEndpoints, typeof teamApplicationGuards>;

/** Native HttpApi handlers for public team intake and staff review. */
export const TeamApplicationsApiHandlers = (config: TeamApplicationApiConfig) =>
  GeneratedTeamApplicationsApiHandlers({
    raw: makeTeamApplicationsRawHandlers(config),
    guards: teamApplicationGuards,
  });
