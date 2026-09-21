import { Schema } from "effect";
import { isUnsafeSourcePath, unsafeSourceScalarReason } from "./source-manifest.js";
import type { SourceRecord } from "./types.js";

export const unsafeDiagnosticCategories = [
  "source",
  "route_failure",
  "legacy_route",
  "mono_route",
  "effect_failure",
  "effect_row",
  "api_failure",
] as const;
export type UnsafeDiagnosticCategory = (typeof unsafeDiagnosticCategories)[number];
export const UnsafeDiagnosticSchema = Schema.Struct({
  category: Schema.Literals(unsafeDiagnosticCategories),
  record_index: Schema.Number,
  sources: Schema.Array(
    Schema.Struct({
      source_index: Schema.Number,
      path: Schema.NullOr(Schema.String),
      line_start: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type UnsafeDiagnostic = typeof UnsafeDiagnosticSchema.Type;

// Never include symbols, payloads or unchecked paths. Indices still locate a
// rejected record when its path itself cannot safely be disclosed.
export const unsafeDiagnostic = (
  category: UnsafeDiagnosticCategory,
  recordIndex: number,
  sourceRefs: readonly string[],
  sources: readonly SourceRecord[],
): UnsafeDiagnostic => ({
  category,
  record_index: recordIndex,
  sources: sources.flatMap((source, sourceIndex) =>
    sourceRefs.includes(source.source_id)
      ? [
          {
            source_index: sourceIndex,
            line_start: source.line_start,
            path:
              source.path.length <= 512 &&
              !isUnsafeSourcePath(source.path) &&
              unsafeSourceScalarReason(source.path, "source_path") === null
                ? source.path
                : null,
          },
        ]
      : [],
  ),
});
