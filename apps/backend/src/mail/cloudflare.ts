import { Duration, Effect, Layer, Predicate, Schema } from "effect";
import {
  Mail,
  MailDeliveryError,
  type MailDeliveryRequest,
  type MailOperations,
} from "@vektorprogrammet/domain/mail";

export interface CloudflareEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Structural type of the Cloudflare Workers `send_email` binding acknowledgement. */
export interface CloudflareEmailSendResult {
  readonly messageId: string;
}

/** Structural type of the Cloudflare Workers `send_email` binding. */
export interface CloudflareSendEmailBinding {
  readonly send: (message: CloudflareEmailMessage) => Promise<CloudflareEmailSendResult>;
}

export interface CloudflareMailConfig {
  readonly binding: CloudflareSendEmailBinding;
  readonly deliveryTimeoutMilliseconds: number;
  readonly recipientOverride?: string;
}

export class CloudflareMailConfigurationError extends Schema.TaggedError<CloudflareMailConfigurationError>()(
  "CloudflareMailConfigurationError",
  {},
) {}

const PERMANENT_REJECTION_CODES = {
  E_CONTENT_TOO_LARGE: true,
  E_FIELD_MISSING: true,
  E_HEADER_NAME_INVALID: true,
  E_HEADER_NOT_ALLOWED: true,
  E_HEADER_USE_API_FIELD: true,
  E_HEADER_VALUE_INVALID: true,
  E_HEADER_VALUE_TOO_LONG: true,
  E_HEADERS_TOO_LARGE: true,
  E_HEADERS_TOO_MANY: true,
  E_RECIPIENT_NOT_ALLOWED: true,
  E_RECIPIENT_SUPPRESSED: true,
  E_SENDER_DOMAIN_NOT_AVAILABLE: true,
  E_SENDER_NOT_VERIFIED: true,
  E_TOO_MANY_ATTACHMENTS: true,
  E_TOO_MANY_RECIPIENTS: true,
  E_VALIDATION_ERROR: true,
} as const;

const CONTROL = /[\r\n\0]/u;

const MAILBOX = /^[^\s@]+@[^\s@]+$/u;

const validMailbox = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 254 &&
  value === value.trim() &&
  !CONTROL.test(value) &&
  MAILBOX.test(value);

const permanent = (): MailDeliveryError => new MailDeliveryError({ kind: "permanent-rejection" });

const temporary = (): MailDeliveryError =>
  new MailDeliveryError({ kind: "temporary-unavailability" });

const ambiguous = (): MailDeliveryError => new MailDeliveryError({ kind: "ambiguous-outcome" });

export const classifyCloudflareMailError = (cause: unknown): MailDeliveryError => {
  if (
    Predicate.isObject(cause) &&
    Predicate.isString(cause.code) &&
    Object.hasOwn(PERMANENT_REJECTION_CODES, cause.code)
  ) {
    return permanent();
  }

  return temporary();
};

const validateRequest = (request: MailDeliveryRequest): void => {
  if (
    request.deliveryId.length === 0 ||
    request.deliveryId.length > 200 ||
    CONTROL.test(request.deliveryId) ||
    !validMailbox(request.sender) ||
    !validMailbox(request.recipient) ||
    (request.replyTo !== undefined && !validMailbox(request.replyTo)) ||
    request.subject.length === 0 ||
    request.subject.length > 998 ||
    CONTROL.test(request.subject) ||
    request.text.length > 2_000_000
  ) {
    throw permanent();
  }
};

const messageFor = (
  request: MailDeliveryRequest,
  recipientOverride: string | undefined,
): CloudflareEmailMessage => {
  const message: CloudflareEmailMessage = {
    from: request.sender,
    to: recipientOverride ?? request.recipient,
    subject: request.subject,
    text: request.text,
    headers: {
      "Message-ID": `<${encodeURIComponent(request.deliveryId)}@delivery.vektorprogrammet.no>`,
    },
  };

  if (request.replyTo !== undefined) Object.assign(message, { replyTo: request.replyTo });

  return message;
};

export const makeCloudflareMail = (config: CloudflareMailConfig): MailOperations => ({
  deliver: (request) =>
    Effect.gen(function* () {
      yield* Effect.try({ try: () => validateRequest(request), catch: () => permanent() });

      const acknowledgement = yield* Effect.tryPromise({
        try: () => config.binding.send(messageFor(request, config.recipientOverride)),
        catch: classifyCloudflareMailError,
      }).pipe(
        Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)),
        Effect.mapError((error) =>
          Predicate.isTagged(error, "TimeoutError") ? ambiguous() : error,
        ),
      );

      if (
        !Predicate.isString(acknowledgement.messageId) ||
        acknowledgement.messageId.length === 0 ||
        acknowledgement.messageId.length > 512 ||
        CONTROL.test(acknowledgement.messageId)
      ) {
        return yield* ambiguous();
      }

      return { providerReference: acknowledgement.messageId };
    }),
});

/** Fails closed while constructing the real Cloudflare Worker mail layer. */
export const CloudflareMailLive = (
  config: CloudflareMailConfig,
): Layer.Layer<Mail, CloudflareMailConfigurationError> =>
  Layer.effect(
    Mail,
    Effect.try({
      try: () => {
        if (
          !Predicate.isObject(config.binding) ||
          !Predicate.isFunction(config.binding.send) ||
          (config.recipientOverride !== undefined && !validMailbox(config.recipientOverride)) ||
          !Number.isSafeInteger(config.deliveryTimeoutMilliseconds) ||
          config.deliveryTimeoutMilliseconds < 1 ||
          config.deliveryTimeoutMilliseconds > 60_000
        ) {
          throw new Error("invalid Cloudflare mail binding");
        }

        return Mail.of(makeCloudflareMail(config));
      },
      catch: () => new CloudflareMailConfigurationError(),
    }),
  );
