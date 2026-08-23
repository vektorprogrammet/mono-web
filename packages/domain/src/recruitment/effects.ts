import { Schema } from "effect";
import {
  PublicApplicationEmailSchema,
  PublicApplicationPhoneSchema,
} from "../application/schema.js";
import { PersonContactEmail, PersonContactPhone } from "../profile/schema.js";
import {
  RecruitmentInvitationId,
  RecruitmentNotificationEffectId,
  RecruitmentScheduleCommandId,
  RecruitmentInterviewId,
  RecruitmentInstantSchema,
} from "./schema.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty value" }),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));

export const RecruitmentInvitationOutboxRequestSchema = Schema.Struct({
  _tag: Schema.Literals(["SendInterviewInvitation"]),
  effectId: RecruitmentNotificationEffectId,
  commandId: RecruitmentScheduleCommandId,
  interviewId: RecruitmentInterviewId,
  invitationId: RecruitmentInvitationId,
  scheduleRevision: Revision,
  applicantEmail: PublicApplicationEmailSchema,
  applicantPhone: PublicApplicationPhoneSchema,
  interviewerDisplayName: NonEmpty,
  interviewerEmail: PersonContactEmail,
  interviewerPhone: PersonContactPhone,
  scheduledAt: RecruitmentInstantSchema,
  room: NonEmpty,
  campus: Schema.NullOr(NonEmpty),
  mapLink: Schema.NullOr(Schema.String),
  message: NonEmpty,
  responseCapability: NonEmpty,
});
export type RecruitmentInvitationOutboxRequest =
  typeof RecruitmentInvitationOutboxRequestSchema.Type;

export const RecruitmentNotificationEvidenceSchema = Schema.Struct({
  effectId: RecruitmentNotificationEffectId,
  deliveredAt: RecruitmentInstantSchema,
  providerReference: NonEmpty,
});
export type RecruitmentNotificationEvidence = typeof RecruitmentNotificationEvidenceSchema.Type;

export class RecruitmentNotificationDeliveryError extends Schema.TaggedError<RecruitmentNotificationDeliveryError>()(
  "RecruitmentNotificationDeliveryError",
  {
    effectId: RecruitmentNotificationEffectId,
    message: NonEmpty,
  },
) {}
