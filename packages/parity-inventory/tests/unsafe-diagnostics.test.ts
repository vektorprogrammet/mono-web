import { expect, test } from "bun:test";
import { unsafeDiagnostic } from "../src/unsafe-diagnostics.js";
import type { SourceRecord } from "../src/types.js";

const source = (path: string): SourceRecord => ({
  source_id: "source-1",
  authority_line: "mono",
  authority_role: "source",
  repository_ref: "mono",
  revision_ref_id: "revision-1",
  path,
  line_start: 1,
  line_end: 2,
  symbol: "never-disclose-symbol",
  byte_length: null,
  sha256: null,
  capture_mode: "static",
  availability: "unavailable",
  classification_status: "unclassified",
  failure_reason: "UNSAFE_SOURCE",
});

test("unsafe projection diagnostics identify a source without copying rejected metadata", () => {
  const diagnostic = unsafeDiagnostic(
    "effect_failure",
    3,
    ["source-1"],
    [source("src/Controller.php")],
  );
  expect(diagnostic).toEqual({
    category: "effect_failure",
    record_index: 3,
    sources: [{ source_index: 0, path: "src/Controller.php" }],
  });
  expect(JSON.stringify(diagnostic)).not.toContain("never-disclose-symbol");
});

test("unsafe paths remain redacted while record and source indices remain actionable", () => {
  for (const path of [
    "private.pem",
    "src/person@real-domain.org.ts",
    "src/+4712345678.ts",
    "src/password=concrete.ts",
  ]) {
    const diagnostic = unsafeDiagnostic("source", 4, ["source-1"], [source(path)]);
    expect(diagnostic.sources).toEqual([{ source_index: 0, path: null }]);
    expect(JSON.stringify(diagnostic)).not.toContain(path);
  }
});

test("failure records with unavailable source references still identify their category and index", () => {
  expect(unsafeDiagnostic("api_failure", 5, ["missing"], [source("src/Safe.php")])).toEqual({
    category: "api_failure",
    record_index: 5,
    sources: [],
  });
});
