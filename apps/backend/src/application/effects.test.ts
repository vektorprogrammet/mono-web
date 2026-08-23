import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeHttpPublicApplicationEffectInterpreter } from "./effects.js";

const request = {
  _tag: "SendApplicantActivationOrConfirmation",
  effectId: "effect-0041",
  commandId: "command-0041",
  applicationId: "application-0041",
  applicantId: "applicant-0041",
  email: "applicant@example.invalid",
  activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
} as const;

const config = {
  endpoint: new URL("https://provider.example.invalid/effects"),
  token: "provider-token",
  pollIntervalMilliseconds: 250,
  staleClaimMilliseconds: 60_000,
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
});
