import { argon2idAsync } from "@noble/hashes/argon2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";

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

export class PasswordHashCapacityError extends Error {
  constructor() {
    super("Password hashing capacity exceeded");
    this.name = "PasswordHashCapacityError";
  }
}

/** Resource ceiling, measured before normalization or UTF-8 allocation. */
const maxPasswordCodeUnits = 4096;
export class PasswordInputTooLongError extends Error {
  constructor() {
    super("Password exceeds the input limit");
    this.name = "PasswordInputTooLongError";
  }
}

// One memory-hard operation per isolate, including legacy scrypt (32 MiB).
// Bound waiting requests too; overload must not retain an unbounded password queue.
let active = false;
const waiting: Array<() => void> = [];
const boundedHash = async <A>(run: () => Promise<A>): Promise<A> => {
  if (active) {
    if (waiting.length >= 8) throw new PasswordHashCapacityError();
    const admission = Promise.withResolvers<void>();
    waiting.push(admission.resolve);
    await admission.promise;
  } else active = true;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active = false;
  }
};

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/u, "");
const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/** Only the frozen PHP PASSWORD_BCRYPT cost-12 format, including canonical padding bits. */
export const isSupportedLegacyPasswordHash = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\$2y\$12\$[./A-Za-z0-9]{21}[.Oeu][./A-Za-z0-9]{30}[.CGKOSWaeimquy26]$/u.test(value);

/** Better Auth 1.7.1 / @better-auth/utils 0.4.2: ASCII-hex salt and 64-byte key. */
const isScryptPasswordHash = (value: string): boolean =>
  /^[a-f0-9]{32}:[a-f0-9]{128}$/u.test(value);

/** Current native policy. Reject other PHC versions, costs, lengths and noncanonical encodings. */
export const isNativePasswordHash = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{21}[AQgw]\$[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/u.test(
    value,
  );

export const nativePasswordHash = async (password: string): Promise<string> => {
  if (password.length > maxPasswordCodeUnits) throw new PasswordInputTooLongError();
  return boundedHash(async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await argon2idAsync(password.normalize("NFKC"), salt, argonOptions);
    try {
      return `${argonPrefix}${base64(salt)}$${base64(key)}`;
    } finally {
      key.fill(0);
    }
  });
};

export const verifyNativeOrLegacyPassword = async ({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> => {
  if (password.length > maxPasswordCodeUnits) throw new PasswordInputTooLongError();
  const native = Boolean(isNativePasswordHash(hash));
  const scrypt = isScryptPasswordHash(hash);
  const legacy = Boolean(isSupportedLegacyPasswordHash(hash));
  if ((!native && !scrypt && !legacy) || (legacy && password.includes("\0"))) return false;
  return boundedHash(async () => {
    if (legacy) {
      // bcryptjs consumes exactly the first 72 UTF-8 bytes, including split code points.
      // Do not decode a truncated byte array, prehash, or normalize the submitted password.
      return compare(password, hash);
    }
    const key = native
      ? await argon2idAsync(
          password.normalize("NFKC"),
          decodeBase64(hash.split("$")[4]!),
          argonOptions,
        )
      : await scryptAsync(password.normalize("NFKC"), hash.slice(0, 32), {
          N: 16_384,
          r: 16,
          p: 1,
          dkLen: 64,
          maxmem: 64 * 1024 * 1024,
          asyncTick: 10,
        });
    try {
      return timingSafeEqual(
        key,
        native ? decodeBase64(hash.split("$")[5]!) : hexToBytes(hash.slice(33)),
      );
    } finally {
      key.fill(0);
    }
  });
};

/** Verification is pure with respect to account persistence. */
export const nativeAndLegacyPasswordCodec = {
  hash: nativePasswordHash,
  verify: verifyNativeOrLegacyPassword,
};
