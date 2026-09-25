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
import { Effect, Option, Predicate, Schema } from "effect";
import { currentInstant } from "../authority.js";
import {
  actorDepartment,
  authorizeInvitationOperation,
  authorizePersonOperation,
  boardContext,
  interviewAuthorizationInTransaction,
} from "./http-access.js";
import { actorFor, type RecruitmentApiHttpOptions } from "./http-context.js";
import {
  decodeBoardQuery,
  decodeInterviewReportQuery,
  invitationCapability,
  rejectQueryString,
} from "./http-decode.js";
import {
  PRIVATE_NO_STORE,
  conditionalJsonResponse,
  interviewETag,
  invitationETag,
  schedulingBoardWithETags,
  strictOutput,
} from "./http-representation.js";

export const readInvitationResponse = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
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

export const readAssignmentBoard = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
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

export const readInterviewReport = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    const query = yield* decodeInterviewReportQuery(request);
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

export const readSchedulingBoard = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
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

export const readInterviewConduct = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  input: RecruitmentApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);

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
