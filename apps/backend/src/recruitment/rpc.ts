/**
 * The RecruitmentRpcs handlers. A board read resolves the caller's recruitment actor and evaluates
 * the RPC's AccessSpec; an interview read or command resolves the credential and authority inside
 * its transaction, and a command stores its answer as a command receipt, so a retry with the same
 * idempotency key replays the first answer. An invitation response is authorized by the response
 * capability in its payload, and conceals every denial as resource.not-found.
 */
import { RecruitmentRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  cancelInterview,
  confirmInvitation,
  correctInterviewAssessment,
  createApplicationInterview,
  finalizeInterview,
  rejectInvitation,
  requestNewInvitationTime,
  scheduleInterview,
} from "./commands.js";
import { maintainRecruitment, readInterviewStaffing, readQuestionnaires } from "./maintenance.js";
import {
  readAssignmentBoard,
  readInterviewConduct,
  readInterviewReport,
  readInvitationResponse,
  readSchedulingBoard,
} from "./reads.js";

/** The RecruitmentRpcs handlers. */
export const RecruitmentRpcHandlers = (options: NativeRpcOptions) =>
  RecruitmentRpcs.toLayer({
    "recruitment.readInvitationResponse": (payload, { headers }) =>
      readInvitationResponse({ headers, payload, options }),
    "recruitment.confirmInvitation": (payload, { headers }) =>
      confirmInvitation({ headers, payload, options }),
    "recruitment.rejectInvitation": (payload, { headers }) =>
      rejectInvitation({ headers, payload, options }),
    "recruitment.requestNewInvitationTime": (payload, { headers }) =>
      requestNewInvitationTime({ headers, payload, options }),
    "recruitment.readAssignmentBoard": (payload, { headers }) =>
      readAssignmentBoard({ headers, payload, options }),
    "recruitment.readSchedulingBoard": (payload, { headers }) =>
      readSchedulingBoard({ headers, payload, options }),
    "recruitment.readInterviewReport": (payload, { headers }) =>
      readInterviewReport({ headers, payload, options }),
    "recruitment.createApplicationInterview": (payload, { headers }) =>
      createApplicationInterview({ headers, payload, options }),
    "recruitment.scheduleInterview": (payload, { headers }) =>
      scheduleInterview({ headers, payload, options }),
    "recruitment.readInterviewConduct": (payload, { headers }) =>
      readInterviewConduct({ headers, payload, options }),
    "recruitment.finalizeInterview": (payload, { headers }) =>
      finalizeInterview({ headers, payload, options }),
    "recruitment.correctInterviewAssessment": (payload, { headers }) =>
      correctInterviewAssessment({ headers, payload, options }),
    "recruitment.cancelInterview": (payload, { headers }) =>
      cancelInterview({ headers, payload, options }),
    "recruitment.readQuestionnaires": (payload, { headers }) =>
      readQuestionnaires({ headers, payload, options }),
    "recruitment.readInterviewStaffing": (payload, { headers }) =>
      readInterviewStaffing({ headers, payload, options }),
    "recruitment.maintainRecruitment": (payload, { headers }) =>
      maintainRecruitment({ headers, payload, options }),
  });
