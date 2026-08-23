import { randomUUID } from "node:crypto";
import type { AdmissionApiConfig, AdmissionApiPrincipal } from "../admission/config.js";
import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";

export interface RecruitmentApiConfig {
  readonly tokens: ReadonlyMap<string, AdmissionApiPrincipal>;
  readonly maxBodyBytes: number;
  readonly now: () => string;
  readonly nextInterviewId: () => typeof RecruitmentInterviewId.Type;
}

export const makeRecruitmentApiConfig = (admission: AdmissionApiConfig): RecruitmentApiConfig => ({
  tokens: admission.tokens,
  maxBodyBytes: admission.maxBodyBytes,
  now: admission.now,
  nextInterviewId: () => RecruitmentInterviewId.make(`recruitment_interview_${randomUUID()}`),
});
