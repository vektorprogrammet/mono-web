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
export interface UnsafeDiagnostic {
  readonly category: UnsafeDiagnosticCategory;
  readonly record_index: number;
  readonly sources: readonly { readonly source_index: number; readonly path: string | null }[];
}

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
