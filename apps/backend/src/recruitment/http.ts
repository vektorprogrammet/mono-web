/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
/** Generated native bindings retain the repaired Recruitment authority and receipt boundaries. */
import {
  ExternalNativeApi,
  readInvitationResponse as readInvitationResponseEndpoint,
  confirmInvitation as confirmInvitationEndpoint,
  rejectInvitation as rejectInvitationEndpoint,
  requestNewInvitationTime as requestNewInvitationTimeEndpoint,
  readAssignmentBoard as readAssignmentBoardEndpoint,
  readInterviewReport as readInterviewReportEndpoint,
  readSchedulingBoard as readSchedulingBoardEndpoint,
  createApplicationInterview as createApplicationInterviewEndpoint,
  scheduleInterview as scheduleInterviewEndpoint,
  readInterviewConduct as readInterviewConductEndpoint,
  finalizeInterview as finalizeInterviewEndpoint,
  correctInterviewAssessment as correctInterviewAssessmentEndpoint,
  cancelInterview as cancelInterviewEndpoint,
  readQuestionnaires as readQuestionnairesEndpoint,
  readInterviewStaffing as readInterviewStaffingEndpoint,
  maintainRecruitment as maintainRecruitmentEndpoint,
} from "@vektorprogrammet/http-api";
import type { HttpApiGroup } from "effect/http-api";
import {
  RecruitmentApiHandlers as GeneratedRecruitmentApiHandlers,
  type RecruitmentGuards,
  type RecruitmentRawHandlers,
} from "../../.effx/generated/recruitment-handlers.js";
import { unreachable, webHandler } from "../http-api/problem.js";
import {
  cancelInterview,
  confirmInvitation,
  correctInterviewAssessment,
  createApplicationInterview,
  finalizeInterview,
  rejectInvitation,
  requestNewInvitationTime,
  scheduleInterview,
} from "./http-commands.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import { invitationGuard, personGuard } from "./http-guard.js";
import {
  readAssignmentBoard,
  readInterviewConduct,
  readInterviewReport,
  readInvitationResponse,
  readSchedulingBoard,
} from "./http-reads.js";
import { maintainRecruitmentHttp, readRecruitmentMaintenanceHttp } from "./maintenance-http.js";

type RecruitmentEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["recruitment"]
>;

/** Every guard is lazy; each raw handler supplies current facts at its existing decision point. */
export const recruitmentGuards = {
  "recruitment.readInvitationResponse": () =>
    invitationGuard("recruitment.readInvitationResponse", readInvitationResponseEndpoint),
  "recruitment.confirmInvitation": () =>
    invitationGuard("recruitment.confirmInvitation", confirmInvitationEndpoint),
  "recruitment.rejectInvitation": () =>
    invitationGuard("recruitment.rejectInvitation", rejectInvitationEndpoint),
  "recruitment.requestNewInvitationTime": () =>
    invitationGuard("recruitment.requestNewInvitationTime", requestNewInvitationTimeEndpoint),
  "recruitment.readAssignmentBoard": () =>
    personGuard("recruitment.readAssignmentBoard", readAssignmentBoardEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.readInterviewReport": () =>
    personGuard("recruitment.readInterviewReport", readInterviewReportEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.readSchedulingBoard": () =>
    personGuard("recruitment.readSchedulingBoard", readSchedulingBoardEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.createApplicationInterview": () =>
    personGuard("recruitment.createApplicationInterview", createApplicationInterviewEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.scheduleInterview": () =>
    personGuard("recruitment.scheduleInterview", scheduleInterviewEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.readInterviewConduct": () =>
    personGuard("recruitment.readInterviewConduct", readInterviewConductEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.finalizeInterview": () =>
    personGuard("recruitment.finalizeInterview", finalizeInterviewEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.correctInterviewAssessment": () =>
    personGuard("recruitment.correctInterviewAssessment", correctInterviewAssessmentEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.cancelInterview": () =>
    personGuard("recruitment.cancelInterview", cancelInterviewEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.readQuestionnaires": () =>
    personGuard("recruitment.readQuestionnaires", readQuestionnairesEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.readInterviewStaffing": () =>
    personGuard("recruitment.readInterviewStaffing", readInterviewStaffingEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "recruitment.maintainRecruitment": () =>
    personGuard("recruitment.maintainRecruitment", maintainRecruitmentEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
} satisfies RecruitmentGuards<RecruitmentEndpoints>;

/**
 * Command success still means the business state, audit, outbox and response capsule committed
 * together. Invitation responses have no HTTP replay receipt. Delivery acknowledgements remain
 * separate at-least-once external work after commit; generated guards add no retry or custody.
 */
export const RecruitmentApiHandlers = <R>(input: RecruitmentApiHttpOptions<R>) => {
  const raw = {
    readInvitationResponse: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readInvitationResponse(webRequest, input, authorize)),
    confirmInvitation: ({ request }, authorize) =>
      webHandler(request, (webRequest) => confirmInvitation(webRequest, input, authorize)),
    rejectInvitation: ({ request }, authorize) =>
      webHandler(request, (webRequest) => rejectInvitation(webRequest, input, authorize)),
    requestNewInvitationTime: ({ request }, authorize) =>
      webHandler(request, (webRequest) => requestNewInvitationTime(webRequest, input, authorize)),
    readAssignmentBoard: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readAssignmentBoard(webRequest, input, authorize)),
    readInterviewReport: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readInterviewReport(webRequest, input, authorize)),
    readSchedulingBoard: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readSchedulingBoard(webRequest, input, authorize)),
    createApplicationInterview: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        createApplicationInterview(webRequest, params.applicationId, input, authorize),
      ),
    scheduleInterview: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        scheduleInterview(webRequest, params.interviewId, input, authorize),
      ),
    readInterviewConduct: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        readInterviewConduct(webRequest, params.interviewId, input, authorize),
      ),
    finalizeInterview: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        finalizeInterview(webRequest, params.interviewId, input, authorize),
      ),
    correctInterviewAssessment: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        correctInterviewAssessment(webRequest, params.interviewId, input, authorize),
      ),
    cancelInterview: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        cancelInterview(webRequest, params.interviewId, input, authorize),
      ),
    readQuestionnaires: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        readRecruitmentMaintenanceHttp(webRequest, "questionnaires", authorize),
      ),
    readInterviewStaffing: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        readRecruitmentMaintenanceHttp(webRequest, "staffing", authorize),
      ),
    maintainRecruitment: ({ request }, authorize) =>
      webHandler(request, (webRequest) => maintainRecruitmentHttp(webRequest, authorize)),
  } satisfies RecruitmentRawHandlers<RecruitmentEndpoints, typeof recruitmentGuards>;

  return GeneratedRecruitmentApiHandlers({ raw, guards: recruitmentGuards });
};
