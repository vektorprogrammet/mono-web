/**
 * Identifier and capability allocation over the platform `Crypto` service.
 *
 * Each allocation is an Effect that requires `Crypto.Crypto`: the entropy comes from the service
 * that the composition root provides, never from an ambient import. Every run draws fresh bytes,
 * so a retried transaction body that yields an allocation again gets a new value. A platform
 * entropy failure has no caller-side recovery, so it is a defect, as at every other `Crypto`
 * call site of this application.
 */
import { Crypto, Effect } from "effect";
import { Base64Url } from "effect/encoding";

const allocateUuid: Effect.Effect<string, never, Crypto.Crypto> = Crypto.Crypto.use(
  (crypto) => crypto.randomUUIDv4,
).pipe(Effect.orDie);

/** `<prefix>_<uuid>` with a fresh UUIDv4, the form of every allocated entity identifier. */
export const allocatePrefixedUuid = Effect.fnUntraced(function* (prefix: string) {
  return `${prefix}_${yield* allocateUuid}`;
});

/** `byteLength` secure random bytes as an unpadded base64url token: 43 characters for 32 bytes. */
export const allocateBase64UrlToken = Effect.fnUntraced(function* (byteLength: number) {
  const bytes = yield* Crypto.Crypto.use((crypto) => crypto.randomBytes(byteLength)).pipe(
    Effect.orDie,
  );

  return Base64Url.encode(bytes);
});
