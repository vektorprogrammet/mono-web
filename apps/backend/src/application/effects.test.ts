import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import {
  ApplicantIdSchema,
  PublicApplicationCommandIdSchema,
  PublicApplicationEffectIdSchema,
  PublicApplicationIdSchema,
} from "@vektorprogrammet/domain/application";
import { makeHttpPublicApplicationEffectInterpreter } from "./effects.js";

const request = {
  _tag: "SendApplicantActivationOrConfirmation",
  effectId: PublicApplicationEffectIdSchema.make("effect-0041"),
  commandId: PublicApplicationCommandIdSchema.make("command-0041"),
  applicationId: PublicApplicationIdSchema.make("application-0041"),
  applicantId: ApplicantIdSchema.make("applicant-0041"),
  email: "applicant@example.invalid",
  activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
} as const;

const config = {
  endpoint: new URL("https://provider.example.invalid/effects"),
  token: "provider-token",
  pollIntervalMilliseconds: 250,
  staleClaimMilliseconds: 60_000,
  deliveryTimeoutMilliseconds: 1_000,
} as const;

describe("public application effect gateway", () => {
  it("uses effectId as the provider idempotency key", async () => {
    const calls: Array<{ readonly input: string; readonly init?: RequestInit }> = [];
    const interpreter = makeHttpPublicApplicationEffectInterpreter(config, async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(null, { status: 204 });
    });

    const evidence = await Effect.runPromise(interpreter.deliver(request, 0, 2));

    expect(evidence).toEqual({
      effectId: request.effectId,
      kind: request._tag,
      ordinal: 0,
      attempts: 2,
      status: "Delivered",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(config.endpoint.href);
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe(request.effectId);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request);
  });

  it("maps provider rejection to the typed retry error", async () => {
    const interpreter = makeHttpPublicApplicationEffectInterpreter(
      config,
      async () => new Response(null, { status: 503 }),
    );

    const failure = await Effect.runPromise(Effect.flip(interpreter.deliver(request, 0, 1)));
    expect(failure).toMatchObject({
      _tag: "PublicApplicationEffectDeliveryError",
      effectId: request.effectId,
    });
  });

  it("bounds provider delivery and aborts the timed-out request", async () => {
    let aborted = false;
    const interpreter = makeHttpPublicApplicationEffectInterpreter(
      { ...config, deliveryTimeoutMilliseconds: 1 },
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const failure = await Effect.runPromise(Effect.flip(interpreter.deliver(request, 0, 1)));

    expect(failure).toMatchObject({
      _tag: "PublicApplicationEffectDeliveryError",
      effectId: request.effectId,
    });
    expect(aborted).toBe(true);
  });

  it("aborts an in-flight provider request when delivery is interrupted", async () => {
    const started = Promise.withResolvers<void>();
    let providerSignal: AbortSignal | undefined;
    const interpreter = makeHttpPublicApplicationEffectInterpreter(config, async (_input, init) => {
      providerSignal = init?.signal ?? undefined;
      started.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const fiber = Effect.runFork(interpreter.deliver(request, 0, 1));
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(providerSignal?.aborted).toBe(true);
  });
});
