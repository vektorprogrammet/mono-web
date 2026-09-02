import { PasswordResetMailDelivery } from "@vektorprogrammet/domain/identity";
import type { PasswordResetMailDeliveryRequest } from "@vektorprogrammet/domain/identity";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CloudflarePasswordResetMailDeliveryLive,
  type CloudflareEmailMessageBuilder,
  type CloudflareEmailSendResult,
  type CloudflarePasswordResetMailDeliveryConfig,
} from "./cloudflare-email.js";

const canonicalOrigin = "https://vektor.phibkro.org";
const resetUrl = `${canonicalOrigin}/api/auth/reset-password/opaque-token?callbackURL=https%3A%2F%2Fvektor.phibkro.org%2Ftilbakestill-passord`;

const request: PasswordResetMailDeliveryRequest = {
  effectId: "effect-not-for-provider-payload",
  recipientEmail: "person@example.com",
  resetUrl,
  expiresAt: new Date("2030-01-02T03:04:05.000Z"),
};

const runDelivery = (
  config: CloudflarePasswordResetMailDeliveryConfig,
  deliveryRequest: PasswordResetMailDeliveryRequest = request,
) =>
  // oxlint-disable-next-line effect/no-premature-execution -- controlled provider-boundary test
  Effect.runPromise(
    Effect.gen(function* () {
      const delivery = yield* PasswordResetMailDelivery;
      return yield* delivery.deliver(deliveryRequest);
    }).pipe(Effect.provide(CloudflarePasswordResetMailDeliveryLive(config))),
  );

const configWith = (
  send: (message: CloudflareEmailMessageBuilder) => Promise<CloudflareEmailSendResult>,
  deliveryTimeoutMilliseconds = 1_000,
): CloudflarePasswordResetMailDeliveryConfig => ({
  binding: { send },
  senderAddress: "noreply@phibkro.org",
  canonicalOrigin,
  dashboardOrigin: canonicalOrigin,
  deliveryTimeoutMilliseconds,
});

describe("CloudflarePasswordResetMailDeliveryLive", () => {
  it("sends the exact plain-text builder payload through the Worker binding", async () => {
    const send = vi.fn(async (_message: CloudflareEmailMessageBuilder) => ({
      messageId: "cloudflare-message-1",
    }));

    await expect(runDelivery(configWith(send))).resolves.toEqual({
      providerReference: "cloudflare-message-1",
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      from: "noreply@phibkro.org",
      to: "person@example.com",
      subject: "Tilbakestill passordet ditt",
      text: [
        "Det ble bedt om et nytt passord for Vektorprogrammet-kontoen din.",
        "",
        "Bruk denne lenken for å velge et nytt passord:",
        resetUrl,
        "",
        "Lenken utløper 2030-01-02T03:04:05.000Z.",
        "",
        "Hvis du ikke ba om dette, kan du se bort fra e-posten.",
      ].join("\n"),
    });
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain(request.effectId);
  });

  it("rejects a reset URL outside the frozen callback boundary before sending", async () => {
    const send = vi.fn(async (_message: CloudflareEmailMessageBuilder) => ({
      messageId: "must-not-send",
    }));
    const hostileRequest = {
      ...request,
      resetUrl: `${canonicalOrigin}/api/auth/reset-password/opaque-token?callbackURL=https%3A%2F%2Fevil.example%2Ftilbakestill-passord`,
    };

    const error = await runDelivery(configWith(send), hostileRequest).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      _tag: "PasswordResetMailDeliveryError",
      code: "provider-rejected",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("maps Cloudflare rejections without exposing recipient, URL, or provider details", async () => {
    const providerDetail = `${request.recipientEmail} ${request.resetUrl}`;
    const send = vi.fn(async (_message: CloudflareEmailMessageBuilder) => {
      throw Object.assign(new Error(providerDetail), { code: "E_RECIPIENT_NOT_ALLOWED" });
    });

    const error = await runDelivery(configWith(send)).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const serialized = JSON.stringify(error);

    expect(error).toMatchObject({
      _tag: "PasswordResetMailDeliveryError",
      code: "provider-rejected",
    });
    expect(serialized).not.toContain(request.recipientEmail);
    expect(serialized).not.toContain(request.resetUrl);
    expect(serialized).not.toContain(providerDetail);
  });

  it("maps an unacknowledged binding call to a bounded timeout", async () => {
    const send = vi.fn(
      (_message: CloudflareEmailMessageBuilder) =>
        new Promise<CloudflareEmailSendResult>(() => undefined),
    );

    const error = await runDelivery(configWith(send, 5)).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      _tag: "PasswordResetMailDeliveryError",
      code: "delivery-timeout",
    });
  });
});
