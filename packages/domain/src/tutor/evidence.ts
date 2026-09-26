import { canonicalJson, sha256Hex } from "../shared-kernel/index.js";
import type { Evidence } from "./schema.js";

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
