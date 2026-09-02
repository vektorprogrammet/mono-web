import { Context, Effect, Schema } from "effect";

export const PasswordResetMailDeliveryFailureCode = Schema.Literals([
  "provider-rejected",
  "provider-unavailable",
  "delivery-timeout",
]);
export type PasswordResetMailDeliveryFailureCode = typeof PasswordResetMailDeliveryFailureCode.Type;

export interface PasswordResetMailDeliveryRequest {
  readonly effectId: string;
  readonly recipientEmail: string;
  readonly resetUrl: string;
  readonly expiresAt: Date;
}

export interface PasswordResetMailDeliveryAcknowledgement {
  readonly providerReference: string;
}

export class PasswordResetMailDeliveryError extends Schema.TaggedError<PasswordResetMailDeliveryError>()(
  "PasswordResetMailDeliveryError",
  { code: PasswordResetMailDeliveryFailureCode },
) {}

export interface PasswordResetMailDeliveryShape {
  readonly deliver: (
    request: PasswordResetMailDeliveryRequest,
  ) => Effect.Effect<PasswordResetMailDeliveryAcknowledgement, PasswordResetMailDeliveryError>;
}

/** Provider transport authority for the frozen 0054.2 password-recovery boundary. */
export class PasswordResetMailDelivery extends Context.Service<
  PasswordResetMailDelivery,
  PasswordResetMailDeliveryShape
>()("@vektorprogrammet/domain/PasswordResetMailDelivery") {}
