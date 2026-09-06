import { hashPassword, verifyPassword } from "better-auth/crypto";

/** Frozen supported source: PHP PASSWORD_BCRYPT, $2y$, cost12. */
export const isSupportedLegacyPasswordHash = (value: unknown): value is string =>
  typeof value === "string" && /^\$2y\$12\$[./A-Za-z0-9]{53}$/.test(value);
/** Installed Better Auth 1.7.1 / @better-auth/utils 0.4.2: 16-byte salt, 64-byte key. */
export const isNativePasswordHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(value);

declare const Bun: {
  password: { verify(password: Uint8Array, hash: string): Promise<boolean> };
};
export const nativePasswordHash = hashPassword;
export const verifyNativeOrLegacyPassword = async ({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> => {
  try {
    if (isNativePasswordHash(hash)) return await verifyPassword({ hash, password });
    if (
      password.includes("\0") ||
      !isSupportedLegacyPasswordHash(hash) ||
      typeof Bun === "undefined"
    )
      return false;
    // Bun prehashes >72-byte bcrypt inputs; PHP truncates. Preserve PHP bytes,
    // including a multibyte code point cut at the boundary. Never normalize them.
    return await Bun.password.verify(new TextEncoder().encode(password).subarray(0, 72), hash);
  } catch {
    return false;
  }
};
/** Composition root installs this object as emailAndPassword.password. No login-time rehash. */
export const nativeAndLegacyPasswordCodec = {
  hash: nativePasswordHash,
  verify: verifyNativeOrLegacyPassword,
};
