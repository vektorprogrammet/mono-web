import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { CurrentAssignmentFailure } from "@vektorprogrammet/database/placements";
import { TestPlatform } from "@vektorprogrammet/database/test-support/platform";
import {
  disposableCurrentAssignmentDatabaseUrl,
  runCurrentAssignmentCohortCli,
} from "./current-assignment-cohort-cli.js";

describe("synthetic assignment CLI custody", () => {
  it.effect(
    "rejects ambient provider configuration before opening the synthetic CLI boundary",
    () =>
      Effect.gen(function* () {
        for (const [key, value] of [
          ["PUBLIC_APPLICATION_EFFECT_MODE", "disabled"],
          ["PUBLIC_APPLICATION_EFFECT_TOKEN", "synthetic-provider-configuration"],
          ["RECEIPT_DELIVERY_URL", "https://provider.example.invalid/delivery"],
          ["RECEIPT_DELIVERY_TOKEN", "synthetic-provider-configuration"],
          ["RECEIPT_DELIVERY_TOKEN", ""],
        ] as const) {
          const failure = yield* Effect.flip(
            runCurrentAssignmentCohortCli(["bun", "current-assignment-cohort-main.ts"]).pipe(
              Effect.provide(
                Layer.merge(
                  TestPlatform,
                  ConfigProvider.layer(
                    ConfigProvider.fromEnv({
                      env: {
                        CURRENT_ASSIGNMENT_MODE: "synthetic",
                        NATIVE_IDENTITY_DEPLOYMENT: "local",
                        [key]: value,
                      },
                      preserveEmptyStrings: true,
                    }),
                  ),
                ),
              ),
            ),
          );

          expect(failure).toBeInstanceOf(CurrentAssignmentFailure);
          expect(failure).toHaveProperty("code", "InvalidSnapshot");
        }
      }),
  );

  it("requires numeric loopback and the disposable current assignment namespace", () => {
    expect(
      disposableCurrentAssignmentDatabaseUrl(
        "postgres://postgres@127.0.0.1:49123/current_assignment_rehearsal",
      ),
    ).toContain("current_assignment_rehearsal");

    for (const value of [
      undefined,
      "postgres://localhost:5432/current_assignment_rehearsal",
      "postgres://example.com:5432/current_assignment_rehearsal",
      "postgres://127.0.0.1:5432/production",
      "postgres://127.0.0.1/current_assignment_rehearsal",
      "postgres://127.0.0.1:5432/historical_service_rehearsal",
      "postgres://127.0.0.1:5432/current_assignment_production",
      "postgres://127.0.0.1:5432/current_assignment_live",
      "postgres://127.0.0.1:5432/current_assignment_main",
    ])
      expect(() => disposableCurrentAssignmentDatabaseUrl(value)).toThrow("InvalidSnapshot");
  });
});
