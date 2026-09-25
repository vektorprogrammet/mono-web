import { Database } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ResourceId,
  ResourceKind,
  Scope,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import type { TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationAccessDenied,
  TeamApplicationAction,
  TeamApplicationCommandConflict,
  TeamApplicationCommandId,
  TeamApplicationIntakeClosed,
  TeamApplicationInvalidCursor,
  TeamApplicationNotFound,
  TeamApplicationPersistenceError,
  TeamApplications,
  TeamApplicationTeamNotFound,
  ReviseTeamApplicationIntakeCommand,
  type TeamApplicationActor,
  type TeamApplicationId,
  type TeamApplicationIntake,
  type TeamApplicationPrincipal,
} from "@vektorprogrammet/domain/team-application";
import {
  DeleteTeamApplicationEndpoint,
  ExternalNativeApi,
  ListTeamApplicationIntakesEndpoint,
  ListTeamApplicationsEndpoint,
  ReadTeamApplicationEndpoint,
  ReadTeamApplicationIntakeEndpoint,
  reflectAccessSpec,
  ReviseTeamApplicationIntakeEndpoint,
  SubmitTeamApplicationEndpoint,
  TeamApplicationInput,
  TeamApplicationIntakeMergePatch,
} from "@vektorprogrammet/http-api";
import {
  makeNativeValidationError,
  nativeUserChallenges,
  type NativeValidationError,
} from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { currentInstant, resolveRequestCredentialInTransaction } from "../authority.js";
import { readBoundedJson } from "../http-api/read-json.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptPersistenceError,
  type NativeHttpResponseCapsule,
} from "../http-api/receipt-transaction.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  deriveHttpIdentity,
  deriveStrongETag,
  encodePathIdentity,
  evaluateMutationPrecondition,
  HttpSemanticFailure,
  jsonBodyBytes,
  nativeProblemResponse,
  normalizeTarget,
  NO_STORE,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
  validationProblemResponse,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";

/** Seven bounded fields; the free-text fields dominate at 10 000 characters each. */
const MAX_SUBMISSION_BYTES = 131_072;

const MAX_INTAKE_PATCH_BYTES = 4_096;

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

interface StaffPrincipal {
  readonly credential: AcceptedCredential;
  readonly principal: TeamApplicationPrincipal;
}

type StaffEndpoint =
  | typeof ListTeamApplicationsEndpoint
  | typeof ReadTeamApplicationEndpoint
  | typeof DeleteTeamApplicationEndpoint
  | typeof ReviseTeamApplicationIntakeEndpoint;

const semantic = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new HttpSemanticFailure("internal.error", 500),
  });

const headerValues = (request: Request, name: string) =>
  request.headers.has(name) ? [request.headers.get(name)!] : [];

const requireNoQuery = (request: Request) =>
  new URL(request.url).search === ""
    ? Effect.void
    : Effect.fail(new HttpSemanticFailure("request.malformed", 400));

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
) =>
  authorizePersonNativeOperation({
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
  });

const snapshotRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;

        return yield* effect;
      }),
    ),
  );

const readJsonBody = (request: Request, mediaType: RegExp, maxBytes: number) =>
  Effect.gen(function* () {
    if (!mediaType.test(request.headers.get("content-type") ?? "")) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }

    return yield* readBoundedJson(request, maxBytes);
  });

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

const readIntake = (request: Request, teamId: TeamId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorizeAnonymousNativeOperation(
      Option.getOrThrow(reflectAccessSpec(ReadTeamApplicationIntakeEndpoint)),
      {
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
      instant,
    );

    const intake = yield* TeamApplications.use((service) => service.readPublicIntake(teamId));

    return json(intake, NO_STORE);
  });

const listIntakes = (request: Request) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorizeAnonymousNativeOperation(
      Option.getOrThrow(reflectAccessSpec(ListTeamApplicationIntakesEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          genericContext({
            domainId: "team-applications",
            authorityVersion: `team-application-intakes:${instant}`,
          }),
        ],
      },
      instant,
    );

    const intakes = yield* TeamApplications.use((service) => service.listPublicIntakes);

    return json(intakes, NO_STORE);
  });

const submit = (request: Request, teamId: TeamId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readJsonBody(
      request,
      /^application\/json(?:\s*;|$)/iu,
      MAX_SUBMISSION_BYTES,
    );

    const decoded = Schema.decodeUnknownOption(TeamApplicationInput)(body, {
      onExcessProperty: "error",
    });

    if (Option.isNone(decoded)) {
      return validationProblemResponse("validation.failed", submissionErrors(body));
    }

    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(headerValues(request, "idempotency-key")),
    );

    const operationId = "team-applications.submitTeamApplication";

    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const instant = yield* currentInstant(undefined);

        yield* authorizeAnonymousNativeOperation(
          Option.getOrThrow(reflectAccessSpec(SubmitTeamApplicationEndpoint)),
          {
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
          instant,
        );

        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: "Anonymous",
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/teams/{teamId}/applications", { teamId }),
            idempotencyKey,
          }),
        );

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
    );

    return nativeCommandOutcomeResponse(outcome);
  });

const cursorQuery = (request: Request) =>
  semantic(() => {
    const parameters = new URL(request.url).searchParams;
    const keys = [...parameters.keys()];

    if (keys.some((key) => key !== "cursor") || parameters.getAll("cursor").length > 1) {
      throw new HttpSemanticFailure("request.malformed", 400);
    }

    return parameters.get("cursor") ?? undefined;
  });

const listApplications = (request: Request, teamId: TeamId) =>
  snapshotRead(
    Effect.gen(function* () {
      const cursor = yield* cursorQuery(request);
      const staff = yield* staffPrincipal(request);

      const page = yield* TeamApplications.use((service) =>
        service.listApplications(staff.principal, teamId, cursor),
      );

      yield* authorizeStaff(ListTeamApplicationsEndpoint, staff, page.actor, "AllMatching");

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
  );

const readApplication = (request: Request, applicationId: TeamApplicationId) =>
  snapshotRead(
    Effect.gen(function* () {
      yield* requireNoQuery(request);
      const staff = yield* staffPrincipal(request);

      const view = yield* TeamApplications.use((service) =>
        service.readApplication(staff.principal, applicationId),
      );

      yield* authorizeStaff(ReadTeamApplicationEndpoint, staff, view.actor, "ExactlyOne");

      return json(
        {
          ...view.application,
          teamName: view.teamName,
          canManage: Predicate.isTagged(view.actor, "TeamLeader"),
        },
        PRIVATE_NO_STORE,
      );
    }),
  );

const deleteApplication = (request: Request, applicationId: TeamApplicationId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(headerValues(request, "idempotency-key")),
    );

    const operationId = "team-applications.deleteTeamApplication";

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

        yield* authorizeStaff(DeleteTeamApplicationEndpoint, staff, actor, "ExactlyOne");

        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: `Person:${staff.principal.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/team-applications/{applicationId}", {
              applicationId,
            }),
            idempotencyKey,
          }),
        );

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
    );

    return nativeCommandOutcomeResponse(outcome);
  });

const reviseIntake = (request: Request, teamId: TeamId) =>
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
      return validationProblemResponse("validation.failed", [
        makeNativeValidationError("", "invalid"),
      ]);
    }

    const patch = decoded.value;

    if (patch.acceptApplication === undefined && patch.deadline === undefined) {
      return validationProblemResponse("validation.no-change", [
        makeNativeValidationError("", "no-change"),
      ]);
    }

    if (patch.acceptApplication === null) {
      return validationProblemResponse("validation.field-not-deletable", [
        makeNativeValidationError("/acceptApplication", "field-not-deletable"),
      ]);
    }

    const ifMatch = yield* semantic(() => parseRequiredIfMatch(headerValues(request, "if-match")));

    const idempotencyKey = yield* semantic(() =>
      parseIdempotencyKey(headerValues(request, "idempotency-key")),
    );

    const operationId = "team-applications.reviseTeamApplicationIntake";

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

        yield* authorizeStaff(ReviseTeamApplicationIntakeEndpoint, staff, actor, "ExactlyOne");

        const identity = yield* semantic(() =>
          deriveHttpIdentity({
            credentialSubject: `Person:${staff.principal.personId}`,
            qualifiedOperationId: operationId,
            normalizedTarget: normalizeTarget("/api/teams/{teamId}/application-intake", {
              teamId,
            }),
            idempotencyKey,
          }),
        );

        const command = yield* Schema.decodeUnknownEffect(ReviseTeamApplicationIntakeCommand)(
          { ...patch, commandId: identity.commandId, teamId },
          { onExcessProperty: "error" },
        ).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.reviseIntake(
              command,
              staff.principal,
              (current): Effect.Effect<void, HttpSemanticFailure> => {
                const precondition = evaluateMutationPrecondition(
                  intakeETag(teamId, current.revision),
                  ifMatch,
                );

                return Predicate.isTagged(precondition, "Failed")
                  ? Effect.fail(new HttpSemanticFailure(precondition.code, precondition.status))
                  : Effect.void;
              },
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
    );

    return nativeCommandOutcomeResponse(outcome);
  });

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    (Predicate.hasProperty(cause, "reason") &&
      (Predicate.isTagged(cause.reason, "SerializationError") ||
        Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && serializationConflict(cause.cause, depth + 1)));

/** Maps typed failures to the declared problems once, without leaking causes. */
const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(
      cause.code,
      cause.status,
      cause.status === 401 ? { "www-authenticate": nativeUserChallenges() } : undefined,
    );
  }

  if (cause instanceof UnauthenticatedActor) {
    return nativeProblemResponse("credential.invalid", 401, {
      "www-authenticate": nativeUserChallenges(),
    });
  }

  if (cause instanceof TeamApplicationAccessDenied) {
    return nativeProblemResponse("authority.denied", 403);
  }

  if (cause instanceof TeamApplicationNotFound || cause instanceof TeamApplicationTeamNotFound) {
    return nativeProblemResponse("resource.not-found", 404);
  }

  if (cause instanceof TeamApplicationIntakeClosed) {
    return nativeProblemResponse("team-application.intake-closed", 409);
  }

  if (cause instanceof TeamApplicationCommandConflict) {
    return nativeProblemResponse("idempotency.digest-conflict", 409);
  }

  if (cause instanceof TeamApplicationInvalidCursor) {
    return nativeProblemResponse("request.malformed", 400);
  }

  if (
    (cause instanceof TeamApplicationPersistenceError && cause.conflict) ||
    (cause instanceof NativeHttpReceiptPersistenceError && serializationConflict(cause))
  ) {
    return nativeProblemResponse("transaction.conflict", 409);
  }

  if (cause instanceof NativeHttpReceiptPersistenceError) {
    return nativeProblemResponse("idempotency.unavailable", 503);
  }

  return nativeProblemResponse("internal.error", 500);
};

/** Native HttpApi handlers for public team intake and staff review. */
export const TeamApplicationsApiHandlers = HttpApiBuilder.group(
  ExternalNativeApi,
  "team-applications",
  (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readTeamApplicationIntake", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readIntake(webRequest, params.teamId),
            errorResponse,
          ),
        )
        .handleRaw("listTeamApplicationIntakes", ({ request }) =>
          toHttpApiResponse(request, listIntakes, errorResponse),
        )
        .handleRaw("submitTeamApplication", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submit(webRequest, params.teamId),
            errorResponse,
          ),
        )
        .handleRaw("listTeamApplications", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listApplications(webRequest, params.teamId),
            errorResponse,
          ),
        )
        .handleRaw("readTeamApplication", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readApplication(webRequest, params.applicationId),
            errorResponse,
          ),
        )
        .handleRaw("deleteTeamApplication", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => deleteApplication(webRequest, params.applicationId),
            errorResponse,
          ),
        )
        .handleRaw("reviseTeamApplicationIntake", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseIntake(webRequest, params.teamId),
            errorResponse,
          ),
        ),
    ),
);
