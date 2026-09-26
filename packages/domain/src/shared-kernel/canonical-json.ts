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

/** A datum whose entries, at every depth, are its encoding. */
type PlainData =
  | null
  | string
  | boolean
  | number
  | ReadonlyArray<PlainData>
  | { readonly [key: string]: PlainData };

// Entries of a DateTime, Date, class instance, or byte array are not its encoded value.
const isPlainData = (input: unknown): input is PlainData => {
  if (Array.isArray(input)) return input.every(isPlainData);

  if (!Predicate.isObjectOrArray(input))
    return (
      Predicate.isNull(input) ||
      Predicate.isString(input) ||
      Predicate.isBoolean(input) ||
      Predicate.isNumber(input)
    );

  const prototype = Object.getPrototypeOf(input);

  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(input).every(isPlainData)
  );
};

const decodePlainData = Schema.decodeUnknownSync(
  Schema.declare(isPlainData, {
    message: "canonical JSON accepts plain data only; encode through the owning schema",
  }),
);

const canonicalPlainData: (value: PlainData) => Schema.Json = Match.type<PlainData>().pipe(
  Match.when(Predicate.isNull, () => null),
  Match.when(Predicate.isString, (value) => value),
  Match.when(Predicate.isBoolean, (value) => value),
  Match.when(Predicate.isNumber, (value) => (Number.isFinite(value) ? value : null)),
  Match.when(Array.isArray, (values): Schema.Json => values.map(canonicalPlainData)),
  Match.orElse((input): Schema.Json => {
    const output: Record<string, Schema.Json> = {};

    for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ))
      output[key] = canonicalPlainData(value);

    return output;
  }),
);

/**
 * The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
 * A datum that is not plain data fails to decode.
 *
 * @construct digest
 */
export const canonicalJsonValue = Match.type<unknown>().pipe(
  Match.orElse((datum): Schema.Json => canonicalPlainData(decodePlainData(datum))),
);

/**
 * The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes
 * `canonicalJsonValue` instead.
 *
 * `sql.json` encodes its argument, so this text would be stored as a JSON string, and
 * `anti-slop/no-json-text-parameter` rejects it there.
 *
 * @construct digest
 */
export const canonicalJson = flow(canonicalJsonValue, (value): string => JSON.stringify(value));

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
