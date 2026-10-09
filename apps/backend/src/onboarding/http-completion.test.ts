/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { assert, it } from "@effect/vitest";
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect, type Layer } from "effect";
import type { HttpApiBuilder, HttpApiGroup } from "effect/http-api";
import { expectTypeOf } from "vitest";
import { OnboardingApiHandlers as GeneratedOnboardingApiHandlers } from "../../.effx/generated/onboarding-handlers.js";
import { OnboardingApiHandlers } from "./http.js";

type Completion = ReturnType<typeof GeneratedOnboardingApiHandlers>;

type PendingHandlers = Parameters<Parameters<Completion>[0]>[0];

// These controls are type-checked but never execute invalid registrations.
const completionControls = (complete: Completion) => {
  // @ts-expect-error Ordinary omission must not produce the completed group layer.
  complete((handlers) => handlers);
  complete((handlers) => {
    const claimed = handlers.handleRaw("claim", () => Effect.die("unused type control"));

    // @ts-expect-error Native Handlers reject a second registration of claim.
    return claimed.handleRaw("claim", () => Effect.die("unused type control"));
  });

  // Expected pass: native ValidateReturn accepts its diagnostic marker when the
  // callback explicitly claims that marker. This known Effect limit is not a
  // completion mechanism: the real callback below registers the handwritten claim.
  complete<PendingHandlers>((): "Endpoint not handled: claim" => "Endpoint not handled: claim");
};

it.effect(
  "the generated subset requires exactly the original handwritten claim before producing a layer",
  () =>
    Effect.sync(() => {
      assert.isFunction(completionControls);
      expectTypeOf<PendingHandlers["~HandledIdentifiers"]>().toEqualTypeOf<
        "readBoard" | "command"
      >();
      expectTypeOf<
        Exclude<
          keyof PendingHandlers["~EndpointsByIdentifier"],
          PendingHandlers["~HandledIdentifiers"]
        >
      >().toEqualTypeOf<"claim">();

      // Negative control: returning the generated subset unchanged cannot satisfy native completion.
      expectTypeOf<
        HttpApiBuilder.Handlers.ValidateReturn<PendingHandlers>
      >().toEqualTypeOf<"Endpoint not handled: claim">();
      expectTypeOf<PendingHandlers>().not.toEqualTypeOf<
        HttpApiBuilder.Handlers.ValidateReturn<PendingHandlers>
      >();

      // The application factory completes the real claim registration and exposes the original group.
      expectTypeOf<Layer.Success<ReturnType<typeof OnboardingApiHandlers>>>().toEqualTypeOf<
        HttpApiGroup.Service<(typeof ExternalNativeApi)["identifier"], "onboarding">
      >();
    }),
);

it.effect(
  "constructing and discarding the completed binding runs no authority, claim or clock work",
  () =>
    Effect.sync(() => {
      let clockReads = 0;

      const layer = OnboardingApiHandlers({
        now: () => {
          clockReads += 1;

          return "2026-10-01T10:00:00.000Z";
        },
      });

      assert.strictEqual(clockReads, 0);
      expectTypeOf<Layer.Error<typeof layer>>().toEqualTypeOf<never>();
      expectTypeOf<Layer.Success<typeof layer>>().toEqualTypeOf<
        HttpApiGroup.Service<"external-native-api", "onboarding">
      >();
    }),
);
