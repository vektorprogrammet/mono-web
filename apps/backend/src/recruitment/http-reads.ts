/** Recruitment read handlers: invitation response, boards, interview report, and interview conduct. */
import { Database } from "@vektorprogrammet/database";
import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import {
  InterviewReport,
  Recruitment,
  type RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import {
  AssignmentBoard,
  ConductObservation,
  InvitationResponseObservation,
  ReadAssignmentBoardEndpoint,
  ReadInterviewConductEndpoint,
  ReadInterviewReportEndpoint,
  ReadInvitationResponseEndpoint,
  ReadSchedulingBoardEndpoint,
  SchedulingBoard,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant } from "../authority.js";
import {
  authorizePerson,
  conditionalJson,
  personPresentation,
  requireNoQuery,
  strictOutput,
  unreachable,
} from "../http-api/problem.js";
import { PRIVATE_NO_STORE } from "../http-semantics.js";
import {
  actorDepartment,
  authorizeInvitationOperation,
  boardContext,
  interviewAuthorizationInTransaction,
} from "./http-access.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import {
  decodeBoardQuery,
  decodeInterviewReportQuery,
  invitationCapability,
} from "./http-decode.js";
import {
  admissionPeriodProblems,
  assignmentProblems,
  conductProblems,
  raceProblems,
  recruitmentProblems,
  schedulingProblems,
} from "./http-problem.js";
import { interviewETag, invitationETag, schedulingBoardWithETags } from "./http-representation.js";

/** A credential-selected read that carries no validator. */
const privateJson = (
  body: typeof AssignmentBoard.Type | InterviewReport | typeof SchedulingBoard.Type,
) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
  });

export const readInvitationResponse = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    const capability = yield* invitationCapability(request);
    const now = yield* currentInstant(input.config.now);

    const snapshot = yield* Recruitment.use((service) =>
      service.readInvitationSnapshot(capability),
    );

    yield* authorizeInvitationOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponseEndpoint)),
      source: snapshot.source,
      authorizationInstant: now,
    });
    const output = yield* strictOutput(InvitationResponseObservation)(snapshot.observation);

    return yield* conditionalJson({
      request,
      body: output,
      etag: invitationETag(snapshot.source),
      cacheControl: PRIVATE_NO_STORE,
      contentType: "application/json",
    });
  }).pipe(
    recruitmentProblems(personPresentation(request), "recruitment.unavailable"),
    // A capability holder is no person, and the snapshot fails only as an unknown
    // invitation, an undecodable row, or an outage.
    unreachable(
      "credential.missing",
      "credential.invalid",
      "authority.denied",
      ...admissionPeriodProblems,
      ...assignmentProblems,
      "recruitment.interview-not-found",
      ...schedulingProblems,
      ...conductProblems,
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );

export const readAssignmentBoard = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const query = yield* decodeBoardQuery(request);
    const actor = yield* input.resolveActor(request);
    const now = yield* currentInstant(input.config.now);
    const departmentId = actorDepartment(actor);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadAssignmentBoardEndpoint)),
        request,
        personId: actor.personId,
        resolution: {
          selection: "AllMatching",
          contexts: [
            boardContext(
              actor,
              {
                departmentAdministratorPersonIds:
                  Predicate.isTagged(actor, "DepartmentAdministrator") && actor.active
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
        now,
      },
      presentation,
    );

    const observation = yield* Recruitment.use(({ readAssignmentBoard: read }) =>
      read(query, { actor, now }),
    );

    return privateJson(yield* strictOutput(AssignmentBoard)(observation));
  }).pipe(
    recruitmentProblems(presentation, "recruitment.unavailable"),
    // The endpoint's query schema rejects every other status value before the handler,
    // and a board answers no assignment, interview, or invitation problem.
    unreachable(
      "validation.failed",
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

export const readInterviewReport = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const query = yield* decodeInterviewReportQuery(request);
    const caller = yield* input.resolveActor(request);
    const now = yield* currentInstant(input.config.now);

    const actor = yield* Recruitment.use((service) =>
      service.resolveInterviewReportLeader(caller.personId, now),
    );

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadInterviewReportEndpoint)),
        request,
        personId: actor.personId,
        resolution: {
          selection: "AllMatching",
          contexts: [
            boardContext(actor, { departmentAdministratorPersonIds: [actor.personId] }, now),
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

    return privateJson(yield* strictOutput(InterviewReport)(observation));
  }).pipe(
    // The report locks applicant custody, so it answers a lost race as a conflict.
    raceProblems,
    recruitmentProblems(presentation, "recruitment.unavailable"),
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

export const readSchedulingBoard = <R>(request: Request, input: RecruitmentApiHttpOptions<R>) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const actor = yield* input.resolveActor(request);
    const now = yield* currentInstant(input.config.now);
    const departmentId = actorDepartment(actor);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadSchedulingBoardEndpoint)),
        request,
        personId: actor.personId,
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

    return privateJson(
      yield* strictOutput(SchedulingBoard)(schedulingBoardWithETags(observation, authority)),
    );
  }).pipe(
    recruitmentProblems(presentation, "recruitment.unavailable"),
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

export const readInterviewConduct = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);

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
    ).pipe(Effect.catchTag("SqlError", () => Effect.fail(Problem.make("internal.error"))));

    const output = yield* strictOutput(ConductObservation)(snapshot.observation);

    // The observation fits its own schema, so encoding it cannot fail.
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ConductObservation))(output).pipe(
      Effect.orDie,
    );

    return yield* conditionalJson({
      request,
      body: encoded,
      etag: interviewETag(snapshot.source),
      cacheControl: PRIVATE_NO_STORE,
      contentType: "application/json",
    });
  }).pipe(
    recruitmentProblems(personPresentation(request), "recruitment.unavailable"),
    // A conduct read answers no assignment, scheduling, lifecycle, or invitation problem.
    unreachable(
      ...admissionPeriodProblems,
      ...assignmentProblems,
      ...schedulingProblems,
      "recruitment.already-finalized",
      "recruitment.already-cancelled",
      "recruitment.conduct-invalid",
      "resource.not-found",
      "invitation.already-responded",
      "idempotency.digest-conflict",
    ),
  );
