/** Recruitment reads: invitation response, boards, interview report, and interview conduct. */
import { Database } from "@vektorprogrammet/database";
import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import {
  InterviewReport,
  Recruitment,
  RecruitmentInvitationCapabilitySchema,
  type InterviewReportQuery,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import {
  AssignmentBoard,
  ConductObservation,
  InvitationResponseObservation,
  ReadAssignmentBoard,
  ReadInterviewConduct,
  ReadInterviewReport,
  ReadInvitationResponse,
  ReadSchedulingBoard,
  SchedulingBoard,
  reflectAccessSpec,
  type InvitationResponseResource,
} from "@vektorprogrammet/rpc";
import { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant } from "../authority.js";
import { credentialRequestOf } from "../rpc/credential.js";
import { authorizePerson, personPresentation, strictOutput, unreachable } from "../rpc/problem.js";
import {
  actorDepartment,
  authorizeInvitationOperation,
  boardContext,
  interviewAuthorizationInTransaction,
} from "./access.js";
import { type RecruitmentCall, recruitmentBoardActor } from "./context.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  raceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./problem.js";
import { interviewETag, invitationETag, schedulingBoardWithETags } from "./representation.js";

/**
 * The invitation that a response capability names. A malformed or empty capability names no
 * invitation, so it answers resource.not-found, as an unknown one does.
 */
export const invitationCapability = (capability: string) =>
  Schema.decodeEffect(RecruitmentInvitationCapabilitySchema)(capability).pipe(
    Effect.mapError(() => Problem.make("resource.not-found")),
  );

export const readInvitationResponse = ({
  headers,
  payload,
  options,
}: RecruitmentCall<{ readonly capability: string }>): Effect.Effect<
  InvitationResponseResource,
  Problem<"resource.not-found"> | Problem<"internal.error"> | Problem<"recruitment.unavailable">,
  Recruitment
> =>
  Effect.gen(function* () {
    const capability = yield* invitationCapability(payload.capability);
    const now = yield* currentInstant(options.config.recruitment.now);

    const snapshot = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    );

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponse)),
      source: snapshot.source,
      authorizationInstant: now,
    });

    const observation = yield* strictOutput(InvitationResponseObservation)(snapshot.observation);

    return { observation, etag: invitationETag(snapshot.source) };
  }).pipe(
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "recruitment.unavailable",
    }),
    // A capability holder is no person, and the snapshot fails only as an unknown invitation, an
    // undecodable row, or an outage.
    unreachable(
      "credential.missing",
      "credential.invalid",
      "authority.denied",
      "precondition.failed",
      ...admissionPeriodProblems,
      ...assignmentProblems,
      "recruitment.interview-not-found",
      ...schedulingProblems,
      ...conductProblems,
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );

export const readAssignmentBoard = ({
  headers,
  payload: query,
  options,
}: RecruitmentCall<RecruitmentAssignmentBoardQuery>) => {
  const presentation = personPresentation(headers);

  return Effect.gen(function* () {
    const actor = yield* recruitmentBoardActor({ headers, now: options.now });
    const now = yield* currentInstant(options.config.recruitment.now);
    const departmentId = actorDepartment(actor);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadAssignmentBoard)),
        request: credentialRequestOf(headers),
        personId: actor.personId,
        resolution: {
          selection: "AllMatching",
          contexts: [
            boardContext({
              actor,
              facts: {
                departmentAdministratorPersonIds:
                  Predicate.isTagged(actor, "DepartmentAdministrator") && actor.active
                    ? [actor.personId]
                    : [],
              },
              version: now,
            }),
          ],
        },
        grantScopes:
          departmentId === null
            ? [Scope.Domain({ domainId: DomainId.make("recruitment") })]
            : [Scope.Department({ departmentId })],
        now,
      },
      presentation,
    );

    const observation = yield* Recruitment.use(({ readAssignmentBoard: read }) =>
      read(query, { actor, now }),
    );

    return yield* strictOutput(AssignmentBoard)(observation);
  }).pipe(
    recruitmentProblems({ presentation: presentation, unavailable: "recruitment.unavailable" }),
    // A board answers no assignment, interview, or invitation problem.
    unreachable(
      ...assignmentProblems,
      "recruitment.interview-not-found",
      "precondition.failed",
      ...schedulingProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );
};

export const readInterviewReport = ({
  headers,
  payload: query,
  options,
}: RecruitmentCall<InterviewReportQuery>) => {
  const presentation = personPresentation(headers);

  return Effect.gen(function* () {
    const caller = yield* recruitmentBoardActor({ headers, now: options.now });
    const now = yield* currentInstant(options.config.recruitment.now);

    const actor = yield* Recruitment.use((service) =>
      service.resolveInterviewReportLeader(caller.personId, now),
    );

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadInterviewReport)),
        request: credentialRequestOf(headers),
        personId: actor.personId,
        resolution: {
          selection: "AllMatching",
          contexts: [
            boardContext({
              actor,
              facts: { departmentAdministratorPersonIds: [actor.personId] },
              version: now,
            }),
          ],
        },
        grantScopes: [Scope.Department({ departmentId: actor.departmentId })],
        now,
      },
      presentation,
    );

    const observation = yield* Recruitment.use((service) =>
      service.readCompletedInterviewReport(actor.personId, now, query),
    );

    return yield* strictOutput(InterviewReport)(observation);
  }).pipe(
    // The report locks applicant custody, so it answers a lost race as a conflict.
    raceProblems,
    recruitmentProblems({ presentation: presentation, unavailable: "recruitment.unavailable" }),
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      "recruitment.interview-not-found",
      "precondition.failed",
      ...schedulingProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );
};

export const readSchedulingBoard = ({ headers, options }: RecruitmentCall<void>) => {
  const presentation = personPresentation(headers);

  return Effect.gen(function* () {
    const actor = yield* recruitmentBoardActor({ headers, now: options.now });
    const now = yield* currentInstant(options.config.recruitment.now);
    const departmentId = actorDepartment(actor);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadSchedulingBoard)),
        request: credentialRequestOf(headers),
        personId: actor.personId,
        resolution: {
          selection: "AllMatching",
          contexts: [
            boardContext({
              actor,
              facts: {
                departmentMemberPersonIds:
                  !Predicate.isTagged(actor, "GlobalAdmin") && actor.active ? [actor.personId] : [],
              },
              version: now,
            }),
          ],
        },
        grantScopes:
          departmentId === null
            ? [Scope.Domain({ domainId: DomainId.make("recruitment") })]
            : [Scope.Department({ departmentId })],
        now,
      },
      presentation,
    );

    const observation = yield* Recruitment.use(({ readSchedulingBoard: read }) =>
      read({ actor, now }),
    );

    const authority = yield* Recruitment.use((service) =>
      service.readPersonAuthoritySources(actor.personId),
    );

    return yield* strictOutput(SchedulingBoard)(
      schedulingBoardWithETags({ board: observation, authority }),
    );
  }).pipe(
    recruitmentProblems({ presentation: presentation, unavailable: "recruitment.unavailable" }),
    // Every interview on the board belongs to an application that cannot vanish.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      "recruitment.interview-not-found",
      "precondition.failed",
      ...schedulingProblems,
      ...conductProblems,
      "resource.not-found",
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );
};

export const readInterviewConduct = ({
  headers,
  payload: { interviewId },
  options,
}: RecruitmentCall<{ readonly interviewId: RecruitmentInterviewId }>) =>
  Effect.gen(function* () {
    const snapshot = yield* Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const authorization = yield* interviewAuthorizationInTransaction({
            headers,
            interviewId,
            rpc: ReadInterviewConduct,
            allowLeader: false,
            now: options.config.recruitment.now,
          });

          const now = yield* currentInstant(options.config.recruitment.now);

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
    ).pipe(Effect.catchTag("SqlError", () => Effect.fail(Problem.make("internal.error"))));

    const detail = yield* strictOutput(ConductObservation)(snapshot.observation);

    return { detail, etag: interviewETag(snapshot.source) };
  }).pipe(
    recruitmentProblems({
      presentation: personPresentation(headers),
      unavailable: "recruitment.unavailable",
    }),
    // A conduct read answers no assignment, scheduling, lifecycle, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "precondition.failed",
      "recruitment.already-finalized",
      "recruitment.already-cancelled",
      "recruitment.conduct-invalid",
      "resource.not-found",
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );
