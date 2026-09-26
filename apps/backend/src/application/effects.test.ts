import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Predicate, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  PublicApplicationOutboxRequestSchema,
  ApplicantIdSchema,
  PublicApplicationCommandIdSchema,
  PublicApplicationEffectIdSchema,
  PublicApplicationIdSchema,
} from "@vektorprogrammet/domain/application";
import type { PublicApplicationEffectConfig } from "../config.js";
import { publicApplicationHttpEffects } from "./effects.js";

const request =
  PublicApplicationOutboxRequestSchema.members[0].cases.SendApplicantActivationOrConfirmation.make({
    effectId: PublicApplicationEffectIdSchema.make("effect-0041"),
    commandId: PublicApplicationCommandIdSchema.make("command-0041"),
    applicationId: PublicApplicationIdSchema.make("application-0041"),
    applicantId: ApplicantIdSchema.make("applicant-0041"),
    email: "applicant@example.invalid",
    activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  });

const config = {
  endpoint: new URL("https://provider.example.invalid/effects"),
  token: "provider-token",
  pollIntervalMilliseconds: 250,
  staleClaimMilliseconds: 60_000,
  deliveryTimeoutMilliseconds: 1_000,
} as const;

/** The gateway over a provider double that answers each request with `respond`. */
const gateway = (
  respond: Parameters<typeof HttpClient.make>[0],
  gatewayConfig: PublicApplicationEffectConfig = config,
) =>
  publicApplicationHttpEffects(gatewayConfig).pipe(
    Effect.provideService(HttpClient.HttpClient, HttpClient.make(respond)),
  );

const JsonText = Schema.fromJsonString(Schema.Unknown);

describe("public application effect gateway", () => {
  it.effect("uses effectId as the provider idempotency key", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly redirect: RequestInit["redirect"];
        readonly body: string;
      }> = [];

      const interpreter = yield* gateway((providerRequest, url, _signal, fiber) =>
        Effect.sync(() => {
          calls.push({
            url: url.href,
            headers: providerRequest.headers,
            redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
            body: Predicate.isTagged(providerRequest.body, "Uint8Array")
              ? new TextDecoder().decode(providerRequest.body.body)
              : "",
          });

          return HttpClientResponse.fromWeb(providerRequest, new Response(null, { status: 204 }));
        }),
      );

      const evidence = yield* interpreter.deliver(request, 0, 2);

      expect(evidence).toEqual({
        effectId: request.effectId,
        kind: request._tag,
        ordinal: 0,
        attempts: 2,
        status: "Delivered",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(config.endpoint.href);
      expect(calls[0]?.headers["idempotency-key"]).toBe(request.effectId);
      expect(calls[0]?.headers).not.toHaveProperty("traceparent");
      expect(calls[0]?.headers).not.toHaveProperty("b3");
      expect(calls[0]?.redirect).toBe("error");
      expect(yield* Schema.decodeUnknownEffect(JsonText)(calls[0]?.body)).toEqual(request);
    }),
  );

  it.effect("maps provider rejection to the typed retry error", () =>
    Effect.gen(function* () {
      const interpreter = yield* gateway((providerRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(providerRequest, new Response(null, { status: 503 })),
        ),
      );

      const failure = yield* Effect.flip(interpreter.deliver(request, 0, 1));

      expect(failure).toHaveProperty("_tag", "PublicApplicationEffectDeliveryError");
      expect(failure).toMatchObject({ effectId: request.effectId });
    }),
  );

  it.live("bounds provider delivery and aborts the timed-out request", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = [];

      const interpreter = yield* gateway(
        (_request, _url, signal) =>
          Effect.suspend(() => {
            signals.push(signal);

            return Effect.never;
          }),
        { ...config, deliveryTimeoutMilliseconds: 1 },
      );

      const failure = yield* Effect.flip(interpreter.deliver(request, 0, 1));

      expect(failure).toHaveProperty("_tag", "PublicApplicationEffectDeliveryError");
      expect(failure).toMatchObject({ effectId: request.effectId });
      expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    }),
  );

  it.effect("aborts an in-flight provider request when delivery is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();

      const interpreter = yield* gateway((_request, _url, signal) =>
        Deferred.succeed(started, signal).pipe(Effect.andThen(Effect.never)),
      );

      const fiber = yield* Effect.forkChild(interpreter.deliver(request, 0, 1));
      const signal = yield* Deferred.await(started);

      yield* Fiber.interrupt(fiber);

      expect(signal.aborted).toBe(true);
    }),
  );
});
