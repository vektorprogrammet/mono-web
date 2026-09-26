import { Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";
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

const makeHttpMailDelivery = (
  config: MailDeliveryConfig | undefined,
  client: HttpClient.HttpClient,
): MailOperations => ({
  deliver: (request) =>
    config === undefined
      ? Effect.fail(new MailDeliveryError({ kind: "temporary-unavailability" }))
      : deliverJson(request, config, { "idempotency-key": request.deliveryId }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.as({ providerReference: request.deliveryId }),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(new MailDeliveryError({ kind: "ambiguous-outcome" })),
            HttpDeliveryFailure: ({ status }) =>
              Effect.fail(
                new MailDeliveryError({
                  kind:
                    status !== undefined && status >= 400 && status < 500
                      ? "permanent-rejection"
                      : "temporary-unavailability",
                }),
              ),
          }),
        ),
});

export const HttpMailLive = (
  config: MailDeliveryConfig | undefined,
): Layer.Layer<Mail, never, HttpClient.HttpClient> =>
  Layer.effect(
    Mail,
    Effect.map(HttpClient.HttpClient, (client) => makeHttpMailDelivery(config, client)),
  );
