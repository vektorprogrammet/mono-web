import { describe, expect, it, vi } from "vitest";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import type * as Argon2 from "@noble/hashes/argon2.js";
import { hashPassword as historicalScryptHash } from "better-auth/crypto";
import { hash as bcryptHash } from "bcryptjs";
import {
  isSupportedLegacyPasswordHash,
  isNativePasswordHash,
  nativePasswordHash,
  PasswordHashCapacityError,
  PasswordInputTooLongError,
  verifyNativeOrLegacyPassword,
} from "./password-codec.js";

vi.mock("@noble/hashes/argon2.js", async (original) => {
  const actual = await original<typeof Argon2>();
  return { ...actual, argon2idAsync: vi.fn(actual.argon2idAsync) };
});

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

  it("denies malformed and unsupported costs before invoking Argon2", async () => {
    const valid = "$argon2id$v=19$m=19456,t=2,p=1$" + "A".repeat(22) + "$" + "A".repeat(43);
    const before = vi.mocked(argon2idAsync).mock.calls.length;
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
    expect(vi.mocked(argon2idAsync).mock.calls.length).toBe(before);
  });

  it("rejects oversized input before normalization or hashing admission", async () => {
    const password = "a".repeat(4096);
    const hash = await nativePasswordHash(password);
    expect(await verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
    const before = vi.mocked(argon2idAsync).mock.calls.length;
    await expect(nativePasswordHash(password + "a")).rejects.toBeInstanceOf(
      PasswordInputTooLongError,
    );
    await expect(
      verifyNativeOrLegacyPassword({ hash, password: password + "a" }),
    ).rejects.toBeInstanceOf(PasswordInputTooLongError);
    expect(vi.mocked(argon2idAsync).mock.calls.length).toBe(before);
  });

  it("bounds pending work, distinguishes overload, and releases capacity after failure", async () => {
    const failure = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    vi.mocked(argon2idAsync).mockImplementationOnce(() => failure.promise);
    const first = nativePasswordHash("Synthetic-first-password");
    const firstFailure = expect(first).rejects.toThrow("derivation failed");
    const queued = Array.from({ length: 8 }, () => {
      vi.mocked(argon2idAsync).mockResolvedValueOnce(new Uint8Array(32));
      return nativePasswordHash("Synthetic-queued-password");
    });
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
    failure.reject(new Error("derivation failed"));
    await firstFailure;
    await Promise.all(queued);
    const hash = await nativePasswordHash("Synthetic-after-failure-password");
    expect(
      await verifyNativeOrLegacyPassword({ hash, password: "Synthetic-after-failure-password" }),
    ).toBe(true);
  });
});
