import {
  deliverNextSchoolServiceNotification,
  recoverStaleSchoolServiceNotifications,
  type SchoolServiceNotificationInterpreter,
} from "@vektorprogrammet/placements/server";
import {
  SchoolServiceNotificationDeliveryError,
  type SchoolServiceNotificationRequest,
} from "@vektorprogrammet/placements/contracts";
import { DateTime, Predicate, Duration, Effect } from "effect";
import { deliverJson, type DeliveryFetch } from "../delivery/http.js";
import { pollForever } from "../worker-support.js";

export interface SchoolServiceNotificationConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly deliveryTimeoutMilliseconds: number;
}

const positiveInteger = (raw: string | undefined, fallback: number, field: string): number => {
  const value = raw ?? String(fallback);

  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be a positive integer`);
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }

  return parsed;
};

export const schoolServiceNotificationConfig = (
  env: Readonly<Record<string, string | undefined>>,
): SchoolServiceNotificationConfig | undefined => {
  const mode = env.SCHOOL_SERVICE_NOTIFICATION_MODE ?? "disabled";
  const endpointValue = env.SCHOOL_SERVICE_NOTIFICATION_URL;
  const token = env.SCHOOL_SERVICE_NOTIFICATION_TOKEN;

  if (mode === "disabled") {
    if (endpointValue !== undefined || token !== undefined) {
      throw new Error(
        "SCHOOL_SERVICE_NOTIFICATION_URL and SCHOOL_SERVICE_NOTIFICATION_TOKEN require SCHOOL_SERVICE_NOTIFICATION_MODE=http",
      );
    }

    return undefined;
  }

  if (mode !== "http" || endpointValue === undefined || token === undefined || token.length === 0) {
    throw new Error("School service notification HTTP configuration is incomplete");
  }

  const endpoint = new URL(endpointValue);

  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "::1";

  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    throw new Error("SCHOOL_SERVICE_NOTIFICATION_URL must use HTTPS or fixed loopback HTTP");
  }

  return {
    endpoint,
    token,
    pollIntervalMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_NOTIFICATION_POLL_MS,
      250,
      "SCHOOL_SERVICE_NOTIFICATION_POLL_MS",
    ),
    staleClaimMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_NOTIFICATION_STALE_MS,
      60_000,
      "SCHOOL_SERVICE_NOTIFICATION_STALE_MS",
    ),
    deliveryTimeoutMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_NOTIFICATION_TIMEOUT_MS,
      10_000,
      "SCHOOL_SERVICE_NOTIFICATION_TIMEOUT_MS",
    ),
  };
};

export const schoolServiceNotificationDelivery =
  (
    config: SchoolServiceNotificationConfig,
    fetchEffect: DeliveryFetch = globalThis.fetch,
  ): SchoolServiceNotificationInterpreter =>
  (request: SchoolServiceNotificationRequest) =>
    deliverJson(request, config, fetchEffect, { "idempotency-key": request.effectId }).pipe(
      Effect.mapError(
        () => new SchoolServiceNotificationDeliveryError({ effectId: request.effectId }),
      ),
    );

export const runSchoolServiceNotificationWorker = (
  interpreter: SchoolServiceNotificationInterpreter,
  options: {
    readonly workerId: string;
    readonly pollIntervalMilliseconds: number;
    readonly staleClaimMilliseconds: number;
  },
) => {
  if (options.workerId.length === 0) throw new Error("worker ID must not be empty");
  let sequence = 0;

  const tick = Effect.gen(function* () {
    const claimedAt = yield* DateTime.now;

    const claimedBefore = DateTime.formatIso(
      DateTime.subtract(claimedAt, { milliseconds: options.staleClaimMilliseconds }),
    );

    yield* recoverStaleSchoolServiceNotifications(claimedBefore);

    return yield* deliverNextSchoolServiceNotification(
      `${options.workerId}:${sequence++}`,
      DateTime.formatIso(claimedAt),
      interpreter,
    );
  });

  return pollForever(tick, {
    interval: Duration.millis(options.pollIntervalMilliseconds),
    skipDelay: Predicate.isTagged("Delivered"),
  });
};
