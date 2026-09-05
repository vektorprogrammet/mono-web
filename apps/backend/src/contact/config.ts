import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { Schema } from "effect";
import type { HttpDeliveryConfig } from "../delivery/http.js";

export interface ContactConfig {
  readonly backendToken: string;
  readonly sender: string;
  readonly delivery: HttpDeliveryConfig;
}
/** Absent/partial configuration disables this command, without breaking unrelated services. */
export const contactConfig = (
  env: Readonly<Record<string, string | undefined>>,
): ContactConfig | undefined => {
  const backendToken = env.CONTACT_BACKEND_TOKEN;
  const token = env.CONTACT_DELIVERY_TOKEN;
  const sender = env.CONTACT_SENDER;
  const endpoint = env.CONTACT_DELIVERY_URL;
  const timeout = Number(env.CONTACT_DELIVERY_TIMEOUT_MS);
  if (
    !backendToken ||
    backendToken.length < 32 ||
    !token ||
    !sender ||
    !endpoint ||
    !Schema.is(ContactEmail)(sender) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000
  )
    return undefined;
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol))
      return undefined;
    return {
      backendToken,
      sender,
      delivery: { endpoint: url, token, deliveryTimeoutMilliseconds: timeout },
    };
  } catch {
    return undefined;
  }
};
