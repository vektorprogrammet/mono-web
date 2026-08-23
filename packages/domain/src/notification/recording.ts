import { Effect, Layer } from "effect";
import type { RecruitmentInvitationOutboxRequest } from "../recruitment/effects.js";
import { RecruitmentNotificationEvidenceSchema } from "../recruitment/effects.js";
import { NotificationGateway } from "./service.js";

export interface RecordingNotificationGateway {
  readonly layer: Layer.Layer<NotificationGateway>;
  readonly requests: ReadonlyArray<RecruitmentInvitationOutboxRequest>;
}

export const makeRecordingNotificationGateway = (
  deliveredAt: string,
): RecordingNotificationGateway => {
  const requests: RecruitmentInvitationOutboxRequest[] = [];
  return {
    requests,
    layer: Layer.succeed(
      NotificationGateway,
      NotificationGateway.of({
        deliverInterviewInvitation: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt,
              providerReference: `recording:${request.effectId}`,
            });
          }),
      }),
    ),
  };
};
