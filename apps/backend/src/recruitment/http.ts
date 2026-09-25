/** Native HttpApi composition for recruitment endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { webHandler } from "../http-api/problem.js";
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
import {
  readAssignmentBoard,
  readInterviewConduct,
  readInterviewReport,
  readInvitationResponse,
  readSchedulingBoard,
} from "./http-reads.js";
import { maintainRecruitmentHttp, readRecruitmentMaintenanceHttp } from "./maintenance-http.js";

/** Native HttpApi implementations for all frozen recruitment operations. */
export const RecruitmentApiHandlers = <R>(input: RecruitmentApiHttpOptions<R>) =>
  HttpApiBuilder.group(ExternalNativeApi, "recruitment", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readQuestionnaires", ({ request }) =>
          webHandler(request, (webRequest) =>
            readRecruitmentMaintenanceHttp(webRequest, "questionnaires"),
          ),
        )
        .handleRaw("readInterviewStaffing", ({ request }) =>
          webHandler(request, (webRequest) =>
            readRecruitmentMaintenanceHttp(webRequest, "staffing"),
          ),
        )
        .handleRaw("maintainRecruitment", ({ request }) =>
          webHandler(request, maintainRecruitmentHttp),
        )
        .handleRaw("readInterviewReport", ({ request }) =>
          webHandler(request, (webRequest) => readInterviewReport(webRequest, input)),
        )
        .handleRaw("readInvitationResponse", ({ request }) =>
          webHandler(request, (webRequest) => readInvitationResponse(webRequest, input)),
        )
        .handleRaw("confirmInvitation", ({ request }) =>
          webHandler(request, (webRequest) => confirmInvitation(webRequest, input)),
        )
        .handleRaw("rejectInvitation", ({ request }) =>
          webHandler(request, (webRequest) => rejectInvitation(webRequest, input)),
        )
        .handleRaw("requestNewInvitationTime", ({ request }) =>
          webHandler(request, (webRequest) => requestNewInvitationTime(webRequest, input)),
        )
        .handleRaw("readAssignmentBoard", ({ request }) =>
          webHandler(request, (webRequest) => readAssignmentBoard(webRequest, input)),
        )
        .handleRaw("readSchedulingBoard", ({ request }) =>
          webHandler(request, (webRequest) => readSchedulingBoard(webRequest, input)),
        )
        .handleRaw("createApplicationInterview", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            createApplicationInterview(webRequest, params.applicationId, input),
          ),
        )
        .handleRaw("scheduleInterview", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            scheduleInterview(webRequest, params.interviewId, input),
          ),
        )
        .handleRaw("readInterviewConduct", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readInterviewConduct(webRequest, params.interviewId, input),
          ),
        )
        .handleRaw("finalizeInterview", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            finalizeInterview(webRequest, params.interviewId, input),
          ),
        )
        .handleRaw("correctInterviewAssessment", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            correctInterviewAssessment(webRequest, params.interviewId, input),
          ),
        )
        .handleRaw("cancelInterview", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            cancelInterview(webRequest, params.interviewId, input),
          ),
        ),
    ),
  );
