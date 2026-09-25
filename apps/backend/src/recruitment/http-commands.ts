/** Recruitment command handlers: invitation responses, assignment, scheduling, correction, finalize, and cancel. */
import type { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { ResourceId, ResourceKind, Scope } from "@vektorprogrammet/domain/authz";
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
import { Effect, Match, Option, Predicate, Schema } from "effect";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  evaluateMutationPrecondition,
  normalizeTarget,
  parseIdempotencyKey,
  responseCapsule,
  semanticMutationRequest,
  semanticRequestDigest,
  type CanonicalSemanticRequest,
  type CredentialSubject,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import {
  applicationContext,
  authorizeInvitationOperation,
  interviewAuthorizationInTransaction,
} from "./http-access.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import {
  headerValues,
  invitationCapability,
  readRecruitmentRequestBody,
  rejectQueryString,
  requiredIfMatch,
  strictDecode,
} from "./http-decode.js";
import { knownRecruitmentFailure } from "./http-problem.js";
import { NO_STORE, interviewETag, invitationETag } from "./http-representation.js";

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
          catch: knownRecruitmentFailure,
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
                catch: knownRecruitmentFailure,
              }),
            ),
          ),
        };
      }),
      input.retry === undefined ? {} : { retry: input.retry },
    );

    return nativeCommandOutcomeResponse(outcome);
  });

/** Confirms, rejects, or requests a new time for one invitation through its response capability. */
export const invitationMutation = <E, R>(
  request: Request,
  operation: "Confirm" | "Reject" | "RequestNewTime",
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const ifMatch = yield* requiredIfMatch(request);

    yield* Effect.try({
      try: () => parseIdempotencyKey(headerValues(request, "idempotency-key")),
      catch: knownRecruitmentFailure,
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
        yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes, true),
      );
      transition = RecruitmentInvitationTransition.Confirm();
    } else if (operation === "Reject") {
      const body = yield* strictDecode(InvitationRejectInput)(
        yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes),
      );

      transition =
        body.message === undefined
          ? RecruitmentInvitationTransition.Reject({})
          : RecruitmentInvitationTransition.Reject({ message: body.message });
    } else {
      const body = yield* strictDecode(InvitationRequestNewTimeInput)(
        yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes),
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

export const createApplicationInterview = <E, R>(
  request: Request,
  applicationId: typeof PublicApplicationIdSchema.Type,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const body = yield* strictDecode(CreateApplicationInterviewRequest)(
      yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes),
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

export const scheduleInterview = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const body = yield* strictDecode(ScheduleInterviewRequest)(
      yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes),
    );

    const ifMatch = yield* requiredIfMatch(request);

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

export const correctInterviewAssessment = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

    const body = yield* strictDecode(CorrectInterviewAssessmentRequest)(
      yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes),
    );

    const ifMatch = yield* requiredIfMatch(request);

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

/** Finalizes or cancels one interview; the operation selects the endpoint and command. */
export const lifecycleInterview = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  operation: "Finalize" | "Cancel",
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const endpoint = operation === "Finalize" ? FinalizeInterviewEndpoint : CancelInterviewEndpoint;
    const rawBody = yield* readRecruitmentRequestBody(request, input.config.maxBodyBytes);

    const ifMatch = yield* requiredIfMatch(request);

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
