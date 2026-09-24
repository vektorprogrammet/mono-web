import { Effect, Layer } from "effect";
import { Mail, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";

export interface RecordingMailLayer {
  readonly layer: Layer.Layer<Mail>;
  readonly deliveries: () => ReadonlyArray<MailDeliveryRequest>;
}

/** Deterministic mail implementation for tests and local boundary checks. */
export const makeRecordingMailLayer = (): RecordingMailLayer => {
  const deliveries: Array<MailDeliveryRequest> = [];

  return {
    layer: Layer.succeed(
      Mail,
      Mail.of({
        deliver: (request) =>
          Effect.sync(() => {
            deliveries.push(request);

            return { providerReference: `recording:${request.deliveryId}` };
          }),
      }),
    ),
    deliveries: () => deliveries,
  };
};
