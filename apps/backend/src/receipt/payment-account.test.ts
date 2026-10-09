import { assert, expect, layer } from "@effect/vitest";
import { Crypto, Deferred, Effect, Exit, Fiber, Layer, PlatformError, type Schema } from "effect";
import {
  decodePaymentAccountCipher,
  makePaymentAccountCipher,
  type PaymentAccountCustodyError,
  type PaymentAccountSubtle,
} from "./payment-account.js";

const subtle: PaymentAccountSubtle = crypto.subtle;

const sevens = new Uint8Array(32).fill(7);

const eights = new Uint8Array(32).fill(8);

/** The nonce that the deterministic vectors below were sealed under. */
const fixedNonce = Uint8Array.from({ length: 12 }, (_, index) => 200 + index);

/*
 * Known answers of the synchronous node:crypto implementation that the WebCrypto cipher replaced.
 * Its code, with only the nonce source replaced for `fixedNonceVectors`, produced all three tables.
 * Keys are synthetic fixtures.
 */
const commitmentVectors = [
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "12345678903",
    commitment: "1725ec001836e9263eea4c9ae13334b03ab3d31d79672021b3ddcad361dffd27",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "1234.56.78903",
    commitment: "022933a92f0d8d7f6dd31d5cce9bb23f4dfa0ac8b1e4fc8aff6613874243c50d",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "1234 56 78903",
    commitment: "91d87eaee4b959f9997e4a4493284725ee043175e811c6ce8610440b2c8e91ff",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "",
    commitment: "d1a140531319fd89129e13501f3103a2125d7ea7a511e01f5ee3e82b59d7b172",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "98765000009",
    commitment: "e6088496c8646acc79b7587d2cac58c81844ab605f9aacaf3af8aa02c32b5ed1",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    raw: "konto-æøå\u0000x",
    commitment: "4548b85438721e2518438c7f2c6892c7dbda2e8d1bd11689f042309dbd8e9d4d",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "12345678903",
    commitment: "4ecd9d892f3b55265309a70292373b19d7f7b1037dc3f11174d8b90901ebb6e7",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "1234.56.78903",
    commitment: "a117e7b55ecc9f375ac74a1c054c172f419c468581b785cdafe34c783c252746",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "1234 56 78903",
    commitment: "a12e9df9b8ba26623816449c9c6508094fb2434f70ee397c56657e0cf7b325cb",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "",
    commitment: "b4bf4e8e3e6e0730a1215ca3dc85ff0ac127b4980f05d7fa7035ff2a8ea78b8c",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "98765000009",
    commitment: "b7cfb5b5edb6720370040df435604b62603af5be348951536b10ed52e5d17b9b",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    raw: "konto-æøå\u0000x",
    commitment: "85e6e750af631a9e23867f09bd9ac12dd06c660b277bb600061facc563ecb0d1",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "12345678903",
    commitment: "ea2377e31045365f89660a3826c3b543106e76ec0f6ded70e52c83f6ca8ff7e5",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "1234.56.78903",
    commitment: "9a8c299f55c3e8417644f553f74f8d660628c598435ff9f9d8f6767586ebf3b5",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "1234 56 78903",
    commitment: "7864abe73b7f7f01cce5b8be4374b8c9ad51c1260cd1221eac2828f136cd96f1",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "",
    commitment: "b23e6aba4bb98e1548335e2643e08fdcdae566a4b4ef937054e785f88999bd4d",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "98765000009",
    commitment: "718edae6f3d3286cde59e42cfe70094786db1316b26c23e2e14723ceb414d1e6",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    raw: "konto-æøå\u0000x",
    commitment: "b7d8e7ab1082158d2e0f5c23feea7f8294f25c309ddeb0960de7a79efaa4ebd3",
  },
];

const sealedVectors = [
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    receiptId: "receipt-one",
    account: "12345678903",
    ciphertext: "v1.fixture.0zB_g3dFj2dq0_3b.8f4qSWXpqA3Vpho.9LEh3HAOnJBtHYvOqIZ4Gw",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    receiptId: "receipt-two",
    account: "12345678903",
    ciphertext: "v1.fixture.W9VwQqJ5q8ex5YZ5.35K9xX7ug0GRfLQ.AZHMOhlaSXwc9zhUM6bwdQ",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    receiptId: "receipt-one",
    account: "12345678903",
    ciphertext: "v1.fixture.njm4d1zPOdwNEgSc.EMcX2kUH9ENj00g.U5LYUem6XGvYYgrAkZK47A",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    receiptId: "kvittering-æøå",
    account: "98765000009",
    ciphertext: "v1.kat_ramp-v1.A-yXnklZKWEZja37.Pv4Iq3MuNQImwXU.K6Sh2_6JoLgpI2XLa1J63w",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    receiptId:
      "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
    account: "12345678903",
    ciphertext: "v1.kat_ramp-v1.EimiD4hQYfBX3syv.R2DAbOrDpiqrNAM.pxCQN_VnEQK4V0DX5suhrw",
  },
];

const fixedNonceVectors = [
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    receiptId: "receipt-one",
    account: "12345678903",
    raw: "12345678903",
    ciphertext: "v1.fixture.yMnKy8zNzs_Q0dLT.9u_ItuXB0RnXUuc.kVsIin_p3nkNDOOuRYgIxQ",
  },
  {
    key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyId: "fixture",
    receiptId: "receipt-two",
    account: "12345678903",
    raw: "1234 56 78903",
    ciphertext: "v1.fixture.yMnKy8zNzs_Q0dLT.9u_ItuXB0RnXUuc.00ADahUjm4UuEqABcnMBnQ",
  },
  {
    key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
    keyId: "fixture",
    receiptId: "receipt-one",
    account: "12345678903",
    raw: "1234.56.78903",
    ciphertext: "v1.fixture.yMnKy8zNzs_Q0dLT.zdznEINkC0BLyZw.lcNS-XqHCmKPRAIgnaf_cg",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    receiptId: "kvittering-æøå",
    account: "98765000009",
    raw: "98765000009",
    ciphertext: "v1.kat_ramp-v1.yMnKy8zNzs_Q0dLT.12cXIevxzZyEsTU.JSpA_YuuPHecuPkMXHdJhw",
  },
  {
    key: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
    keyId: "kat_ramp-v1",
    receiptId:
      "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
    account: "12345678903",
    raw: "12345678903",
    ciphertext: "v1.kat_ramp-v1.yMnKy8zNzs_Q0dLT.320TI-v3ypSNsT8.zlc5XjK_Le5MhF-0HrRI9g",
  },
];

const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const cipherOf = (key: Uint8Array, keyId = "fixture") =>
  makePaymentAccountCipher({ subtle, keyId, key });

const codeOf = <A, R>(effect: Effect.Effect<A, PaymentAccountCustodyError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

const cryptoOf = (randomBytes: (size: number) => Uint8Array) =>
  Crypto.make({ randomBytes, digest: () => Effect.die("The cipher computes no digest.") });

/** The Crypto service over the host CSPRNG: the nonce source of the cipher under real randomness. */
const PlatformRandom = Layer.succeed(
  Crypto.Crypto,
  cryptoOf((size) => crypto.getRandomValues(new Uint8Array(size))),
);

const FixedNonce = Layer.succeed(
  Crypto.Crypto,
  cryptoOf((size) => new Uint8Array(fixedNonce.subarray(0, size))),
);

const rejected = () => Promise.reject(new Error("platform failure"));

/** WebCrypto whose named operations are replaced; the others stay the real, bound ones. */
const withSubtle = (replaced: Partial<PaymentAccountSubtle>): PaymentAccountSubtle => ({
  importKey: subtle.importKey.bind(subtle),
  deriveKey: subtle.deriveKey.bind(subtle),
  encrypt: subtle.encrypt.bind(subtle),
  decrypt: subtle.decrypt.bind(subtle),
  sign: subtle.sign.bind(subtle),
  ...replaced,
});

layer(PlatformRandom, { excludeTestServices: true })("payment account cipher", (it) => {
  it.effect("reproduces every commitment of the synchronous implementation", () =>
    Effect.gen(function* () {
      for (const vector of commitmentVectors) {
        const cipher = yield* cipherOf(fromBase64(vector.key), vector.keyId);

        assert.strictEqual(yield* cipher.commitment(vector.raw), vector.commitment);
      }
    }),
  );

  it.effect("opens every ciphertext that the synchronous implementation sealed", () =>
    Effect.gen(function* () {
      for (const vector of sealedVectors) {
        const cipher = yield* cipherOf(fromBase64(vector.key), vector.keyId);

        assert.strictEqual(
          yield* cipher.decrypt(vector.ciphertext, vector.receiptId),
          vector.account,
        );
      }
    }),
  );

  it.effect("seals byte for byte what the synchronous implementation seals under one nonce", () =>
    Effect.gen(function* () {
      for (const vector of fixedNonceVectors) {
        const cipher = yield* cipherOf(fromBase64(vector.key), vector.keyId);

        assert.strictEqual(yield* cipher.encrypt(vector.raw, vector.receiptId), vector.ciphertext);
        assert.strictEqual(
          yield* cipher.decrypt(vector.ciphertext, vector.receiptId),
          vector.account,
        );
      }
    }).pipe(Effect.provide(FixedNonce)),
  );

  it.effect("draws the 12-byte nonce of every encryption from the Crypto service", () =>
    Effect.gen(function* () {
      const requested: number[] = [];

      const recording = Layer.succeed(
        Crypto.Crypto,
        cryptoOf((size) => {
          requested.push(size);

          return new Uint8Array(size).fill(9);
        }),
      );

      const encrypted = yield* cipherOf(sevens).pipe(
        Effect.flatMap((cipher) => cipher.encrypt("12345678903", "receipt-one")),
        Effect.provide(recording),
      );

      assert.deepStrictEqual(requested, [12]);
      assert.strictEqual(encrypted.split(".")[2], base64url(new Uint8Array(12).fill(9)));
    }),
  );

  it.effect("never repeats a nonce or a ciphertext across repeated encryptions", () =>
    Effect.gen(function* () {
      const cipher = yield* cipherOf(sevens);

      const sealed = yield* Effect.forEach(
        Array.from({ length: 512 }, () => "12345678903"),
        (account) => cipher.encrypt(account, "receipt-one"),
        { concurrency: 8 },
      );

      const nonces = sealed.map((value) => value.split(".")[2]!);

      expect(new Set(nonces).size).toBe(512);
      expect(new Set(sealed).size).toBe(512);
      expect(nonces.every((nonce) => Buffer.from(nonce, "base64url").length === 12)).toBe(true);

      for (const value of sealed.slice(0, 8))
        assert.strictEqual(yield* cipher.decrypt(value, "receipt-one"), "12345678903");
    }),
  );

  it.effect("binds ciphertext, tag, nonce, owning receipt, and key id", () =>
    Effect.gen(function* () {
      const cipher = yield* cipherOf(sevens);
      const encrypted = yield* cipher.encrypt("1234.56.78903", "receipt-one");
      const parts = encrypted.split(".");

      const flip = (index: number) => {
        const bytes = Buffer.from(parts[index]!, "base64url");
        bytes[0] = bytes[0]! ^ 1;

        return parts.with(index, bytes.toString("base64url")).join(".");
      };

      assert.strictEqual(yield* cipher.decrypt(encrypted, "receipt-one"), "12345678903");

      for (const tampered of [
        flip(2),
        flip(3),
        flip(4),
        parts.with(1, "other").join("."),
        parts.with(0, "v2").join("."),
        parts.slice(0, 4).join("."),
        `${encrypted}.AA`,
        parts.with(4, `${parts[4]!}=`).join("."),
        parts.with(3, parts[3]!.slice(1)).join("."),
        "x".repeat(257),
        "",
      ])
        assert.strictEqual(
          yield* codeOf(cipher.decrypt(tampered, "receipt-one")),
          "InvalidCiphertext",
        );

      for (const receiptId of ["receipt-two", "", "r".repeat(513)])
        assert.strictEqual(
          yield* codeOf(cipher.decrypt(encrypted, receiptId)),
          "InvalidCiphertext",
        );
    }),
  );

  it.effect("refuses a ciphertext of another key and keeps commitments key-bound", () =>
    Effect.gen(function* () {
      const cipher = yield* cipherOf(sevens);
      const wrongKey = yield* cipherOf(eights);
      const otherId = yield* cipherOf(sevens, "second");
      const encrypted = yield* cipher.encrypt("12345678903", "receipt-one");
      const commitment = yield* cipher.commitment("12345678903");

      assert.strictEqual(
        yield* codeOf(wrongKey.decrypt(encrypted, "receipt-one")),
        "InvalidCiphertext",
      );
      assert.strictEqual(
        yield* codeOf(otherId.decrypt(encrypted, "receipt-one")),
        "InvalidCiphertext",
      );
      expect(commitment).not.toBe(yield* wrongKey.commitment("12345678903"));
      expect(commitment).not.toBe(yield* otherId.commitment("12345678903"));
      expect(commitment).not.toBe(yield* cipher.commitment("1234.56.78903"));
    }),
  );

  it.effect("rejects an invalid check digit and an invalid key before any sealing", () =>
    Effect.gen(function* () {
      const cipher = yield* cipherOf(sevens);

      for (const raw of ["12345678904", "1234.56 78903", "1234567890", "1234.56.789030", ""])
        assert.strictEqual(yield* codeOf(cipher.encrypt(raw, "receipt-one")), "InvalidAccount");

      assert.strictEqual(yield* codeOf(cipher.encrypt("12345678903", "")), "InvalidCiphertext");
      assert.strictEqual(
        yield* cipher.decrypt(yield* cipher.encrypt("1234 56 78903", "receipt-one"), "receipt-one"),
        "12345678903",
      );

      for (const [key, keyId] of [
        [new Uint8Array(31), "fixture"],
        [new Uint8Array(33), "fixture"],
        [sevens, ""],
        [sevens, "bad id"],
        [sevens, "a".repeat(65)],
      ] as const)
        assert.strictEqual(yield* codeOf(cipherOf(key, keyId)), "InvalidKey");
    }),
  );

  it.effect("decodes a canonical key file and refuses every other file", () =>
    Effect.gen(function* () {
      const key = Buffer.from(sevens).toString("base64");

      const cipher = yield* decodePaymentAccountCipher(subtle, {
        keyId: "fixture",
        keyBase64: key,
      });

      const direct = yield* cipherOf(sevens);
      const encrypted = yield* direct.encrypt("12345678903", "receipt-one");

      assert.strictEqual(cipher.keyId, "fixture");
      assert.strictEqual(yield* cipher.decrypt(encrypted, "receipt-one"), "12345678903");

      const files: ReadonlyArray<Schema.Json> = [
        { keyId: "fixture", keyBase64: key, extra: true },
        { keyId: "fixture" },
        { keyId: 7, keyBase64: key },
        { keyId: "fixture", keyBase64: key.slice(0, -2) },
        { keyId: "fixture", keyBase64: key.replace(/=+$/, "") },
        { keyId: "fixture", keyBase64: Buffer.from(new Uint8Array(16)).toString("base64") },
        { keyId: "fixture", keyBase64: `${key}\n` },
        { keyId: "bad id", keyBase64: key },
        null,
        [],
      ];

      for (const file of files)
        assert.strictEqual(yield* codeOf(decodePaymentAccountCipher(subtle, file)), "InvalidKey");
    }),
  );

  it.effect("maps WebCrypto failures to typed custody errors", () =>
    Effect.gen(function* () {
      for (const replaced of [{ importKey: rejected }, { deriveKey: rejected }])
        assert.strictEqual(
          yield* codeOf(
            makePaymentAccountCipher({
              subtle: withSubtle(replaced),
              keyId: "fixture",
              key: sevens,
            }),
          ),
          "InvalidKey",
        );

      const sealing = yield* makePaymentAccountCipher({
        subtle: withSubtle({ encrypt: rejected, sign: rejected }),
        keyId: "fixture",
        key: sevens,
      });

      assert.strictEqual(
        yield* codeOf(sealing.encrypt("12345678903", "receipt-one")),
        "CryptoFailure",
      );
      assert.strictEqual(yield* codeOf(sealing.commitment("12345678903")), "CryptoFailure");

      const sealed = yield* (yield* cipherOf(sevens)).encrypt("12345678903", "receipt-one");

      const opening = yield* makePaymentAccountCipher({
        subtle: withSubtle({ decrypt: rejected }),
        keyId: "fixture",
        key: sevens,
      });

      assert.strictEqual(
        yield* codeOf(opening.decrypt(sealed, "receipt-one")),
        "InvalidCiphertext",
      );
    }),
  );

  it.effect("maps a missing or malformed nonce to a typed custody error", () =>
    Effect.gen(function* () {
      const unavailable = Layer.succeed(Crypto.Crypto, {
        ...cryptoOf(() => new Uint8Array(12)),
        randomBytes: () =>
          Effect.fail(
            PlatformError.badArgument({
              module: "Crypto",
              method: "randomBytes",
              description: "unavailable",
            }),
          ),
      });

      const short = Layer.succeed(
        Crypto.Crypto,
        cryptoOf(() => new Uint8Array(11)),
      );

      for (const nonces of [unavailable, short])
        assert.strictEqual(
          yield* codeOf(
            cipherOf(sevens).pipe(
              Effect.flatMap((cipher) => cipher.encrypt("12345678903", "receipt-one")),
              Effect.provide(nonces),
            ),
          ),
          "CryptoFailure",
        );
    }),
  );

  it.effect("stops waiting for WebCrypto when the operation is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const hanging = () => {
        Deferred.doneUnsafe(started, Exit.void);

        return Promise.withResolvers<never>().promise;
      };

      const cipher = yield* makePaymentAccountCipher({
        subtle: withSubtle({ encrypt: hanging }),
        keyId: "fixture",
        key: sevens,
      });

      const fiber = yield* Effect.forkChild(cipher.encrypt("12345678903", "receipt-one"));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(Fiber.join(fiber))));
    }),
  );
});
