import { describe, expect, it } from "vitest";
import { hashPassword as historicalScryptHash } from "better-auth/crypto";
import { hash as bcryptHash } from "bcryptjs";
import {
  isSupportedLegacyPasswordHash,
  isNativePasswordHash,
  nativePasswordHash,
  PasswordHashCapacityError,
  PasswordInputTooLongError,
  withPasswordHashCapacity,
  verifyNativeOrLegacyPassword,
} from "./password-codec.js";

describe("portable credential boundary", () => {
  it("writes the native Argon2 profile and preserves NFKC and embedded NUL", async () => {
    const password = "Synthetic-Å-\0-password";
    const hash = await nativePasswordHash(password);
    expect(isNativePasswordHash(hash)).toBe(true);
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-\0-password" }),
    ).toBe(true);
    expect(await verifyNativeOrLegacyPassword({ hash, password: "incorrect" })).toBe(false);
    expect((await nativePasswordHash(password)) === hash).toBe(false);
  });

  it("reads the installed historical scrypt policy including its ASCII-hex salt", async () => {
    const hash = await historicalScryptHash("Synthetic-Å-\0-password");
    expect(isNativePasswordHash(hash)).toBe(false);
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-\0-password" }),
    ).toBe(true);
    expect(await verifyNativeOrLegacyPassword({ hash, password: "incorrect" })).toBe(false);
  });

  it("preserves legacy bytes while the upgraded password retains its entire suffix", async () => {
    const password = "a".repeat(71) + "é-original-tail";
    const hash = (await bcryptHash(password, 12)).replace("$2b$", "$2y$");
    expect(isSupportedLegacyPasswordHash(hash)).toBe(true);
    expect(await verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
    // Both code points start with 0xc3; bcrypt must retain the split byte, not U+FFFD.
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "ê-other-tail" }),
    ).toBe(true);
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "�-other-tail" }),
    ).toBe(false);
    expect(await verifyNativeOrLegacyPassword({ hash, password: password + "\0" })).toBe(false);
    const upgraded = await nativePasswordHash(password);
    expect(await verifyNativeOrLegacyPassword({ hash: upgraded, password })).toBe(true);
    expect(
      await verifyNativeOrLegacyPassword({
        hash: upgraded,
        password: "a".repeat(71) + "ê-other-tail",
      }),
    ).toBe(false);
  });

  it("does not normalize PHP passwords", async () => {
    const hash = (await bcryptHash("Synthetic-Å-password", 12)).replace("$2b$", "$2y$");
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-password" }),
    ).toBe(false);
  });

  it("rejects malformed hashes and unsupported derivation policies", async () => {
    const valid = "$argon2id$v=19$m=19456,t=2,p=1$" + "A".repeat(22) + "$" + "A".repeat(43);

    for (const hash of [
      "plain",
      "$2y$31$" + ".".repeat(53),
      "scrypt:not-valid",
      valid.replace("v=19", "v=16"),
      valid.replace("m=19456", "m=999999999"),
      valid.replace("t=2", "t=3"),
      valid.replace("p=1", "p=2"),
      valid.replace("m=19456", "m=019456"),
      valid + "=",
      valid + "\n",
      valid.slice(0, -1) + "B",
      valid.replace("A$", "B$"),
      valid + "$extra",
    ]) {
      expect(await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-Password" })).toBe(
        false,
      );
    }
  });

  it("rejects oversized input before normalization or hashing admission", async () => {
    const password = "a".repeat(4096);
    const hash = await nativePasswordHash(password);
    expect(await verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
    await expect(nativePasswordHash(password + "a")).rejects.toBeInstanceOf(
      PasswordInputTooLongError,
    );
    await expect(
      verifyNativeOrLegacyPassword({ hash, password: password + "a" }),
    ).rejects.toBeInstanceOf(PasswordInputTooLongError);
  });

  it("bounds pending work, distinguishes overload, and releases capacity after failure", async () => {
    const failure = Promise.withResolvers<void>();
    const derivationFailure = new Error("derivation failed");
    const first = withPasswordHashCapacity(() => failure.promise);
    const firstFailure = expect(first).rejects.toBe(derivationFailure);
    const queued = Array.from({ length: 8 }, () => withPasswordHashCapacity(async () => undefined));
    await expect(nativePasswordHash("Synthetic-overload-password")).rejects.toBeInstanceOf(
      PasswordHashCapacityError,
    );
    const syntactic = "$2y$12$" + ".".repeat(53);
    await expect(
      verifyNativeOrLegacyPassword({ hash: syntactic, password: "Synthetic-overload-password" }),
    ).rejects.toBeInstanceOf(PasswordHashCapacityError);
    expect(
      await verifyNativeOrLegacyPassword({ hash: "invalid", password: "Synthetic-password" }),
    ).toBe(false);
    failure.reject(derivationFailure);
    await firstFailure;
    await Promise.all(queued);
    const hash = await nativePasswordHash("Synthetic-after-failure-password");
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-after-failure-password" }),
    ).toBe(true);
  });
});
