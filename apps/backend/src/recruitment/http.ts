/** Native HttpApi composition for recruitment endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  correctInterviewAssessment,
  createApplicationInterview,
  invitationMutation,
  lifecycleInterview,
  scheduleInterview,
} from "./http-commands.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";
import { recruitmentHttpErrorResponse } from "./http-problem.js";
import {
  readAssignmentBoard,
  readInterviewConduct,
  readInterviewReport,
  readInvitationResponse,
  readSchedulingBoard,
} from "./http-reads.js";
import {
  maintainRecruitmentHttp,
  readRecruitmentMaintenanceHttp,
  recruitmentMaintenanceErrorResponse,
} from "./maintenance-http.js";

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
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("readInvitationResponse", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readInvitationResponse(webRequest, input),
            (cause) => recruitmentHttpErrorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("confirmInvitation", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "Confirm", input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("rejectInvitation", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "Reject", input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("requestNewInvitationTime", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => invitationMutation(webRequest, "RequestNewTime", input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("readAssignmentBoard", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readAssignmentBoard(webRequest, input),
            (cause) => recruitmentHttpErrorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("readSchedulingBoard", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readSchedulingBoard(webRequest, input),
            (cause) => recruitmentHttpErrorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("createApplicationInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createApplicationInterview(webRequest, params.applicationId, input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("scheduleInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => scheduleInterview(webRequest, params.interviewId, input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("readInterviewConduct", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readInterviewConduct(webRequest, params.interviewId, input),
            (cause) => recruitmentHttpErrorResponse(cause, "recruitment.unavailable"),
          ),
        )
        .handleRaw("finalizeInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleInterview(webRequest, params.interviewId, "Finalize", input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("correctInterviewAssessment", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => correctInterviewAssessment(webRequest, params.interviewId, input),
            recruitmentHttpErrorResponse,
          ),
        )
        .handleRaw("cancelInterview", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => lifecycleInterview(webRequest, params.interviewId, "Cancel", input),
            recruitmentHttpErrorResponse,
          ),
        ),
    ),
  );
