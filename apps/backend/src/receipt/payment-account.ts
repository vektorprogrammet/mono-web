import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { Schema } from "effect";

const KeyFile = Schema.Struct({ keyId: Schema.String, keyBase64: Schema.String });

export class PaymentAccountCustodyError extends Error {
  constructor(readonly code: "InvalidKey" | "InvalidAccount" | "InvalidCiphertext") {
    super(code);
    this.name = "PaymentAccountCustodyError";
  }
}

export interface PaymentAccountCipher {
  readonly keyId: string;
  readonly commitment: (raw: string) => string;
  readonly encrypt: (raw: string, receiptId: string) => string;
  readonly decrypt: (ciphertext: string, receiptId: string) => string;
}

const normalizedAccount = (raw: string): string => {
  if (!/^(?:[0-9]{11}|[0-9]{4}([. ])[0-9]{2}\1[0-9]{5})$/.test(raw))
    throw new PaymentAccountCustodyError("InvalidAccount");

  const digits = raw.replace(/[. ]/g, "");
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;

  for (let index = 0; index < weights.length; index += 1)
    sum += Number(digits[index]) * weights[index]!;

  if ((11 - (sum % 11)) % 11 !== Number(digits[10]))
    throw new PaymentAccountCustodyError("InvalidAccount");

  return digits;
};

const associatedData = (receiptId: string): Buffer => {
  if (receiptId.length === 0 || receiptId.length > 512)
    throw new PaymentAccountCustodyError("InvalidCiphertext");

  return Buffer.from(`vektor/receipt/payment-account/v1:${receiptId}`, "utf8");
};

const decodePart = (value: string, size: number): Buffer => {
  const decoded = Buffer.from(value, "base64url");

  if (decoded.length !== size || decoded.toString("base64url") !== value)
    throw new PaymentAccountCustodyError("InvalidCiphertext");

  return decoded;
};

export const makePaymentAccountCipher = (config: {
  readonly keyId: string;
  readonly key: Uint8Array;
}): PaymentAccountCipher => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || config.key.byteLength !== 32)
    throw new PaymentAccountCustodyError("InvalidKey");

  const encryptionKey = Buffer.from(
    hkdfSync("sha256", config.key, "", "vektor/receipt/payment-account/v1/aead", 32),
  );

  const commitmentKey = Buffer.from(
    hkdfSync("sha256", config.key, "", "vektor/receipt/payment-account/v1/commitment", 32),
  );

  const keyId = config.keyId;

  return {
    keyId,
    commitment: (raw) =>
      createHmac("sha256", commitmentKey).update(keyId).update("\0").update(raw).digest("hex"),
    encrypt: (raw, receiptId) => {
      const account = normalizedAccount(raw);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(associatedData(receiptId));
      const encrypted = Buffer.concat([cipher.update(account, "utf8"), cipher.final()]);

      return [
        "v1",
        keyId,
        nonce.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    decrypt: (ciphertext, receiptId) => {
      try {
        if (ciphertext.length > 256) throw new PaymentAccountCustodyError("InvalidCiphertext");
        const parts = ciphertext.split(".");

        if (parts.length !== 5 || parts[0] !== "v1" || parts[1] !== keyId)
          throw new PaymentAccountCustodyError("InvalidCiphertext");
        const nonce = decodePart(parts[2]!, 12);
        const encrypted = decodePart(parts[3]!, 11);
        const tag = decodePart(parts[4]!, 16);
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAAD(associatedData(receiptId));
        decipher.setAuthTag(tag);

        return normalizedAccount(
          Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
        );
      } catch {
        throw new PaymentAccountCustodyError("InvalidCiphertext");
      }
    },
  };
};

export const decodePaymentAccountCipher = (input: Schema.Json): PaymentAccountCipher => {
  try {
    const file = Schema.decodeUnknownSync(KeyFile)(input, { onExcessProperty: "error" });
    const key = Buffer.from(file.keyBase64, "base64");

    if (key.toString("base64") !== file.keyBase64)
      throw new PaymentAccountCustodyError("InvalidKey");

    return makePaymentAccountCipher({ keyId: file.keyId, key });
  } catch {
    throw new PaymentAccountCustodyError("InvalidKey");
  }
};
