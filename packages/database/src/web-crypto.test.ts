import { assert, layer } from "@effect/vitest";
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, type Layer } from "effect";
import { vi } from "vitest";
import { verifiedSessionToken } from "./auth-live.js";
import { makeOAuthWebCrypto, OAuthExchangeFailure } from "./oauth-live.js";
import { TestPlatform } from "./test-support/platform.js";
import {
  HmacTagVerifier,
  HmacTagVerifierLive,
  SecretEquality,
  SecretEqualityLive,
  type WebCryptoSubtle,
} from "./web-crypto.js";

/*
 * Known answers of the node:crypto implementations that the injected WebCrypto verifiers replaced:
 * `createHmac` plus `timingSafeEqual` for the Better Auth session cookie, `timingSafeEqual` over
 * UTF-8 bytes for the stored OAuth digests, and `webcrypto.subtle.verify` for the ES256 JWT. The
 * pre-migration code of commit 444db897 produced every expectation below; the keys, secrets, and
 * tokens are synthetic fixtures.
 */
const cookieSecret = "kat-cookie-secret-0123456789abcdef0123456789";

const cookieToken = "kat-session-token-AbCdEf0123456789";

const cookieSignature = "dnw0N1mS%2BGUA%2FNDE0XYpnfwo3uUdtgxEvKTkcXLguh0%3D";

const cookieName = "better-auth.session_token";

const acceptedCookies = {
  valid: `${cookieName}=${cookieToken}.${cookieSignature}`,
  validSecure: `__Secure-${cookieName}=${cookieToken}.${cookieSignature}`,
  // The decoded tag is the base64 prefix up to the first padding, as `Buffer.from(_, "base64")`
  // reads it; the previous verifier accepted this cookie and so does the current one.
  trailingDataAfterPadding: `${cookieName}=${cookieToken}.${cookieSignature}${cookieSignature}`,
};

const rejectedCookies = {
  tamperedToken: `${cookieName}=${cookieToken}x.${cookieSignature}`,
  tamperedSignature: `${cookieName}=${cookieToken}.dnw0N1mS%2BGUA%2FNDE0XYpnfwo3uUdtgxEvKTkcXLguAAA`,
  oneBitDifferentSignature: `${cookieName}=${cookieToken}.d3w0N1mS%2BGUA%2FNDE0XYpnfwo3uUdtgxEvKTkcXLguh0%3D`,
  truncatedSignature: `${cookieName}=${cookieToken}.dnw0N1mS%2BGUA%2FNDE0XYp`,
  emptySignature: `${cookieName}=${cookieToken}.`,
  unsigned: `${cookieName}=${cookieToken}`,
  signedUnderAnotherSecret: `${cookieName}=${cookieToken}.%2BX3z9WfePsHbTHSk5Lx3Wk7N6sGqZfLgzp0POrsb9w4%3D`,
};

const digest = "abcDEF-_0123456789abcdefghijklmnopqrstuvwxyzABCD";

const jwtPublicKey =
  '{"crv":"P-256","ext":true,"key_ops":["verify"],"kty":"EC","x":"quGeCw1f3TmxxG0hZQVKxhFbtdPCNjcvz0YqKan1-1w","y":"A1GvoSRX-1KzjO4pbwHHOrxWKm1GV1NnCZ78eMoBAl4"}';

const otherJwtPublicKey =
  '{"kty":"EC","crv":"P-256","x":"pifkMXVD1vHe3po5Q2z-Zc6QbRPu7qugS2VTwUB3j5M","y":"-pr5JrOz3iGVZvAc38TQXCSMFmh7LqN1_BsLfH90WEU"}';

const signingInput =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImthdC1rZXkifQ.eyJpc3MiOiJrYXQiLCJzdWIiOiJwIiwianRpIjoiaiJ9";

const jwtSignature =
  "-oNMm9FOrgPme-4DqC2om0Ee5KEl3YUqDtXUPwpRdE4Xqc3hZma_8JucLxZ2cI5J5HsB6U1uuEqxlE4m6RDknw";

const jwtSignatureWithOneBitFlipped =
  "-oNMm9FPrgPme-4DqC2om0Ee5KEl3YUqDtXUPwpRdE4Xqc3hZma_8JucLxZ2cI5J5HsB6U1uuEqxlE4m6RDknw";

const encoder = new TextEncoder();

const signed = (input: string, signature: string) => ({
  signingInput: encoder.encode(input),
  signature: Buffer.from(signature, "base64url"),
});

const realSubtle = globalThis.crypto.subtle;

/** WebCrypto whose named operations are replaced; the others stay the real, bound ones. */
const withSubtle = (replaced: Partial<WebCryptoSubtle>): WebCryptoSubtle => ({
  importKey: realSubtle.importKey.bind(realSubtle),
  sign: realSubtle.sign.bind(realSubtle),
  verify: realSubtle.verify.bind(realSubtle),
  ...replaced,
});

/** The real, bound operations behind spies, so a test reads the arguments and results of each call. */
const spiedSubtle = () => {
  const subtle = withSubtle({});

  return {
    subtle,
    importKey: vi.spyOn(subtle, "importKey"),
    sign: vi.spyOn(subtle, "sign"),
    verify: vi.spyOn(subtle, "verify"),
  };
};

const rejected = () => Promise.reject(new Error("platform failure"));

/** A provider whose `verify` starts, signals `started`, and never settles. */
const hangingVerify = (started: Deferred.Deferred<void>): Partial<WebCryptoSubtle> => ({
  verify: () => {
    Deferred.doneUnsafe(started, Effect.void);

    return Promise.withResolvers<boolean>().promise;
  },
});

const isDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause);

const isInterrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);

const cookieVerifier = (subtle: WebCryptoSubtle, secret = cookieSecret) =>
  HmacTagVerifierLive(subtle, secret);

const verifiedWith = (layerOfVerifier: Layer.Layer<HmacTagVerifier>, header: string | undefined) =>
  Effect.gen(function* () {
    const hmac = yield* HmacTagVerifier;

    return yield* verifiedSessionToken(hmac, header);
  }).pipe(Effect.provide(layerOfVerifier));

layer(TestPlatform, { excludeTestServices: true })("identity WebCrypto verifiers", (it) => {
  it.effect("accepts the signed cookies that the node:crypto verifier accepted", () =>
    Effect.gen(function* () {
      for (const header of Object.values(acceptedCookies)) {
        assert.strictEqual(yield* verifiedWith(cookieVerifier(realSubtle), header), cookieToken);
      }
    }),
  );

  it.effect("rejects tampered, truncated, unsigned, and foreign-secret cookies", () =>
    Effect.gen(function* () {
      for (const header of Object.values(rejectedCookies)) {
        assert.strictEqual(yield* verifiedWith(cookieVerifier(realSubtle), header), null);
      }

      assert.strictEqual(yield* verifiedWith(cookieVerifier(realSubtle), undefined), null);
    }),
  );

  it.effect("rejects a genuine cookie under a different engine secret", () =>
    Effect.gen(function* () {
      const rotated = cookieVerifier(realSubtle, `${cookieSecret}-rotated`);

      assert.strictEqual(yield* verifiedWith(rotated, acceptedCookies.valid), null);
    }),
  );

  it.effect("compares the cookie tag through subtle.verify, never in JavaScript", () =>
    Effect.gen(function* () {
      const spied = spiedSubtle();

      assert.strictEqual(
        yield* verifiedWith(cookieVerifier(spied.subtle), acceptedCookies.valid),
        cookieToken,
      );
      assert.strictEqual(
        yield* verifiedWith(cookieVerifier(spied.subtle), rejectedCookies.oneBitDifferentSignature),
        null,
      );
      assert.deepStrictEqual(
        spied.verify.mock.calls.map((call) => call[0]),
        ["HMAC", "HMAC"],
      );
    }),
  );

  it.effect("wipes the encoded secret once the key is imported", () =>
    Effect.gen(function* () {
      const spied = spiedSubtle();

      yield* verifiedWith(cookieVerifier(spied.subtle), undefined);

      const imported = spied.importKey.mock.calls.map((call) => call[1]);

      assert.strictEqual(imported.length, 1);

      const [secretBytes] = imported;

      assert.instanceOf(secretBytes, Uint8Array);
      assert.isTrue(secretBytes.every((byte) => byte === 0));
    }),
  );

  it.effect("fails with a defect, not a rejection, when key import is refused", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        verifiedWith(cookieVerifier(withSubtle({ importKey: rejected })), acceptedCookies.valid),
      );

      assert.isTrue(isDefect(exit));
    }),
  );

  it.effect("fails with a defect, never accepts, when verification itself fails", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        verifiedWith(cookieVerifier(withSubtle({ verify: rejected })), acceptedCookies.valid),
      );

      assert.isTrue(isDefect(exit));
    }),
  );

  it.effect("stops waiting for verification when interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const fiber = yield* Effect.forkChild(
        verifiedWith(cookieVerifier(withSubtle(hangingVerify(started))), acceptedCookies.valid),
      );

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(isInterrupted(yield* Fiber.await(fiber)));
    }),
  );

  it.effect("accepts the ES256 signature that the node:crypto verifier accepted", () =>
    Effect.gen(function* () {
      const webCrypto = yield* makeOAuthWebCrypto(realSubtle);

      assert.isTrue(
        yield* webCrypto.verifyJwtSignature(signed(signingInput, jwtSignature), jwtPublicKey),
      );
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("rejects a tampered signature, signing input, key, and truncated signature", () =>
    Effect.gen(function* () {
      const webCrypto = yield* makeOAuthWebCrypto(realSubtle);

      const verdicts = yield* Effect.all([
        webCrypto.verifyJwtSignature(
          signed(signingInput, jwtSignatureWithOneBitFlipped),
          jwtPublicKey,
        ),
        webCrypto.verifyJwtSignature(signed(`${signingInput}x`, jwtSignature), jwtPublicKey),
        webCrypto.verifyJwtSignature(signed(signingInput, jwtSignature), otherJwtPublicKey),
        webCrypto.verifyJwtSignature(signed(signingInput, jwtSignature.slice(0, 84)), jwtPublicKey),
      ]);

      assert.deepStrictEqual(verdicts, [false, false, false, false]);
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("fails with the typed exchange failure for a key it cannot import", () =>
    Effect.gen(function* () {
      const webCrypto = yield* makeOAuthWebCrypto(realSubtle);

      const offCurve = otherJwtPublicKey.replace("pifk", "aifk");

      const failure = yield* Effect.flip(
        webCrypto.verifyJwtSignature(signed(signingInput, jwtSignature), offCurve),
      );

      assert.instanceOf(failure, OAuthExchangeFailure);
      assert.strictEqual(failure.message, "signing key is unusable");
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("fails with a typed decode failure for key text that is not a JWK object", () =>
    Effect.gen(function* () {
      const webCrypto = yield* makeOAuthWebCrypto(realSubtle);

      const failure = yield* Effect.flip(
        webCrypto.verifyJwtSignature(signed(signingInput, jwtSignature), "not json"),
      );

      assert.strictEqual(failure._tag, "SchemaError");
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("keeps the verdicts of the node:crypto digest comparison", () =>
    Effect.gen(function* () {
      const { digestsEqual } = yield* makeOAuthWebCrypto(realSubtle);

      const table: ReadonlyArray<readonly [string, string, boolean]> = [
        [digest, digest, true],
        [digest, `${digest.slice(0, -1)}E`, false],
        [digest, digest.slice(0, -1), false],
        [digest, `${digest}A`, false],
        [digest, "", false],
        ["", digest, false],
        ["", "", true],
        ["æøå", "æøå", true],
        ["æøå", "æøa", false],
      ];

      for (const [expected, presented, verdict] of table) {
        assert.strictEqual(yield* digestsEqual(expected, presented), verdict);
      }
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("rejects every one-character change of a digest", () =>
    Effect.gen(function* () {
      const { equal } = yield* SecretEquality;

      for (let index = 0; index < digest.length; index += 1) {
        const changed = `${digest.slice(0, index)}${digest[index] === "A" ? "B" : "A"}${digest.slice(index + 1)}`;

        assert.isFalse(yield* equal(digest, changed));
      }
    }).pipe(Effect.provide(SecretEqualityLive(realSubtle))),
  );

  it.effect("compares through subtle.sign and subtle.verify under one key per layer", () =>
    Effect.gen(function* () {
      const spied = spiedSubtle();
      const first = yield* SecretEquality.pipe(Effect.provide(SecretEqualityLive(spied.subtle)));
      const second = yield* SecretEquality.pipe(Effect.provide(SecretEqualityLive(spied.subtle)));

      assert.isTrue(yield* first.equal("secret", "secret"));
      assert.isTrue(yield* first.equal("secret", "secret"));
      assert.isTrue(yield* second.equal("secret", "secret"));
      assert.isFalse(yield* second.equal("secret", "Secret"));
      assert.strictEqual(spied.verify.mock.calls.length, 4);

      const [firstTag, firstAgain, secondTag] = yield* Effect.promise(() =>
        Promise.all(spied.sign.mock.results.map((result) => result.value)),
      );

      assert.deepStrictEqual(new Uint8Array(firstTag), new Uint8Array(firstAgain));
      assert.notDeepEqual(new Uint8Array(firstTag), new Uint8Array(secondTag));
    }),
  );

  it.effect("draws its key from the Crypto service and wipes it after the import", () =>
    Effect.gen(function* () {
      const drawn: Uint8Array[] = [];

      const recorded = Crypto.make({
        randomBytes: (size) => {
          const bytes = new Uint8Array(size).fill(0x5a);

          drawn.push(bytes);

          return bytes;
        },
        digest: () => Effect.die("The verifiers compute no digest."),
      });

      yield* SecretEquality.pipe(
        Effect.provide(SecretEqualityLive(realSubtle)),
        Effect.provideService(Crypto.Crypto, recorded),
      );

      assert.deepStrictEqual(
        drawn.map((bytes) => bytes.length),
        [32],
      );
      assert.isTrue(drawn[0]!.every((byte) => byte === 0));
    }),
  );

  it.effect("fails with a defect, never equal, when signing or verification fails", () =>
    Effect.gen(function* () {
      const signing = yield* SecretEquality.pipe(
        Effect.provide(SecretEqualityLive(withSubtle({ sign: rejected }))),
      );

      const verifying = yield* SecretEquality.pipe(
        Effect.provide(SecretEqualityLive(withSubtle({ verify: rejected }))),
      );

      assert.isTrue(isDefect(yield* Effect.exit(signing.equal("a", "a"))));
      assert.isTrue(isDefect(yield* Effect.exit(verifying.equal("a", "a"))));
    }),
  );

  it.effect("fails with a defect when the key cannot be imported", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        SecretEquality.pipe(
          Effect.provide(SecretEqualityLive(withSubtle({ importKey: rejected }))),
        ),
      );

      assert.isTrue(isDefect(exit));
    }),
  );

  it.effect("stops waiting for a pending comparison when interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const secretEquality = yield* SecretEquality.pipe(
        Effect.provide(SecretEqualityLive(withSubtle(hangingVerify(started)))),
      );

      const fiber = yield* Effect.forkChild(secretEquality.equal("a", "a"));

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(isInterrupted(yield* Fiber.await(fiber)));
    }),
  );
});
