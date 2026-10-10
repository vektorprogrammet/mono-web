import { assert, expect, layer } from "@effect/vitest";
import { hashPassword as historicalScryptHash } from "better-auth/crypto";
import { hash as bcryptHash } from "bcryptjs";
import { Cause, Crypto, Data, Deferred, Effect, Exit, Fiber, Layer, PlatformError } from "effect";
import {
  isSupportedLegacyPasswordHash,
  isNativePasswordHash,
  nativePasswordHash,
  PasswordHashCapacityError,
  PasswordInputTooLongError,
  withPasswordHashCapacity,
  verifyNativeOrLegacyPassword,
} from "./password-codec.js";
import { TestPlatform } from "./test-support/platform.js";
import { SecretEquality, SecretEqualityLive } from "./web-crypto.js";

class DerivationFailure extends Data.TaggedError("DerivationFailure") {}

/*
 * Known answers of the code that preceded the Crypto and SecretEquality migration (commit
 * 5e2ce43a): `crypto.getRandomValues` drew the salt and `timingSafeEqual` compared the keys. A
 * run of that file with the salt pinned to the bytes below wrote every native hash; the scrypt hash
 * is `hashPassword` of better-auth/crypto. The passwords are synthetic fixtures.
 */
const saltA = Array.from({ length: 16 }, (_, index) => index);

const saltB = Array.from({ length: 16 }, (_, index) => 0xf0 + index);

const salts = { A: saltA, B: saltB };

interface NativeVector {
  readonly salt: "A" | "B";
  readonly password: string;
  readonly hash: string;
}

const nativeVectors = {
  ascii: {
    salt: "A",
    password: "Synthetic-ascii-password",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$ebrjeverey7FkdWJjiLPg9bihe48TU9UZuL+Sq4U+0I",
  },
  precomposedWithNul: {
    salt: "A",
    password: "Synthetic-\u00c5-\0-password",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$p4rqsokS7mFvczxdM6knK/W2CzQop2ppyR4SC53dSFM",
  },
  // NFKC folds the combining ring into the precomposed letter, so the hash is the one above.
  decomposedWithNul: {
    salt: "A",
    password: "Synthetic-A\u030a-\0-password",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$p4rqsokS7mFvczxdM6knK/W2CzQop2ppyR4SC53dSFM",
  },
  empty: {
    salt: "A",
    password: "",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$MVSMP3rBIzE7F86FWHKNemRnE6hkgY2O2buZdxt7Gkw",
  },
  fullwidth: {
    salt: "A",
    password:
      "\uff53\uff59\uff4e\uff54\uff48\uff45\uff54\uff49\uff43\uff0d\uff50\uff41\uff53\uff53",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$Oi+DAnpX/BLQB4EVVpt9nsKkeVoFpIFAYlhlHAg7QLY",
  },
  maxLength: {
    salt: "A",
    password: "a".repeat(4096),
    hash: "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$eS7NUurgeZCGOSFB9R7AJZpZchAfCUwOKwGF5I4/noU",
  },
  asciiOtherSalt: {
    salt: "B",
    password: "Synthetic-ascii-password",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$8PHy8/T19vf4+fr7/P3+/w$6QKdIETHo8c+8QzWNlGoRkyTFpxg5ePOuaTU4oYKpJg",
  },
  emptyOtherSalt: {
    salt: "B",
    password: "",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$8PHy8/T19vf4+fr7/P3+/w$XpMfJl+3/VoJi9TI1i/XH7ntYV9DB46v8PUWjLhK5ng",
  },
} satisfies Record<string, NativeVector>;

const scryptPassword = "Synthetic-\u00c5-\0-password";

const scryptHash =
  "4bf95652fe9df8aa5d8eac03aa0980e4:c0a2e220bd0a457f863a60893276e7b4eb20d2c1a7c85dcdd4e19616d9a31d031e802296fc148b1fa76982726dac737bd69e2a2ef835a073bb3eda49dacfd1e6";

const unpadded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/u, "");

/** `hash` with the bit `0x01` of the first byte of its salt field, 4, or key field, 5, flipped. */
const withFlippedBit = (hash: string, field: 4 | 5) => {
  const parts = hash.split("$");
  const bytes = Buffer.from(parts[field]!, "base64");

  bytes[0] = bytes[0]! ^ 1;
  parts[field] = unpadded(bytes);

  return parts.join("$");
};

/** `effect` with the salt that the codec draws pinned to `salt`, the digest left to the platform. */
const withSalt = <A, E, R>(salt: ReadonlyArray<number>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const platform = yield* Crypto.Crypto;

    return yield* Effect.provideService(
      effect,
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => Uint8Array.from(salt).slice(0, size),
        digest: (algorithm, data) => platform.digest(algorithm, data),
      }),
    );
  });

const isDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause);

const isInterrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);

const CodecLive = SecretEqualityLive(globalThis.crypto.subtle).pipe(
  Layer.provideMerge(TestPlatform),
);

layer(CodecLive, { excludeTestServices: true, timeout: "60 seconds" })(
  "portable credential boundary",
  (it) => {
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

    it.effect("draws a fresh 16-byte salt from the Crypto service for every hash", () =>
      Effect.gen(function* () {
        const first = yield* nativePasswordHash("Synthetic-salt-password");
        const second = yield* nativePasswordHash("Synthetic-salt-password");
        const [firstSalt, secondSalt] = [first, second].map((hash) => hash.split("$")[4]!);

        expect(Buffer.from(firstSalt!, "base64")).toHaveLength(16);
        expect(Buffer.from(secondSalt!, "base64")).toHaveLength(16);
        expect(firstSalt).not.toBe(secondSalt);
      }),
    );

    it.effect("writes the hash that the previous code wrote for the same salt", () =>
      Effect.gen(function* () {
        for (const [name, vector] of Object.entries(nativeVectors)) {
          const written = yield* withSalt(salts[vector.salt], nativePasswordHash(vector.password));

          assert.strictEqual(written, vector.hash, name);
        }
      }),
    );

    it.effect("verifies the hashes that the previous code wrote", () =>
      Effect.gen(function* () {
        for (const [name, vector] of Object.entries(nativeVectors)) {
          assert.isTrue(
            yield* verifyNativeOrLegacyPassword({ hash: vector.hash, password: vector.password }),
            name,
          );
        }
      }),
    );

    it.effect("verifies the historical scrypt hash and rejects its tampered forms", () =>
      Effect.gen(function* () {
        const [salt = "", key = ""] = scryptHash.split(":");
        const flippedNibble = (value: string) => (value[0] === "0" ? "1" : "0") + value.slice(1);

        assert.isTrue(
          yield* verifyNativeOrLegacyPassword({ hash: scryptHash, password: scryptPassword }),
        );

        for (const [name, hash, password] of [
          ["wrong password", scryptHash, "incorrect"],
          ["one-bit-different key", `${salt}:${flippedNibble(key)}`, scryptPassword],
          ["tampered salt", `${flippedNibble(salt)}:${key}`, scryptPassword],
          ["truncated key", `${salt}:${key.slice(0, -2)}`, scryptPassword],
          ["extended key", `${salt}:${key}00`, scryptPassword],
        ] as const) {
          assert.isFalse(yield* verifyNativeOrLegacyPassword({ hash, password }), name);
        }
      }),
    );

    it.effect("rejects a wrong password, a one-bit-different hash, and a tampered salt", () =>
      Effect.gen(function* () {
        const vector = nativeVectors.ascii;

        assert.isTrue(
          yield* verifyNativeOrLegacyPassword({ hash: vector.hash, password: vector.password }),
        );

        for (const [name, hash, password] of [
          ["wrong password", vector.hash, "Synthetic-ascii-passworD"],
          ["empty password", vector.hash, ""],
          ["one-bit-different key", withFlippedBit(vector.hash, 5), vector.password],
          ["tampered salt", withFlippedBit(vector.hash, 4), vector.password],
          ["hash of another password", nativeVectors.precomposedWithNul.hash, vector.password],
        ] as const) {
          assert.isFalse(yield* verifyNativeOrLegacyPassword({ hash, password }), name);
        }
      }),
    );

    it.effect("rejects hashes whose key is shorter or longer than the derived key", () =>
      Effect.gen(function* () {
        const vector = nativeVectors.ascii;

        const head = vector.hash.slice(0, vector.hash.lastIndexOf("$"));
        const key = vector.hash.split("$")[5]!;

        for (const hash of [
          `${head}$${key.slice(0, -4)}`,
          `${head}$${key.slice(0, 22)}`,
          `${head}$`,
          `${head}$${key}AAAA`,
        ]) {
          assert.isFalse(yield* verifyNativeOrLegacyPassword({ hash, password: vector.password }));
        }
      }),
    );

    it.effect("takes the whole comparison from the SecretEquality of the context", () =>
      Effect.gen(function* () {
        const vector = nativeVectors.ascii;
        const calls: Array<readonly [string, string]> = [];

        const answering = (answer: boolean) =>
          SecretEquality.of({
            equal: (expected, presented) =>
              Effect.sync(() => {
                calls.push([expected, presented]);

                return answer;
              }),
          });

        const accepting = yield* verifyNativeOrLegacyPassword({
          hash: vector.hash,
          password: "Synthetic-another-password",
        }).pipe(Effect.provideService(SecretEquality, answering(true)));

        const rejecting = yield* verifyNativeOrLegacyPassword({
          hash: vector.hash,
          password: vector.password,
        }).pipe(Effect.provideService(SecretEquality, answering(false)));

        assert.isTrue(accepting);
        assert.isFalse(rejecting);
        // The stored key and the derived key meet in it as the hex of their bytes, in that order.
        const storedKey = Buffer.from(vector.hash.split("$")[5]!, "base64").toString("hex");

        assert.strictEqual(calls[1]![0], storedKey);
        assert.strictEqual(calls[1]![1], storedKey);
        assert.notStrictEqual(calls[0]![1], storedKey);
      }),
    );

    it.effect("releases the hashing capacity when the comparison is interrupted", () =>
      Effect.gen(function* () {
        const vector = nativeVectors.ascii;
        const started = yield* Deferred.make<void>();

        const hanging = SecretEquality.of({
          equal: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });

        const fiber = yield* Effect.forkChild(
          verifyNativeOrLegacyPassword({ hash: vector.hash, password: vector.password }).pipe(
            Effect.provideService(SecretEquality, hanging),
          ),
        );

        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);

        assert.isTrue(isInterrupted(yield* Fiber.await(fiber)));
        // A leaked permit would hold this admission forever.
        yield* withPasswordHashCapacity(Effect.void);
        assert.isTrue(
          yield* verifyNativeOrLegacyPassword({ hash: vector.hash, password: vector.password }),
        );
      }),
    );

    it.effect("treats a failed salt draw as a defect, never a hash", () =>
      Effect.gen(function* () {
        const platform = yield* Crypto.Crypto;

        const failing = Crypto.Crypto.of({
          ...platform,
          randomBytes: () =>
            Effect.fail(PlatformError.badArgument({ module: "Crypto", method: "randomBytes" })),
        });

        const exit = yield* nativePasswordHash("Synthetic-defect-password").pipe(
          Effect.provideService(Crypto.Crypto, failing),
          Effect.exit,
        );

        assert.isTrue(isDefect(exit));
      }),
    );

    it.effect("reads the installed historical scrypt policy including its ASCII-hex salt", () =>
      Effect.gen(function* () {
        const hash = yield* Effect.promise(() => historicalScryptHash("Synthetic-Å-\0-password"));

        for (const stored of [hash, scryptHash]) {
          expect(isNativePasswordHash(stored)).toBe(false);
          expect(
            yield* verifyNativeOrLegacyPassword({
              hash: stored,
              password: "Synthetic-A\u030A-\0-password",
            }),
          ).toBe(true);
          expect(yield* verifyNativeOrLegacyPassword({ hash: stored, password: "incorrect" })).toBe(
            false,
          );
        }
      }),
    );

    it.effect("preserves legacy bytes while the upgraded password retains its entire suffix", () =>
      Effect.gen(function* () {
        const password = "a".repeat(71) + "é-original-tail";

        const hash = (yield* Effect.promise(() => bcryptHash(password, 12))).replace(
          "$2b$",
          "$2y$",
        );

        expect(isSupportedLegacyPasswordHash(hash)).toBe(true);
        expect(yield* verifyNativeOrLegacyPassword({ hash, password })).toBe(true);
        // Both code points start with 0xc3; bcrypt must retain the split byte, not U+FFFD.
        expect(
          yield* verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "ê-other-tail" }),
        ).toBe(true);
        expect(
          yield* verifyNativeOrLegacyPassword({ hash, password: "a".repeat(71) + "�-other-tail" }),
        ).toBe(false);
        expect(yield* verifyNativeOrLegacyPassword({ hash, password: password + "\0" })).toBe(
          false,
        );
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
          expect(
            yield* verifyNativeOrLegacyPassword({ hash, password: "Synthetic-Password" }),
          ).toBe(false);
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
            yield* verifyNativeOrLegacyPassword({
              hash: "invalid",
              password: "Synthetic-password",
            }),
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
  },
);
