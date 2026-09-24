import { Context, Effect } from "effect";
import type {
  RecruitmentInterviewCompletionOutboxRequest,
  RecruitmentInvitationOutboxRequest,
  RecruitmentInvitationResponseOutboxRequest,
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidence,
} from "../recruitment/effects.js";

export interface NotificationGatewayOperations {
  readonly deliverInterviewCompletionReceipt: (
    request: RecruitmentInterviewCompletionOutboxRequest,
  ) => Effect.Effect<RecruitmentNotificationEvidence, RecruitmentNotificationDeliveryError>;
  readonly deliverInterviewInvitation: (
    request: RecruitmentInvitationOutboxRequest,
  ) => Effect.Effect<RecruitmentNotificationEvidence, RecruitmentNotificationDeliveryError>;
  readonly deliverInterviewInvitationResponse: (
    request: RecruitmentInvitationResponseOutboxRequest,
  ) => Effect.Effect<RecruitmentNotificationEvidence, RecruitmentNotificationDeliveryError>;
}

export class NotificationGateway extends Context.Service<
  NotificationGateway,
  NotificationGatewayOperations
>()("@vektorprogrammet/domain/NotificationGateway") {}
