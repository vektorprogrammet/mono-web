import { describe, expect, it } from "vitest";
import {
  APEX_LOCAL_STATE_CONTRACT,
  APEX_LOCAL_STATE_LOGICAL_IDS,
  stateBackendForStage,
} from "./state-contract.ts";

describe("deployment state contract", () => {
  it("maps dev-main only to local state", () => {
    expect(stateBackendForStage("dev-main")).toBe("local");
    expect(APEX_LOCAL_STATE_CONTRACT).toBe("vektor-dev-main-local-v1");
    expect(APEX_LOCAL_STATE_LOGICAL_IDS).toEqual([
      "vektor-apex-dashboard",
      "vektor-apex-homepage",
      "vektor-apex-worker",
    ]);
  });

  it("preserves p20 on Cloudflare state", () => {
    expect(stateBackendForStage("p20")).toBe("cloudflare");
  });

  it.each(["p000", "p21", "production", "", "dev-main "])(
    "rejects unsupported stage %j before selecting state",
    (stage) => {
      expect(() => stateBackendForStage(stage)).toThrow("Only p20 or dev-main");
    },
  );
});
