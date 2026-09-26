/**
 * Canonical JSON and its SHA-256 digest, shared by every context.
 *
 * Use these wherever a value is hashed, compared, or kept as evidence: command receipts,
 * idempotency keys, lock keys, snapshot and source digests. The encoding sorts object keys and
 * writes non-finite numbers as `null`. It accepts plain data only, so encode a `DateTime`, a
 * `Date`, a class instance, or bytes through its owning schema first.
 */
import { Schema, flow, Match, Predicate } from "effect";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
 *
 * @construct digest
 */
export const canonicalJsonValue = Match.type<unknown>().pipe(
  Match.when(Predicate.isNull, () => null),
  Match.when(Predicate.isString, (value) => value),
  Match.when(Predicate.isBoolean, (value) => value),
  Match.when(Predicate.isNumber, (value) => (Number.isFinite(value) ? value : null)),
  Match.when(Array.isArray, (values): Schema.Json => values.map(canonicalJsonValue)),
  Match.when(Predicate.isObjectOrArray, (input): Schema.Json => {
    const prototype = Object.getPrototypeOf(input);

    // Entries of a DateTime, Date, class instance, or byte array are not its encoded value.
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("canonical JSON accepts plain data only; encode through the owning schema");

    const output: Record<string, Schema.Json> = {};

    for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ))
      output[key] = canonicalJsonValue(value);

    return output;
  }),
  Match.orElse((): never => {
    throw new Error("canonical JSON cannot contain undefined or executable values");
  }),
);

const encodeJsonValue = (value: Schema.Json): string => {
  const encoded = JSON.stringify(value);

  if (encoded === undefined) throw new Error("canonical JSON encoding failed");

  return encoded;
};

/**
 * The canonical JSON text of a datum.
 *
 * @construct digest
 */
export const canonicalJson = flow(canonicalJsonValue, encodeJsonValue);

/**
 * The UTF-8 bytes of the canonical JSON text of a datum.
 *
 * @construct digest
 */
export const canonicalJsonBytes = flow(canonicalJson, (json) => new TextEncoder().encode(json));

/**
 * The lowercase hexadecimal SHA-256 digest of bytes.
 *
 * @construct digest
 */
export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));
