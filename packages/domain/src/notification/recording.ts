import { Effect, Layer } from "effect";
import type {
  RecruitmentInterviewCompletionOutboxRequest,
  RecruitmentInvitationOutboxRequest,
  RecruitmentInvitationResponseOutboxRequest,
} from "../recruitment/effects.js";
import { RecruitmentNotificationEvidenceSchema } from "../recruitment/effects.js";
import { NotificationGateway } from "./service.js";

export interface RecordingNotificationGateway {
  readonly completionRequests: ReadonlyArray<RecruitmentInterviewCompletionOutboxRequest>;
  readonly layer: Layer.Layer<NotificationGateway>;
  readonly requests: ReadonlyArray<RecruitmentInvitationOutboxRequest>;
  readonly responseRequests: ReadonlyArray<RecruitmentInvitationResponseOutboxRequest>;
}

export const makeRecordingNotificationGateway = (
  deliveredAt: string,
): RecordingNotificationGateway => {
  const completionRequests: RecruitmentInterviewCompletionOutboxRequest[] = [];
  const requests: RecruitmentInvitationOutboxRequest[] = [];
  const responseRequests: RecruitmentInvitationResponseOutboxRequest[] = [];
  return {
    completionRequests,
    requests,
    responseRequests,
    layer: Layer.succeed(
      NotificationGateway,
      NotificationGateway.of({
        deliverInterviewCompletionReceipt: (request) =>
          Effect.sync(() => {
            completionRequests.push(request);
            return RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt,
              providerReference: `recording-completion:${request.effectId}`,
            });
          }),
        deliverInterviewInvitation: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt,
              providerReference: `recording:${request.effectId}`,
            });
          }),
        deliverInterviewInvitationResponse: (request) =>
          Effect.sync(() => {
            responseRequests.push(request);
            return RecruitmentNotificationEvidenceSchema.make({
              effectId: request.effectId,
              deliveredAt,
              providerReference: `recording-response:${request.effectId}`,
            });
          }),
      }),
    ),
  };
};
