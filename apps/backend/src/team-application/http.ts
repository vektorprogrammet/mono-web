import { Database } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ResourceId,
  ResourceKind,
  Scope,
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
  type CredentialPresentation,
  makeNativeValidationError,
  type NativeValidationError,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
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

type StaffEndpoint =
  | typeof ListTeamApplicationsEndpoint
  | typeof ReadTeamApplicationEndpoint
  | typeof DeleteTeamApplicationEndpoint
  | typeof ReviseTeamApplicationIntakeEndpoint;

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

const readIntake = (request: Request, teamId: TeamId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorizeAnonymous(
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

    // A public read runs no serializable transaction, so it cannot lose a conflict.
    const intake = yield* TeamApplications.use((service) => service.readPublicIntake(teamId)).pipe(
      teamApplicationProblems,
      unreachable("transaction.conflict"),
    );

    return json(intake, NO_STORE);
  });

const listIntakes = (request: Request) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const instant = yield* currentInstant(undefined);

    yield* authorizeAnonymous(
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

    const intakes = yield* TeamApplications.use((service) => service.listPublicIntakes).pipe(
      teamApplicationProblems,
      unreachable("transaction.conflict"),
    );

    return json(intakes, NO_STORE);
  });

const submit = (request: Request, teamId: TeamId, config: TeamApplicationApiConfig) =>
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

    const operationId = "team-applications.submitTeamApplication";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const instant = yield* currentInstant(undefined);

        yield* authorizeAnonymous(
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

const listApplications = (request: Request, teamId: TeamId) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      const cursor = yield* cursorQuery(request);
      const staff = yield* staffPrincipal(request);

      // A read-only snapshot cannot lose a serialization conflict.
      const page = yield* TeamApplications.use((service) =>
        service.listApplications(staff.principal, teamId, cursor),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict"));

      yield* authorizeStaff(
        ListTeamApplicationsEndpoint,
        staff,
        page.actor,
        "AllMatching",
        presentation,
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

const readApplication = (request: Request, applicationId: TeamApplicationId) => {
  const presentation = personPresentation(request);

  return snapshotRead(
    Effect.gen(function* () {
      yield* requireNoQuery(request);
      const staff = yield* staffPrincipal(request);

      // A read-only snapshot cannot lose a serialization conflict.
      const view = yield* TeamApplications.use((service) =>
        service.readApplication(staff.principal, applicationId),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict"));

      yield* authorizeStaff(
        ReadTeamApplicationEndpoint,
        staff,
        view.actor,
        "ExactlyOne",
        presentation,
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

const deleteApplication = (request: Request, applicationId: TeamApplicationId) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const idempotencyKey = yield* idempotencyKeyOf(request);
    const presentation = personPresentation(request);

    const operationId = "team-applications.deleteTeamApplication";

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

        yield* authorizeStaff(
          DeleteTeamApplicationEndpoint,
          staff,
          actor,
          "ExactlyOne",
          presentation,
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

    const operationId = "team-applications.reviseTeamApplicationIntake";

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

        yield* authorizeStaff(
          ReviseTeamApplicationIntakeEndpoint,
          staff,
          actor,
          "ExactlyOne",
          presentation,
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

/** Native HttpApi handlers for public team intake and staff review. */
export const TeamApplicationsApiHandlers = (config: TeamApplicationApiConfig) =>
  HttpApiBuilder.group(ExternalNativeApi, "team-applications", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readTeamApplicationIntake", ({ request, params }) =>
          webHandler(request, (webRequest) => readIntake(webRequest, params.teamId)),
        )
        .handleRaw("listTeamApplicationIntakes", ({ request }) => webHandler(request, listIntakes))
        .handleRaw("submitTeamApplication", ({ request, params }) =>
          webHandler(request, (webRequest) => submit(webRequest, params.teamId, config)),
        )
        .handleRaw("listTeamApplications", ({ request, params }) =>
          webHandler(request, (webRequest) => listApplications(webRequest, params.teamId)),
        )
        .handleRaw("readTeamApplication", ({ request, params }) =>
          webHandler(request, (webRequest) => readApplication(webRequest, params.applicationId)),
        )
        .handleRaw("deleteTeamApplication", ({ request, params }) =>
          webHandler(request, (webRequest) => deleteApplication(webRequest, params.applicationId)),
        )
        .handleRaw("reviseTeamApplicationIntake", ({ request, params }) =>
          webHandler(request, (webRequest) => reviseIntake(webRequest, params.teamId)),
        ),
    ),
  );
