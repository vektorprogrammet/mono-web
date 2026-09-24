import { Schema, flow, Match, Predicate } from "effect";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Evidence } from "./schema.js";

export const canonicalJsonValue = Match.type<unknown>().pipe(
  Match.when(Predicate.isNull, () => null),
  Match.when(Predicate.isString, (value) => value),
  Match.when(Predicate.isBoolean, (value) => value),
  Match.when(Predicate.isNumber, (value) => (Number.isFinite(value) ? value : null)),
  Match.when(Array.isArray, (values): Schema.Json => values.map(canonicalJsonValue)),
  Match.when(Predicate.isObjectOrArray, (input): Schema.Json => {
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

export const canonicalJson = flow(canonicalJsonValue, encodeJsonValue);

export const canonicalJsonBytes = flow(canonicalJson, (json) => new TextEncoder().encode(json));

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export const canonicalEvidenceJson = (evidence: Evidence): string => {
  const orderedEntries = [
    ["formatVersion", evidence.formatVersion],
    ["specId", evidence.specId],
    ["baseCommit", evidence.baseCommit],
    ["fixtureId", evidence.fixtureId],
    ["schemaVersion", evidence.schemaVersion],
    ["correlationId", evidence.correlationId],
    ["stream", evidence.stream],
    ["cases", evidence.cases],
    ["projection", evidence.projection],
    ["eventIds", evidence.eventIds],
    ["effectDescriptors", evidence.effectDescriptors],
    ["provenance", evidence.provenance],
  ] as const;

  const encodedEntries = orderedEntries.map(
    ([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`,
  );

  return `{${encodedEntries.join(",")}}`;
};

export const canonicalEvidenceBytes = (evidence: Evidence): Uint8Array =>
  new TextEncoder().encode(`${canonicalEvidenceJson(evidence)}\n`);

export interface EvidenceArtifact {
  readonly document: Evidence;
  readonly canonicalJson: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export const renderEvidence = (document: Evidence): EvidenceArtifact => {
  const canonical = canonicalEvidenceJson(document);
  const bytes = new TextEncoder().encode(`${canonical}\n`);

  return {
    document,
    canonicalJson: canonical,
    bytes,
    digest: sha256Hex(bytes),
  };
};
