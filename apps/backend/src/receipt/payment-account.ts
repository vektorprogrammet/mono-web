import { Crypto, Data, Effect, Result, Schema } from "effect";
import { Base64, Base64Url, Hex } from "effect/encoding";

/** The WebCrypto provider that the composition root injects; this module reads no global. */
export type PaymentAccountSubtle = Pick<
  typeof crypto.subtle,
  "importKey" | "deriveKey" | "encrypt" | "decrypt" | "sign"
>;

const KeyFile = Schema.Struct({ keyId: Schema.String, keyBase64: Schema.String });

const decodeKeyFile = Schema.decodeUnknownEffect(KeyFile);

/**
 * The failures of payment-account custody.
 * `CryptoFailure` is a platform failure of an otherwise valid operation (nonce, seal, or MAC).
 */
export class PaymentAccountCustodyError extends Data.TaggedError("PaymentAccountCustodyError")<{
  readonly code: "InvalidKey" | "InvalidAccount" | "InvalidCiphertext" | "CryptoFailure";
}> {
  override get message(): string {
    return this.code;
  }
}

/**
 * Seals and opens Norwegian payment accounts under one custody key.
 *
 * Every operation is an Effect that requires nothing: the cipher captured the platform `Crypto`
 * service (the source of nonces) when it was made.
 * WebCrypto operations cannot be aborted, so interrupting an operation stops its waiter only.
 */
export interface PaymentAccountCipher {
  readonly keyId: string;
  readonly commitment: (raw: string) => Effect.Effect<string, PaymentAccountCustodyError>;
  readonly encrypt: (
    raw: string,
    receiptId: string,
  ) => Effect.Effect<string, PaymentAccountCustodyError>;
  readonly decrypt: (
    ciphertext: string,
    receiptId: string,
  ) => Effect.Effect<string, PaymentAccountCustodyError>;
}

const label = "vektor/receipt/payment-account/v1";

const nonceBytes = 12;

const tagBytes = 16;

const accountBytes = 11;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const failure = (code: PaymentAccountCustodyError["code"]) =>
  new PaymentAccountCustodyError({ code });

/** Check digits follow the Norwegian account number rule; the digits are the stored form. */
const normalizedAccount = (raw: string): Result.Result<string, PaymentAccountCustodyError> => {
  if (!/^(?:[0-9]{11}|[0-9]{4}([. ])[0-9]{2}\1[0-9]{5})$/.test(raw))
    return Result.fail(failure("InvalidAccount"));

  const digits = raw.replace(/[. ]/g, "");
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;

  for (let index = 0; index < weights.length; index += 1)
    sum += Number(digits[index]) * weights[index]!;

  return (11 - (sum % 11)) % 11 === Number(digits[10])
    ? Result.succeed(digits)
    : Result.fail(failure("InvalidAccount"));
};

const associatedData = (
  receiptId: string,
): Result.Result<Uint8Array, PaymentAccountCustodyError> =>
  receiptId.length === 0 || receiptId.length > 512
    ? Result.fail(failure("InvalidCiphertext"))
    : Result.succeed(encoder.encode(`${label}:${receiptId}`));

/** Only the canonical unpadded base64url form of exactly `size` bytes is a part. */
const decodePart = (
  value: string,
  size: number,
): Result.Result<Uint8Array, PaymentAccountCustodyError> => {
  const decoded = Base64Url.decode(value);

  return Result.isSuccess(decoded) &&
    decoded.success.length === size &&
    Base64Url.encode(decoded.success) === value
    ? Result.succeed(decoded.success)
    : Result.fail(failure("InvalidCiphertext"));
};

const parseCiphertext = (
  ciphertext: string,
  keyId: string,
): Result.Result<
  { readonly nonce: Uint8Array; readonly sealed: Uint8Array },
  PaymentAccountCustodyError
> => {
  const parts = ciphertext.split(".");

  if (ciphertext.length > 256 || parts.length !== 5 || parts[0] !== "v1" || parts[1] !== keyId)
    return Result.fail(failure("InvalidCiphertext"));

  return Result.flatMap(decodePart(parts[2]!, nonceBytes), (nonce) =>
    Result.flatMap(decodePart(parts[3]!, accountBytes), (encrypted) =>
      Result.map(decodePart(parts[4]!, tagBytes), (tag) => {
        // WebCrypto AES-GCM takes the ciphertext with its tag appended.
        const sealed = new Uint8Array(encrypted.length + tag.length);
        sealed.set(encrypted);
        sealed.set(tag, encrypted.length);

        return { nonce, sealed };
      }),
    ),
  );
};

/**
 * Derives the AES-256-GCM and HMAC-SHA-256 keys from the 32-byte custody key with HKDF-SHA-256
 * (empty salt, one fixed label per purpose) and returns the cipher over them.
 *
 * `subtle` is the WebCrypto provider of the composition root; the module reads no global.
 * The nonce of each encryption is `Crypto.randomBytes(12)` of the platform service.
 */
export const makePaymentAccountCipher = Effect.fn("PaymentAccountCipher.make")(function* (config: {
  readonly subtle: PaymentAccountSubtle;
  readonly keyId: string;
  readonly key: Uint8Array;
}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || config.key.byteLength !== 32)
    return yield* failure("InvalidKey");

  const random = yield* Crypto.Crypto;
  const { subtle, keyId } = config;

  const master = yield* Effect.tryPromise({
    try: () => subtle.importKey("raw", new Uint8Array(config.key), "HKDF", false, ["deriveKey"]),
    catch: () => failure("InvalidKey"),
  });

  const derive = (
    purpose: string,
    algorithm: Parameters<PaymentAccountSubtle["deriveKey"]>[2],
    usages: Parameters<PaymentAccountSubtle["deriveKey"]>[4],
  ) =>
    Effect.tryPromise({
      try: () =>
        subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: encoder.encode(`${label}/${purpose}`),
          },
          master,
          algorithm,
          false,
          usages,
        ),
      catch: () => failure("InvalidKey"),
    });

  const encryptionKey = yield* derive("aead", { name: "AES-GCM", length: 256 }, [
    "encrypt",
    "decrypt",
  ]);

  const commitmentKey = yield* derive(
    "commitment",
    { name: "HMAC", hash: "SHA-256", length: 256 },
    ["sign"],
  );

  const commitment = Effect.fn("PaymentAccountCipher.commitment")(function* (raw: string) {
    const mac = yield* Effect.tryPromise({
      try: () => subtle.sign("HMAC", commitmentKey, encoder.encode(`${keyId}\0${raw}`)),
      catch: () => failure("CryptoFailure"),
    });

    return Hex.encode(new Uint8Array(mac));
  });

  const encrypt = Effect.fn("PaymentAccountCipher.encrypt")(function* (
    raw: string,
    receiptId: string,
  ) {
    const account = yield* Effect.fromResult(normalizedAccount(raw));

    const generated = yield* random
      .randomBytes(nonceBytes)
      .pipe(Effect.mapError(() => failure("CryptoFailure")));

    if (generated.byteLength !== nonceBytes) return yield* failure("CryptoFailure");

    const nonce = new Uint8Array(generated);
    const additionalData = yield* Effect.fromResult(associatedData(receiptId));

    const sealed = new Uint8Array(
      yield* Effect.tryPromise({
        try: () =>
          subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData, tagLength: tagBytes * 8 },
            encryptionKey,
            encoder.encode(account),
          ),
        catch: () => failure("CryptoFailure"),
      }),
    );

    const encrypted = sealed.subarray(0, sealed.length - tagBytes);
    const tag = sealed.subarray(sealed.length - tagBytes);

    return [
      "v1",
      keyId,
      Base64Url.encode(nonce),
      Base64Url.encode(encrypted),
      Base64Url.encode(tag),
    ].join(".");
  });

  const decrypt = Effect.fn("PaymentAccountCipher.decrypt")(function* (
    ciphertext: string,
    receiptId: string,
  ) {
    // Every failure of an opening is one `InvalidCiphertext`: the cause is not a signal to callers.
    const opened = Effect.gen(function* () {
      const { nonce, sealed } = yield* Effect.fromResult(parseCiphertext(ciphertext, keyId));
      const additionalData = yield* Effect.fromResult(associatedData(receiptId));

      const plain = yield* Effect.tryPromise({
        try: () =>
          subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData, tagLength: tagBytes * 8 },
            encryptionKey,
            sealed,
          ),
        catch: () => failure("InvalidCiphertext"),
      });

      return yield* Effect.fromResult(normalizedAccount(decoder.decode(plain)));
    });

    return yield* opened.pipe(Effect.mapError(() => failure("InvalidCiphertext")));
  });

  return { keyId, commitment, encrypt, decrypt } satisfies PaymentAccountCipher;
});

/** Decodes a custody key file `{ keyId, keyBase64 }`; any malformed file is `InvalidKey`. */
export const decodePaymentAccountCipher = Effect.fn("PaymentAccountCipher.decode")(function* (
  subtle: PaymentAccountSubtle,
  input: Schema.Json,
) {
  const file = yield* decodeKeyFile(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => failure("InvalidKey")),
  );

  const key = yield* Effect.fromResult(Base64.decode(file.keyBase64)).pipe(
    Effect.mapError(() => failure("InvalidKey")),
  );

  if (Base64.encode(key) !== file.keyBase64) return yield* failure("InvalidKey");

  return yield* makePaymentAccountCipher({ subtle, keyId: file.keyId, key }).pipe(
    Effect.mapError(() => failure("InvalidKey")),
  );
});
