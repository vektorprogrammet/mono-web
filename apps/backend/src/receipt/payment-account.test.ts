import { expect, it } from "vitest";
import { makePaymentAccountCipher, PaymentAccountCustodyError } from "./payment-account.js";

it("authenticates the ciphertext, custody key, and owning receipt", () => {
  const cipher = makePaymentAccountCipher({ keyId: "fixture", key: new Uint8Array(32).fill(7) });
  const wrongKey = makePaymentAccountCipher({ keyId: "fixture", key: new Uint8Array(32).fill(8) });
  const encrypted = cipher.encrypt("1234.56.78903", "receipt-one");
  const parts = encrypted.split(".");
  const tag = Buffer.from(parts[4]!, "base64url");
  tag[0] = tag[0]! ^ 1;
  parts[4] = tag.toString("base64url");

  expect(cipher.decrypt(encrypted, "receipt-one")).toBe("12345678903");
  expect(() => cipher.decrypt(parts.join("."), "receipt-one")).toThrow(PaymentAccountCustodyError);
  expect(() => cipher.decrypt(encrypted, "receipt-two")).toThrow(PaymentAccountCustodyError);
  expect(() => wrongKey.decrypt(encrypted, "receipt-one")).toThrow(PaymentAccountCustodyError);
});

it("uses fresh encryption while retaining key-bound source commitments", () => {
  const cipher = makePaymentAccountCipher({ keyId: "fixture", key: new Uint8Array(32).fill(7) });

  const changedKey = makePaymentAccountCipher({
    keyId: "fixture",
    key: new Uint8Array(32).fill(8),
  });

  const first = cipher.encrypt("12345678903", "receipt-one");
  const second = cipher.encrypt("12345678903", "receipt-one");

  expect(first).not.toBe(second);
  expect(cipher.decrypt(second, "receipt-one")).toBe("12345678903");
  expect(cipher.commitment("12345678903")).not.toBe(changedKey.commitment("12345678903"));
  expect(cipher.commitment("12345678903")).not.toBe(cipher.commitment("1234.56.78903"));
});

it("rejects an invalid check digit instead of encrypting an unusable destination", () => {
  const cipher = makePaymentAccountCipher({ keyId: "fixture", key: new Uint8Array(32).fill(7) });

  expect(() => cipher.encrypt("12345678904", "receipt-one")).toThrow(PaymentAccountCustodyError);
  expect(cipher.decrypt(cipher.encrypt("1234 56 78903", "receipt-one"), "receipt-one")).toBe(
    "12345678903",
  );
});
