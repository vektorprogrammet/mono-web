import { Context, Crypto, Data, Effect, Layer } from "effect";

/**
 * The WebCrypto operations of the identity modules. A composition root injects the provider; the
 * modules of this package read no global.
 */
export type WebCryptoSubtle = Pick<
  typeof globalThis.crypto.subtle,
  "importKey" | "sign" | "verify"
>;

/** A WebCrypto operation failed, which valid HMAC inputs never cause: a defect, never an answer. */
export class WebCryptoFailure extends Data.TaggedError("WebCryptoFailure")<{
  readonly operation: "importKey" | "sign" | "verify";
}> {}

const encoder = new TextEncoder();

const hmac = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Verifies HMAC-SHA-256 tags that another party issued under one shared secret, such as the signed
 * session cookie of Better Auth.
 *
 * A context holds one such secret; `verify` requires nothing.
 */
export class HmacTagVerifier extends Context.Service<
  HmacTagVerifier,
  {
    /**
     * Whether `tag` is the HMAC-SHA-256 of `message` under the secret. The comparison is the
     * constant-time comparison of `subtle.verify`; a tag of any other length answers `false`.
     * A WebCrypto failure is a defect, never an answer.
     */
    readonly verify: (message: Uint8Array, tag: Uint8Array) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/database/HmacTagVerifier") {}

/**
 * Imports `secret` once as a non-extractable verification key of `subtle`, the provider of the
 * composition root, and zeroes the encoded secret afterwards. A failed import is a defect.
 */
export const HmacTagVerifierLive = (subtle: WebCryptoSubtle, secret: string) =>
  Layer.effect(
    HmacTagVerifier,
    Effect.gen(function* () {
      const secretBytes = encoder.encode(secret);

      const key = yield* Effect.tryPromise({
        try: () => subtle.importKey("raw", secretBytes, hmac, false, ["verify"]),
        catch: () => new WebCryptoFailure({ operation: "importKey" }),
      }).pipe(Effect.ensuring(Effect.sync(() => secretBytes.fill(0))), Effect.orDie);

      return HmacTagVerifier.of({
        verify: (message, tag) =>
          Effect.tryPromise({
            try: () => subtle.verify("HMAC", key, tag, message),
            catch: () => new WebCryptoFailure({ operation: "verify" }),
          }).pipe(Effect.orDie),
      });
    }),
  );

/**
 * Compares two raw secrets for equality without a timing channel, where the expected one is read
 * per request.
 */
export class SecretEquality extends Context.Service<
  SecretEquality,
  {
    /**
     * Whether `presented` equals `expected`. It signs `expected` under the per-process key and
     * verifies `presented` against that tag with `subtle.verify`, so the constant-time comparison
     * covers MACs that an observer cannot predict, and a presented value of any length answers
     * `false` without a length shortcut. A WebCrypto failure is a defect, never an answer.
     */
    readonly equal: (expected: string, presented: string) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/database/SecretEquality") {}

/**
 * Supplies constant-time comparison of raw secrets under one process-owned HMAC key.
 * @remarks Draws a random 256-bit key from Crypto, imports it as non-extractable, and
 * zeroes temporary bytes on success, failure, and interruption. The key never leaves the layer.
 * Signing the expected value and verifying the presented value has no length shortcut.
 * @sideEffects Draws random bytes and imports a WebCrypto key at layer construction; each
 * comparison signs and verifies through the injected provider. Provider failures are defects.
 * @example
 * ```ts
 * SecretEqualityLive(subtle).pipe(Layer.provide(platform));
 * ```
 * @avoid Comparing raw secrets with a plain equality, digest equality, or a length shortcut.
 * @construct digest
 */
export const SecretEqualityLive = (
  subtle: WebCryptoSubtle,
): Layer.Layer<SecretEquality, never, Crypto.Crypto> =>
  Layer.effect(
    SecretEquality,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const keyBytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);

      const key = yield* Effect.tryPromise({
        try: () => subtle.importKey("raw", keyBytes, hmac, false, ["sign", "verify"]),
        catch: () => new WebCryptoFailure({ operation: "importKey" }),
      }).pipe(Effect.ensuring(Effect.sync(() => keyBytes.fill(0))), Effect.orDie);

      return SecretEquality.of({
        equal: (expected, presented) =>
          Effect.gen(function* () {
            const expectedTag = yield* Effect.tryPromise({
              try: () => subtle.sign("HMAC", key, encoder.encode(expected)),
              catch: () => new WebCryptoFailure({ operation: "sign" }),
            });

            return yield* Effect.tryPromise({
              try: () => subtle.verify("HMAC", key, expectedTag, encoder.encode(presented)),
              catch: () => new WebCryptoFailure({ operation: "verify" }),
            });
          }).pipe(Effect.orDie),
      });
    }),
  );
