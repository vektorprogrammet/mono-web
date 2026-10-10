import { Crypto, Effect } from "effect";
import { Hex } from "effect/encoding";

const tokenEncoder = new TextEncoder();

/** The existing wire token: onboard_ followed by lowercase hex of exactly 32 secure bytes. */
export const allocateOnboardingClaimToken: Effect.Effect<string, never, Crypto.Crypto> =
  Crypto.Crypto.use((crypto) => crypto.randomBytes(32)).pipe(
    Effect.map((bytes) => `onboard_${Hex.encode(bytes)}`),
    Effect.orDie,
  );

/** Lowercase SHA-256 hex of the exact UTF-8 token text, not of its decoded random bytes. */
export const onboardingClaimTokenDigest = Effect.fnUntraced(function* (token: string) {
  const crypto = yield* Crypto.Crypto;

  return Hex.encode(yield* crypto.digest("SHA-256", tokenEncoder.encode(token)).pipe(Effect.orDie));
});
