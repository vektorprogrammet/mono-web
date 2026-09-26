import { describe, expect, it } from "@effect/vitest";
import { hashPassword as historicalScryptHash } from "better-auth/crypto";
import { hash as bcryptHash } from "bcryptjs";
import { Data, Deferred, Effect, Fiber } from "effect";
import {
  isSupportedLegacyPasswordHash,
  isNativePasswordHash,
  nativePasswordHash,
  PasswordHashCapacityError,
  PasswordInputTooLongError,
  withPasswordHashCapacity,
  verifyNativeOrLegacyPassword,
} from "./password-codec.js";

class DerivationFailure extends Data.TaggedError("DerivationFailure") {}

describe("portable credential boundary", () => {
  it.effect("writes the native Argon2 profile and preserves NFKC and embedded NUL", () =>
    Effect.gen(function* () {
      const password = "Synthetic-Å-\0-password";
      const hash = yield* nativePasswordHash(password);
      expect(isNativePasswordHash(hash)).toBe(true);
      expect(
        yield* verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-\0-password" }),
      ).toBe(true);
      expect(yield* verifyNativeOrLegacyPassword({ hash, password: "incorrect" })).toBe(false);
      expect((yield* nativePasswordHash(password)) === hash).toBe(false);
    }),
  );

  it.effect("reads the installed historical scrypt policy including its ASCII-hex salt", () =>
    Effect.gen(function* () {
      const hash = yield* Effect.promise(() => historicalScryptHash("Synthetic-Å-\0-password"));
      expect(isNativePasswordHash(hash)).toBe(false);
      expect(
        yield* verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-\0-password" }),
      ).toBe(true);
      expect(yield* verifyNativeOrLegacyPassword({ hash, password: "incorrect" })).toBe(false);
    }),
  );

  it.effect("preserves legacy bytes while the upgraded password retains its entire suffix", () =>
    Effect.gen(function* () {
      const password = "a".repeat(71) + "é-original-tail";

      const hash = (yield* Effect.promise(() => bcryptHash(password, 12))).replace("$2b$", "$2y$");

      expect(isSupportedLegacyPasswordHash(hash)).toBe(true);
      expect(yield* verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
      // Both code points start with 0xc3; bcrypt must retain the split byte, not U+FFFD.
      expect(
        yield* verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "ê-other-tail" }),
      ).toBe(true);
      expect(
        yield* verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "�-other-tail" }),
      ).toBe(false);
      expect(yield* verifyNativeOrLegacyPassword({ hash, password: password + "\0" })).toBe(false);
      const upgraded = yield* nativePasswordHash(password);
      expect(yield* verifyNativeOrLegacyPassword({ hash: upgraded, password })).toBe(true);
      expect(
        yield* verifyNativeOrLegacyPassword({
          hash: upgraded,
          password: "a".repeat(71) + "ê-other-tail",
        }),
      ).toBe(false);
    }),
  );

  it.effect("does not normalize PHP passwords", () =>
    Effect.gen(function* () {
      const hash = (yield* Effect.promise(() => bcryptHash("Synthetic-Å-password", 12))).replace(
        "$2b$",
        "$2y$",
      );

      expect(
        yield* verifyNativeOrLegacyPassword({ hash, password: "Synthetic-A\u030A-password" }),
      ).toBe(false);
    }),
  );

  it.effect("rejects malformed hashes and unsupported derivation policies", () =>
    Effect.gen(function* () {
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
        expect(yield* verifyNativeOrLegacyPassword({ hash, password: "Synthetic-Password" })).toBe(
          false,
        );
      }
    }),
  );

  it.effect("rejects oversized input before normalization or hashing admission", () =>
    Effect.gen(function* () {
      const password = "a".repeat(4096);
      const hash = yield* nativePasswordHash(password);
      expect(yield* verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
      expect(yield* Effect.flip(nativePasswordHash(password + "a"))).toBeInstanceOf(
        PasswordInputTooLongError,
      );
      expect(
        yield* Effect.flip(verifyNativeOrLegacyPassword({ hash, password: password + "a" })),
      ).toBeInstanceOf(PasswordInputTooLongError);
    }),
  );

  it.effect(
    "bounds pending work, distinguishes overload, and releases capacity after failure",
    () =>
      Effect.gen(function* () {
        const failure = yield* Deferred.make<void, DerivationFailure>();
        const derivationFailure = new DerivationFailure();

        const first = yield* Effect.forkChild(withPasswordHashCapacity(Deferred.await(failure)), {
          startImmediately: true,
        });

        const queued = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          Effect.forkChild(withPasswordHashCapacity(Effect.void), { startImmediately: true }),
        );

        expect(
          yield* Effect.flip(nativePasswordHash("Synthetic-overload-password")),
        ).toBeInstanceOf(PasswordHashCapacityError);
        const syntactic = "$2y$12$" + ".".repeat(53);
        expect(
          yield* Effect.flip(
            verifyNativeOrLegacyPassword({
              hash: syntactic,
              password: "Synthetic-overload-password",
            }),
          ),
        ).toBeInstanceOf(PasswordHashCapacityError);
        expect(
          yield* verifyNativeOrLegacyPassword({ hash: "invalid", password: "Synthetic-password" }),
        ).toBe(false);
        yield* Deferred.fail(failure, derivationFailure);
        expect(yield* Effect.flip(Fiber.join(first))).toBe(derivationFailure);
        yield* Fiber.joinAll(queued);
        const hash = yield* nativePasswordHash("Synthetic-after-failure-password");
        expect(
          yield* verifyNativeOrLegacyPassword({
            hash,
            password: "Synthetic-after-failure-password",
          }),
        ).toBe(true);
      }),
  );
});
