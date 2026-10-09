import { assert, layer } from "@effect/vitest";
import type { OAuthOptions, Scope, StoreTokenType } from "@better-auth/oauth-provider";
import { Cause, Crypto, Deferred, Effect, Exit, FiberSet, PlatformError, Predicate } from "effect";
import {
  hashOAuthClientSecret,
  hashOAuthToken,
  makeOAuthOptions,
  OAUTH_NATIVE_API_RESOURCE,
  sha256Base64Url,
  type OAuthCallbackRunner,
} from "./oauth-config.js";
import { TestPlatform } from "./test-support/platform.js";

/*
 * Known answers of `sha256Base64Url` as it was before the Crypto migration (commit 5e2ce43a), which
 * hashed `node:crypto` `createHash("sha256")` over `domain`, one NUL byte, and `value`, each in
 * UTF-8. A run of that file produced every digest below from synthetic inputs.
 */
const inputs = {
  empty: "",
  ascii: "synthetic-token-0123456789",
  nonAscii: "synthetic-\u00e6\u00f8\u00e5-\u65e5\u672c\u8a9e-\u{1f642}",
  embeddedNul: "synthetic\0nul",
  // The UTF-8 encoder replaces a lone surrogate with U+FFFD, as `createHash` did.
  loneSurrogate: "synthetic-\ud800-lone",
  long: "x".repeat(10_000),
} as const;

type InputName = keyof typeof inputs;

type DigestKind = "secret" | StoreTokenType;

const knownAnswers: ReadonlyArray<readonly [DigestKind, InputName, string]> = [
  ["secret", "empty", "XV5x0QGRPvxW0yA-Xa1wqmwrctDLhyLdv6j5pTOzM_U"],
  ["access_token", "empty", "lEO6BYQ8FDA22BWKmbfYYrBfQfhdOV3SCiyT1HGO-gg"],
  ["refresh_token", "empty", "GOgk2NTUM6O_CCfczPWM77zRotwkVV8GGbGHXPKt2XI"],
  ["authorization_code", "empty", "ADUKuYJc9CM7OIrl8CdVUA3lGJGUjaQuMToCpBkawLw"],
  ["secret", "ascii", "FFX4QZYw3LgrVVyEr0G_OUo6viBoTRqtZjF85DjVV6E"],
  ["access_token", "ascii", "DZgKXTo2gQApPc_NU1kf6zV-L4bs6MpL1i7COQLAqeo"],
  ["refresh_token", "ascii", "ydkHB9qvofpMdECRcTWokFqPu2pxtqj8rTeg4FGfoYg"],
  ["authorization_code", "ascii", "tu2DywiPc28mUhSMbq8JmFw1lzNraGMLI4b6ojvQJ5Q"],
  ["secret", "nonAscii", "VUF9IesCX_oX-cfWgFk3VCVvzwEeyLwSqS_Bv77aJnc"],
  ["access_token", "nonAscii", "HEgVBYxM58OIl3yShdUAgcHXR5jdU3MqbQyiHCb5Y5c"],
  ["refresh_token", "nonAscii", "7C7IZJVPx65eBx432SW1edx65VjSmKSOs-qKAXdVqqo"],
  ["authorization_code", "nonAscii", "W84vxell7Jhl35skreQSGKT_4tuin1v-WlRMnw5TW7Y"],
  ["secret", "embeddedNul", "aCok3qOVWQxHCNWW0k2x5iqkVaaIZ1d9vIUF6_J5A0Y"],
  ["access_token", "embeddedNul", "7ezK05B1kUC8CLQXZi3Xin0Q8QupoGr3ce-yqJhu6n0"],
  ["refresh_token", "embeddedNul", "RP2vIbJ-YAv5WV70XMYI_i-zSAF8v1eg_3ySiMHgZVU"],
  ["authorization_code", "embeddedNul", "sK8ddWZ-MpvtJ4aVVE7d22EQpB3rCzNlHshVJRafboc"],
  ["secret", "loneSurrogate", "yDHofMm217hW8ItQJwAhqd9mjjdQCxINHzHp_M5xz2M"],
  ["access_token", "loneSurrogate", "43i5j4Pyt_2KpJRsgh7g8lMpu-x21K7bvu7XFhwnqqg"],
  ["refresh_token", "loneSurrogate", "xvIO5b3iKw0HZI0G21Sm9uF_GnRxnByse4z7B1U4EzM"],
  ["authorization_code", "loneSurrogate", "IYc5EfWTWnU_8xixNaYcfNv4Sh02rk50TmtYfruh89U"],
  ["secret", "long", "Q5xZ1FGjzA-iPrpWINol5q05EWHWX_yY0xxWhLu0hJA"],
  ["access_token", "long", "4lbdYcpWTQBKKwF5qCMvWZAdcv10CBBSSkr5qGjOlWo"],
  ["refresh_token", "long", "dRLDQ3XmSVcs_DFRvXzWkdXN1rvc8hEM9NfpVg676FQ"],
  ["authorization_code", "long", "uqqNmCWDhBbw3FvO1XYHXY02g828lZ0m7PPDkTw3s20"],
];

const domainAnswers: ReadonlyArray<readonly [string, string]> = [
  ["", "IuWGbP5WfocjlQnQ0l1TLhOP1jWpXyaciqGwS20h7PI"],
  ["dömäin-日本", "Ou7i4EOnDqMttyqhxzN0S0vjq4uAjnIljHx9H-yC6m4"],
];

const hashOf = (kind: DigestKind, value: string) =>
  kind === "secret" ? hashOAuthClientSecret(value) : hashOAuthToken(value, kind);

const isDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause);

const oauth = {
  canonicalOrigin: "http://127.0.0.1:4173",
  dashboardOrigin: "http://127.0.0.1:4173",
  nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
} as const;

/** The `Crypto` of the platform with its digest replaced. */
const withDigest = (digest: Crypto.Crypto["digest"]) =>
  Effect.gen(function* () {
    const platform = yield* Crypto.Crypto;

    return Crypto.Crypto.of({ ...platform, digest });
  });

const failingDigest: Crypto.Crypto["digest"] = () =>
  Effect.fail(PlatformError.badArgument({ module: "Crypto", method: "digest" }));

/** The plugin callbacks of `options`, which the plugin awaits as `Awaitable<string>`. */
const pluginCallbacks = (options: OAuthOptions<Scope[]>) => {
  const { storeClientSecret, storeTokens } = options;

  return Predicate.isObject(storeClientSecret) &&
    "hash" in storeClientSecret &&
    Predicate.isObject(storeTokens)
    ? Effect.succeed({ secret: storeClientSecret.hash, token: storeTokens.hash })
    : Effect.die("the options store hashes through callbacks");
};

layer(TestPlatform, { excludeTestServices: true })("OAuth digests on the Crypto service", (it) => {
  it.effect("matches the digests of the node:crypto implementation over every input", () =>
    Effect.gen(function* () {
      for (const [kind, input, expected] of knownAnswers) {
        assert.strictEqual(yield* hashOf(kind, inputs[input]), expected, `${kind}/${input}`);
      }

      for (const [domain, expected] of domainAnswers) {
        assert.strictEqual(yield* sha256Base64Url(domain, inputs.ascii), expected, domain);
      }
    }),
  );

  it.effect("keeps one value apart across the four digest domains", () =>
    Effect.gen(function* () {
      const kinds: ReadonlyArray<DigestKind> = [
        "secret",
        "access_token",
        "refresh_token",
        "authorization_code",
      ];

      const digests = yield* Effect.forEach(kinds, (kind) => hashOf(kind, inputs.ascii));

      assert.strictEqual(new Set(digests).size, 4);
    }),
  );

  it.effect("treats a failed digest as a defect, never a hash", () =>
    Effect.gen(function* () {
      const crypto = yield* withDigest(failingDigest);

      const exit = yield* hashOAuthToken(inputs.ascii, "access_token").pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.exit,
      );

      assert.isTrue(isDefect(exit));
    }),
  );

  it.effect("serves the awaited plugin callbacks with the same digests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run: OAuthCallbackRunner = yield* FiberSet.makeRuntimePromise<Crypto.Crypto>();
        const callbacks = yield* pluginCallbacks(makeOAuthOptions(oauth, run));

        for (const [kind, input, expected] of knownAnswers) {
          const stored = yield* Effect.promise(() =>
            Promise.resolve(
              kind === "secret"
                ? callbacks.secret(inputs[input])
                : callbacks.token(inputs[input], kind),
            ),
          );

          assert.strictEqual(stored, expected, `${kind}/${input}`);
        }
      }),
    ),
  );

  it.effect("rejects the plugin callback when the digest fails, so no value is stored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = yield* withDigest(failingDigest);

        const run: OAuthCallbackRunner = yield* FiberSet.makeRuntimePromise<Crypto.Crypto>().pipe(
          Effect.provideService(Crypto.Crypto, failing),
        );

        const callbacks = yield* pluginCallbacks(makeOAuthOptions(oauth, run));

        for (const callback of [
          () => callbacks.secret(inputs.ascii),
          () => callbacks.token(inputs.ascii, "refresh_token"),
        ]) {
          const exit = yield* Effect.exit(Effect.tryPromise(() => Promise.resolve(callback())));

          assert.isTrue(Exit.isFailure(exit));
        }
      }),
    ),
  );

  it.effect("rejects a plugin callback that the closing runner scope interrupts", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const hanging = yield* withDigest(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );

      const outcome = yield* Deferred.make<Exit.Exit<string, unknown>>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const run: OAuthCallbackRunner = yield* FiberSet.makeRuntimePromise<Crypto.Crypto>();
          const callbacks = yield* pluginCallbacks(makeOAuthOptions(oauth, run));

          yield* Effect.forkChild(
            Effect.exit(
              Effect.tryPromise(() =>
                Promise.resolve(callbacks.token(inputs.ascii, "access_token")),
              ),
            ).pipe(Effect.flatMap((exit) => Deferred.succeed(outcome, exit))),
            { startImmediately: true },
          );

          yield* Deferred.await(started);
        }),
      ).pipe(Effect.provideService(Crypto.Crypto, hanging));

      // Closing the scope interrupted the digest; the callback never answers with a hash.
      assert.isTrue(Exit.isFailure(yield* Deferred.await(outcome)));
    }),
  );
});
