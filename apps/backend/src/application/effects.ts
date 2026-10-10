/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  makePublicApplicationEffectInterpreter,
  PublicApplicationEffectDeliveryError,
  type PublicApplicationEffectInterpreter,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { deliverJson } from "../delivery/http.js";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import type { PublicApplicationEffectConfig } from "../config.js";

/** The interpreter delivers every public application effect through the composition's client. */
export const publicApplicationHttpEffects = (
  config: PublicApplicationEffectConfig,
): Effect.Effect<PublicApplicationEffectInterpreter, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => {
    const deliver = (request: PublicApplicationOutboxRequest) =>
      deliverJson(request, config, { "idempotency-key": request.effectId }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError(
          () => new PublicApplicationEffectDeliveryError({ effectId: request.effectId }),
        ),
      );

    return makePublicApplicationEffectInterpreter({
      sendApplicantNotification: deliver,
      createAdmissionSubscription: deliver,
      writeApplicationAudit: deliver,
    });
  });
