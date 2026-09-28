/**
 * The TeamApplicationsRpcs handlers, ported from the HTTP handlers of
 * `apps/backend/src/team-application/http.ts` at the base commit that docs/specs/rpc-only.md names.
 *
 * The two public reads and the public submission evaluate their anonymous AccessSpec with
 * `authorizeAnonymous`; the submission also counts against the per-process public rate limit
 * before it runs. A staff read resolves the credential and the team authority in one
 * repeatable-read snapshot. A staff command resolves them inside the serializable transaction that
 * commits it, where `TeamApplications.authorize` mints its `TeamApplicationAuthorization` evidence
 * before any stored response can be replayed. Every command stores its first answer as a command
 * receipt under the HTTP route it replaced, so a retry that straddles the cutover replays it.
 */
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
  ReviseTeamApplicationIntakeCommand,
  TeamApplicationAction,
  TeamApplicationCommandId,
  TeamApplications,
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
  DeleteTeamApplication,
  ListTeamApplicationIntakes,
  ListTeamApplications,
  PublicTeamApplicationIntake,
  ReadTeamApplication,
  ReadTeamApplicationIntake,
  reflectAccessSpec,
  ReviseTeamApplicationIntake,
  SubmitTeamApplication,
  TeamApplicationConfirmation,
  TeamApplicationIntakeListResponse,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
  TeamApplicationsRpcs,
  type TeamApplicationInput,
  type TeamApplicationIntakeMergePatch,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  makeNativeValidationError,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import { currentInstant, resolveRequestCredentialInTransaction } from "../authority.js";
import {
  deriveStrongETag,
  encodePathIdentity,
  jsonBodyBytes,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
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
  requireCurrentETag,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import { publicRateLimitKey } from "../rpc/public-rate-limit.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

interface StaffPrincipal {
  readonly credential: AcceptedCredential;
  readonly principal: TeamApplicationPrincipal;
}

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

const intakeETag = (teamId: TeamId, revision: number) =>
  deriveStrongETag({
    representationKind: "TeamApplicationIntake",
    resourceIdentity: teamId,
    version: revision,
  });

const intakeResource = (
  teamId: TeamId,
  intake: TeamApplicationIntake,
): typeof TeamApplicationIntakeResource.Type => ({
  ...intake,
  etag: intakeETag(teamId, intake.revision),
});

/** The HTTP capsule a command receipt stores, byte for byte what the HTTP handler stored. */
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

/** The receipt of a deletion: the no-content answer the HTTP contract stored. */
const noContent: NativeHttpResponseCapsule = {
  status: 204,
  mediaType: null,
  headers: {},
  bodyBytes: null,
};

/**
 * A deletion answers nothing: a committed or replayed receipt succeeds with no value, and every
 * other outcome is its idempotency problem.
 */
const noContentOutcome = (outcome: NativeHttpCommandOutcome) =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", () => Effect.void),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

/** Resolves the current Person credential through the caller's transaction at one instant. */
const staffPrincipal = (headers: Headers.Headers) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestCredentialInTransaction(
      credentialRequestOf(headers),
      "OAuthUserBearer",
    );

    const principal = authenticated.credential.principal;

    if (!Predicate.isTagged(principal, "Person")) {
      return yield* UnauthenticatedActor.make({ message: "authentication required" });
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
const authorizeStaff = (input: {
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly staff: StaffPrincipal;
  readonly actor: TeamApplicationActor;
  readonly selection: "ExactlyOne" | "AllMatching";
  readonly presentation: CredentialPresentation;
}) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      credential: input.staff.credential,
      personId: input.staff.principal.personId,
      resolution: {
        selection: input.selection,
        contexts: [
          genericContext({
            domainId: "team-applications",
            resourceKind: "organization-team",
            resourceId: input.actor.teamId,
            authorityVersion: `team-applications:${input.actor._tag}:${input.staff.principal.authorizationInstant}`,
          }),
        ],
      },
      grantScopes: [
        Scope.Resource({
          resource: {
            kind: ResourceKind.make("organization-team"),
            id: ResourceId.make(input.actor.teamId),
          },
        }),
      ],
      now: input.staff.principal.authorizationInstant,
    },
    input.presentation,
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

const readIntake = (teamId: TeamId) =>
  Effect.gen(function* () {
    const instant = yield* currentInstant(undefined);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadTeamApplicationIntake)),
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

    return yield* strictOutput(PublicTeamApplicationIntake)(intake);
  });

const listIntakes = Effect.gen(function* () {
  const instant = yield* currentInstant(undefined);

  yield* authorizeAnonymous(
    Option.getOrThrow(reflectAccessSpec(ListTeamApplicationIntakes)),
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

  return yield* strictOutput(TeamApplicationIntakeListResponse)(intakes);
});

const submit = (
  headers: Headers.Headers,
  payload: {
    readonly teamId: TeamId;
    readonly idempotencyKey: IdempotencyKey;
    readonly request: TeamApplicationInput;
  },
  options: NativeRpcOptions,
) =>
  Effect.gen(function* () {
    const { teamId, idempotencyKey, request } = payload;
    const config = options.config.teamApplication;
    const arrivedAt = yield* currentInstant(undefined);

    // Counted before the command runs; a replay uses the window like any other submission.
    if (!config.rateLimit.consume(publicRateLimitKey(credentialRequestOf(headers)), arrivedAt)) {
      return yield* Problem.rateLimited(config.retryAfterSeconds);
    }

    const operationId = "team-applications.submitTeamApplication";

    // Domain failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const instant = yield* currentInstant(undefined);

        yield* authorizeAnonymous(
          Option.getOrThrow(reflectAccessSpec(SubmitTeamApplication)),
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

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
          credentialSubject: "Anonymous",
          qualifiedOperationId: operationId,
          normalizedTarget: normalizeTarget("/api/teams/{teamId}/applications", { teamId }),
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: identity.identitySha256,
            requestSha256: semanticRequestDigest({ body: request }),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.submit({
              commandId: TeamApplicationCommandId.make(identity.commandId),
              teamId,
              application: request,
            }),
          ).pipe(
            Effect.flatMap(({ confirmation }) =>
              strictOutput(TeamApplicationConfirmation)(confirmation),
            ),
            Effect.map((confirmation) =>
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

    return yield* commandOutcome(TeamApplicationConfirmation)(outcome);
  }).pipe(
    // A submission reads no page.
    unreachable("request.malformed"),
  );

const listApplications = (
  headers: Headers.Headers,
  payload: { readonly teamId: TeamId; readonly cursor?: string | undefined },
) => {
  const presentation = personPresentation(headers);

  return snapshotRead(
    Effect.gen(function* () {
      const staff = yield* staffPrincipal(headers);

      // A read-only snapshot cannot lose a serialization conflict.
      const page = yield* TeamApplications.use((service) =>
        service.listApplications(staff.principal, payload.teamId, payload.cursor),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict"));

      yield* authorizeStaff({
        rpc: ListTeamApplications,
        staff,
        actor: page.actor,
        selection: "AllMatching",
        presentation,
      });

      const body = {
        teamId: page.teamId,
        teamName: page.teamName,
        items: page.items,
        intake: intakeResource(page.teamId, page.intake),
        canManage: Predicate.isTagged(page.actor, "TeamLeader"),
      };

      return yield* strictOutput(TeamApplicationListResponse)(
        page.nextCursor === undefined ? body : { ...body, nextCursor: page.nextCursor },
      );
    }),
  ).pipe(staffCredentialProblems(presentation));
};

const readApplication = (headers: Headers.Headers, applicationId: TeamApplicationId) => {
  const presentation = personPresentation(headers);

  return snapshotRead(
    Effect.gen(function* () {
      const staff = yield* staffPrincipal(headers);

      // A read-only snapshot cannot lose a serialization conflict, and a read by identifier
      // takes no cursor.
      const view = yield* TeamApplications.use((service) =>
        service.readApplication(staff.principal, applicationId),
      ).pipe(teamApplicationProblems, unreachable("transaction.conflict", "request.malformed"));

      yield* authorizeStaff({
        rpc: ReadTeamApplication,
        staff,
        actor: view.actor,
        selection: "ExactlyOne",
        presentation,
      });

      return yield* strictOutput(TeamApplicationResource)({
        ...view.application,
        teamName: view.teamName,
        canManage: Predicate.isTagged(view.actor, "TeamLeader"),
      });
    }),
  ).pipe(staffCredentialProblems(presentation));
};

const deleteApplication = (
  headers: Headers.Headers,
  payload: { readonly applicationId: TeamApplicationId; readonly idempotencyKey: IdempotencyKey },
) =>
  Effect.gen(function* () {
    const { applicationId, idempotencyKey } = payload;
    const presentation = personPresentation(headers);

    const operationId = "team-applications.deleteTeamApplication";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const staff = yield* staffPrincipal(headers);

        // Authority is current before any stored response can be replayed.
        const authorization = yield* TeamApplications.use((service) =>
          service.authorize(
            staff.principal,
            TeamApplicationAction.DeleteTeamApplication({ applicationId }),
          ),
        );

        yield* authorizeStaff({
          rpc: DeleteTeamApplication,
          staff,
          actor: authorization.actor,
          selection: "ExactlyOne",
          presentation,
        });

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
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
            service.deleteApplication(authorization, {
              commandId: TeamApplicationCommandId.make(identity.commandId),
            }),
          ).pipe(Effect.as(noContent)),
        };
      }),
      { retry: "serialization-once" },
    ).pipe(teamApplicationProblems, commandReceiptProblems, staffCredentialProblems(presentation));

    return yield* noContentOutcome(outcome);
  }).pipe(
    // A deletion reads no page.
    unreachable("request.malformed"),
  );

/** The merge-patch rules the HTTP handler applied before any authority or receipt work. */
const requireApplicablePatch = (
  patch: TeamApplicationIntakeMergePatch,
): Effect.Effect<
  void,
  Problem<"validation.no-change"> | Problem<"validation.field-not-deletable">
> => {
  if (patch.acceptApplication === undefined && patch.deadline === undefined) {
    return Effect.fail(
      Problem.validation("validation.no-change", [makeNativeValidationError("", "no-change")]),
    );
  }

  if (patch.acceptApplication === null) {
    return Effect.fail(
      Problem.validation("validation.field-not-deletable", [
        makeNativeValidationError("/acceptApplication", "field-not-deletable"),
      ]),
    );
  }

  return Effect.void;
};

const reviseIntake = (
  headers: Headers.Headers,
  payload: {
    readonly teamId: TeamId;
    readonly idempotencyKey: IdempotencyKey;
    readonly ifMatch: StrongETag;
    readonly request: TeamApplicationIntakeMergePatch;
  },
) =>
  Effect.gen(function* () {
    const { teamId, idempotencyKey, ifMatch, request: patch } = payload;

    yield* requireApplicablePatch(patch);

    const presentation = personPresentation(headers);

    const operationId = "team-applications.reviseTeamApplicationIntake";

    // Domain and credential failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const staff = yield* staffPrincipal(headers);

        // Authority is current before any stored response can be replayed.
        const authorization = yield* TeamApplications.use((service) =>
          service.authorize(
            staff.principal,
            TeamApplicationAction.ReviseTeamApplicationIntake({ teamId }),
          ),
        );

        yield* authorizeStaff({
          rpc: ReviseTeamApplicationIntake,
          staff,
          actor: authorization.actor,
          selection: "ExactlyOne",
          presentation,
        });

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const identity = yield* commandIdentity({
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
        ).pipe(Effect.mapError(requestInvalid));

        return {
          identity: {
            identitySha256: identity.identitySha256,
            // The decoded patch is the JSON body that the HTTP handler digested, for every body
            // that the schema accepts without excess members.
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
            operationId,
          },
          execute: TeamApplications.use((service) =>
            service.reviseIntake(authorization, command, (current) =>
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
      // authorize answers an unknown team on revise with an authority denial, and a revision
      // reads no page.
      unreachable("resource.not-found", "request.malformed"),
    );

    return yield* commandOutcome(TeamApplicationIntakeResource)(outcome);
  });

/** The TeamApplicationsRpcs handlers. */
export const TeamApplicationsRpcHandlers = (options: NativeRpcOptions) =>
  TeamApplicationsRpcs.toLayer({
    "team-applications.readTeamApplicationIntake": ({ teamId }) => readIntake(teamId),
    "team-applications.listTeamApplicationIntakes": () => listIntakes,
    "team-applications.submitTeamApplication": (payload, { headers }) =>
      submit(headers, payload, options),
    "team-applications.listTeamApplications": (payload, { headers }) =>
      listApplications(headers, payload),
    "team-applications.readTeamApplication": ({ applicationId }, { headers }) =>
      readApplication(headers, applicationId),
    "team-applications.deleteTeamApplication": (payload, { headers }) =>
      deleteApplication(headers, payload),
    "team-applications.reviseTeamApplicationIntake": (payload, { headers }) =>
      reviseIntake(headers, payload),
  });
