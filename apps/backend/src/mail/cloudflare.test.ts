import { Effect } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { Mail, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";
import {
  CloudflareMailLive,
  classifyCloudflareMailError,
  type CloudflareEmailSendResult,
  type CloudflareMailConfig,
} from "./cloudflare.js";
import { makeRecordingMailLayer } from "./recording.js";

const request: MailDeliveryRequest = {
  deliveryId: "password-reset:account-123",
  sender: "noreply@example.invalid",
  recipient: "operator@example.invalid",
  replyTo: "support@example.invalid",
  subject: "Reset your password",
  text: "A deterministic text message.",
};

const deliver = (config: CloudflareMailConfig, value: MailDeliveryRequest = request) =>
  Mail.use((mail) => mail.deliver(value)).pipe(Effect.provide(CloudflareMailLive(config)));

describe("CloudflareMailLive", () => {
  it.live(
    "maps permanent provider codes, availability failures, and timeouts to distinct outcomes",
    () =>
      Effect.gen(function* () {
        expect(classifyCloudflareMailError({ code: "E_RECIPIENT_NOT_ALLOWED" }).kind).toBe(
          "permanent-rejection",
        );
        expect(classifyCloudflareMailError(new Error("network unavailable")).kind).toBe(
          "temporary-unavailability",
        );

        const observed = yield* Effect.flip(
          deliver({
            binding: { send: () => Promise.withResolvers<CloudflareEmailSendResult>().promise },
            deliveryTimeoutMilliseconds: 1,
          }),
        );

        expect(observed).toHaveProperty("_tag", "MailDeliveryError");
        expect(observed).toMatchObject({ kind: "ambiguous-outcome" });
      }),
  );

  it.effect(
    "sends the immutable provider-neutral request and returns a stable acknowledgement",
    () =>
      Effect.gen(function* () {
        const send = vi.fn(() => Promise.resolve({ messageId: "cloudflare-message-1" }));

        expect(yield* deliver({ binding: { send }, deliveryTimeoutMilliseconds: 1_000 })).toEqual({
          providerReference: "cloudflare-message-1",
        });
        expect(send).toHaveBeenCalledWith({
          from: request.sender,
          to: request.recipient,
          replyTo: request.replyTo,
          subject: request.subject,
          text: request.text,
          headers: {
            "Message-ID": "<password-reset%3Aaccount-123@delivery.vektorprogrammet.no>",
          },
        });
      }),
  );

  it.effect("confines development delivery to the configured Cloudflare recipient", () =>
    Effect.gen(function* () {
      const send = vi.fn(() => Promise.resolve({ messageId: "cloudflare-message-1" }));

      yield* deliver({
        binding: { send },
        deliveryTimeoutMilliseconds: 1_000,
        recipientOverride: "development-mailbox@example.invalid",
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "development-mailbox@example.invalid" }),
      );
    }),
  );

  it.effect("records deterministic test deliveries without selecting a provider", () =>
    Effect.gen(function* () {
      const recording = makeRecordingMailLayer();

      yield* Mail.use((mail) => mail.deliver(request)).pipe(Effect.provide(recording.layer));
      expect(recording.deliveries()).toEqual([request]);
    }),
  );
});
