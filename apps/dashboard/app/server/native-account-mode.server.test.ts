import { describe, expect, it } from "vitest";
import { nativeDashboardRecoveryMode } from "./native-account-mode.server";

describe("native credential composition", () => {
  it("keeps recovery disabled until explicitly enabled for a native cohort", () => {
    expect(nativeDashboardRecoveryMode({})).toBe("disabled");
    expect(nativeDashboardRecoveryMode({ PASSWORD_RECOVERY_ENGINE: "native" })).toBe("native");
  });
  it.each(["legacy-symfony", "other", "", " native"])(
    "rejects a mixed or unknown engine selection: %s",
    (value) => {
      expect(() => nativeDashboardRecoveryMode({ PASSWORD_RECOVERY_ENGINE: value })).toThrow(
        "supports only native",
      );
    },
  );
});
