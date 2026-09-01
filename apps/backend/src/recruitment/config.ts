import { randomBytes, randomUUID } from "node:crypto";
import type { AdmissionApiConfig } from "../admission/config.js";
import {
  RecruitmentInterviewId,
  RecruitmentInvitationId,
} from "@vektorprogrammet/domain/recruitment";

export interface RecruitmentApiConfig {
  readonly maxBodyBytes: number;
  readonly now: () => string;
  readonly nextInterviewId: () => typeof RecruitmentInterviewId.Type;
  readonly nextInvitationId: () => typeof RecruitmentInvitationId.Type;
  readonly nextResponseCapability: () => string;
}

export const makeRecruitmentInvitationId = (): typeof RecruitmentInvitationId.Type =>
  RecruitmentInvitationId.make(`recruitment_invitation_${randomUUID()}`);

export const makeRecruitmentResponseCapability = (): string =>
  randomBytes(32).toString("base64url");

export const makeRecruitmentApiConfig = (admission: AdmissionApiConfig) => ({
  maxBodyBytes: admission.maxBodyBytes,
  now: admission.now,
  nextInterviewId: () => RecruitmentInterviewId.make(`recruitment_interview_${randomUUID()}`),
  nextInvitationId: makeRecruitmentInvitationId,
  nextResponseCapability: makeRecruitmentResponseCapability,
});
