import {
  deliverNextSchoolServiceDispatchNotification,
  recoverStaleSchoolServiceDispatchNotifications,
  type SchoolServiceDispatchNotificationInterpreter,
} from "@vektorprogrammet/placements/server";
import {
  SchoolServiceDispatchNotificationDeliveryError,
  type SchoolServiceDispatchNotificationRequest,
} from "@vektorprogrammet/placements/contracts";
import { Predicate, Duration, Effect } from "effect";
import { deliverJson, type DeliveryFetch } from "../delivery/http.js";

export interface SchoolServiceDispatchNotificationConfig {
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

export const schoolServiceDispatchNotificationConfig = (
  env: Readonly<Record<string, string | undefined>>,
): SchoolServiceDispatchNotificationConfig | undefined => {
  const mode = env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE ?? "disabled";
  const endpointValue = env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_URL;
  const token = env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TOKEN;

  if (mode === "disabled") {
    if (endpointValue !== undefined || token !== undefined) {
      throw new Error(
        "SCHOOL_SERVICE_DISPATCH_NOTIFICATION_URL and SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TOKEN require SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE=http",
      );
    }

    return undefined;
  }

  if (mode !== "http" || endpointValue === undefined || token === undefined || token.length === 0) {
    throw new Error("School service dispatch notification HTTP configuration is incomplete");
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
    throw new Error(
      "SCHOOL_SERVICE_DISPATCH_NOTIFICATION_URL must use HTTPS or fixed loopback HTTP",
    );
  }

  return {
    endpoint,
    token,
    pollIntervalMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_POLL_MS,
      250,
      "SCHOOL_SERVICE_DISPATCH_NOTIFICATION_POLL_MS",
    ),
    staleClaimMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_STALE_MS,
      60_000,
      "SCHOOL_SERVICE_DISPATCH_NOTIFICATION_STALE_MS",
    ),
    deliveryTimeoutMilliseconds: positiveInteger(
      env.SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TIMEOUT_MS,
      10_000,
      "SCHOOL_SERVICE_DISPATCH_NOTIFICATION_TIMEOUT_MS",
    ),
  };
};

export const schoolServiceDispatchDelivery =
  (
    config: SchoolServiceDispatchNotificationConfig,
    fetchEffect: DeliveryFetch = globalThis.fetch,
  ): SchoolServiceDispatchNotificationInterpreter =>
  (request: SchoolServiceDispatchNotificationRequest) =>
    deliverJson(request, config, fetchEffect, { "idempotency-key": request.effectId }).pipe(
      Effect.mapError(
        () => new SchoolServiceDispatchNotificationDeliveryError({ effectId: request.effectId }),
      ),
    );

export const runSchoolServiceDispatchNotificationWorker = (
  interpreter: SchoolServiceDispatchNotificationInterpreter,
  options: {
    readonly workerId: string;
    readonly pollIntervalMilliseconds: number;
    readonly staleClaimMilliseconds: number;
    readonly now: () => string;
  },
) => {
  if (options.workerId.length === 0) throw new Error("worker ID must not be empty");
  let sequence = 0;

  const tick = Effect.gen(function* () {
    const claimedAt = options.now();

    const claimedBefore = new Date(
      Date.parse(claimedAt) - options.staleClaimMilliseconds,
    ).toISOString();

    yield* recoverStaleSchoolServiceDispatchNotifications(claimedBefore);

    const result = yield* deliverNextSchoolServiceDispatchNotification(
      `${options.workerId}:${sequence++}`,
      claimedAt,
      interpreter,
    );

    if (!Predicate.isTagged(result, "Delivered")) {
      yield* Effect.sleep(Duration.millis(options.pollIntervalMilliseconds));
    }
  });

  return Effect.forever(tick);
};
