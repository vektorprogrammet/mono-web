import {
  readCompletedInterviewReport,
  resolveInterviewReportLeader,
  InterviewReportQuery,
  InterviewReport,
} from "@vektorprogrammet/domain/recruitment";
import { guardInterviewApplicantIdentity } from "@vektorprogrammet/domain/recruitment";
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
import { Admissions } from "@vektorprogrammet/domain/admissions";
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
  makeGrant,
  type AccessSpec,
  type CanonicalScopeResolution,
  type Scope,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/domain/database";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import { DepartmentId, Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
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
  assignApplicantPostgres,
  cancelInterviewPostgres,
  correctInterviewAssessmentPostgres,
  executeRecruitmentInvitationHttpTransitionPostgres,
  finalizeInterviewPostgres,
  readInterviewConductInTransaction,
  readInvitationResponsePostgres,
  readRecruitmentApplicationHttpAccessPostgres,
  readRecruitmentInterviewHttpSourcePostgres,
  readRecruitmentPersonAuthorityHttpSourcesPostgres,
  readRecruitmentInvitationHttpSourcePostgres,
  readRecruitmentTargetActorPostgres,
  readRecruitmentTargetAuthorityPostgres,
  scheduleInterviewPostgres,
  type RecruitmentActor,
  type RecruitmentInterviewHttpSource,
  type RecruitmentAuthorityHttpSource,
  type RecruitmentInvitationHttpSource,
  type RecruitmentSchedulingBoard,
  type RecruitmentInvitationHttpTransition,
} from "@vektorprogrammet/domain/recruitment";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
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
  prepareNativeHttpCommand,
} from "../native-operation.js";
import type { BackendRun } from "../router.js";
import { type RecruitmentApiConfig } from "./config.js";

export interface RecruitmentConductContextResolution {
  readonly actor: RecruitmentActor;
  readonly authorizationInstant: string;
}

export interface RecruitmentApiHttpOptions {
  readonly config: RecruitmentApiConfig;
  readonly resolveActor: (request: Request) => Promise<RecruitmentActor>;
  readonly resolveConductContext?: (
    request: Request,
  ) => Promise<RecruitmentConductContextResolution>;
  readonly run: BackendRun;
}

type RecruitmentBackendRun = RecruitmentApiHttpOptions["run"];

type GenericFacts = Readonly<Record<string, unknown>>;

export const RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS = {
  readInvitationResponse: {
    operationId: "recruitment.readInvitationResponse",
    method: "GET",
    path: "/api/recruitment/invitation-response",
  },
  confirmInvitation: {
    operationId: "recruitment.confirmInvitation",
    method: "POST",
    path: "/api/recruitment/invitation-response:confirm",
  },
  rejectInvitation: {
    operationId: "recruitment.rejectInvitation",
    method: "POST",
    path: "/api/recruitment/invitation-response:reject",
  },
  requestNewInvitationTime: {
    operationId: "recruitment.requestNewInvitationTime",
    method: "POST",
    path: "/api/recruitment/invitation-response:request-new-time",
  },
  readAssignmentBoard: {
    operationId: "recruitment.readAssignmentBoard",
    method: "GET",
    path: "/api/recruitment/application-assignments",
  },
  readInterviewReport: {
    operationId: "recruitment.readInterviewReport",
    method: "GET",
    path: "/api/recruitment/interview-report",
  },
  readSchedulingBoard: {
    operationId: "recruitment.readSchedulingBoard",
    method: "GET",
    path: "/api/recruitment/interviews",
  },
  createApplicationInterview: {
    operationId: "recruitment.createApplicationInterview",
    method: "POST",
    path: "/api/recruitment/applications/{applicationId}/interviews",
  },
  scheduleInterview: {
    operationId: "recruitment.scheduleInterview",
    method: "POST",
    path: "/api/recruitment/interviews/{interviewId}:schedule",
  },
  readInterviewConduct: {
    operationId: "recruitment.readInterviewConduct",
    method: "GET",
    path: "/api/recruitment/interviews/{interviewId}",
  },
  correctInterviewAssessment: {
    operationId: "recruitment.correctInterviewAssessment",
    method: "POST",
    path: "/api/recruitment/interviews/{interviewId}:correct",
  },
  finalizeInterview: {
    operationId: "recruitment.finalizeInterview",
    method: "POST",
    path: "/api/recruitment/interviews/{interviewId}:finalize",
  },
  cancelInterview: {
    operationId: "recruitment.cancelInterview",
    method: "POST",
    path: "/api/recruitment/interviews/{interviewId}:cancel",
  },
} as const;

export const RECRUITMENT_NATIVE_OPERATION_IDS = Object.values(
  RECRUITMENT_NATIVE_OPERATION_REGISTRATIONS,
).map((registration) => registration.operationId);

const NativeHttpCommandId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^httpv2_[A-Za-z0-9_-]+$/u)),
);

const NO_STORE = "no-store";
const PRIVATE_NO_STORE = "private, no-store";
const PERSON_CHALLENGE = 'VektorSession realm="native-api", Bearer realm="native-api"';

const errorTag = (cause: unknown): string | undefined =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : undefined;

const errorResponse = (
  cause: unknown,
  unavailableCode: "recruitment.unavailable" | "dependency.unavailable" = "dependency.unavailable",
): Response => {
  const sqlCode = (value: unknown, depth = 0): string | undefined =>
    depth < 8 && typeof value === "object" && value !== null
      ? "code" in value && typeof value.code === "string"
        ? value.code
        : "cause" in value
          ? sqlCode(value.cause, depth + 1)
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

const strictDecode = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: RecruitmentBackendRun,
  failure: {
    readonly code: "request.malformed" | "validation.failed";
    readonly status: 400 | 422;
  } = { code: "validation.failed", status: 422 },
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure(failure.code, failure.status)),
    ),
  );

const strictOutput = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
  run: RecruitmentBackendRun,
): Promise<S["Type"]> =>
  run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
    ),
  );

const readJsonBody = async (
  request: Request,
  maxBodyBytes: number,
  malformedOnly = false,
): Promise<unknown> => {
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
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) fail("request.too-large", 413);
  try {
    return parseJsonWithoutDuplicateMembers(bytes);
  } catch (cause) {
    if (malformedOnly && cause instanceof HttpSemanticFailure) {
      throw new HttpSemanticFailure("request.malformed", 400);
    }
    throw cause;
  }
};

export const readRecruitmentRequestBody = readJsonBody;

const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);
  return value === null ? [] : [value];
};

const noQuery = (request: Request): void => {
  if (new URL(request.url).search.length > 0) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
};

const decodeBoardQuery = async (
  request: Request,
  run: RecruitmentBackendRun,
): Promise<typeof RecruitmentAssignmentBoardQuerySchema.Type> => {
  const parameters = [...new URL(request.url).searchParams];
  if (parameters.length !== 1 || parameters[0]?.[0] !== "status") {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  return strictDecode(RecruitmentAssignmentBoardQuerySchema, { status: parameters[0][1] }, run);
};

const invitationCapability = async (
  request: Request,
  run: RecruitmentBackendRun,
): Promise<typeof RecruitmentInvitationCapabilitySchema.Type> => {
  const value = request.headers.get("x-recruitment-invitation-capability");
  return run(
    Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(value, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("resource.not-found", 404))),
  );
};

const actorFor = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<RecruitmentActor> => {
  try {
    return await input.resolveActor(request);
  } catch (cause) {
    if (errorTag(cause) !== undefined) throw cause;
    throw new HttpSemanticFailure("credential.invalid", 401);
  }
};

const authorizationFor = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<RecruitmentConductContextResolution> => {
  try {
    if (input.resolveConductContext !== undefined) {
      return await input.resolveConductContext(request);
    }
    return { actor: await actorFor(request, input), authorizationInstant: input.config.now() };
  } catch (cause) {
    if (errorTag(cause) !== undefined || cause instanceof HttpSemanticFailure) throw cause;
    throw new HttpSemanticFailure("credential.invalid", 401);
  }
};

const capabilityForSpec = (spec: AccessSpec) => {
  if (spec.capabilities._tag !== "One") {
    throw new HttpSemanticFailure("internal.error", 500);
  }
  return spec.capabilities.capability;
};

const rejectedCode = (status: 401 | 403 | 404) =>
  status === 401
    ? "credential.invalid"
    : status === 404
      ? "resource.not-found"
      : "authority.denied";

const authorizePersonOperation = async (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: RecruitmentActor;
  readonly resolution: CanonicalScopeResolution<GenericFacts>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly authorizationInstant: string;
  readonly run: RecruitmentBackendRun;
}): Promise<void> => {
  const principal = { _tag: "Person" as const, personId: input.actor.personId };
  const instant = AuthorizationInstant.make(input.authorizationInstant);
  const capability = capabilityForSpec(input.spec);
  const grants = input.grantScopes.map((scope, index) =>
    makeGrant({
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
  const evaluation = await input.run(
    evaluateAccessJourney(input.spec, undefined, {
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
    }),
  );
  const status = accessHttpStatus(evaluation, input.spec.concealment);
  if (status !== 200) {
    throw new HttpSemanticFailure(rejectedCode(status), status);
  }
};

const authorizeInvitationOperation = async (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly source: RecruitmentInvitationHttpSource;
  readonly authorizationInstant: string;
  readonly run: RecruitmentBackendRun;
}): Promise<void> => {
  const capabilityId = CapabilityId.make(input.source.capabilitySha256);
  const principal = { _tag: "CapabilityHolder" as const, capabilityId };
  const instant = AuthorizationInstant.make(input.authorizationInstant);
  const resource = {
    kind: RECRUITMENT_INVITATION_RESOURCE_KIND,
    id: ResourceId.make(input.source.invitationId),
  };
  const capability = capabilityForSpec(input.spec);
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
  const grant = makeGrant({
    grantId: GrantId.make(`native-invitation:${input.source.capabilitySha256}`),
    subject: principal,
    capability,
    scope: { _tag: "Resource", resource },
    startAt: instant,
    endAt: null,
    requirements: [],
    source: AuthorityRef.make("native-invitation-capability"),
    revision: input.source.responseRevision,
  });
  const evaluation = await input.run(
    evaluateAccessJourney(input.spec, undefined, {
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
    }),
  );
  const status = accessHttpStatus(evaluation, input.spec.concealment);
  if (status !== 200) throw new HttpSemanticFailure(rejectedCode(status), status);
};

const actorDepartment = (actor: RecruitmentActor): DepartmentId | null =>
  actor._tag === "GlobalAdmin" ? null : actor.departmentId;

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
    linkedApplicantPersonId: source.linkedApplicantPersonId,
    departmentLeaderPersonIds:
      allowLeader && actor._tag === "DepartmentLeader" && actor.departmentId === source.departmentId
        ? [actor.personId]
        : [],
  },
  authorityVersion: AuthorityVersion.make(
    `${source.interviewRevision}:${source.linkedApplicantPersonId ?? "Unknown"}:${source.authority.map((item) => `${item.kind}:${item.identity}:${item.revisions.join(".")}`).join("|")}`,
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
      interviewRevision: interview.revision,
      authority,
    }),
  })),
});

export const conditionalJsonResponse = (
  request: Request,
  body: unknown,
  etag: StrongETag,
): Response => {
  const decision = evaluateReadPreconditions({
    currentETag: etag,
    ifMatch: parseReadIfMatch(headerValues(request, "if-match")),
    ifNoneMatch: parseIfNoneMatch(headerValues(request, "if-none-match")),
  });
  if (decision._tag === "Failed") return nativeProblemResponse(decision.code, decision.status);
  if (decision._tag === "NotModified") {
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
};

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

const executeCommand = async <CommandId>(input: {
  readonly request: Request;
  readonly operationId: string;
  readonly routeTemplate: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly semanticRequest: CanonicalSemanticRequest;
  readonly commandIdSchema: Schema.ConstraintDecoder<CommandId, never>;
  readonly prepare: (run: RecruitmentBackendRun) => Promise<{
    readonly credentialSubject: CredentialSubject;
    readonly execute: (
      commandId: CommandId,
    ) => Effect.Effect<
      Response,
      unknown,
      never | Database | Admissions | Organization | Profile | Recruitment
    >;
  }>;
  readonly run: RecruitmentBackendRun;
}): Promise<Response> => {
  const outcome = await input.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(input.run, async (txRun) => {
        const prepared = await input.prepare(txRun);
        const derived = commandIdentity(
          input.request,
          prepared.credentialSubject,
          input.operationId,
          input.routeTemplate,
          input.identities,
        );
        const commandId = await strictDecode(input.commandIdSchema, derived.commandId, txRun);
        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(input.semanticRequest),
            operationId: input.operationId,
          },
          execute: prepared
            .execute(commandId)
            .pipe(Effect.flatMap((response) => Effect.promise(() => responseCapsule(response)))),
        };
      }),
    ),
  );
  return nativeCommandOutcomeResponse(outcome);
};

const readInvitationResponse = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const capability = await invitationCapability(request, input.run);
  const now = input.config.now();
  const source = await input.run(readRecruitmentInvitationHttpSourcePostgres(capability));
  await authorizeInvitationOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponseEndpoint)),
    request,
    source,
    authorizationInstant: now,
    run: input.run,
  });
  const observation = await input.run(readInvitationResponsePostgres(capability));
  const output = await strictOutput(InvitationResponseObservation, observation, input.run);
  return conditionalJsonResponse(request, output, invitationETag(source));
};

const invitationMutation = async (
  request: Request,
  operation: "Confirm" | "Reject" | "RequestNewTime",
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const capability = await invitationCapability(request, input.run);
  const endpoint =
    operation === "Confirm"
      ? ConfirmInvitationEndpoint
      : operation === "Reject"
        ? RejectInvitationEndpoint
        : RequestNewInvitationTimeEndpoint;
  let commandInput: {
    readonly body: unknown;
    readonly transition: RecruitmentInvitationHttpTransition;
  };
  if (operation === "Confirm") {
    commandInput = {
      body: await strictDecode(
        ConfirmInvitationPayload,
        await readJsonBody(request, input.config.maxBodyBytes, true),
        input.run,
        { code: "request.malformed", status: 400 },
      ),
      transition: { _tag: "Confirm" },
    };
  } else if (operation === "Reject") {
    const body = await strictDecode(
      InvitationRejectInput,
      await readJsonBody(request, input.config.maxBodyBytes),
      input.run,
    );
    commandInput = {
      body,
      transition: {
        _tag: "Reject",
        ...(body.message === undefined ? {} : { message: body.message }),
      },
    };
  } else {
    const body = await strictDecode(
      InvitationRequestNewTimeInput,
      await readJsonBody(request, input.config.maxBodyBytes),
      input.run,
    );
    commandInput = {
      body,
      transition: { _tag: "RequestNewTime", message: body.message },
    };
  }
  const operationId =
    operation === "Confirm"
      ? "recruitment.confirmInvitation"
      : operation === "Reject"
        ? "recruitment.rejectInvitation"
        : "recruitment.requestNewInvitationTime";
  const suffix =
    operation === "Confirm" ? "confirm" : operation === "Reject" ? "reject" : "request-new-time";
  return executeCommand({
    request,
    operationId,
    routeTemplate: `/api/recruitment/invitation-response:${suffix}`,
    identities: {},
    semanticRequest: semanticMutationRequest(commandInput.body, ifMatch),
    commandIdSchema: NativeHttpCommandId,
    run: input.run,
    prepare: async (txRun) => {
      const now = input.config.now();
      const source = await txRun(readRecruitmentInvitationHttpSourcePostgres(capability));
      await authorizeInvitationOperation({
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
        request,
        source,
        authorizationInstant: now,
        run: txRun,
      });
      const precondition = evaluateMutationPrecondition(invitationETag(source), ifMatch);
      if (precondition._tag === "Failed") {
        throw new HttpSemanticFailure(precondition.code, precondition.status);
      }
      return {
        credentialSubject: `Capability:${source.capabilitySha256}`,
        execute: (commandId) =>
          Effect.gen(function* () {
            yield* executeRecruitmentInvitationHttpTransitionPostgres({
              commandId,
              capability,
              transition: commandInput.transition,
              now,
            });
            const updated = yield* readRecruitmentInvitationHttpSourcePostgres(capability);
            return new Response(null, {
              status: 204,
              headers: { "cache-control": NO_STORE, etag: invitationETag(updated) },
            });
          }),
      };
    },
  });
};

const readAssignmentBoard = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  const query = await decodeBoardQuery(request, input.run);
  const actor = await actorFor(request, input);
  const now = input.config.now();
  const departmentId = actorDepartment(actor);
  await authorizePersonOperation({
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
              actor._tag === "DepartmentLeader" && actor.active ? [actor.personId] : [],
          },
          now,
        ),
      ],
    },
    grantScopes:
      departmentId === null
        ? [{ _tag: "Domain", domainId: DomainId.make("recruitment") }]
        : [{ _tag: "Department", departmentId }],
    authorizationInstant: now,
    run: input.run,
  });
  const observation = await input.run(
    Recruitment.use(({ readAssignmentBoard: read }) => read(query, { actor, now })),
  );
  const output = await strictOutput(AssignmentBoard, observation, input.run);
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
  });
};

const readInterviewReport = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys())
    if (values.getAll(key).length !== 1) throw new HttpSemanticFailure("request.malformed", 400);
  const query = await strictDecode(InterviewReportQuery, Object.fromEntries(values), input.run);
  const caller = await actorFor(request, input);
  const now = input.config.now();
  const actor = await input.run(resolveInterviewReportLeader(caller.personId, now));
  await authorizePersonOperation({
    spec: Option.getOrThrow(reflectAccessSpec(ReadInterviewReportEndpoint)),
    request,
    actor,
    resolution: {
      selection: "AllMatching",
      contexts: [boardContext(actor, { departmentLeaderPersonIds: [actor.personId] }, now)],
    },
    grantScopes: [{ _tag: "Department", departmentId: actor.departmentId }],
    authorizationInstant: now,
    run: input.run,
  });
  const observation = await input.run(readCompletedInterviewReport(actor.personId, now, query));
  const output = await strictOutput(InterviewReport, observation, input.run);
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
  });
};

const readSchedulingBoard = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const actor = await actorFor(request, input);
  const now = input.config.now();
  const departmentId = actorDepartment(actor);
  await authorizePersonOperation({
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
              actor._tag !== "GlobalAdmin" && actor.active ? [actor.personId] : [],
          },
          now,
        ),
      ],
    },
    grantScopes:
      departmentId === null
        ? [{ _tag: "Domain", domainId: DomainId.make("recruitment") }]
        : [{ _tag: "Department", departmentId }],
    authorizationInstant: now,
    run: input.run,
  });
  const observation = await input.run(
    Recruitment.use(({ readSchedulingBoard: read }) => read({ actor, now })),
  );
  const authority = await input.run(
    readRecruitmentPersonAuthorityHttpSourcesPostgres(actor.personId),
  );
  const output = await strictOutput(
    SchedulingBoard,
    schedulingBoardWithETags(observation, authority),
    input.run,
  );
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
  });
};

const createApplicationInterview = async (
  request: Request,
  applicationId: typeof PublicApplicationIdSchema.Type,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const body = await strictDecode(
    CreateApplicationInterviewRequest,
    await readJsonBody(request, input.config.maxBodyBytes),
    input.run,
  );
  return executeCommand({
    request,
    operationId: "recruitment.createApplicationInterview",
    routeTemplate: "/api/recruitment/applications/{applicationId}/interviews",
    identities: { applicationId },
    semanticRequest: { body },
    commandIdSchema: RecruitmentAssignmentCommandId,
    run: input.run,
    prepare: async (txRun) => {
      const authorization = await resolveRequestPersonAuthorityInTransaction(request, {
        run: txRun,
        now: input.config.now,
      });
      const access = await txRun(
        readRecruitmentApplicationHttpAccessPostgres({
          applicationId,
          interviewerPersonId: body.interviewerPersonId,
          authorizationInstant: authorization.authorizationInstant,
        }),
      );
      const actor = await txRun(
        readRecruitmentTargetActorPostgres({
          personId: authorization.authority.personId,
          departmentId: access.departmentId,
          authorizationInstant: authorization.authorizationInstant,
        }),
      );
      const resource = {
        kind: ResourceKind.make("application"),
        id: ResourceId.make(applicationId),
      };
      await authorizePersonNativeOperation({
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
                  actor._tag === "DepartmentLeader" && actor.active ? [actor.personId] : [],
                eligibleInterviewerPersonIds: access.interviewerEligible ? [actor.personId] : [],
              },
              version: authorization.authorizationInstant,
            }),
          ],
        },
        grantScopes: [{ _tag: "Resource", resource }],
        now: authorization.authorizationInstant,
        run: txRun,
      });
      return {
        credentialSubject: `Person:${actor.personId}`,
        execute: (commandId) =>
          Effect.gen(function* () {
            const result = yield* assignApplicantPostgres(
              { commandId, applicationId, ...body },
              {
                actor,
                now: authorization.authorizationInstant,
                interviewId: input.config.nextInterviewId(),
              },
            );
            const output = yield* Schema.decodeEffect(RecruitmentInterviewResource)(
              result.observation.interview,
              { onExcessProperty: "error" },
            ).pipe(Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)));
            const source = yield* readRecruitmentInterviewHttpSourcePostgres(
              result.observation.interview.interviewId,
              actor.personId,
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
    },
  });
};

const interviewAuthorization = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint:
    | typeof ScheduleInterviewEndpoint
    | typeof ReadInterviewConductEndpoint
    | typeof FinalizeInterviewEndpoint
    | typeof CancelInterviewEndpoint
    | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions,
) => {
  const authorization = await authorizationFor(request, input);
  const source = await input.run(
    readRecruitmentInterviewHttpSourcePostgres(interviewId, authorization.actor.personId),
  );
  const { actor, activeMember } = await input.run(
    readRecruitmentTargetAuthorityPostgres({
      personId: authorization.actor.personId,
      departmentId: source.departmentId,
      authorizationInstant: authorization.authorizationInstant,
    }),
  );
  const resource = {
    kind: ResourceKind.make("recruitment-interview"),
    id: ResourceId.make(interviewId),
  };
  await authorizePersonOperation({
    spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
    request,
    actor,
    resolution: {
      selection: "ExactlyOne",
      contexts: [recruitmentInterviewAccessContext(source, actor, allowLeader, activeMember)],
    },
    grantScopes: [{ _tag: "Resource", resource }],
    authorizationInstant: authorization.authorizationInstant,
    run: input.run,
  });
  return { actor, authorizationInstant: authorization.authorizationInstant, source };
};

const interviewAuthorizationInTransaction = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint:
    | typeof ScheduleInterviewEndpoint
    | typeof ReadInterviewConductEndpoint
    | typeof FinalizeInterviewEndpoint
    | typeof CancelInterviewEndpoint
    | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions,
  txRun: RecruitmentBackendRun,
) => {
  const authorization = await resolveRequestPersonAuthorityInTransaction(request, {
    run: txRun,
    now: input.config.now,
  });
  const source = await txRun(
    readRecruitmentInterviewHttpSourcePostgres(interviewId, authorization.authority.personId),
  );
  const { actor, activeMember } = await txRun(
    readRecruitmentTargetAuthorityPostgres({
      personId: authorization.authority.personId,
      departmentId: source.departmentId,
      authorizationInstant: authorization.authorizationInstant,
    }),
  );
  const resource = {
    kind: ResourceKind.make("recruitment-interview"),
    id: ResourceId.make(interviewId),
  };
  await authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
    credential: authorization.credential,
    personId: actor.personId,
    resolution: {
      selection: "ExactlyOne",
      contexts: [recruitmentInterviewAccessContext(source, actor, allowLeader, activeMember)],
    },
    grantScopes: [{ _tag: "Resource", resource }],
    now: authorization.authorizationInstant,
    run: txRun,
  });
  return {
    actor,
    authorizationInstant: authorization.authorizationInstant,
    source,
  };
};

const scheduleInterview = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const body = await strictDecode(
    ScheduleInterviewRequest,
    await readJsonBody(request, input.config.maxBodyBytes),
    input.run,
  );
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  return executeCommand({
    request,
    operationId: "recruitment.scheduleInterview",
    routeTemplate: "/api/recruitment/interviews/{interviewId}:schedule",
    identities: { interviewId },
    semanticRequest: semanticMutationRequest(body, ifMatch),
    commandIdSchema: RecruitmentScheduleCommandId,
    run: input.run,
    prepare: async (txRun) => {
      const authorization = await interviewAuthorizationInTransaction(
        request,
        interviewId,
        ScheduleInterviewEndpoint,
        true,
        input,
        txRun,
      );
      const precondition = evaluateMutationPrecondition(
        interviewETag(authorization.source),
        ifMatch,
      );
      if (precondition._tag === "Failed") {
        throw new HttpSemanticFailure(precondition.code, precondition.status);
      }
      return {
        credentialSubject: `Person:${authorization.actor.personId}`,
        execute: (commandId) =>
          Effect.gen(function* () {
            const result = yield* scheduleInterviewPostgres(
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
            const updated = yield* readRecruitmentInterviewHttpSourcePostgres(
              interviewId,
              authorization.actor.personId,
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
    },
  });
};

const readInterviewConductHandler = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const snapshot = await input.run(
    Effect.gen(function* () {
      const sql = yield* Database;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const txRun: RecruitmentBackendRun = (effect) =>
            input.run(effect.pipe(Effect.provideService(Database, sql)));
          const authorization = yield* Effect.promise(() =>
            interviewAuthorizationInTransaction(
              request,
              interviewId,
              ReadInterviewConductEndpoint,
              false,
              input,
              txRun,
            ),
          );
          const observation = yield* readInterviewConductInTransaction(
            interviewId,
            {
              actor: authorization.actor,
              now: input.config.now,
              authorizationInstant: authorization.authorizationInstant,
            },
            sql,
          );
          const source = yield* readRecruitmentInterviewHttpSourcePostgres(
            interviewId,
            authorization.actor.personId,
          ).pipe(Effect.provideService(Database, sql));
          return { observation, source };
        }),
      );
    }),
  );
  const output = await strictOutput(ConductObservation, snapshot.observation, input.run);
  return conditionalJsonResponse(request, output, interviewETag(snapshot.source));
};

const correctInterviewAssessment = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const body = await strictDecode(
    CorrectInterviewAssessmentRequest,
    await readJsonBody(request, input.config.maxBodyBytes),
    input.run,
  );
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  return executeCommand({
    request,
    operationId: "recruitment.correctInterviewAssessment",
    routeTemplate: "/api/recruitment/interviews/{interviewId}:correct",
    identities: { interviewId },
    semanticRequest: semanticMutationRequest(body, ifMatch),
    commandIdSchema: RecruitmentInterviewCorrectionCommandId,
    run: input.run,
    prepare: async (txRun) => {
      const authorization = await interviewAuthorizationInTransaction(
        request,
        interviewId,
        CorrectInterviewAssessmentEndpoint,
        false,
        input,
        txRun,
      );
      return {
        credentialSubject: `Person:${authorization.actor.personId}`,
        execute: (commandId) =>
          Effect.gen(function* () {
            const precondition = evaluateMutationPrecondition(
              interviewETag(authorization.source),
              ifMatch,
            );
            if (precondition._tag === "Failed")
              return yield* Effect.fail(
                new HttpSemanticFailure(precondition.code, precondition.status),
              );
            if (body.expectedRevision !== authorization.source.interviewRevision)
              return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
            const result = yield* correctInterviewAssessmentPostgres(
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
            const updated = yield* readRecruitmentInterviewHttpSourcePostgres(
              interviewId,
              authorization.actor.personId,
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
    },
  });
};

const lifecycleInterview = async (
  request: Request,
  interviewId: RecruitmentInterviewId,
  operation: "Finalize" | "Cancel",
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  noQuery(request);
  const endpoint = operation === "Finalize" ? FinalizeInterviewEndpoint : CancelInterviewEndpoint;
  const rawBody = await readJsonBody(request, input.config.maxBodyBytes);
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const prepareAuthorization = async (txRun: RecruitmentBackendRun) => {
    const authorization = await interviewAuthorizationInTransaction(
      request,
      interviewId,
      endpoint,
      false,
      input,
      txRun,
    );
    await txRun(guardInterviewApplicantIdentity(interviewId, authorization.actor.personId));
    return authorization;
  };
  if (operation === "Finalize") {
    const body = await strictDecode(FinalizeInterviewRequest, rawBody, input.run);
    return executeCommand({
      request,
      operationId: "recruitment.finalizeInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:finalize",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentConductCommandId,
      run: input.run,
      prepare: async (txRun) => {
        const authorization = await prepareAuthorization(txRun);
        return {
          credentialSubject: `Person:${authorization.actor.personId}`,
          execute: (commandId) =>
            Effect.gen(function* () {
              const precondition = evaluateMutationPrecondition(
                interviewETag(authorization.source),
                ifMatch,
              );
              if (precondition._tag === "Failed")
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              const result = yield* finalizeInterviewPostgres(
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
              const updated = yield* readRecruitmentInterviewHttpSourcePostgres(
                interviewId,
                authorization.actor.personId,
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
      },
    });
  }
  const body = await strictDecode(CancelInterviewRequest, rawBody, input.run);
  return executeCommand({
    request,
    operationId: "recruitment.cancelInterview",
    routeTemplate: "/api/recruitment/interviews/{interviewId}:cancel",
    identities: { interviewId },
    semanticRequest: semanticMutationRequest(body, ifMatch),
    commandIdSchema: RecruitmentCancellationCommandId,
    run: input.run,
    prepare: async (txRun) => {
      const authorization = await prepareAuthorization(txRun);
      return {
        credentialSubject: `Person:${authorization.actor.personId}`,
        execute: (commandId) =>
          Effect.gen(function* () {
            const precondition = evaluateMutationPrecondition(
              interviewETag(authorization.source),
              ifMatch,
            );
            if (precondition._tag === "Failed")
              return yield* Effect.fail(
                new HttpSemanticFailure(precondition.code, precondition.status),
              );
            const result = yield* cancelInterviewPostgres(
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
            const updated = yield* readRecruitmentInterviewHttpSourcePostgres(
              interviewId,
              authorization.actor.personId,
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
    },
  });
};

/** Native HttpApi implementations for all frozen recruitment operations. */
export const RecruitmentApiHandlers = (input: RecruitmentApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "recruitment", (handlers) =>
    Effect.succeed(
      handlers
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
