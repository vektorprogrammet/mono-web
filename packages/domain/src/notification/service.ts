import { Context, Effect } from "effect";
import type {
  RecruitmentInvitationOutboxRequest,
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidence,
} from "../recruitment/effects.js";

export interface NotificationGatewayShape {
  readonly deliverInterviewInvitation: (
    request: RecruitmentInvitationOutboxRequest,
  ) => Effect.Effect<RecruitmentNotificationEvidence, RecruitmentNotificationDeliveryError>;
}

export class NotificationGateway extends Context.Service<
  NotificationGateway,
  NotificationGatewayShape
>()("@vektorprogrammet/domain/NotificationGateway") {}
