import { assert, layer } from "@effect/vitest";
import { Crypto, Effect } from "effect";
import { allocateOnboardingClaimToken, onboardingClaimTokenDigest } from "./claim-token.js";
import { TestPlatform } from "../test/platform.js";

const expectedToken = "onboard_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

// Independent pre-cutover oracle: SHA-256 of the exact UTF-8 token text, computed with sha256sum.
const expectedDigest = "e4bc46661b4983ca2b6c1c8a1b14fcb833344205170a76c97a75fcc8d6d50a17";

layer(TestPlatform, { excludeTestServices: true })("onboarding claim token protocol", (it) => {
  it.effect("keeps 32-byte entropy, lowercase hex, prefix and the exact stored string digest", () =>
    Effect.gen(function* () {
      const platform = yield* Crypto.Crypto;
      const draws: Array<number> = [];

      const crypto = Crypto.make({
        randomBytes: (size) => {
          draws.push(size);

          return Uint8Array.from({ length: size }, (_, index) => index);
        },
        digest: (algorithm, bytes) => platform.digest(algorithm, bytes),
      });

      const token = yield* allocateOnboardingClaimToken.pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );

      assert.deepStrictEqual(draws, [32]);
      assert.strictEqual(token, expectedToken);
      assert.match(token, /^onboard_[0-9a-f]{64}$/u);
      assert.strictEqual(token.length, 72);
      assert.strictEqual(yield* onboardingClaimTokenDigest(token), expectedDigest);
    }),
  );
});
