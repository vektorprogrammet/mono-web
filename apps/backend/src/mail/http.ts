import { Predicate, Effect, Layer } from "effect";
import { Mail, MailDeliveryError, type MailOperations } from "@vektorprogrammet/domain/mail";
import { deliverJson, type HttpDeliveryConfig } from "../delivery/http.js";

export interface MailDeliveryConfig extends HttpDeliveryConfig {}

export const mailDeliveryConfig = (
  env: Readonly<Record<string, string | undefined>>,
): MailDeliveryConfig | undefined => {
  const keys = ["MAIL_DELIVERY_URL", "MAIL_DELIVERY_TOKEN", "MAIL_DELIVERY_TIMEOUT_MS"] as const;

  if (keys.every((key) => env[key] === undefined)) return undefined;

  if (keys.some((key) => !env[key])) throw new Error("Incomplete mail delivery configuration");
  const endpoint = new URL(env.MAIL_DELIVERY_URL!);
  const timeout = Number(env.MAIL_DELIVERY_TIMEOUT_MS);

  if (
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000
  ) {
    throw new Error("Invalid mail delivery configuration");
  }

  return { endpoint, token: env.MAIL_DELIVERY_TOKEN!, deliveryTimeoutMilliseconds: timeout };
};

const makeHttpMailDelivery = (config: MailDeliveryConfig | undefined): MailOperations => ({
  deliver: (request) =>
    Effect.suspend(() => {
      if (config === undefined) {
        return Effect.fail(new MailDeliveryError({ kind: "temporary-unavailability" }));
      }

      let rejected = false;

      return deliverJson(
        request,
        config,
        async (input, init) => {
          const response = await fetch(input, init);
          rejected = response.status >= 400 && response.status < 500;

          return response;
        },
        { "idempotency-key": request.deliveryId },
      ).pipe(
        Effect.map(() => ({ providerReference: request.deliveryId })),
        Effect.mapError(
          (error) =>
            new MailDeliveryError({
              kind:
                error !== null &&
                (error === null || Predicate.isObjectOrArray(error)) &&
                "_tag" in error &&
                Predicate.isTagged(error, "TimeoutError")
                  ? "ambiguous-outcome"
                  : rejected
                    ? "permanent-rejection"
                    : "temporary-unavailability",
            }),
        ),
      );
    }),
});

export const HttpMailLive = (config: MailDeliveryConfig | undefined): Layer.Layer<Mail> =>
  Layer.sync(Mail, () => makeHttpMailDelivery(config));
