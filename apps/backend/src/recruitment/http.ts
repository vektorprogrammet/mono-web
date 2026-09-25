import {
  readRecruitmentMaintenanceHttp,
  maintainRecruitmentHttp,
  recruitmentMaintenanceErrorResponse,
} from "./maintenance-http.js";
import { InterviewReportQuery, InterviewReport } from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInvitationTransition,
  type RecruitmentAuthorityHttpSource,
  type RecruitmentInterviewHttpSource,
  type RecruitmentInvitationHttpSource,
} from "@vektorprogrammet/domain/recruitment";

import {
  AssignmentBoard,
  AssignApplicantEndpoint,
  CancelInterviewEndpoint,
  CancelInterviewRequest,
  CorrectInterviewAssessmentEndpoint,
  CorrectInterviewAssessmentRequest,
  CorrectInterviewAssessmentResponse,
  CancelInterviewResponse,
  ConductObservation,
  ConfirmInvitationEndpoint,
  ConfirmInvitationPayload,
  CreateApplicationInterviewRequest,
  ExternalNativeApi,
  FinalizeInterviewEndpoint,
  FinalizeInterviewRequest,
  FinalizeInterviewResponse,
  InvitationRejectInput,
  InvitationRequestNewTimeInput,
  InvitationResponseObservation,
  ReadAssignmentBoardEndpoint,
  ReadInterviewConductEndpoint,
  ReadInvitationResponseEndpoint,
  ReadSchedulingBoardEndpoint,
  ReadInterviewReportEndpoint,
  RecruitmentInterviewResource,
  RejectInvitationEndpoint,
  RequestNewInvitationTimeEndpoint,
  ScheduleInterviewEndpoint,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
  SchedulingBoard,
  reflectAccessSpec,
  type StrongETag,
} from "@vektorprogrammet/http-api";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";

import {
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CapabilityId,
  CredentialEvidenceRef,
  DomainId,
  GrantId,
  INVITATION_RESPONSE_CAPABILITY,
  RECRUITMENT_INVITATION_RESOURCE_KIND,
  ResourceId,
  ResourceKind,
  accessHttpStatus,
  evaluateAccessJourney,
  decodeGrant,
  type AccessSpec,
  type CanonicalScopeResolution,
  Scope,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/database";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  Recruitment,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandId,
  RecruitmentCancellationCommandId,
  RecruitmentConductCommandId,
  RecruitmentInterviewCorrectionCommandId,
  RecruitmentInterviewId,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentScheduleCommandId,
  type RecruitmentActor,
  type RecruitmentSchedulingBoard,
} from "@vektorprogrammet/domain/recruitment";

import { flow, Cause, Match, Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  type CanonicalSemanticRequest,
  type CredentialSubject,
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  nativeProblemResponse,
  normalizeTarget,
  notModifiedResponse,
  parseIdempotencyKey,
  parseIfNoneMatch,
  parseJsonWithoutDuplicateMembers,
  parseReadIfMatch,
  parseRequiredIfMatch,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { type RecruitmentApiConfig } from "./config.js";

export interface RecruitmentConductContextResolution {
  readonly actor: RecruitmentActor;
  readonly authorizationInstant: string;
}

export interface RecruitmentApiHttpOptions<E = never, R = never> {
  readonly config: RecruitmentApiConfig;
  readonly resolveActor: (request: Request) => Effect.Effect<RecruitmentActor, E, R>;
  readonly resolveConductContext?: (
    request: Request,
  ) => Effect.Effect<RecruitmentConductContextResolution, E, R>;
}

type GenericFacts = Schema.JsonObject;

const NO_STORE = "no-store";

const PRIVATE_NO_STORE = "private, no-store";

const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

const errorTag = (cause: unknown): string | undefined =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isString(cause._tag)
    ? cause._tag
    : undefined;

const errorResponse = (
  cause: unknown,
  unavailableCode: "recruitment.unavailable" | "dependency.unavailable" = "dependency.unavailable",
): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  const sqlCode = (cause: unknown, depth = 0): string | undefined =>
    depth < 8 && (cause === null || Predicate.isObjectOrArray(cause)) && cause !== null
      ? "code" in cause && Predicate.isString(cause.code)
        ? cause.code
        : "cause" in cause
          ? sqlCode(cause.cause, depth + 1)
          : undefined
      : undefined;

  const code = sqlCode(cause);

  if (code === "40001" || code === "40P01")
    return nativeProblemResponse("transaction.conflict", 409);

  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(
      cause.code,
      cause.status,
      cause.status === 401 ? { "www-authenticate": PERSON_CHALLENGE } : undefined,
    );
  }

  switch (errorTag(cause)) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": PERSON_CHALLENGE,
      });
    case "RecruitmentInactiveActor":
    case "RecruitmentRoleDenied":
    case "RecruitmentScopeDenied":
    case "RecruitmentInterviewerNotEligible":
      return nativeProblemResponse("authority.denied", 403);
    case "RecruitmentAdmissionPeriodNotFound":
      return nativeProblemResponse("recruitment.admission-period-not-found", 404);
    case "RecruitmentAmbiguousAdmissionPeriod":
      return nativeProblemResponse("application.ambiguous-period", 409);
    case "RecruitmentApplicationNotFound":
      return nativeProblemResponse("recruitment.application-not-found", 404);
    case "RecruitmentInterviewSchemaNotFound":
      return nativeProblemResponse("recruitment.interview-schema-not-found", 404);
    case "RecruitmentApplicationAlreadyAssigned":
      return nativeProblemResponse("recruitment.application-already-assigned", 409);
    case "RecruitmentInterviewSchemaInactive":
      return nativeProblemResponse("recruitment.interview-schema-inactive", 422);
    case "RecruitmentInterviewNotFound":
      return nativeProblemResponse("recruitment.interview-not-found", 404);
    case "RecruitmentInterviewAlreadyScheduled":
      return nativeProblemResponse("recruitment.already-scheduled", 409);
    case "RecruitmentInterviewStaleRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "RecruitmentScheduleInPast":
      return nativeProblemResponse("recruitment.schedule-in-past", 422);
    case "RecruitmentInvitationNotFound":
      return nativeProblemResponse("resource.not-found", 404);
    case "RecruitmentInvitationAlreadyResponded":
      return nativeProblemResponse("invitation.already-responded", 409);
    case "RecruitmentInterviewAlreadyFinalized":
      return nativeProblemResponse("recruitment.already-finalized", 409);
    case "RecruitmentInterviewAlreadyCancelled":
      return nativeProblemResponse("recruitment.already-cancelled", 409);
    case "RecruitmentInterviewNotScheduled":
      return nativeProblemResponse("recruitment.interview-not-scheduled", 409);
    case "RecruitmentInvitationNotAccepted":
      return nativeProblemResponse("recruitment.invitation-not-accepted", 409);
    case "RecruitmentConductValidationError":
      return nativeProblemResponse("recruitment.conduct-invalid", 422);
    case "RecruitmentAssignmentCommandConflict":
    case "RecruitmentScheduleCommandConflict":
    case "RecruitmentLifecycleCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    case "RecruitmentPersistenceError":
    case "InterviewQuestionsUnavailable":
    case "ProfileContactNotFound":
      return nativeProblemResponse(unavailableCode, 503);
    case "RecruitmentDecodeError":
    case "RecruitmentInvalidContext":
    case "NativeHttpReceiptInvalid":
      return nativeProblemResponse("internal.error", 500);
    default:
      return nativeProblemResponse("internal.error", 500);
  }
};

export const recruitmentHttpErrorResponse = errorResponse;

const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  failure: {
    readonly code: "request.malformed" | "validation.failed";
    readonly status: 400 | 422;
  } = { code: "validation.failed", status: 422 },
) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure(failure.code, failure.status)),
  );

const strictOutput = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

const readJsonBody = (request: Request, maxBodyBytes: number, malformedOnly = false) =>
  Effect.tryPromise({
    try: async () => {
      const fail = (
        code: "request.malformed" | "media-type.unsupported" | "request.too-large",
        status: 400 | 413 | 415,
      ) => {
        throw new HttpSemanticFailure(
          malformedOnly ? "request.malformed" : code,
          malformedOnly ? 400 : status,
        );
      };

      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

      if (mediaType !== "application/json") fail("media-type.unsupported", 415);
      const declaredLength = request.headers.get("content-length");

      if (declaredLength !== null) {
        const length = Number(declaredLength);

        if (!Number.isSafeInteger(length) || length < 0) fail("request.malformed", 400);

        if (length > maxBodyBytes) fail("request.too-large", 413);
      }

      const chunks: Uint8Array[] = [];
      let byteLength = 0;

      if (request.body !== null) {
        const reader = request.body.getReader();

        try {
          while (true) {
            const chunk = await reader.read();

            if (chunk.done) break;
            byteLength += chunk.value.byteLength;

            if (byteLength > maxBodyBytes) {
              await reader.cancel().catch(() => undefined);
              fail("request.too-large", 413);
            }

            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      const bytes = new Uint8Array(byteLength);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      try {
        return parseJsonWithoutDuplicateMembers(bytes);
      } catch (cause) {
        if (malformedOnly && cause instanceof HttpSemanticFailure) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }

        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
  });

export const readRecruitmentRequestBody = readJsonBody;

const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

const noQuery = (request: Request) =>
  Effect.try({
    try: () => {
      if (new URL(request.url).search.length > 0) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
    },
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
  });

const decodeBoardQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const parameters = [...new URL(request.url).searchParams];

      if (parameters.length !== 1 || parameters[0]?.[0] !== "status") {
        throw new HttpSemanticFailure("request.malformed", 400);
      }

      return { status: parameters[0][1] };
    },
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
  }).pipe(Effect.flatMap((query) => strictDecode(RecruitmentAssignmentBoardQuerySchema)(query)));

const invitationCapability = (request: Request) =>
  Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(
    request.headers.get("x-recruitment-invitation-capability"),
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new HttpSemanticFailure("resource.not-found", 404)));

const actorFor = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
): Effect.Effect<RecruitmentActor, E | HttpSemanticFailure, R> =>
  Effect.catch(
    input.resolveActor(request),
    (cause): Effect.Effect<never, E | HttpSemanticFailure> =>
      Effect.fail(
        errorTag(cause) === undefined ? new HttpSemanticFailure("credential.invalid", 401) : cause,
      ),
  );

const capabilityForSpec = (spec: AccessSpec) =>
  Predicate.isTagged(spec.capabilities, "One")
    ? Effect.succeed(spec.capabilities.capability)
    : Effect.fail(new HttpSemanticFailure("internal.error", 500));

const rejectedCode = (status: 401 | 403 | 404) =>
  Match.value(status).pipe(
    Match.when(401, () => "credential.invalid" as const),
    Match.when(404, () => "resource.not-found" as const),
    Match.orElse(() => "authority.denied" as const),
  );

const authorizePersonOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: RecruitmentActor;
  readonly resolution: CanonicalScopeResolution<GenericFacts>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly authorizationInstant: string;
}) =>
  Effect.gen(function* () {
    const principal = { _tag: "Person" as const, personId: input.actor.personId };
    const instant = AuthorizationInstant.make(input.authorizationInstant);
    const capability = yield* capabilityForSpec(input.spec);

    const grants = input.grantScopes.map((scope, index) =>
      decodeGrant({
        grantId: GrantId.make(
          `native-recruitment:${input.actor.personId}:${capability.type}:${index}`,
        ),
        subject: principal,
        capability,
        scope,
        startAt: instant,
        endAt: null,
        requirements: [],
        source: AuthorityRef.make("native-recruitment-actor"),
        revision: 0,
      }),
    );

    const bearer = input.request.headers.get("authorization")?.startsWith("Bearer ") === true;

    const evaluation = yield* evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: {
            _tag: bearer ? ("OAuthUserBearer" as const) : ("BetterAuthCookie" as const),
          },
          principal,
          evidenceRef: CredentialEvidenceRef.make("native-recruitment-person"),
        }),
      resolveScope: () => Effect.succeed(input.resolution),
      resolveGrants: () => Effect.succeed(grants),
    });

    const status = accessHttpStatus(evaluation, input.spec.concealment);

    if (status !== 200) {
      return yield* Effect.fail(new HttpSemanticFailure(rejectedCode(status), status));
    }
  });

const authorizeInvitationOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly source: RecruitmentInvitationHttpSource;
  readonly authorizationInstant: string;
}) =>
  Effect.gen(function* () {
    const capabilityId = CapabilityId.make(input.source.capabilitySha256);
    const principal = { _tag: "CapabilityHolder" as const, capabilityId };
    const instant = AuthorizationInstant.make(input.authorizationInstant);

    const resource = {
      kind: RECRUITMENT_INVITATION_RESOURCE_KIND,
      id: ResourceId.make(input.source.invitationId),
    };

    const capability = yield* capabilityForSpec(input.spec);

    const resolution = {
      selection: "ExactlyOne" as const,
      contexts: [
        {
          domainId: DomainId.make("recruitment"),
          departmentId: input.source.departmentId,
          resource,
          facts: {
            capabilityId,
            invitationId: input.source.invitationId,
            interviewId: input.source.interviewId,
            departmentId: input.source.departmentId,
            responseState: input.source.responseState,
            responseRevision: input.source.responseRevision,
            supersededAt: input.source.supersededAt,
          },
          authorityVersion: AuthorityVersion.make(
            `${input.source.scheduleRevision}:${input.source.responseRevision}`,
          ),
        },
      ],
    };

    const grant = decodeGrant({
      grantId: GrantId.make(`native-invitation:${input.source.capabilitySha256}`),
      subject: principal,
      capability,
      scope: Scope.Resource({ resource }),
      startAt: instant,
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("native-invitation-capability"),
      revision: input.source.responseRevision,
    });

    const evaluation = yield* evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: {
            _tag: "ObjectCapability" as const,
            capabilityType: INVITATION_RESPONSE_CAPABILITY,
          },
          principal,
          evidenceRef: CredentialEvidenceRef.make(
            `native-invitation:${input.source.capabilitySha256}`,
          ),
        }),
      resolveScope: () => Effect.succeed(resolution),
      resolveGrants: () => Effect.succeed([grant]),
    });

    const status = accessHttpStatus(evaluation, input.spec.concealment);

    if (status !== 200) {
      return yield* Effect.fail(new HttpSemanticFailure(rejectedCode(status), status));
    }
  });

const actorDepartment = (actor: RecruitmentActor): DepartmentId | null =>
  Predicate.isTagged(actor, "GlobalAdmin") ? null : actor.departmentId;

const boardContext = (actor: RecruitmentActor, facts: GenericFacts, version: string) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: actorDepartment(actor),
  resource: null,
  facts,
  authorityVersion: AuthorityVersion.make(version),
});

const applicationContext = (input: {
  readonly applicationId: typeof PublicApplicationIdSchema.Type;
  readonly departmentId: DepartmentId;
  readonly facts: GenericFacts;
  readonly version: string;
}) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: input.departmentId,
  resource: {
    kind: ResourceKind.make("application"),
    id: ResourceId.make(input.applicationId),
  },
  facts: input.facts,
  authorityVersion: AuthorityVersion.make(input.version),
});

export const recruitmentInterviewAccessContext = (
  source: RecruitmentInterviewHttpSource,
  actor: RecruitmentActor,
  allowLeader: boolean,
  activeMember: boolean,
) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: source.departmentId,
  resource: {
    kind: ResourceKind.make("recruitment-interview"),
    id: ResourceId.make(source.interviewId),
  },
  facts: {
    assignedInterviewerPersonIds: activeMember ? [source.interviewerPersonId] : [],
    interviewParticipantPersonIds: activeMember
      ? source.coInterviewerPersonId === null
        ? [source.interviewerPersonId]
        : [source.interviewerPersonId, source.coInterviewerPersonId]
      : [],
    linkedApplicantPersonId: source.linkedApplicantPersonId,
    departmentLeaderPersonIds:
      allowLeader &&
      Predicate.isTagged(actor, "DepartmentLeader") &&
      actor.departmentId === source.departmentId
        ? [actor.personId]
        : [],
  },
  authorityVersion: AuthorityVersion.make(
    `${source.interviewRevision}:${JSON.stringify(source.coInterviewerPersonId)}:${source.linkedApplicantPersonId ?? "Unknown"}:${source.authority.map((item) => `${item.kind}:${item.identity}:${item.revisions.join(".")}`).join("|")}`,
  ),
});

export const invitationETag = (source: RecruitmentInvitationHttpSource): StrongETag =>
  deriveStrongETag({
    representationKind: "InvitationResponseObservation",
    resourceIdentity: `recruitment-invitation:${source.invitationId}`,
    version: [source.scheduleRevision, source.responseRevision],
  });

export const interviewETag = (
  source: Omit<RecruitmentInterviewHttpSource, "linkedApplicantPersonId">,
): StrongETag =>
  deriveStrongETag({
    representationKind: "RecruitmentInterviewResource",
    resourceIdentity: `recruitment-interview:${source.interviewId}`,
    version: [
      source.interviewRevision,
      source.coInterviewerPersonId ?? "Absent",
      source.authority.map((item) => [item.kind, item.identity, item.revisions]),
    ],
  });

export const schedulingBoardWithETags = (
  board: RecruitmentSchedulingBoard,
  authority: ReadonlyArray<RecruitmentAuthorityHttpSource>,
) => ({
  ...board,
  interviews: board.interviews.map((interview) => ({
    ...interview,
    etag: interviewETag({
      interviewId: interview.interviewId,
      departmentId: interview.departmentId,
      interviewerPersonId: interview.interviewer.personId,
      coInterviewerPersonId:
        interview.coInterviewer === null ? null : interview.coInterviewer.personId,
      interviewRevision: interview.revision,
      authority,
    }),
  })),
});

export const conditionalJsonResponse = (request: Request, body: Schema.Json, etag: StrongETag) =>
  Effect.try({
    try: () => {
      const decision = evaluateReadPreconditions({
        currentETag: etag,
        ifMatch: parseReadIfMatch(headerValues(request, "if-match")),
        ifNoneMatch: parseIfNoneMatch(headerValues(request, "if-none-match")),
      });

      if (Predicate.isTagged(decision, "Failed"))
        return nativeProblemResponse(decision.code, decision.status);

      if (Predicate.isTagged(decision, "NotModified")) {
        return notModifiedResponse({ etag, cacheControl: PRIVATE_NO_STORE, vary: "Origin" });
      }

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "cache-control": PRIVATE_NO_STORE,
          "content-type": "application/json",
          etag,
          vary: "Origin",
        },
      });
    },
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
  });

const commandIdentity = (
  request: Request,
  credentialSubject: CredentialSubject,
  operationId: string,
  routeTemplate: string,
  identities: Readonly<Record<string, string>>,
) => {
  const idempotencyKey = parseIdempotencyKey(headerValues(request, "idempotency-key"));

  return deriveHttpIdentity({
    credentialSubject,
    qualifiedOperationId: operationId,
    normalizedTarget: normalizeTarget(routeTemplate, identities),
    idempotencyKey,
  });
};

const executeCommand = <CommandId, E, R>(input: {
  readonly request: Request;
  readonly operationId: string;
  readonly routeTemplate: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly semanticRequest: CanonicalSemanticRequest;
  readonly commandIdSchema: Schema.ConstraintDecoder<CommandId, never>;
  readonly prepare: () => Effect.Effect<
    {
      readonly credentialSubject: CredentialSubject;
      readonly execute: (
        commandId: NoInfer<CommandId>,
      ) => Effect.Effect<Response, unknown, Recruitment>;
    },
    E,
    R
  >;
  readonly retry?: "serialization-once";
}) =>
  Effect.gen(function* () {
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const prepared = yield* input.prepare();

        const derived = yield* Effect.try({
          try: () =>
            commandIdentity(
              input.request,
              prepared.credentialSubject,
              input.operationId,
              input.routeTemplate,
              input.identities,
            ),
          catch: (cause) =>
            cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
        });

        const commandId = yield* strictDecode(input.commandIdSchema)(derived.commandId);

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(input.semanticRequest),
            operationId: input.operationId,
          },
          execute: prepared.execute(commandId).pipe(
            Effect.flatMap((response) =>
              Effect.tryPromise({
                try: () => responseCapsule(response),
                catch: (cause) =>
                  cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
              }),
            ),
          ),
        };
      }),
      input.retry === undefined ? {} : { retry: input.retry },
    );

    return nativeCommandOutcomeResponse(outcome);
  });

const readInvitationResponse = <E, R>(request: Request, input: RecruitmentApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const capability = yield* invitationCapability(request);
    const now = yield* currentInstant(input.config.now);

    const snapshot = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    );

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponseEndpoint)),
      request,
      source: snapshot.source,
      authorizationInstant: now,
    });
    const output = yield* strictOutput(InvitationResponseObservation)(snapshot.observation);

    return yield* conditionalJsonResponse(request, output, invitationETag(snapshot.source));
  });

const invitationMutation = <E, R>(
  request: Request,
  operation: "Confirm" | "Reject" | "RequestNewTime",
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);

    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    yield* Effect.try({
      try: () => parseIdempotencyKey(headerValues(request, "idempotency-key")),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });
    const capability = yield* invitationCapability(request);

    const endpoint = Match.value(operation).pipe(
      Match.when("Confirm", () => ConfirmInvitationEndpoint),
      Match.when("Reject", () => RejectInvitationEndpoint),
      Match.orElse(() => RequestNewInvitationTimeEndpoint),
    );

    let transition: RecruitmentInvitationTransition;

    if (operation === "Confirm") {
      yield* strictDecode(ConfirmInvitationPayload, { code: "request.malformed", status: 400 })(
        yield* readJsonBody(request, input.config.maxBodyBytes, true),
      );
      transition = RecruitmentInvitationTransition.Confirm();
    } else if (operation === "Reject") {
      const body = yield* strictDecode(InvitationRejectInput)(
        yield* readJsonBody(request, input.config.maxBodyBytes),
      );

      transition =
        body.message === undefined
          ? RecruitmentInvitationTransition.Reject({})
          : RecruitmentInvitationTransition.Reject({ message: body.message });
    } else {
      const body = yield* strictDecode(InvitationRequestNewTimeInput)(
        yield* readJsonBody(request, input.config.maxBodyBytes),
      );

      transition = RecruitmentInvitationTransition.RequestNewTime({ message: body.message });
    }

    const now = yield* currentInstant(input.config.now);

    const source = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    ).pipe(Effect.map((snapshot) => snapshot.source));

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      request,
      source,
      authorizationInstant: now,
    });

    if (source.responseState === "Pending") {
      const precondition = evaluateMutationPrecondition(invitationETag(source), ifMatch);

      if (Predicate.isTagged(precondition, "Failed")) {
        return yield* Effect.fail(new HttpSemanticFailure(precondition.code, precondition.status));
      }
    }

    const updated = yield* Recruitment.use((service) =>
      service.transitionInvitation({
        capability,
        transition,
        now,
      }),
    );

    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": NO_STORE,
        etag: invitationETag(updated.source),
        vary: "Origin",
      },
    });
  });

const readAssignmentBoard = <E, R>(request: Request, input: RecruitmentApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    const query = yield* decodeBoardQuery(request);
    const actor = yield* actorFor(request, input);
    const now = yield* currentInstant(input.config.now);
    const departmentId = actorDepartment(actor);
    yield* authorizePersonOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadAssignmentBoardEndpoint)),
      request,
      actor,
      resolution: {
        selection: "AllMatching",
        contexts: [
          boardContext(
            actor,
            {
              departmentLeaderPersonIds:
                Predicate.isTagged(actor, "DepartmentLeader") && actor.active
                  ? [actor.personId]
                  : [],
            },
            now,
          ),
        ],
      },
      grantScopes:
        departmentId === null
          ? [Scope.Domain({ domainId: DomainId.make("recruitment") })]
          : [Scope.Department({ departmentId })],
      authorizationInstant: now,
    });

    const observation = yield* Recruitment.use(({ readAssignmentBoard: read }) =>
      read(query, { actor, now }),
    );

    const output = yield* strictOutput(AssignmentBoard)(observation);

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  });

const readInterviewReport = <E, R>(request: Request, input: RecruitmentApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    const queryInput = yield* Effect.try({
      try: () => {
        const values = new URL(request.url).searchParams;

        for (const key of values.keys()) {
          if (values.getAll(key).length !== 1) {
            throw new HttpSemanticFailure("request.malformed", 400);
          }
        }

        return Object.fromEntries(values);
      },
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    const query = yield* strictDecode(InterviewReportQuery)(queryInput);
    const caller = yield* actorFor(request, input);
    const now = yield* currentInstant(input.config.now);

    const actor = yield* Recruitment.use((service) =>
      service.resolveInterviewReportLeader(caller.personId, now),
    );

    yield* authorizePersonOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadInterviewReportEndpoint)),
      request,
      actor,
      resolution: {
        selection: "AllMatching",
        contexts: [boardContext(actor, { departmentLeaderPersonIds: [actor.personId] }, now)],
      },
      grantScopes: [Scope.Department({ departmentId: actor.departmentId })],
      authorizationInstant: now,
    });

    const observation = yield* Recruitment.use((service) =>
      service.readCompletedInterviewReport(actor.personId, now, query),
    );

    const output = yield* strictOutput(InterviewReport)(observation);

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  });

const readSchedulingBoard = <E, R>(request: Request, input: RecruitmentApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const actor = yield* actorFor(request, input);
    const now = yield* currentInstant(input.config.now);
    const departmentId = actorDepartment(actor);
    yield* authorizePersonOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadSchedulingBoardEndpoint)),
      request,
      actor,
      resolution: {
        selection: "AllMatching",
        contexts: [
          boardContext(
            actor,
            {
              departmentMemberPersonIds:
                !Predicate.isTagged(actor, "GlobalAdmin") && actor.active ? [actor.personId] : [],
            },
            now,
          ),
        ],
      },
      grantScopes:
        departmentId === null
          ? [Scope.Domain({ domainId: DomainId.make("recruitment") })]
          : [Scope.Department({ departmentId })],
      authorizationInstant: now,
    });

    const observation = yield* Recruitment.use(({ readSchedulingBoard: read }) =>
      read({ actor, now }),
    );

    const authority = yield* Recruitment.use((service) =>
      service.readPersonAuthoritySources(actor.personId),
    );

    const output = yield* strictOutput(SchedulingBoard)(
      schedulingBoardWithETags(observation, authority),
    );

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  });

const createApplicationInterview = <E, R>(
  request: Request,
  applicationId: typeof PublicApplicationIdSchema.Type,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);

    const body = yield* strictDecode(CreateApplicationInterviewRequest)(
      yield* readJsonBody(request, input.config.maxBodyBytes),
    );

    return yield* executeCommand({
      request,
      operationId: "recruitment.createApplicationInterview",
      routeTemplate: "/api/recruitment/applications/{applicationId}/interviews",
      identities: { applicationId },
      semanticRequest: { body },
      commandIdSchema: RecruitmentAssignmentCommandId,
      retry: "serialization-once",
      prepare: () =>
        Effect.gen(function* () {
          const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
            now: input.config.now,
          });

          const { access, actor } = yield* Recruitment.use((service) =>
            service.prepareAssignment({
              applicationId,
              interviewerPersonId: body.interviewerPersonId,
              personId: authorization.authority.personId,
              authorizationInstant: authorization.authorizationInstant,
            }),
          );

          const resource = {
            kind: ResourceKind.make("application"),
            id: ResourceId.make(applicationId),
          };

          yield* authorizePersonNativeOperation({
            spec: Option.getOrThrow(reflectAccessSpec(AssignApplicantEndpoint)),
            credential: authorization.credential,
            personId: actor.personId,
            resolution: {
              selection: "ExactlyOne",
              contexts: [
                applicationContext({
                  applicationId,
                  departmentId: access.departmentId,
                  facts: {
                    departmentLeaderPersonIds:
                      Predicate.isTagged(actor, "DepartmentLeader") && actor.active
                        ? [actor.personId]
                        : [],
                    eligibleInterviewerPersonIds: access.interviewerEligible
                      ? [actor.personId]
                      : [],
                  },
                  version: authorization.authorizationInstant,
                }),
              ],
            },
            grantScopes: [Scope.Resource({ resource })],
            now: authorization.authorizationInstant,
          });

          return {
            credentialSubject: `Person:${actor.personId}`,
            execute: (commandId: RecruitmentAssignmentCommandId) =>
              Effect.gen(function* () {
                const result = yield* Recruitment.use((service) =>
                  service.assignApplicant(
                    { commandId, applicationId, ...body },
                    {
                      actor,
                      now: authorization.authorizationInstant,
                      interviewId: input.config.nextInterviewId(),
                    },
                  ),
                );

                const output = yield* Schema.decodeEffect(RecruitmentInterviewResource)(
                  result.observation.interview,
                  { onExcessProperty: "error" },
                ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const source = yield* Recruitment.use((service) =>
                  service.readInterviewSource(
                    result.observation.interview.interviewId,
                    actor.personId,
                  ),
                );

                const location = normalizeTarget("/api/recruitment/interviews/{interviewId}", {
                  interviewId: result.observation.interview.interviewId,
                });

                return new Response(JSON.stringify(output), {
                  status: 201,
                  headers: {
                    "cache-control": NO_STORE,
                    "content-type": "application/json",
                    etag: interviewETag(source),
                    location,
                  },
                });
              }),
          };
        }),
    });
  });

const interviewAuthorizationInTransaction = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint:
    | typeof ScheduleInterviewEndpoint
    | typeof ReadInterviewConductEndpoint
    | typeof FinalizeInterviewEndpoint
    | typeof CancelInterviewEndpoint
    | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });

    const { source, actor, activeMember } = yield* Recruitment.use((service) =>
      service.prepareInterview({
        interviewId,
        personId: authorization.authority.personId,
        authorizationInstant: authorization.authorizationInstant,
      }),
    );

    const resource = {
      kind: ResourceKind.make("recruitment-interview"),
      id: ResourceId.make(interviewId),
    };

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: authorization.credential,
      personId: actor.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [recruitmentInterviewAccessContext(source, actor, allowLeader, activeMember)],
      },
      grantScopes: [Scope.Resource({ resource })],
      now: authorization.authorizationInstant,
    });

    return {
      actor,
      authorizationInstant: authorization.authorizationInstant,
      source,
    };
  });

const scheduleInterview = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);

    const body = yield* strictDecode(ScheduleInterviewRequest)(
      yield* readJsonBody(request, input.config.maxBodyBytes),
    );

    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    return yield* executeCommand({
      request,
      operationId: "recruitment.scheduleInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:schedule",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentScheduleCommandId,
      retry: "serialization-once",
      prepare: () =>
        Effect.gen(function* () {
          const authorization = yield* interviewAuthorizationInTransaction(
            request,
            interviewId,
            ScheduleInterviewEndpoint,
            true,
            input,
          );

          return {
            credentialSubject: `Person:${authorization.actor.personId}`,
            execute: (commandId: RecruitmentScheduleCommandId) =>
              Effect.gen(function* () {
                const precondition = evaluateMutationPrecondition(
                  interviewETag(authorization.source),
                  ifMatch,
                );

                if (Predicate.isTagged(precondition, "Failed")) {
                  return yield* Effect.fail(
                    new HttpSemanticFailure(precondition.code, precondition.status),
                  );
                }

                const result = yield* Recruitment.use((service) =>
                  service.scheduleInterview(
                    {
                      commandId,
                      interviewId,
                      expectedRevision: authorization.source.interviewRevision,
                      ...body,
                    },
                    {
                      actor: authorization.actor,
                      now: authorization.authorizationInstant,
                      invitationId: input.config.nextInvitationId(),
                      responseCapability: input.config.nextResponseCapability(),
                    },
                  ),
                );

                const observation = result.observation;

                const output = yield* Schema.decodeEffect(ScheduleInterviewResponse)(
                  {
                    interviewId: observation.interviewId,
                    schedule: observation.schedule,
                    responseState: observation.responseState,
                    notificationState: observation.notificationState,
                  },
                  { onExcessProperty: "error" },
                ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const updated = yield* Recruitment.use((service) =>
                  service.readInterviewSource(interviewId, authorization.actor.personId),
                );

                return new Response(JSON.stringify(output), {
                  status: 200,
                  headers: {
                    "cache-control": NO_STORE,
                    "content-type": "application/json",
                    etag: interviewETag(updated),
                  },
                });
              }),
          };
        }),
    });
  });

const readInterviewConductHandler = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);

    const snapshot = yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const authorization = yield* interviewAuthorizationInTransaction(
            request,
            interviewId,
            ReadInterviewConductEndpoint,
            false,
            input,
          );

          const now = yield* currentInstant(input.config.now);

          const observation = yield* Recruitment.use((service) =>
            service.readInterviewConduct(interviewId, {
              actor: authorization.actor,
              now,
              authorizationInstant: authorization.authorizationInstant,
            }),
          );

          const source = yield* Recruitment.use((service) =>
            service.readInterviewSource(interviewId, authorization.actor.personId),
          );

          return { observation, source };
        }),
      ),
    );

    const output = yield* strictOutput(ConductObservation)(snapshot.observation);

    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ConductObservation))(output);

    return yield* conditionalJsonResponse(request, encoded, interviewETag(snapshot.source));
  });

const correctInterviewAssessment = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);

    const body = yield* strictDecode(CorrectInterviewAssessmentRequest)(
      yield* readJsonBody(request, input.config.maxBodyBytes),
    );

    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    return yield* executeCommand({
      request,
      operationId: "recruitment.correctInterviewAssessment",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:correct",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentInterviewCorrectionCommandId,
      prepare: () =>
        Effect.gen(function* () {
          const authorization = yield* interviewAuthorizationInTransaction(
            request,
            interviewId,
            CorrectInterviewAssessmentEndpoint,
            false,
            input,
          );

          return {
            credentialSubject: `Person:${authorization.actor.personId}`,
            execute: (commandId: RecruitmentInterviewCorrectionCommandId) =>
              Effect.gen(function* () {
                const precondition = evaluateMutationPrecondition(
                  interviewETag(authorization.source),
                  ifMatch,
                );

                if (Predicate.isTagged(precondition, "Failed")) {
                  return yield* Effect.fail(
                    new HttpSemanticFailure(precondition.code, precondition.status),
                  );
                }

                if (body.expectedRevision !== authorization.source.interviewRevision) {
                  return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
                }

                const result = yield* Recruitment.use((service) =>
                  service.correctInterviewAssessment(
                    {
                      commandId,
                      interviewId,
                      ...body,
                    },
                    {
                      actor: authorization.actor,
                      now: authorization.authorizationInstant,
                      authorizationInstant: authorization.authorizationInstant,
                    },
                  ),
                );

                const observation = result.observation;

                const output = yield* Schema.decodeEffect(CorrectInterviewAssessmentResponse)(
                  {
                    _tag: observation._tag,
                    commandId: observation.commandId,
                    interviewId: observation.interviewId,
                    predecessorRevision: observation.predecessorRevision,
                    resultingRevision: observation.resultingRevision,
                    replayed: result.replayed,
                  },
                  { onExcessProperty: "error" },
                ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const updated = yield* Recruitment.use((service) =>
                  service.readInterviewSource(interviewId, authorization.actor.personId),
                );

                return new Response(JSON.stringify(output), {
                  status: 200,
                  headers: {
                    "cache-control": NO_STORE,
                    "content-type": "application/json",
                    etag: interviewETag(updated),
                  },
                });
              }),
          };
        }),
    });
  });

const lifecycleInterview = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  operation: "Finalize" | "Cancel",
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* noQuery(request);
    const endpoint = operation === "Finalize" ? FinalizeInterviewEndpoint : CancelInterviewEndpoint;
    const rawBody = yield* readJsonBody(request, input.config.maxBodyBytes);

    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    const prepareAuthorization = () =>
      Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction(
          request,
          interviewId,
          endpoint,
          false,
          input,
        );

        return authorization;
      });

    if (operation === "Finalize") {
      const body = yield* strictDecode(FinalizeInterviewRequest)(rawBody);

      return yield* executeCommand({
        request,
        operationId: "recruitment.finalizeInterview",
        routeTemplate: "/api/recruitment/interviews/{interviewId}:finalize",
        identities: { interviewId },
        semanticRequest: semanticMutationRequest(body, ifMatch),
        commandIdSchema: RecruitmentConductCommandId,
        retry: "serialization-once",
        prepare: () =>
          Effect.gen(function* () {
            const authorization = yield* prepareAuthorization();

            return {
              credentialSubject: `Person:${authorization.actor.personId}`,
              execute: (commandId: RecruitmentConductCommandId) =>
                Effect.gen(function* () {
                  const precondition = evaluateMutationPrecondition(
                    interviewETag(authorization.source),
                    ifMatch,
                  );

                  if (Predicate.isTagged(precondition, "Failed")) {
                    return yield* Effect.fail(
                      new HttpSemanticFailure(precondition.code, precondition.status),
                    );
                  }

                  const result = yield* Recruitment.use((service) =>
                    service.finalizeInterview(
                      {
                        commandId,
                        interviewId,
                        expectedRevision: authorization.source.interviewRevision,
                        ...body,
                      },
                      {
                        actor: authorization.actor,
                        now: authorization.authorizationInstant,
                        authorizationInstant: authorization.authorizationInstant,
                      },
                    ),
                  );

                  const observation = result.observation;

                  const output = yield* Schema.decodeEffect(FinalizeInterviewResponse)(
                    {
                      interviewId: observation.interviewId,
                      finalizedAt: observation.finalizedAt,
                      completionState: observation.completionState,
                      cancellationState: observation.cancellationState,
                    },
                    { onExcessProperty: "error" },
                  ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                  const updated = yield* Recruitment.use((service) =>
                    service.readInterviewSource(interviewId, authorization.actor.personId),
                  );

                  return new Response(JSON.stringify(output), {
                    status: 200,
                    headers: {
                      "cache-control": NO_STORE,
                      "content-type": "application/json",
                      etag: interviewETag(updated),
                    },
                  });
                }),
            };
          }),
      });
    }

    const body = yield* strictDecode(CancelInterviewRequest)(rawBody);

    return yield* executeCommand({
      request,
      operationId: "recruitment.cancelInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:cancel",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentCancellationCommandId,
      retry: "serialization-once",
      prepare: () =>
        Effect.gen(function* () {
          const authorization = yield* prepareAuthorization();

          return {
            credentialSubject: `Person:${authorization.actor.personId}`,
            execute: (commandId: RecruitmentCancellationCommandId) =>
              Effect.gen(function* () {
                const precondition = evaluateMutationPrecondition(
                  interviewETag(authorization.source),
                  ifMatch,
                );

                if (Predicate.isTagged(precondition, "Failed")) {
                  return yield* Effect.fail(
                    new HttpSemanticFailure(precondition.code, precondition.status),
                  );
                }

                const result = yield* Recruitment.use((service) =>
                  service.cancelInterview(
                    {
                      commandId,
                      interviewId,
                      expectedRevision: authorization.source.interviewRevision,
                    },
                    {
                      actor: authorization.actor,
                      now: authorization.authorizationInstant,
                      authorizationInstant: authorization.authorizationInstant,
                    },
                  ),
                );

                const observation = result.observation;

                const output = yield* Schema.decodeEffect(CancelInterviewResponse)(
                  {
                    interviewId: observation.interviewId,
                    cancelledAt: observation.cancelledAt,
                    completionState: observation.completionState,
                    cancellationState: observation.cancellationState,
                  },
                  { onExcessProperty: "error" },
                ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));

                const updated = yield* Recruitment.use((service) =>
                  service.readInterviewSource(interviewId, authorization.actor.personId),
                );

                return new Response(JSON.stringify(output), {
                  status: 200,
                  headers: {
                    "cache-control": NO_STORE,
                    "content-type": "application/json",
                    etag: interviewETag(updated),
                  },
                });
              }),
          };
        }),
    });
  });

/** Native HttpApi implementations for all frozen recruitment operations. */
export const RecruitmentApiHandlers = <E, R>(input: RecruitmentApiHttpOptions<E, R>) =>
  HttpApiBuilder.group(ExternalNativeApi, "recruitment", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readQuestionnaires", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readRecruitmentMaintenanceHttp(webRequest, "questionnaires"),
            recruitmentMaintenanceErrorResponse,
          ),
        )
        .handleRaw("readInterviewStaffing", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readRecruitmentMaintenanceHttp(webRequest, "staffing"),
            recruitmentMaintenanceErrorResponse,
          ),
        )
        .handleRaw("maintainRecruitment", ({ request }) =>
          toHttpApiResponse(request, maintainRecruitmentHttp, recruitmentMaintenanceErrorResponse),
        )
        .handleRaw("readInterviewReport", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readInterviewReport(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("readInvitationResponse", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readInvitationResponse(webRequest, input),
            (cause) => errorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("confirmInvitation", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "Confirm", input),
            errorResponse,
          ),
        )
        .handleRaw("rejectInvitation", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "Reject", input),
            errorResponse,
          ),
        )
        .handleRaw("requestNewInvitationTime", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "RequestNewTime", input),
            errorResponse,
          ),
        )
        .handleRaw("readAssignmentBoard", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readAssignmentBoard(webRequest, input),
            (cause) => errorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("readSchedulingBoard", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readSchedulingBoard(webRequest, input),
            (cause) => errorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("createApplicationInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createApplicationInterview(webRequest, params.applicationId, input),
            errorResponse,
          ),
        )
        .handleRaw("scheduleInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => scheduleInterview(webRequest, params.interviewId, input),
            errorResponse,
          ),
        )
        .handleRaw("readInterviewConduct", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readInterviewConductHandler(webRequest, params.interviewId, input),
            (cause) => errorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("finalizeInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleInterview(webRequest, params.interviewId, "Finalize", input),
            errorResponse,
          ),
        )
        .handleRaw("correctInterviewAssessment", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => correctInterviewAssessment(webRequest, params.interviewId, input),
            errorResponse,
          ),
        )
        .handleRaw("cancelInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleInterview(webRequest, params.interviewId, "Cancel", input),
            errorResponse,
          ),
        ),
    ),
  );
