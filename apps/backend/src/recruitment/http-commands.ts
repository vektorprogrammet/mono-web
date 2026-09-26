/** Recruitment command handlers: invitation responses, assignment, scheduling, correction, finalize, and cancel. */
import type { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { ResourceId, ResourceKind, Scope } from "@vektorprogrammet/domain/authz";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import {
  Recruitment,
  RecruitmentAssignmentCommandId,
  RecruitmentCancellationCommandId,
  RecruitmentConductCommandId,
  RecruitmentInterviewCorrectionCommandId,
  RecruitmentInvitationTransition,
  RecruitmentScheduleCommandId,
  type RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import {
  AssignApplicantEndpoint,
  CancelInterviewEndpoint,
  CancelInterviewRequest,
  CancelInterviewResponse,
  ConfirmInvitationEndpoint,
  ConfirmInvitationPayload,
  CorrectInterviewAssessmentEndpoint,
  CorrectInterviewAssessmentRequest,
  CorrectInterviewAssessmentResponse,
  CreateApplicationInterviewRequest,
  FinalizeInterviewEndpoint,
  FinalizeInterviewRequest,
  FinalizeInterviewResponse,
  InvitationRejectInput,
  InvitationRequestNewTimeInput,
  RecruitmentInterviewResource,
  RejectInvitationEndpoint,
  RequestNewInvitationTimeEndpoint,
  ScheduleInterviewEndpoint,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { isProblem, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  requireCurrentETag,
  requiredIfMatchOf,
  requireNoQuery,
  semanticProblem,
  strictOutput,
  unreachable,
  jsonText,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  NO_STORE,
  normalizeTarget,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
  type CanonicalSemanticRequest,
  type CredentialSubject,
} from "../http-semantics.js";
import {
  applicationContext,
  authorizeInvitationOperation,
  interviewAuthorizationInTransaction,
} from "./http-access.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import { invitationCapability, readRecruitmentBody } from "./http-decode.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  raceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./http-problem.js";
import { interviewETag, invitationETag } from "./http-representation.js";

/**
 * Runs one idempotent command: current authority first, then the stored
 * receipt, then the command, all in one serializable transaction that is
 * retried once after a lost race.
 */
const executeCommand = <CommandId, EPrepare, RPrepare, EExecute>(input: {
  readonly request: Request;
  readonly operationId: string;
  readonly routeTemplate: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly semanticRequest: CanonicalSemanticRequest;
  readonly commandIdSchema: Schema.ConstraintDecoder<CommandId, never>;
  readonly prepare: Effect.Effect<
    {
      readonly credentialSubject: CredentialSubject;
      readonly execute: (
        commandId: NoInfer<CommandId>,
      ) => Effect.Effect<Response, EExecute, Recruitment>;
    },
    EPrepare,
    RPrepare
  >;
}) =>
  executeNativeHttpCommandPostgres(
    Effect.gen(function* () {
      const prepared = yield* input.prepare;
      const idempotencyKey = yield* idempotencyKeyOf(input.request);

      const normalizedTarget = yield* semanticProblem(
        () => normalizeTarget(input.routeTemplate, input.identities),
        ["request.malformed"],
      );

      const derived = yield* httpIdentity({
        credentialSubject: prepared.credentialSubject,
        qualifiedOperationId: input.operationId,
        normalizedTarget,
        idempotencyKey,
      });

      const commandId = yield* decodeRequest(input.commandIdSchema)(derived.commandId);

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
    { retry: "serialization-once" },
  ).pipe(Effect.flatMap(commandOutcomeResponse));

/** An interview command's committed representation, with the interview's new validator. */
const interviewCommandResponse = (
  interviewId: RecruitmentInterviewId,
  personId: PersonId,
  output:
    | typeof ScheduleInterviewResponse.Type
    | typeof CorrectInterviewAssessmentResponse.Type
    | typeof FinalizeInterviewResponse.Type
    | typeof CancelInterviewResponse.Type,
) =>
  Recruitment.use((service) => service.readInterviewSource(interviewId, personId)).pipe(
    Effect.map(
      (updated) =>
        new Response(JSON.stringify(output), {
          status: 200,
          headers: {
            "cache-control": NO_STORE,
            "content-type": "application/json",
            etag: interviewETag(updated),
          },
        }),
    ),
  );

/** Answers one invitation through its response capability with the transition its body names. */
const respondToInvitation = <E, R, RActor>(
  request: Request,
  input: RecruitmentApiHttpOptions<RActor>,
  endpoint:
    | typeof ConfirmInvitationEndpoint
    | typeof RejectInvitationEndpoint
    | typeof RequestNewInvitationTimeEndpoint,
  readTransition: Effect.Effect<RecruitmentInvitationTransition, E, R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const ifMatch = yield* requiredIfMatchOf(request);
    const capability = yield* invitationCapability(request);
    const transition = yield* readTransition;
    const now = yield* currentInstant(input.config.now);

    const source = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    ).pipe(Effect.map((snapshot) => snapshot.source));

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      source,
      authorizationInstant: now,
    });

    // An answered invitation fails as already responded, whatever its validator.
    if (source.responseState === "Pending") {
      yield* requireCurrentETag(invitationETag(source), ifMatch);
    }

    const updated = yield* Recruitment.use((service) =>
      service.transitionInvitation({ capability, transition, now }),
    );

    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": NO_STORE,
        etag: invitationETag(updated.source),
        vary: "Origin",
      },
    });
  }).pipe(
    recruitmentProblems(personPresentation(request), "dependency.unavailable"),
    // A capability holder is no person, and an invitation answers only its own problems.
    unreachable(
      "credential.missing",
      "credential.invalid",
      ...admissionPeriodProblems,
      ...assignmentProblems,
      "recruitment.interview-not-found",
      ...schedulingProblems,
      ...conductProblems,
      "idempotency.digest-conflict",
    ),
  );

/** Accepts one invitation. */
export const confirmInvitation = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) =>
  respondToInvitation(
    request,
    input,
    ConfirmInvitationEndpoint,
    readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(ConfirmInvitationPayload)(body, { onExcessProperty: "error" }),
      ),
      // request.malformed is the only client problem the confirmation contract declares.
      Effect.mapError((failure) =>
        isProblem(failure) && failure.code === "internal.error"
          ? Problem.make("internal.error")
          : Problem.make("request.malformed"),
      ),
      Effect.as(RecruitmentInvitationTransition.Confirm()),
    ),
  );

/** Rejects one invitation with an optional message. */
export const rejectInvitation = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) =>
  respondToInvitation(
    request,
    input,
    RejectInvitationEndpoint,
    readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(InvitationRejectInput)),
      Effect.map((body) =>
        body.message === undefined
          ? RecruitmentInvitationTransition.Reject({})
          : RecruitmentInvitationTransition.Reject({ message: body.message }),
      ),
    ),
  );

/** Asks for another interview time with a message. */
export const requestNewInvitationTime = <R>(
  request: Request,
  input: RecruitmentApiHttpOptions<R>,
) =>
  respondToInvitation(
    request,
    input,
    RequestNewInvitationTimeEndpoint,
    readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(InvitationRequestNewTimeInput)),
      Effect.map((body) =>
        RecruitmentInvitationTransition.RequestNewTime({ message: body.message }),
      ),
    ),
  );

export const createApplicationInterview = <R>(
  request: Request,
  applicationId: typeof PublicApplicationIdSchema.Type,
  input: RecruitmentApiHttpOptions<R>,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(CreateApplicationInterviewRequest)),
    );

    return yield* executeCommand({
      request,
      operationId: "recruitment.createApplicationInterview",
      routeTemplate: "/api/recruitment/applications/{applicationId}/interviews",
      identities: { applicationId },
      semanticRequest: { body },
      commandIdSchema: RecruitmentAssignmentCommandId,
      prepare: Effect.gen(function* () {
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

        yield* authorizePerson(
          {
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
                    departmentAdministratorPersonIds:
                      Predicate.isTagged(actor, "DepartmentAdministrator") && actor.active
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
          },
          presentation,
        );

        return {
          credentialSubject: `Person:${actor.personId}` as const,
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

              const interview = result.observation.interview;
              const output = yield* strictOutput(RecruitmentInterviewResource)(interview);

              const source = yield* Recruitment.use((service) =>
                service.readInterviewSource(interview.interviewId, actor.personId),
              );

              const location = normalizeTarget("/api/recruitment/interviews/{interviewId}", {
                interviewId: interview.interviewId,
              });

              return new Response(yield* jsonText(output), {
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
  }).pipe(
    raceProblems,
    recruitmentProblems(presentation, "dependency.unavailable"),
    commandReceiptProblems,
    // The interview was created or replayed in this transaction, and assignment
    // answers no scheduling, conduct, or invitation problem.
    unreachable(
      "recruitment.interview-not-found",
      "precondition.failed",
      ...schedulingProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );
};

export const scheduleInterview = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(ScheduleInterviewRequest)),
    );

    const ifMatch = yield* requiredIfMatchOf(request);

    return yield* executeCommand({
      request,
      operationId: "recruitment.scheduleInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:schedule",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentScheduleCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction(
          request,
          interviewId,
          ScheduleInterviewEndpoint,
          true,
          input,
        );

        return {
          credentialSubject: `Person:${authorization.actor.personId}` as const,
          execute: (commandId: RecruitmentScheduleCommandId) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(interviewETag(authorization.source), ifMatch);

              const { observation } = yield* Recruitment.use((service) =>
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

              const output = yield* strictOutput(ScheduleInterviewResponse)({
                interviewId: observation.interviewId,
                schedule: observation.schedule,
                responseState: observation.responseState,
                notificationState: observation.notificationState,
              });

              return yield* interviewCommandResponse(
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });
  }).pipe(
    raceProblems,
    recruitmentProblems(personPresentation(request), "dependency.unavailable"),
    commandReceiptProblems,
    // Scheduling reads its interview's own application, which cannot vanish, and
    // answers no assignment, conduct, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );

export const correctInterviewAssessment = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

    const body = yield* readRecruitmentBody(request, input.config.maxBodyBytes).pipe(
      Effect.flatMap(decodeRequest(CorrectInterviewAssessmentRequest)),
    );

    const ifMatch = yield* requiredIfMatchOf(request);

    return yield* executeCommand({
      request,
      operationId: "recruitment.correctInterviewAssessment",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:correct",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentInterviewCorrectionCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction(
          request,
          interviewId,
          CorrectInterviewAssessmentEndpoint,
          false,
          input,
        );

        return {
          credentialSubject: `Person:${authorization.actor.personId}` as const,
          execute: (commandId: RecruitmentInterviewCorrectionCommandId) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(interviewETag(authorization.source), ifMatch);

              if (body.expectedRevision !== authorization.source.interviewRevision) {
                return yield* Problem.make("precondition.failed");
              }

              const { observation, replayed } = yield* Recruitment.use((service) =>
                service.correctInterviewAssessment(
                  { commandId, interviewId, ...body },
                  {
                    actor: authorization.actor,
                    now: authorization.authorizationInstant,
                    authorizationInstant: authorization.authorizationInstant,
                  },
                ),
              );

              const output = yield* strictOutput(CorrectInterviewAssessmentResponse)({
                _tag: observation._tag,
                commandId: observation.commandId,
                interviewId: observation.interviewId,
                predecessorRevision: observation.predecessorRevision,
                resultingRevision: observation.resultingRevision,
                replayed,
              });

              return yield* interviewCommandResponse(
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });
  }).pipe(
    raceProblems,
    recruitmentProblems(personPresentation(request), "dependency.unavailable"),
    commandReceiptProblems,
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );

export const finalizeInterview = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const rawBody = yield* readRecruitmentBody(request, input.config.maxBodyBytes);
    const ifMatch = yield* requiredIfMatchOf(request);
    const body = yield* decodeRequest(FinalizeInterviewRequest)(rawBody);

    return yield* executeCommand({
      request,
      operationId: "recruitment.finalizeInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:finalize",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentConductCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction(
          request,
          interviewId,
          FinalizeInterviewEndpoint,
          false,
          input,
        );

        return {
          credentialSubject: `Person:${authorization.actor.personId}` as const,
          execute: (commandId: RecruitmentConductCommandId) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(interviewETag(authorization.source), ifMatch);

              const { observation } = yield* Recruitment.use((service) =>
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

              const output = yield* strictOutput(FinalizeInterviewResponse)({
                interviewId: observation.interviewId,
                finalizedAt: observation.finalizedAt,
                completionState: observation.completionState,
                cancellationState: observation.cancellationState,
              });

              return yield* interviewCommandResponse(
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });
  }).pipe(
    raceProblems,
    recruitmentProblems(personPresentation(request), "dependency.unavailable"),
    commandReceiptProblems,
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );

export const cancelInterview = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const rawBody = yield* readRecruitmentBody(request, input.config.maxBodyBytes);
    const ifMatch = yield* requiredIfMatchOf(request);
    const body = yield* decodeRequest(CancelInterviewRequest)(rawBody);

    return yield* executeCommand({
      request,
      operationId: "recruitment.cancelInterview",
      routeTemplate: "/api/recruitment/interviews/{interviewId}:cancel",
      identities: { interviewId },
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentCancellationCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction(
          request,
          interviewId,
          CancelInterviewEndpoint,
          false,
          input,
        );

        return {
          credentialSubject: `Person:${authorization.actor.personId}` as const,
          execute: (commandId: RecruitmentCancellationCommandId) =>
            Effect.gen(function* () {
              yield* requireCurrentETag(interviewETag(authorization.source), ifMatch);

              const { observation } = yield* Recruitment.use((service) =>
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

              const output = yield* strictOutput(CancelInterviewResponse)({
                interviewId: observation.interviewId,
                cancelledAt: observation.cancelledAt,
                completionState: observation.completionState,
                cancellationState: observation.cancellationState,
              });

              return yield* interviewCommandResponse(
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });
  }).pipe(
    raceProblems,
    recruitmentProblems(personPresentation(request), "dependency.unavailable"),
    commandReceiptProblems,
    // Cancellation checks no invitation, and its instant always fits the clock.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "recruitment.invitation-not-accepted",
      "recruitment.conduct-invalid",
      "resource.not-found",
      "invitation.already-responded",
    ),
  );
