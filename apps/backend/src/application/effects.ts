import {
  makePublicApplicationEffectInterpreter,
  PublicApplicationEffectDeliveryError,
  type PublicApplicationEffectInterpreter,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { deliverJson } from "../delivery/http.js";
import { Effect } from "effect";
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
  deliverJson(request, config, fetchEffect, { "idempotency-key": request.effectId }).pipe(
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
