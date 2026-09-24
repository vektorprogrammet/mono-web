import { Effect, Layer } from "effect";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import {
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidenceSchema,
  type RecruitmentInterviewCompletionOutboxRequest,
  type RecruitmentInvitationOutboxRequest,
  type RecruitmentInvitationResponseOutboxRequest,
} from "@vektorprogrammet/domain/recruitment";
import { deliverJson, type DeliveryFetch, type HttpDeliveryConfig } from "../delivery/http.js";

export interface RecruitmentNotificationConfig extends HttpDeliveryConfig {
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
}

export const recruitmentNotificationConfig = (
  env: Readonly<Record<string, string | undefined>>,
): RecruitmentNotificationConfig | undefined => {
  const mode = env.RECRUITMENT_NOTIFICATION_MODE ?? "disabled";
  const endpointValue = env.RECRUITMENT_NOTIFICATION_URL;
  const token = env.RECRUITMENT_NOTIFICATION_TOKEN;

  if (mode === "disabled") {
    if (endpointValue !== undefined || token !== undefined) {
      throw new Error(
        "Recruitment delivery credentials require RECRUITMENT_NOTIFICATION_MODE=http",
      );
    }

    return undefined;
  }

  if (mode !== "http" || !endpointValue || !token) {
    throw new Error("Recruitment notification HTTP configuration is incomplete");
  }

  const endpoint = new URL(endpointValue);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);

  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "Recruitment delivery requires HTTPS or loopback HTTP without URL credentials, query, or fragment",
    );
  }

  const positiveInteger = (key: string, fallback: number): number => {
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);

    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive safe integer`);
    }

    return value;
  };

  const staleClaimMilliseconds = positiveInteger("RECRUITMENT_NOTIFICATION_STALE_MS", 60_000);

  const deliveryTimeoutMilliseconds = positiveInteger(
    "RECRUITMENT_NOTIFICATION_TIMEOUT_MS",
    10_000,
  );

  if (staleClaimMilliseconds <= deliveryTimeoutMilliseconds) {
    throw new Error("Recruitment claim interval must exceed the delivery timeout");
  }

  return {
    endpoint,
    token,
    pollIntervalMilliseconds: positiveInteger("RECRUITMENT_NOTIFICATION_POLL_MS", 250),
    staleClaimMilliseconds,
    deliveryTimeoutMilliseconds,
  };
};

export const HttpRecruitmentNotificationsLive = (
  config: RecruitmentNotificationConfig,
  fetchEffect: DeliveryFetch = globalThis.fetch,
): Layer.Layer<NotificationGateway> => {
  const deliver = (
    request:
      | RecruitmentInvitationOutboxRequest
      | RecruitmentInvitationResponseOutboxRequest
      | RecruitmentInterviewCompletionOutboxRequest,
  ) =>
    deliverJson(request, config, fetchEffect, { "idempotency-key": request.effectId }).pipe(
      Effect.map(() =>
        RecruitmentNotificationEvidenceSchema.make({
          effectId: request.effectId,
          deliveredAt: new Date().toISOString(),
          // This identifies the acknowledged HTTP submission, not downstream mailbox delivery.
          providerReference: `http:${request.effectId}`,
        }),
      ),
      Effect.mapError(
        () =>
          new RecruitmentNotificationDeliveryError({
            effectId: request.effectId,
            message: "Recruitment notification submission was not acknowledged",
          }),
      ),
    );

  return Layer.succeed(NotificationGateway, {
    deliverInterviewInvitation: deliver,
    deliverInterviewInvitationResponse: deliver,
    deliverInterviewCompletionReceipt: deliver,
  });
};
