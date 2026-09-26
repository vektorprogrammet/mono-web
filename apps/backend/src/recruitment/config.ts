import { randomBytes, randomUUID } from "node:crypto";
import type { AdmissionApiConfig } from "../admission/config.js";
import {
  RecruitmentInterviewId,
  RecruitmentInvitationId,
} from "@vektorprogrammet/domain/recruitment";

export interface RecruitmentApiConfig {
  readonly maxBodyBytes: number;
  /** Fixed instant from `ADMISSION_FIXED_NOW`; without it, handlers read the Clock service. */
  readonly now?: () => string;
  readonly nextInterviewId: () => RecruitmentInterviewId;
  readonly nextInvitationId: () => RecruitmentInvitationId;
  readonly nextResponseCapability: () => string;
}

export const makeRecruitmentInvitationId = (): RecruitmentInvitationId =>
  RecruitmentInvitationId.make(`recruitment_invitation_${randomUUID()}`);

export const makeRecruitmentResponseCapability = (): string =>
  randomBytes(32).toString("base64url");

export const recruitmentApiConfig = (admission: AdmissionApiConfig) => ({
  maxBodyBytes: admission.maxBodyBytes,
  now: admission.now,
  nextInterviewId: () => RecruitmentInterviewId.make(`recruitment_interview_${randomUUID()}`),
  nextInvitationId: makeRecruitmentInvitationId,
  nextResponseCapability: makeRecruitmentResponseCapability,
});
