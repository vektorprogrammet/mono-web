import {
  makePublicApplicationEffectInterpreter,
  PublicApplicationEffectDeliveryError,
  type PublicApplicationEffectInterpreter,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { Duration, Effect } from "effect";
import type { PublicApplicationEffectConfig } from "../config.js";

export type PublicApplicationEffectFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const deliver = (
  request: PublicApplicationOutboxRequest,
  config: PublicApplicationEffectConfig,
  fetchEffect: PublicApplicationEffectFetch,
): Effect.Effect<void, PublicApplicationEffectDeliveryError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchEffect(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "idempotency-key": request.effectId,
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error(`provider returned ${response.status}`);
    },
    catch: () => new PublicApplicationEffectDeliveryError({ effectId: request.effectId }),
  }).pipe(
    Effect.timeout(Duration.millis(config.deliveryTimeoutMilliseconds)),
    Effect.mapError(() => new PublicApplicationEffectDeliveryError({ effectId: request.effectId })),
  );

export const makeHttpPublicApplicationEffectInterpreter = (
  config: PublicApplicationEffectConfig,
  fetchEffect: PublicApplicationEffectFetch = globalThis.fetch,
): PublicApplicationEffectInterpreter =>
  makePublicApplicationEffectInterpreter({
    sendApplicantNotification: (request) => deliver(request, config, fetchEffect),
    createAdmissionSubscription: (request) => deliver(request, config, fetchEffect),
    writeApplicationAudit: (request) => deliver(request, config, fetchEffect),
  });
