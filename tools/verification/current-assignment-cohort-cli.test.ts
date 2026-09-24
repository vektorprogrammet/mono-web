import { describe, expect, it } from "vitest";
import {
  disposableCurrentAssignmentDatabaseUrl,
  runCurrentAssignmentCohortCli,
} from "./current-assignment-cohort-cli.js";

describe("synthetic assignment CLI custody", () => {
  it("rejects ambient provider configuration before opening the synthetic CLI boundary", async () => {
    for (const [key, value] of [
      ["PUBLIC_APPLICATION_EFFECT_MODE", "disabled"],
      ["PUBLIC_APPLICATION_EFFECT_TOKEN", "synthetic-provider-configuration"],
      ["RECEIPT_DELIVERY_URL", "https://provider.example.invalid/delivery"],
      ["RECEIPT_DELIVERY_TOKEN", "synthetic-provider-configuration"],
    ] as const) {
      const previous = {
        mode: process.env.CURRENT_ASSIGNMENT_MODE,
        deployment: process.env.NATIVE_IDENTITY_DEPLOYMENT,
        provider: process.env[key],
        argv: process.argv,
      };

      process.env.CURRENT_ASSIGNMENT_MODE = "synthetic";
      process.env.NATIVE_IDENTITY_DEPLOYMENT = "local";
      process.env[key] = value;
      process.argv = process.argv.slice(0, 2);

      try {
        await expect(runCurrentAssignmentCohortCli()).rejects.toThrow("InvalidSnapshot");
      } finally {
        process.argv = previous.argv;

        for (const [environmentKey, previousValue] of [
          ["CURRENT_ASSIGNMENT_MODE", previous.mode],
          ["NATIVE_IDENTITY_DEPLOYMENT", previous.deployment],
          [key, previous.provider],
        ] as const) {
          if (previousValue === undefined) delete process.env[environmentKey];
          else process.env[environmentKey] = previousValue;
        }
      }
    }
  });

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
