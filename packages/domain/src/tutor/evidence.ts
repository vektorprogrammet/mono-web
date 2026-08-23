import { createHash } from "node:crypto";
import type { Evidence } from "./schema.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

const sortedJsonValue = (input: unknown): JsonValue => {
  if (input === null) return null;
  if (typeof input === "string" || typeof input === "boolean" || typeof input === "number")
    return input;
  if (Array.isArray(input)) return input.map((value) => sortedJsonValue(value));
  if (typeof input === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      output[key] = sortedJsonValue(value);
    }
    return output;
  }
  throw new Error("canonical JSON cannot contain undefined or executable values");
};

const encodeJsonValue = (value: JsonValue): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON encoding failed");
  return encoded;
};

export const canonicalJson = (value: unknown): string => encodeJsonValue(sortedJsonValue(value));

export const canonicalJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalJson(value));

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const canonicalEvidenceJson = (evidence: Evidence): string => {
  const orderedEntries: ReadonlyArray<readonly [string, unknown]> = [
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
  ];
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
