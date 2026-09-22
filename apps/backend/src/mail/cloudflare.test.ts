import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Mail, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";
import {
  CloudflareMailLive,
  classifyCloudflareMailError,
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
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Mail).deliver(value);
    }).pipe(Effect.provide(CloudflareMailLive(config))),
  );

describe("CloudflareMailLive", () => {
  it("maps permanent provider codes, availability failures, and timeouts to distinct outcomes", async () => {
    expect(classifyCloudflareMailError({ code: "E_RECIPIENT_NOT_ALLOWED" }).kind).toBe(
      "permanent-rejection",
    );
    expect(classifyCloudflareMailError(new Error("network unavailable")).kind).toBe(
      "temporary-unavailability",
    );

    await expect(
      deliver({
        binding: { send: async () => new Promise<never>(() => undefined) },
        deliveryTimeoutMilliseconds: 1,
      }),
    ).rejects.toMatchObject({ _tag: "MailDeliveryError", kind: "ambiguous-outcome" });
  });

  it("sends the immutable provider-neutral request and returns a stable acknowledgement", async () => {
    const send = vi.fn(async () => ({ messageId: "cloudflare-message-1" }));
    await expect(
      deliver({ binding: { send }, deliveryTimeoutMilliseconds: 1_000 }),
    ).resolves.toEqual({
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
  });

  it("confines development delivery to the configured Cloudflare recipient", async () => {
    const send = vi.fn(async () => ({ messageId: "cloudflare-message-1" }));
    await deliver({
      binding: { send },
      deliveryTimeoutMilliseconds: 1_000,
      recipientOverride: "development-mailbox@example.invalid",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "development-mailbox@example.invalid" }),
    );
  });

  it("records deterministic test deliveries without selecting a provider", async () => {
    const recording = makeRecordingMailLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Mail).deliver(request);
      }).pipe(Effect.provide(recording.layer)),
    );
    expect(recording.deliveries()).toEqual([request]);
  });
});
