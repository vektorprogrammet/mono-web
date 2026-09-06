import { Effect } from "effect";
import {
  PasswordResetMailDeliveryError,
  type PasswordResetMailDeliveryShape,
} from "@vektorprogrammet/domain/identity";
import { deliverJson, type HttpDeliveryConfig } from "../delivery/http.js";

/** Explicit receiver authority; absent configuration is a retryable failure, never delivery. */
export const passwordResetDeliveryConfig = (
  env: Readonly<Record<string, string | undefined>>,
): (HttpDeliveryConfig & { readonly sender: string }) | undefined => {
  const keys = [
    "PASSWORD_RESET_DELIVERY_URL",
    "PASSWORD_RESET_DELIVERY_TOKEN",
    "PASSWORD_RESET_DELIVERY_TIMEOUT_MS",
    "PASSWORD_RESET_DELIVERY_SENDER",
  ] as const;
  if (keys.every((key) => env[key] === undefined)) return undefined;
  if (keys.some((key) => !env[key]))
    throw new Error("Incomplete password reset delivery configuration");
  const endpoint = new URL(env.PASSWORD_RESET_DELIVERY_URL!);
  const timeout = Number(env.PASSWORD_RESET_DELIVERY_TIMEOUT_MS);
  const sender = env.PASSWORD_RESET_DELIVERY_SENDER!;
  if (
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000 ||
    !/^[^\s@]+@[^\s@]+$/.test(sender)
  )
    throw new Error("Invalid password reset delivery configuration");
  return {
    endpoint,
    token: env.PASSWORD_RESET_DELIVERY_TOKEN!,
    deliveryTimeoutMilliseconds: timeout,
    sender,
  };
};
export const makeHttpPasswordResetDelivery = (
  config: ReturnType<typeof passwordResetDeliveryConfig>,
): PasswordResetMailDeliveryShape => ({
  deliver: (request) =>
    config === undefined
      ? Effect.fail(new PasswordResetMailDeliveryError({ code: "provider-unavailable" }))
      : deliverJson(
          { sender: config.sender, ...request, expiresAt: request.expiresAt.toISOString() },
          config,
          fetch,
          { "idempotency-key": request.effectId },
        ).pipe(
          Effect.map(() => ({ providerReference: request.effectId })),
          Effect.mapError(
            (error) =>
              new PasswordResetMailDeliveryError({
                code:
                  error !== null &&
                  typeof error === "object" &&
                  "_tag" in error &&
                  error._tag === "TimeoutError"
                    ? "delivery-timeout"
                    : "provider-unavailable",
              }),
          ),
        ),
});
