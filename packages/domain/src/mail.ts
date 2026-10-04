import { Context, Effect, Schema } from "effect";

const Mailbox = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const DeliveryId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** The longest HTML alternative that any mail transport accepts. */
export const MAIL_HTML_MAX_LENGTH = 1_000_000;

const Html = Schema.String.pipe(Schema.check(Schema.isMaxLength(MAIL_HTML_MAX_LENGTH)));

/**
 * Immutable, provider-neutral request for one delivery attempt. `text` is required in every mail;
 * `html` is an optional alternative that a transport forwards only when it is present.
 */
export const MailDeliveryRequest = Schema.Struct({
  deliveryId: DeliveryId,
  sender: Mailbox,
  recipient: Mailbox,
  replyTo: Schema.optional(Mailbox),
  subject: Schema.String,
  text: Schema.String,
  html: Schema.optional(Html),
});

export type MailDeliveryRequest = typeof MailDeliveryRequest.Type;

/** A request whose HTML alternative is required, as the admission outcome envelope sends it. */
export const HtmlMailDeliveryRequest = Schema.Struct({
  ...MailDeliveryRequest.fields,
  html: Html,
});

export type HtmlMailDeliveryRequest = typeof HtmlMailDeliveryRequest.Type;

export const MailDeliveryOutcome = Schema.Struct({
  providerReference: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

export type MailDeliveryOutcome = typeof MailDeliveryOutcome.Type;

export const MailDeliveryFailureKind = Schema.Literals([
  "permanent-rejection",
  "temporary-unavailability",
  "ambiguous-outcome",
]);

export type MailDeliveryFailureKind = typeof MailDeliveryFailureKind.Type;

export class MailDeliveryError extends Schema.TaggedError<MailDeliveryError>()(
  "MailDeliveryError",
  {
    kind: MailDeliveryFailureKind,
  },
) {}

export interface MailOperations {
  readonly deliver: (
    request: MailDeliveryRequest,
  ) => Effect.Effect<MailDeliveryOutcome, MailDeliveryError>;
}

/** Provider-neutral authority for delivering one complete mail message. */
export class Mail extends Context.Service<Mail, MailOperations>()(
  "@vektorprogrammet/domain/Mail",
) {}
