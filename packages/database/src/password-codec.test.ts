import { describe, expect, it } from "vitest";
import {
  isSupportedLegacyPasswordHash,
  isNativePasswordHash,
  nativePasswordHash,
  verifyNativeOrLegacyPassword,
} from "./password-codec.js";
describe("bounded credential hash namespace", () => {
  it("admits only source2y/cost12 and exact installed native encoding", () => {
    const syntactic = "$2y$12$" + "A".repeat(53);
    expect(isSupportedLegacyPasswordHash(syntactic)).toBe(true);
    for (const invalid of [
      syntactic.replace("2y", "2b"),
      syntactic.replace("12", "31"),
      syntactic + "x",
      null,
      "plain",
    ])
      expect(isSupportedLegacyPasswordHash(invalid)).toBe(false);
    expect(isNativePasswordHash("a".repeat(32) + ":" + "b".repeat(128))).toBe(true);
    expect(isNativePasswordHash("salt:key")).toBe(false);
  });
  it("retains installed native normalization and NUL behavior", async () => {
    const hash = await nativePasswordHash("Synthetic-Å-\0-password");
    expect(isNativePasswordHash(hash)).toBe(true);
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-\0-password" }),
    ).toBe(true);
    expect(await verifyNativeOrLegacyPassword({ hash, password: "incorrect" })).toBe(false);
  });
  it("fails unsupported encodings closed without invoking expensive work", async () => {
    for (const hash of ["plain", "$2y$31$" + "A".repeat(53), "scrypt:not-valid"])
      expect(await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-Password" })).toBe(
        false,
      );
    expect(
      await verifyNativeOrLegacyPassword({
        hash: "$2y$12$" + "A".repeat(53),
        password: "value\0tail",
      }),
    ).toBe(false);
  });
});
