import { Array as Arr, flow, Predicate, Schema } from "effect";
import { sha256 as digestSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();

const byteCompare = (left: string, right: string): number => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const size = Math.min(a.length, b.length);

  for (let index = 0; index < size; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);

    if (delta !== 0) return delta;
  }

  return a.length - b.length;
};

const sortCanonical = (value: Schema.Json): Schema.Json => {
  if (Arr.isArray<Schema.Json>(value)) return value.map(sortCanonical);

  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  )
    return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => byteCompare(left, right))
      .map(([key, entry]) => [key, sortCanonical(entry)]),
  );
};

export const compareByteOrder = byteCompare;

/** Compact UTF-8 JSON with recursively byte-sorted object keys and no newline. */
export const canonicalJson = flow(
  Schema.decodeUnknownSync(Schema.Json),
  sortCanonical,
  JSON.stringify,
);

export const canonicalBytes = flow(canonicalJson, (value: string) => encoder.encode(value));

export const sha256Hex = (value: Uint8Array | string): string =>
  bytesToHex(digestSha256(Predicate.isString(value) ? encoder.encode(value) : value));

export const sha256 = (value: Uint8Array | string): string => `sha256:${sha256Hex(value)}`;

export const stableId = (prefix: string, value: Schema.Json): string =>
  `${prefix}-${sha256Hex(canonicalJson(value))}`;

export const normalizeScalar = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;

  return value.trim().normalize("NFC");
};

export const normalizePath = (value: string | null | undefined): string | null => {
  const normalized = normalizeScalar(value);

  if (normalized === null || normalized.length === 0) return normalized;

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

export const normalizeMethods = (values: readonly unknown[]): string[] => {
  const methods = values
    .values()
    .flatMap((value) => {
      if (Predicate.isString(value)) return value.split(",");

      return [];
    })
    .map((value) => normalizeScalar(value)?.toUpperCase() ?? "")
    .filter((value): value is string => value.length > 0)
    .toArray();

  return [...new Set(methods)].sort(byteCompare);
};

export const sortUnique = <Value extends string>(values: readonly Value[]): Value[] =>
  [...new Set(values)].sort(byteCompare);

export const canonicalRouteKey = (
  method: string | null,
  pathTemplate: string | null,
  routeName: string | null,
): string => canonicalJson(["http_route", method, pathTemplate, routeName]);

export const declarationId = (
  authorityLine: "legacy" | "mono" | "cross_line",
  repositoryRef: string,
  logicalPath: string,
  declarationKind: string,
  ordinalWithinFile: number,
): string =>
  stableId("decl", {
    authority_line: authorityLine,
    repository_ref: repositoryRef,
    logical_path: logicalPath,
    declaration_kind: declarationKind,
    ordinal_within_file: ordinalWithinFile,
  });

export const rowId = (inventoryKind: string, declaration: string, canonicalKey: string): string =>
  stableId("row", {
    inventory_kind: inventoryKind,
    declaration_id: declaration,
    canonical_key: canonicalKey,
  });

export const duplicateGroupId = (
  authorityLine: string,
  inventoryKind: string,
  canonicalKey: string,
): string =>
  stableId("dup", {
    authority_scope: authorityLine,
    inventory_kind: inventoryKind,
    canonical_key: canonicalKey,
  });

export const relationId = (
  relationKind: string,
  fromRowId: string,
  toRowId: string,
  sourceRefIds: readonly string[],
): string =>
  stableId("rel", {
    relation_kind: relationKind,
    from_row_id: fromRowId,
    to_row_id: toRowId,
    source_ref_ids: sortUnique(sourceRefIds),
  });

export const observationId = (
  observationKind: string,
  sourceRefIds: readonly string[],
  valueDigest: string,
): string =>
  stableId("obs", {
    observation_kind: observationKind,
    source_ref_ids: sortUnique(sourceRefIds),
    value_digest: valueDigest,
  });

export const edgeId = (
  edgeType: string,
  fromRefIds: readonly string[],
  toRowIds: readonly string[],
): string =>
  stableId("edge", {
    edge_type: edgeType,
    from_ref_ids: sortUnique(fromRefIds),
    to_row_ids: sortUnique(toRowIds),
  });

export const failureId = (
  status: string,
  reasonCode: string,
  rowIds: readonly string[],
  sourceRefIds: readonly string[],
): string =>
  stableId("failure", {
    status,
    reason_code: reasonCode,
    row_ids: sortUnique(rowIds),
    source_ref_ids: sortUnique(sourceRefIds),
  });
