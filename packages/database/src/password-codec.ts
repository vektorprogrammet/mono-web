import { argon2idAsync } from "@noble/hashes/argon2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";
import { Data, Effect, Option, Predicate, Semaphore } from "effect";

const argonPrefix = "$argon2id$v=19$m=19456,t=2,p=1$";

const argonOptions = {
  version: 19,
  m: 19_456,
  t: 2,
  p: 1,
  dkLen: 32,
  maxmem: 19_456 * 1024,
  asyncTick: 10,
};

export class PasswordHashCapacityError extends Data.TaggedError("PasswordHashCapacityError") {
  override get message(): string {
    return "Password hashing capacity exceeded";
  }
}

/** Resource ceiling, measured before normalization or UTF-8 allocation. */
const maxPasswordCodeUnits = 4096;

export class PasswordInputTooLongError extends Data.TaggedError("PasswordInputTooLongError") {
  override get message(): string {
    return "Password exceeds the input limit";
  }
}

// One memory-hard operation per isolate, including legacy scrypt (32 MiB).
// Bound waiting requests too; overload must not retain an unbounded password queue.
const hashing = Semaphore.makeUnsafe(1);

/** The running operation and at most eight waiting ones. */
const admission = Semaphore.makeUnsafe(9);

export const withPasswordHashCapacity = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  admission
    .withPermitsIfAvailable(1)(hashing.withPermit(run))
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new PasswordHashCapacityError()),
          onSome: Effect.succeed,
        }),
      ),
    );

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/u, "");

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/** Only the frozen PHP PASSWORD_BCRYPT cost-12 format, including canonical padding bits. */
export const isSupportedLegacyPasswordHash = (value: unknown): value is string =>
  Predicate.isString(value) &&
  /^\$2y\$12\$[./A-Za-z0-9]{21}[.Oeu][./A-Za-z0-9]{30}[.CGKOSWaeimquy26]$/u.test(value);

/** Better Auth 1.7.1 / @better-auth/utils 0.4.2: ASCII-hex salt and 64-byte key. */
const isScryptPasswordHash = (value: string): boolean =>
  /^[a-f0-9]{32}:[a-f0-9]{128}$/u.test(value);

/** Current native policy. Reject other PHC versions, costs, lengths and noncanonical encodings. */
export const isNativePasswordHash = (value: unknown): value is string =>
  Predicate.isString(value) &&
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{21}[AQgw]\$[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/u.test(
    value,
  );

/** Derives a key with `derive`, reads it with `use`, and zeroes it afterwards. */
const withDerivedKey = <A>(derive: () => Promise<Uint8Array>, use: (key: Uint8Array) => A) =>
  Effect.acquireUseRelease(
    Effect.promise(derive),
    (key) => Effect.sync(() => use(key)),
    (key) => Effect.sync(() => key.fill(0)),
  );

export const nativePasswordHash = (password: string) =>
  Effect.gen(function* () {
    if (password.length > maxPasswordCodeUnits) return yield* new PasswordInputTooLongError();
    const salt = crypto.getRandomValues(new Uint8Array(16));

    return yield* withPasswordHashCapacity(
      withDerivedKey(
        () => argon2idAsync(password.normalize("NFKC"), salt, argonOptions),
        (key) => `${argonPrefix}${base64(salt)}$${base64(key)}`,
      ),
    );
  });

export const verifyNativeOrLegacyPassword = ({
  hash,
  password,
}: {
  hash: string;
  password: string;
}) =>
  Effect.gen(function* () {
    if (password.length > maxPasswordCodeUnits) return yield* new PasswordInputTooLongError();
    const native = Boolean(isNativePasswordHash(hash));
    const scrypt = isScryptPasswordHash(hash);
    const legacy = Boolean(isSupportedLegacyPasswordHash(hash));

    if ((!native && !scrypt && !legacy) || (legacy && password.includes("\0"))) return false;

    return yield* withPasswordHashCapacity(
      legacy
        ? // bcryptjs consumes exactly the first 72 UTF-8 bytes, including split code points.
          // Do not decode a truncated byte array, prehash, or normalize the submitted password.
          Effect.promise(() => compare(password, hash))
        : withDerivedKey(
            () =>
              native
                ? argon2idAsync(
                    password.normalize("NFKC"),
                    decodeBase64(hash.split("$")[4]!),
                    argonOptions,
                  )
                : scryptAsync(password.normalize("NFKC"), hash.slice(0, 32), {
                    N: 16_384,
                    r: 16,
                    p: 1,
                    dkLen: 64,
                    maxmem: 64 * 1024 * 1024,
                    asyncTick: 10,
                  }),
            (key) =>
              timingSafeEqual(
                key,
                native ? decodeBase64(hash.split("$")[5]!) : hexToBytes(hash.slice(33)),
              ),
          ),
    );
  });
