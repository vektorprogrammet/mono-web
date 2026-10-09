import { Effect, type Crypto } from "effect";
import type { AdmissionApiConfig } from "../admission/config.js";
import { allocateBase64UrlToken, allocatePrefixedUuid } from "../allocation.js";
import {
  RecruitmentInterviewId,
  RecruitmentInvitationId,
} from "@vektorprogrammet/domain/recruitment";

export interface RecruitmentApiConfig {
  readonly maxBodyBytes: number;
  /** Fixed instant from `ADMISSION_FIXED_NOW`; without it, handlers read the Clock service. */
  readonly now?: () => string;
  /** Each allocation draws fresh entropy from the platform `Crypto` service when it runs. */
  readonly nextInterviewId: Effect.Effect<RecruitmentInterviewId, never, Crypto.Crypto>;
  readonly nextInvitationId: Effect.Effect<RecruitmentInvitationId, never, Crypto.Crypto>;
  readonly nextResponseCapability: Effect.Effect<string, never, Crypto.Crypto>;
}

export const recruitmentApiConfig = (admission: AdmissionApiConfig): RecruitmentApiConfig => ({
  maxBodyBytes: admission.maxBodyBytes,
  now: admission.now,
  nextInterviewId: Effect.map(allocatePrefixedUuid("recruitment_interview"), (id) =>
    RecruitmentInterviewId.make(id),
  ),
  nextInvitationId: Effect.map(allocatePrefixedUuid("recruitment_invitation"), (id) =>
    RecruitmentInvitationId.make(id),
  ),
  nextResponseCapability: allocateBase64UrlToken(32),
});
