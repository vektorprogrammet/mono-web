/**
 * Recruitment commands: invitation responses, assignment, scheduling, correction, finalization,
 * and cancellation.
 *
 * An interview command resolves the credential and authority inside the serializable transaction
 * that commits it and stores its answer as a command receipt, byte for byte what the HTTP contract
 * stored: the response body, and the interview's new entity tag as the `etag` header. A retry that
 * straddles the cutover from HTTP therefore replays its first answer.
 */
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
  CancelInterview,
  CancelInterviewResponse,
  ConfirmInvitation,
  CorrectInterviewAssessment,
  CorrectInterviewAssessmentResponse,
  CreateApplicationInterview,
  FinalizeInterview,
  FinalizeInterviewResponse,
  RecruitmentInterviewResource,
  RejectInvitation,
  RequestNewInvitationTime,
  ScheduleInterview,
  ScheduleInterviewResponse,
  reflectAccessSpec,
  type CorrectInterviewAssessmentRequest,
  type CreateApplicationInterviewRequest,
  type FinalizeInterviewRequest,
  type ScheduleInterviewRequest,
} from "@vektorprogrammet/rpc";
import { type IdempotencyKey, Problem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import { currentInstant, resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import {
  jsonBodyBytes,
  normalizeTarget,
  semanticMutationRequest,
  semanticRequestDigest,
  type CanonicalSemanticRequest,
  type CredentialSubject,
} from "../http-semantics.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandReceiptProblems,
  personPresentation,
  requireCurrentETag,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";
import {
  applicationContext,
  authorizeInvitationOperation,
  interviewAuthorizationInTransaction,
} from "./access.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  raceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./problem.js";
import { type RecruitmentCall } from "./context.js";
import { invitationCapability } from "./reads.js";
import { interviewETag, invitationETag } from "./representation.js";

/** A schema whose JSON codec a command receipt stores. */
type ReceiptSchema = Schema.Codec<unknown, unknown, never, never>;

/**
 * The receipt of an interview command: its body as JSON, and the interview's entity tag as the
 * `etag` header. An assignment also keeps its 201 status and the interview's `location`.
 */
const interviewCapsule =
  <S extends ReceiptSchema>(schema: S) =>
  (
    value: S["Type"],
    etag: StrongETag,
    created?: { readonly location: string },
  ): Effect.Effect<NativeHttpResponseCapsule> =>
    Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
      Effect.orDie,
      Effect.map(
        (body): NativeHttpResponseCapsule => ({
          status: created === undefined ? 200 : 201,
          mediaType: "application/json",
          headers:
            created === undefined
              ? { "content-type": "application/json", etag }
              : { "content-type": "application/json", etag, location: created.location },
          bodyBytes: jsonBodyBytes(body),
        }),
      ),
    );

/** The body and entity tag that an interview command receipt stores; a mismatch is a defect. */
const storedInterviewCommand =
  <S extends ReceiptSchema>(schema: S) =>
  (capsule: NativeHttpResponseCapsule) =>
    Effect.gen(function* () {
      if (capsule.bodyBytes === null || capsule.headers.etag === undefined) {
        return yield* Effect.die(
          new NativeHttpReceiptInvalid({ reason: "an interview receipt stores no entity" }),
        );
      }

      const body: S["Type"] = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(schema)),
      )(new TextDecoder().decode(capsule.bodyBytes)).pipe(Effect.orDie);

      const etag = yield* Schema.decodeEffect(StrongETag)(capsule.headers.etag).pipe(Effect.orDie);

      return { body, etag };
    });

/**
 * The value of an interview command outcome: the committed or replayed body beside its entity
 * tag, or an idempotency problem.
 */
const interviewCommandOutcome =
  <S extends ReceiptSchema>(schema: S) =>
  (outcome: NativeHttpCommandOutcome) =>
    Match.value(outcome).pipe(
      Match.tag("Committed", "Replay", ({ response }) => storedInterviewCommand(schema)(response)),
      Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
      Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
      Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
      Match.exhaustive,
    );

/**
 * Runs one idempotent command: current authority first, then the stored receipt, then the
 * command, all in one serializable transaction that is retried once after a lost race.
 */
const executeCommand = <CommandId, EPrepare, RPrepare, EExecute>(input: {
  readonly operationId: string;
  readonly normalizedTarget: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly semanticRequest: CanonicalSemanticRequest;
  readonly commandIdSchema: Schema.Codec<CommandId, string, never, never>;
  readonly prepare: Effect.Effect<
    {
      readonly credentialSubject: CredentialSubject;
      readonly execute: (
        commandId: NoInfer<CommandId>,
      ) => Effect.Effect<NativeHttpResponseCapsule, EExecute, Recruitment>;
    },
    EPrepare,
    RPrepare
  >;
}) =>
  executeNativeHttpCommandPostgres(
    Effect.gen(function* () {
      const prepared = yield* input.prepare;

      // The HTTP route stays the normalized target, so receipts and command IDs are stable.
      const derived = yield* commandIdentity({
        credentialSubject: prepared.credentialSubject,
        qualifiedOperationId: input.operationId,
        normalizedTarget: input.normalizedTarget,
        idempotencyKey: input.idempotencyKey,
      });

      // A derived command ID always fits the domain's command ID.
      const commandId = yield* Schema.decodeEffect(input.commandIdSchema)(derived.commandId).pipe(
        Effect.orDie,
      );

      return {
        identity: {
          identitySha256: derived.identitySha256,
          requestSha256: semanticRequestDigest(input.semanticRequest),
          operationId: input.operationId,
        },
        execute: prepared.execute(commandId),
      };
    }),
    { retry: "serialization-once" },
  );

/** The route of one interview, as the HTTP contract named it. A path it cannot spell is a defect. */
const interviewTarget = (routeTemplate: string, interviewId: RecruitmentInterviewId) =>
  Effect.sync(() => normalizeTarget(routeTemplate, { interviewId }));

/** An interview command's committed answer, with the interview's new entity tag. */
const interviewCommandCapsule = <S extends ReceiptSchema>(
  schema: S,
  interviewId: RecruitmentInterviewId,
  personId: PersonId,
  output: S["Type"],
) =>
  Recruitment.use((service) => service.readInterviewSource(interviewId, personId)).pipe(
    Effect.flatMap((updated) => interviewCapsule(schema)(output, interviewETag(updated))),
  );

/** Answers one invitation through its response capability with the transition its payload names. */
const respondToInvitation = (input: {
  readonly headers: Headers.Headers;
  readonly options: NativeRpcOptions;
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly capability: string;
  readonly ifMatch: StrongETag;
  readonly transition: RecruitmentInvitationTransition;
}) =>
  Effect.gen(function* () {
    const capability = yield* invitationCapability(input.capability);
    const now = yield* currentInstant(input.options.config.recruitment.now);

    const source = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    ).pipe(Effect.map((snapshot) => snapshot.source));

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      source,
      authorizationInstant: now,
    });

    // An answered invitation fails as already responded, whatever its validator.
    if (source.responseState === "Pending") {
      yield* requireCurrentETag(invitationETag(source), input.ifMatch);
    }

    const updated = yield* Recruitment.use((service) =>
      service.transitionInvitation({ capability, transition: input.transition, now }),
    );

    return { etag: invitationETag(updated.source) };
  }).pipe(
    recruitmentProblems({
      presentation: personPresentation(input.headers),
      unavailable: "dependency.unavailable",
    }),
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
export const confirmInvitation = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{ readonly capability: string; readonly ifMatch: StrongETag }>) =>
  respondToInvitation({
    headers,
    options,
    rpc: ConfirmInvitation,
    capability: payload.capability,
    ifMatch: payload.ifMatch,
    transition: RecruitmentInvitationTransition.Confirm(),
  });

/** Rejects one invitation with an optional message. */
export const rejectInvitation = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly capability: string;
  readonly ifMatch: StrongETag;
  readonly request: { readonly message?: string | undefined };
}>) =>
  respondToInvitation({
    headers,
    options,
    rpc: RejectInvitation,
    capability: payload.capability,
    ifMatch: payload.ifMatch,
    transition:
      payload.request.message === undefined
        ? RecruitmentInvitationTransition.Reject({})
        : RecruitmentInvitationTransition.Reject({ message: payload.request.message }),
  });

/** Asks for another interview time with a message. */
export const requestNewInvitationTime = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly capability: string;
  readonly ifMatch: StrongETag;
  readonly request: { readonly message: string };
}>) =>
  respondToInvitation({
    headers,
    options,
    rpc: RequestNewInvitationTime,
    capability: payload.capability,
    ifMatch: payload.ifMatch,
    transition: RecruitmentInvitationTransition.RequestNewTime({
      message: payload.request.message,
    }),
  });

export const createApplicationInterview = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly applicationId: typeof PublicApplicationIdSchema.Type;
  readonly idempotencyKey: IdempotencyKey;
  readonly request: CreateApplicationInterviewRequest;
}>) => {
  const presentation = personPresentation(headers);
  const { applicationId, request: body } = payload;
  const config = options.config.recruitment;

  return Effect.gen(function* () {
    const normalizedTarget = yield* Effect.sync(() =>
      normalizeTarget("/api/recruitment/applications/{applicationId}/interviews", {
        applicationId,
      }),
    );

    const outcome = yield* executeCommand({
      operationId: "recruitment.createApplicationInterview",
      normalizedTarget,
      idempotencyKey: payload.idempotencyKey,
      semanticRequest: { body },
      commandIdSchema: RecruitmentAssignmentCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* resolveRequestPersonAuthorityInTransaction(
          credentialRequestOf(headers),
          { now: config.now },
        );

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
            spec: Option.getOrThrow(reflectAccessSpec(CreateApplicationInterview)),
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
                    interviewId: config.nextInterviewId(),
                  },
                ),
              );

              const interview = result.observation.interview;
              const output = yield* strictOutput(RecruitmentInterviewResource)(interview);

              const source = yield* Recruitment.use((service) =>
                service.readInterviewSource(interview.interviewId, actor.personId),
              );

              const location = yield* interviewTarget(
                "/api/recruitment/interviews/{interviewId}",
                interview.interviewId,
              );

              return yield* interviewCapsule(RecruitmentInterviewResource)(
                output,
                interviewETag(source),
                { location },
              );
            }),
        };
      }),
    });

    const stored = yield* interviewCommandOutcome(RecruitmentInterviewResource)(outcome);

    return { interview: stored.body, etag: stored.etag };
  }).pipe(
    raceProblems,
    recruitmentProblems({ presentation: presentation, unavailable: "dependency.unavailable" }),
    commandReceiptProblems,
    // The interview was created or replayed in this transaction, and assignment answers no
    // scheduling, conduct, or invitation problem.
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

export const scheduleInterview = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly interviewId: RecruitmentInterviewId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  readonly request: ScheduleInterviewRequest;
}>) => {
  const { interviewId, ifMatch, request: body } = payload;
  const config = options.config.recruitment;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      operationId: "recruitment.scheduleInterview",
      normalizedTarget: yield* interviewTarget(
        "/api/recruitment/interviews/{interviewId}:schedule",
        interviewId,
      ),
      idempotencyKey: payload.idempotencyKey,
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentScheduleCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction({
          headers,
          interviewId,
          rpc: ScheduleInterview,
          allowLeader: true,
          now: config.now,
        });

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
                    invitationId: config.nextInvitationId(),
                    responseCapability: config.nextResponseCapability(),
                  },
                ),
              );

              const output = yield* strictOutput(ScheduleInterviewResponse)({
                interviewId: observation.interviewId,
                schedule: observation.schedule,
                responseState: observation.responseState,
                notificationState: observation.notificationState,
              });

              return yield* interviewCommandCapsule(
                ScheduleInterviewResponse,
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });

    const stored = yield* interviewCommandOutcome(ScheduleInterviewResponse)(outcome);

    return { result: stored.body, etag: stored.etag };
  }).pipe(
    raceProblems,
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "dependency.unavailable",
    }),
    commandReceiptProblems,
    // Scheduling reads its interview's own application, which cannot vanish, and answers no
    // assignment, conduct, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );
};

export const correctInterviewAssessment = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly interviewId: RecruitmentInterviewId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  readonly request: CorrectInterviewAssessmentRequest;
}>) => {
  const { interviewId, ifMatch, request: body } = payload;
  const config = options.config.recruitment;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      operationId: "recruitment.correctInterviewAssessment",
      normalizedTarget: yield* interviewTarget(
        "/api/recruitment/interviews/{interviewId}:correct",
        interviewId,
      ),
      idempotencyKey: payload.idempotencyKey,
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentInterviewCorrectionCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction({
          headers,
          interviewId,
          rpc: CorrectInterviewAssessment,
          allowLeader: false,
          now: config.now,
        });

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

              return yield* interviewCommandCapsule(
                CorrectInterviewAssessmentResponse,
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });

    const stored = yield* interviewCommandOutcome(CorrectInterviewAssessmentResponse)(outcome);

    return { result: stored.body, etag: stored.etag };
  }).pipe(
    raceProblems,
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "dependency.unavailable",
    }),
    commandReceiptProblems,
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );
};

export const finalizeInterview = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly interviewId: RecruitmentInterviewId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
  readonly request: FinalizeInterviewRequest;
}>) => {
  const { interviewId, ifMatch, request: body } = payload;
  const config = options.config.recruitment;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      operationId: "recruitment.finalizeInterview",
      normalizedTarget: yield* interviewTarget(
        "/api/recruitment/interviews/{interviewId}:finalize",
        interviewId,
      ),
      idempotencyKey: payload.idempotencyKey,
      semanticRequest: semanticMutationRequest(body, ifMatch),
      commandIdSchema: RecruitmentConductCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction({
          headers,
          interviewId,
          rpc: FinalizeInterview,
          allowLeader: false,
          now: config.now,
        });

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

              return yield* interviewCommandCapsule(
                FinalizeInterviewResponse,
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });

    const stored = yield* interviewCommandOutcome(FinalizeInterviewResponse)(outcome);

    return { result: stored.body, etag: stored.etag };
  }).pipe(
    raceProblems,
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "dependency.unavailable",
    }),
    commandReceiptProblems,
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "resource.not-found",
      "invitation.already-responded",
    ),
  );
};

export const cancelInterview = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{
  readonly interviewId: RecruitmentInterviewId;
  readonly idempotencyKey: IdempotencyKey;
  readonly ifMatch: StrongETag;
}>) => {
  const { interviewId, ifMatch } = payload;
  const config = options.config.recruitment;

  return Effect.gen(function* () {
    const outcome = yield* executeCommand({
      operationId: "recruitment.cancelInterview",
      normalizedTarget: yield* interviewTarget(
        "/api/recruitment/interviews/{interviewId}:cancel",
        interviewId,
      ),
      idempotencyKey: payload.idempotencyKey,
      // The HTTP contract took an exact empty JSON object, which the digest keeps.
      semanticRequest: semanticMutationRequest({}, ifMatch),
      commandIdSchema: RecruitmentCancellationCommandId,
      prepare: Effect.gen(function* () {
        const authorization = yield* interviewAuthorizationInTransaction({
          headers,
          interviewId,
          rpc: CancelInterview,
          allowLeader: false,
          now: config.now,
        });

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

              return yield* interviewCommandCapsule(
                CancelInterviewResponse,
                interviewId,
                authorization.actor.personId,
                output,
              );
            }),
        };
      }),
    });

    const stored = yield* interviewCommandOutcome(CancelInterviewResponse)(outcome);

    return { result: stored.body, etag: stored.etag };
  }).pipe(
    raceProblems,
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "dependency.unavailable",
    }),
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
};
