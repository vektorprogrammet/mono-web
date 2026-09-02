import {
  PasswordResetMailDelivery,
  PasswordResetMailDeliveryError,
} from "@vektorprogrammet/domain/identity";
import type {
  PasswordResetMailDeliveryRequest,
  PasswordResetMailDeliveryShape,
} from "@vektorprogrammet/domain/identity";
import { Duration, Effect, Layer, Schema } from "effect";

export interface CloudflareEmailMessageBuilder {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface CloudflareEmailSendResult {
  readonly messageId: string;
}

/** Structural type of the current Cloudflare Workers `send_email` builder binding. */
export interface CloudflareSendEmailBinding {
  readonly send: (message: CloudflareEmailMessageBuilder) => Promise<CloudflareEmailSendResult>;
}

export interface CloudflarePasswordResetMailDeliveryConfig {
  readonly binding: CloudflareSendEmailBinding;
  readonly senderAddress: string;
  readonly canonicalOrigin: string;
  readonly dashboardOrigin: string;
  readonly deliveryTimeoutMilliseconds: number;
}

export class CloudflarePasswordResetMailConfigurationError extends Schema.TaggedError<CloudflarePasswordResetMailConfigurationError>()(
  "CloudflarePasswordResetMailConfigurationError",
  {},
) {}

const PROVIDER_REJECTION_CODES: Readonly<Record<string, true>> = {
  E_VALIDATION_ERROR: true,
  E_FIELD_MISSING: true,
  E_TOO_MANY_RECIPIENTS: true,
  E_TOO_MANY_ATTACHMENTS: true,
  E_SENDER_NOT_VERIFIED: true,
  E_RECIPIENT_NOT_ALLOWED: true,
  E_RECIPIENT_SUPPRESSED: true,
  E_SENDER_DOMAIN_NOT_AVAILABLE: true,
  E_CONTENT_TOO_LARGE: true,
  E_HEADER_NOT_ALLOWED: true,
  E_HEADER_USE_API_FIELD: true,
  E_HEADER_VALUE_INVALID: true,
  E_HEADER_VALUE_TOO_LONG: true,
  E_HEADER_NAME_INVALID: true,
  E_HEADERS_TOO_LARGE: true,
  E_HEADERS_TOO_MANY: true,
};

const HEADER_CONTROL = /[\r\n\0]/u;
const MAILBOX = /^[^\s@]+@[^\s@]+$/u;
const RESET_PATH_PREFIX = "/api/auth/reset-password/";
const RESET_PAGE_PATH = "/tilbakestill-passord";

const exactHttpsOrigin = (input: string): string => {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.origin !== input ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("origin must be an exact HTTPS origin");
  }
  return url.origin;
};

const safeMailbox = (input: string): boolean =>
  input.length > 0 &&
  input.length <= 254 &&
  input === input.trim() &&
  !HEADER_CONTROL.test(input) &&
  MAILBOX.test(input);

interface ValidatedConfig {
  readonly binding: CloudflareSendEmailBinding;
  readonly senderAddress: string;
  readonly canonicalOrigin: string;
  readonly dashboardOrigin: string;
  readonly deliveryTimeoutMilliseconds: number;
}

const validateConfig = (config: CloudflarePasswordResetMailDeliveryConfig): ValidatedConfig => {
  if (!safeMailbox(config.senderAddress)) throw new TypeError("invalid sender address");
  if (
    !Number.isSafeInteger(config.deliveryTimeoutMilliseconds) ||
    config.deliveryTimeoutMilliseconds < 1 ||
    config.deliveryTimeoutMilliseconds > 60_000
  ) {
    throw new TypeError("invalid delivery timeout");
  }

  return {
    ...config,
    canonicalOrigin: exactHttpsOrigin(config.canonicalOrigin),
    dashboardOrigin: exactHttpsOrigin(config.dashboardOrigin),
  };
};

const validateRequest = (
  request: PasswordResetMailDeliveryRequest,
  config: ValidatedConfig,
): void => {
  if (
    request.effectId.length === 0 ||
    request.effectId.length > 200 ||
    HEADER_CONTROL.test(request.effectId) ||
    !safeMailbox(request.recipientEmail) ||
    request.resetUrl.length > 8_192 ||
    HEADER_CONTROL.test(request.resetUrl) ||
    !Number.isFinite(request.expiresAt.getTime())
  ) {
    throw new TypeError("invalid password-reset mail request");
  }

  const resetUrl = new URL(request.resetUrl);
  const callbackUrls = resetUrl.searchParams.getAll("callbackURL");
  const parameterNames = [...resetUrl.searchParams.keys()];
  const token = resetUrl.pathname.slice(RESET_PATH_PREFIX.length);
  if (
    resetUrl.href !== request.resetUrl ||
    resetUrl.origin !== config.canonicalOrigin ||
    resetUrl.username.length > 0 ||
    resetUrl.password.length > 0 ||
    resetUrl.hash.length > 0 ||
    !resetUrl.pathname.startsWith(RESET_PATH_PREFIX) ||
    token.length === 0 ||
    token.includes("/") ||
    callbackUrls.length !== 1 ||
    parameterNames.length !== 1 ||
    parameterNames[0] !== "callbackURL" ||
    callbackUrls[0] !== `${config.dashboardOrigin}${RESET_PAGE_PATH}`
  ) {
    throw new TypeError("invalid password-reset URL");
  }
};

const passwordResetMessage = (
  senderAddress: string,
  request: PasswordResetMailDeliveryRequest,
): CloudflareEmailMessageBuilder => ({
  from: senderAddress,
  to: request.recipientEmail,
  subject: "Tilbakestill passordet ditt",
  text: [
    "Det ble bedt om et nytt passord for Vektorprogrammet-kontoen din.",
    "",
    "Bruk denne lenken for å velge et nytt passord:",
    request.resetUrl,
    "",
    `Lenken utløper ${request.expiresAt.toISOString()}.`,
    "",
    "Hvis du ikke ba om dette, kan du se bort fra e-posten.",
  ].join("\n"),
});

const providerError = (cause: unknown): PasswordResetMailDeliveryError => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? Reflect.get(cause, "code")
      : undefined;
  return new PasswordResetMailDeliveryError({
    code:
      typeof code === "string" && PROVIDER_REJECTION_CODES[code] === true
        ? "provider-rejected"
        : "provider-unavailable",
  });
};

const makeService = (config: ValidatedConfig): PasswordResetMailDeliveryShape => ({
  deliver: (request) =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => validateRequest(request, config),
        catch: () => new PasswordResetMailDeliveryError({ code: "provider-rejected" }),
      });
      const acknowledgement = yield* Effect.tryPromise({
        try: () => config.binding.send(passwordResetMessage(config.senderAddress, request)),
        catch: providerError,
      });
      if (
        typeof acknowledgement.messageId !== "string" ||
        acknowledgement.messageId.length === 0 ||
        acknowledgement.messageId.length > 512 ||
        HEADER_CONTROL.test(acknowledgement.messageId)
      ) {
        return yield* new PasswordResetMailDeliveryError({ code: "provider-unavailable" });
      }
      return { providerReference: acknowledgement.messageId };
    }).pipe(
      Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new PasswordResetMailDeliveryError({ code: "delivery-timeout" })
          : error,
      ),
    ),
});

/**
 * Real Cloudflare Email Service adapter. It uses the Worker binding directly,
 * does not read ambient configuration, and makes no exactly-once claim.
 */
export const CloudflarePasswordResetMailDeliveryLive = (
  config: CloudflarePasswordResetMailDeliveryConfig,
): Layer.Layer<PasswordResetMailDelivery, CloudflarePasswordResetMailConfigurationError> =>
  Layer.effect(
    PasswordResetMailDelivery,
    Effect.try({
      try: () => validateConfig(config),
      catch: () => new CloudflarePasswordResetMailConfigurationError(),
    }).pipe(Effect.map((validated) => PasswordResetMailDelivery.of(makeService(validated)))),
  );
