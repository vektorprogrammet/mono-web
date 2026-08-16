import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  canonicalJson,
  compareByteOrder,
  failureId,
  relationId,
  sha256,
  sortUnique,
} from "./canonical.js"
import { collectRoutes, routeRowsBySignature, setRowMismatch, updateEnvelopeRows } from "./routes.js"
import { finalizeManifest, sourceDigestForManifest, type ManifestContext } from "./source-manifest.js"
import { createManifestContextEffect, ParityRuntimeError, readProjectionEffect, writeProjectionSetEffect } from "./runtime.js"
import { validateInventory, validateOpenApiReconciliation, validateReport, validateSourceManifest } from "./schema.js"
import type {
  GeneratedArtifacts,
  InventoryEnvelope,
  InventoryRow,
  OpenApiReconciliation,
  ReportFailure,
  ReportMismatch,
  SourceManifest,
  ZeroGapReport,
} from "./types.js"

export const PROJECTION_DIRECTORY = "evidence/functional-parity"
export const COMMITTED_PROJECTIONS = ["source-manifest.json", "legacy-routes.json", "mono-routes.json"] as const
export const FALSIFIERS = [
  "F0_deterministic_replay",
  "F1_missing_required_source",
  "F2_source_hash_drift",
  "F3_duplicate_legacy_route",
  "F4_dead_unimported_source",
  "F5_missing_counterpart",
  "F6_extra_counterpart",
  "F7_method_path_mismatch",
  "F8_openapi_stale",
  "F9_runtime_unavailable",
  "F10_static_runtime_mismatch",
  "F11_intent_missing_or_stale",
  "F12_uncovered_journey",
  "F13_unknown_effect",
  "F14_absent_schedule",
  "F15_secret_or_pii_input",
  "F16_h3_authority_copy",
  "F17_locale_order",
  "F18_stale_artifact_diff",
  "F19_ignore_residual_precedence",
] as const

export type FalsifierId = (typeof FALSIFIERS)[number]
export type RunMode = "diff" | "write" | "fixture_injection"

export interface RunOptions {
  readonly root: string
  readonly legacyRoot: string
  readonly mode: RunMode
  readonly falsifierId?: FalsifierId
}

export interface RunResult {
  readonly exitCode: number
  readonly report: ZeroGapReport
  readonly artifacts?: GeneratedArtifacts
  readonly projectionDiff: boolean
}

const emptyOpenApi = (sourceManifestSha256: string): OpenApiReconciliation => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-openapi-reconciliation/v1",
  status: "unresolved",
  source_manifest_sha256: sourceManifestSha256,
  committed_source_ref_ids: [],
  regenerated_source_ref_ids: [],
  committed_sha256: null,
  regenerated_sha256: null,
  only_committed: [],
  only_regenerated: [],
  changed_operations: [],
})


const buildFailure = (status: ReportFailure["status"], reasonCode: string, rowIds: readonly string[], sourceRefIds: readonly string[]): ReportFailure => ({
  failure_id: failureId(status, reasonCode, rowIds, sourceRefIds),
  status,
  reason_code: reasonCode,
  row_ids: sortUnique(rowIds),
  source_ref_ids: sortUnique(sourceRefIds),
  accepted_intent_ref_ids: [],
})

const rowCounts = (inventories: readonly InventoryEnvelope[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const inventory of inventories) counts[inventory.inventory_kind] = inventory.rows.length
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareByteOrder(left, right)))
}

const statusCounts = (inventories: readonly InventoryEnvelope[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const inventory of inventories) {
    for (const row of inventory.rows) counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareByteOrder(left, right)))
}
const crossReferenceValidation = (manifest: SourceManifest, inventories: readonly InventoryEnvelope[], mismatches: readonly ReportMismatch[]): boolean => {
  const sourceIds = new Set(manifest.sources.map((source) => source.source_id))
  const revisionIds = new Set(manifest.revisions.map((revision) => revision.revision_ref_id))
  const rowIds = new Set(inventories.flatMap((inventory) => inventory.rows.map((row) => row.row_id)))
  if (inventories.some((inventory) => inventory.source_manifest_sha256 !== sourceDigestForManifest(manifest))) return false
  for (const inventory of inventories) {
    for (const row of inventory.rows) {
      if (row.source_ref_ids.some((id) => !sourceIds.has(id)) || row.revision_ref_ids.some((id) => !revisionIds.has(id))) return false
      if (row.mismatch.counterpart_row_ids.some((id) => !rowIds.has(id))) return false
      if (row.related_row_ids.some((id) => !rowIds.has(id))) return false
    }
    for (const link of inventory.links) {
      if (!rowIds.has(link.from_row_id) || !rowIds.has(link.to_row_id) || link.source_ref_ids.some((id) => !sourceIds.has(id))) return false
    }
  }
  return mismatches.every((mismatch) => mismatch.row_ids.every((id) => rowIds.has(id)))
}

const mismatchKey = (mismatch: ReportMismatch): string => canonicalJson({ kind: mismatch.kind, row_ids: mismatch.row_ids })

const reconcileRoutes = (legacy: InventoryEnvelope, mono: InventoryEnvelope): { readonly legacy: InventoryEnvelope; readonly mono: InventoryEnvelope; readonly mismatches: readonly ReportMismatch[]; readonly links: InventoryEnvelope["links"] } => {
  const legacyBySignature = routeRowsBySignature(legacy)
  const monoBySignature = routeRowsBySignature(mono)
  const legacyRows: InventoryRow[] = legacy.rows.map((row) => row)
  const monoRows: InventoryRow[] = mono.rows.map((row) => row)
  const mismatches: ReportMismatch[] = []
  const links: Array<InventoryEnvelope["links"][number]> = []
  const counterpartByName = (row: InventoryRow, rows: readonly InventoryRow[]): InventoryRow | undefined => {
    const details = row.details as { readonly route_name?: string | null; readonly path_template?: string | null }
    if (details.route_name === null || details.route_name === undefined) return undefined
    return rows.find((candidate) => (candidate.details as { readonly route_name?: string | null }).route_name === details.route_name)
  }
  for (const row of legacyRows) {
    if (row.status === "duplicate" || row.status === "unresolved" || row.status === "dead_unimported") continue
    const exact = monoBySignature.get(row.signature) ?? []
    if (exact.length > 0) {
      const counterpart = exact[0]
      if (counterpart !== undefined) {
        const index = legacyRows.findIndex((candidate) => candidate.row_id === row.row_id)
        legacyRows[index] = setRowMismatch(row, "none", [counterpart.row_id], "")
        const monoIndex = monoRows.findIndex((candidate) => candidate.row_id === counterpart.row_id)
        if (monoIndex >= 0 && monoRows[monoIndex]?.status !== "duplicate") monoRows[monoIndex] = setRowMismatch(monoRows[monoIndex] as InventoryRow, "none", [row.row_id], "")
        links.push({ relation_id: relationId("matches", row.row_id, counterpart.row_id, [...row.source_ref_ids, ...counterpart.source_ref_ids]), relation_kind: "matches", from_row_id: row.row_id, to_row_id: counterpart.row_id, source_ref_ids: sortUnique([...row.source_ref_ids, ...counterpart.source_ref_ids]) })
      }
      continue
    }
    const changed = counterpartByName(row, monoRows)
    const index = legacyRows.findIndex((candidate) => candidate.row_id === row.row_id)
    if (changed !== undefined) {
      legacyRows[index] = setRowMismatch(row, "changed", [changed.row_id], "CHANGED_SIGNATURE")
      const monoIndex = monoRows.findIndex((candidate) => candidate.row_id === changed.row_id)
      if (monoIndex >= 0 && monoRows[monoIndex] !== undefined) monoRows[monoIndex] = setRowMismatch(monoRows[monoIndex] as InventoryRow, "changed", [row.row_id], "CHANGED_SIGNATURE")
      const mismatch: ReportMismatch = { kind: "changed", row_ids: sortUnique([row.row_id, changed.row_id]), disposition: "none", accepted_intent_ref_ids: [] }
      if (!mismatches.some((entry) => mismatchKey(entry) === mismatchKey(mismatch))) mismatches.push(mismatch)
    } else {
      legacyRows[index] = setRowMismatch(row, "missing", [], "MISSING_COUNTERPART")
      mismatches.push({ kind: "missing", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
    }
  }
  for (const row of monoRows) {
    if (row.status === "duplicate" || row.status === "unresolved" || row.status === "dead_unimported" || row.status === "changed") continue
    const exact = legacyBySignature.get(row.signature) ?? []
    if (exact.length > 0) continue
    const changed = counterpartByName(row, legacyRows)
    const index = monoRows.findIndex((candidate) => candidate.row_id === row.row_id)
    if (changed !== undefined) {
      monoRows[index] = setRowMismatch(row, "changed", [changed.row_id], "CHANGED_SIGNATURE")
      if (!mismatches.some((entry) => mismatchKey(entry) === mismatchKey({ kind: "changed", row_ids: sortUnique([row.row_id, changed.row_id]), disposition: "none", accepted_intent_ref_ids: [] }))) mismatches.push({ kind: "changed", row_ids: sortUnique([row.row_id, changed.row_id]), disposition: "none", accepted_intent_ref_ids: [] })
    } else {
      monoRows[index] = setRowMismatch(row, "extra", [], "EXTRA_COUNTERPART")
      mismatches.push({ kind: "extra", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
    }
  }
  for (const row of legacyRows) {
    if (row.status === "duplicate") mismatches.push({ kind: "duplicate", row_ids: [row.row_id, ...row.mismatch.counterpart_row_ids], disposition: "none", accepted_intent_ref_ids: [] })
    if (row.status === "unresolved") mismatches.push({ kind: "unresolved", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
    if (row.status === "dead_unimported") mismatches.push({ kind: "dead_unimported", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
  }
  for (const row of monoRows) {
    if (row.status === "duplicate") mismatches.push({ kind: "duplicate", row_ids: [row.row_id, ...row.mismatch.counterpart_row_ids], disposition: "none", accepted_intent_ref_ids: [] })
    if (row.status === "unresolved") mismatches.push({ kind: "unresolved", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
    if (row.status === "dead_unimported") mismatches.push({ kind: "dead_unimported", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
  }
  const unique = new Map<string, ReportMismatch>()
  for (const mismatch of mismatches) unique.set(mismatchKey({ ...mismatch, row_ids: sortUnique(mismatch.row_ids) }), { ...mismatch, row_ids: sortUnique(mismatch.row_ids) })
  return { legacy: updateEnvelopeRows(legacy, legacyRows), mono: { ...updateEnvelopeRows(mono, monoRows), links }, mismatches: [...unique.values()].sort((a, b) => compareByteOrder(a.kind, b.kind) || compareByteOrder(a.row_ids.join("\u0000"), b.row_ids.join("\u0000"))), links }
}

const artifactBytes = (manifest: SourceManifest, legacy: InventoryEnvelope, mono: InventoryEnvelope, reconciliation: OpenApiReconciliation): Record<string, string> => ({
  "source-manifest.json": canonicalJson(manifest),
  "legacy-routes.json": canonicalJson(legacy),
  "mono-routes.json": canonicalJson(mono),
  "openapi-reconciliation.json": canonicalJson(reconciliation),
})

const primaryFailure = (failures: readonly ReportFailure[], projectionDiff: boolean): { readonly status: ZeroGapReport["status"]; readonly exitCode: number } => {
  if (failures.some((failure) => failure.status === "command_error")) return { status: "command_error", exitCode: 12 }
  if (failures.some((failure) => failure.status === "source_unavailable")) return { status: "source_unavailable", exitCode: 6 }
  if (failures.some((failure) => failure.status === "source_hash_drift")) return { status: "source_hash_drift", exitCode: 7 }
  if (failures.some((failure) => failure.status === "schema_invalid")) return { status: "schema_invalid", exitCode: 8 }
  if (failures.some((failure) => failure.status === "nondeterministic_output")) return { status: "nondeterministic_output", exitCode: 9 }
  if (failures.some((failure) => failure.status === "runtime_unavailable")) return { status: "runtime_unavailable", exitCode: 10 }
  if (failures.some((failure) => failure.status === "accepted_intent_invalid")) return { status: "accepted_intent_invalid", exitCode: 11 }
  if (projectionDiff) return { status: "stale", exitCode: 5 }
  if (failures.some((failure) => failure.status === "duplicate")) return { status: "duplicate", exitCode: 4 }
  if (failures.some((failure) => failure.status === "unresolved")) return { status: "unresolved", exitCode: 3 }
  return { status: "gaps_found", exitCode: 2 }
}

const reportWith = (params: {
  readonly mode: RunMode
  readonly falsifierId: string | null
  readonly status: ZeroGapReport["status"]
  readonly exitCode: number
  readonly projectionWrite: ZeroGapReport["projection_write"]
  readonly sourceManifestSha256: string | null
  readonly artifactBytes: Readonly<Record<string, string>>
  readonly inventories: readonly InventoryEnvelope[]
  readonly failures: readonly ReportFailure[]
  readonly mismatches: readonly ReportMismatch[]
  readonly deterministicDiff: ZeroGapReport["verification"]["deterministic_diff"]
  readonly schemaValidation: boolean
  readonly crossReferenceValidation: boolean
}): ZeroGapReport => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-zero-gap-report/v1",
  status: params.status,
  exit_code: params.exitCode,
  mode: params.mode,
  falsifier_id: params.falsifierId,
  projection_write: params.projectionWrite,
  source_manifest_sha256: params.sourceManifestSha256,
  inventory_artifact_sha256: Object.fromEntries(Object.entries(params.artifactBytes).filter(([name]) => name !== "zero-gap-report.json").sort(([left], [right]) => compareByteOrder(left, right)).map(([name, bytes]) => [name, sha256(bytes)])),
  row_counts: rowCounts(params.inventories),
  status_counts: statusCounts(params.inventories),
  failures: [...params.failures].sort((a, b) => compareByteOrder(a.failure_id, b.failure_id)),
  mismatches: [...params.mismatches].sort((a, b) => compareByteOrder(a.kind, b.kind) || compareByteOrder(a.row_ids.join("\u0000"), b.row_ids.join("\u0000"))),
  openapi_reconciliation_ref: "openapi-reconciliation.json",
  verification: {
    canonical_json: "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline",
    schema_validation: params.schemaValidation,
    cross_reference_validation: params.crossReferenceValidation,
    deterministic_diff: params.deterministicDiff,
    forbidden_states_empty: false,
  },
})

class UnsafeSourceProjectionError extends Error {}

const hasUnsafeProjectionMetadata = (context: ManifestContext, preliminary: ReturnType<typeof collectRoutes>): boolean =>
  context.sources.some((source) => source.failure_reason === "UNSAFE_SOURCE") ||
  preliminary.failures.some((failure) => failure.reason_code === "UNSAFE_SOURCE") ||
  preliminary.legacy.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
  preliminary.mono.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE"))

const generateFromContext = (context: ManifestContext, mode: RunMode): GeneratedArtifacts => {
  const preliminary = collectRoutes(context, sha256("c0-source-manifest-pending"))
  if (hasUnsafeProjectionMetadata(context, preliminary)) throw new UnsafeSourceProjectionError("unsafe source metadata encountered during projection construction")
  const manifest = finalizeManifest(context)
  const manifestDigest = sourceDigestForManifest(manifest)
  let legacy = { ...preliminary.legacy, source_manifest_sha256: manifestDigest }
  let mono = { ...preliminary.mono, source_manifest_sha256: manifestDigest }
  const reconciled = reconcileRoutes(legacy, mono)
  legacy = reconciled.legacy
  mono = reconciled.mono
  const reconciliation = emptyOpenApi(manifestDigest)
  const bytes = artifactBytes(manifest, legacy, mono, reconciliation)
  const failures: ReportFailure[] = []
  const unavailableSources = manifest.sources.filter((source) => source.availability === "unavailable")
  for (const source of unavailableSources) failures.push(buildFailure("source_unavailable", source.failure_reason ?? "SOURCE_UNAVAILABLE", [], [source.source_id]))
  const unclassified = manifest.root_census.filter((record) => record.classification === "unclassified")
  for (const record of unclassified) failures.push(buildFailure("unresolved", "UNCLASSIFIED_SOURCE", [], record.source_ref_ids))
  for (const failure of preliminary.failures) failures.push(buildFailure(failure.status === "source_unavailable" ? "source_unavailable" : "unresolved", failure.reason_code, [], [failure.source_ref_id]))
  const allRows = [...legacy.rows, ...mono.rows]
  for (const row of allRows) {
    const unsafe = row.reason_codes.includes("UNSAFE_SOURCE")
    if (unsafe) {
      failures.push(buildFailure("source_unavailable", "UNSAFE_SOURCE", [row.row_id], row.source_ref_ids))
      continue
    }
    if (row.status === "duplicate") failures.push(buildFailure("duplicate", "DUPLICATE_CANONICAL_IDENTITY", [row.row_id, ...row.mismatch.counterpart_row_ids], row.source_ref_ids))
    else if (row.status === "unresolved") failures.push(buildFailure("unresolved", row.reason_codes[0] ?? "SOURCE_PARSE_ERROR", [row.row_id], row.source_ref_ids))
    else if (row.status === "dead_unimported") failures.push(buildFailure("gaps_found", "DEAD_UNIMPORTED_SOURCE", [row.row_id], row.source_ref_ids))
    else if (row.status === "missing") failures.push(buildFailure("gaps_found", "MISSING_COUNTERPART", [row.row_id], row.source_ref_ids))
    else if (row.status === "extra") failures.push(buildFailure("gaps_found", "EXTRA_COUNTERPART", [row.row_id], row.source_ref_ids))
    else if (row.status === "changed") failures.push(buildFailure("gaps_found", "CHANGED_SIGNATURE", [row.row_id], row.source_ref_ids))
  }
  const schemaValidation = validateSourceManifest(manifest) && validateInventory(legacy) && validateInventory(mono) && validateOpenApiReconciliation(reconciliation)
  if (!schemaValidation) failures.push(buildFailure("schema_invalid", "SCHEMA_VALIDATION_FAILED", [], []))
  const crossReferencesValid = crossReferenceValidation(manifest, [legacy, mono], reconciled.mismatches)
  if (!crossReferencesValid) failures.push(buildFailure("schema_invalid", "CROSS_REFERENCE_VALIDATION_FAILED", [], []))
  failures.push(buildFailure("gaps_found", "C0_BOUNDED_SCOPE", [], []))
  const primary = primaryFailure(failures, false)
  let report = reportWith({ mode, falsifierId: null, status: primary.status, exitCode: primary.exitCode, projectionWrite: mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: manifestDigest, artifactBytes: bytes, inventories: [legacy, mono], failures, mismatches: reconciled.mismatches, deterministicDiff: mode === "write" ? "not_run" : "different", schemaValidation, crossReferenceValidation: crossReferencesValid })
  if (!validateReport(report)) {
    failures.push(buildFailure("schema_invalid", "REPORT_SCHEMA_VALIDATION_FAILED", [], []))
    const reportPrimary = primaryFailure(failures, false)
    report = reportWith({ mode, falsifierId: null, status: reportPrimary.status, exitCode: reportPrimary.exitCode, projectionWrite: mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: manifestDigest, artifactBytes: bytes, inventories: [legacy, mono], failures, mismatches: reconciled.mismatches, deterministicDiff: mode === "write" ? "not_run" : "different", schemaValidation: false, crossReferenceValidation: crossReferencesValid })
  }
  return { sourceManifest: manifest, legacyRoutes: legacy, monoRoutes: mono, openapiReconciliation: reconciliation, report, bytes, failures, routeRows: allRows }
}
const generateFromRootsEffect = (options: RunOptions): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
  Effect.gen(function* () {
    const context = yield* createManifestContextEffect(options.legacyRoot, options.root)
    return yield* Effect.try({
      try: () => generateFromContext(context, options.mode),
      catch: (cause) => new ParityRuntimeError({
        operation: cause instanceof UnsafeSourceProjectionError ? "unsafe_source" : "generate",
        path: options.root,
        message: cause instanceof Error ? cause.message : "projection generation failed",
      }),
    })
  })

interface FixtureExpectation {
  readonly status: ZeroGapReport["status"]
  readonly reasonCode: string
  readonly routeName?: string
  readonly routeAuthority?: "legacy" | "mono"
}

interface FixtureWorkspace {
  readonly directory: string
  readonly root: string
  readonly legacyRoot: string
}

const C0_FALSIFIERS: Partial<Record<FalsifierId, true>> = {
  F0_deterministic_replay: true,
  F1_missing_required_source: true,
  F2_source_hash_drift: true,
  F3_duplicate_legacy_route: true,
  F4_dead_unimported_source: true,
  F5_missing_counterpart: true,
  F6_extra_counterpart: true,
  F7_method_path_mismatch: true,
}

const fixtureExpectation = (falsifierId: FalsifierId): FixtureExpectation | null => {
  switch (falsifierId) {
    case "F0_deterministic_replay": return { status: "falsifier_passed", reasonCode: "DETERMINISTIC_REPLAY" }
    case "F1_missing_required_source": return { status: "source_unavailable", reasonCode: "SOURCE_UNAVAILABLE" }
    case "F2_source_hash_drift": return { status: "source_hash_drift", reasonCode: "SOURCE_HASH_DRIFT" }
    case "F3_duplicate_legacy_route": return { status: "duplicate", reasonCode: "DUPLICATE_CANONICAL_IDENTITY", routeName: "fixture_duplicate", routeAuthority: "legacy" }
    case "F4_dead_unimported_source": return { status: "gaps_found", reasonCode: "DEAD_UNIMPORTED_SOURCE", routeName: "fixture_dead", routeAuthority: "legacy" }
    case "F5_missing_counterpart": return { status: "gaps_found", reasonCode: "MISSING_COUNTERPART", routeName: "fixture_missing", routeAuthority: "legacy" }
    case "F6_extra_counterpart": return { status: "gaps_found", reasonCode: "EXTRA_COUNTERPART", routeName: "fixture_extra", routeAuthority: "mono" }
    case "F7_method_path_mismatch": return { status: "gaps_found", reasonCode: "CHANGED_SIGNATURE", routeName: "fixture_changed" }
    default: return null
  }
}


const unimplementedFixture = (falsifierId: FalsifierId): RunResult => {
  const failure = buildFailure("command_error", "C0_FALSIFIER_NOT_IMPLEMENTED", [], [])
  const report = reportWith({ mode: "fixture_injection", falsifierId, status: "command_error", exitCode: 12, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: null, artifactBytes: {}, inventories: [], failures: [failure], mismatches: [], deterministicDiff: "not_run", schemaValidation: true, crossReferenceValidation: false })
  return { exitCode: 12, report, projectionDiff: false }
}

const syntheticFixtureFiles: readonly { readonly root: "legacy" | "mono"; readonly path: string; readonly contents: string }[] = [
  { root: "legacy", path: "app/config/routing.yml", contents: "fixture_base:\n  path: /fixture/base\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [GET]\n" },
  { root: "legacy", path: "src/AppBundle/Controller/Api/FixtureController.php", contents: "<?php\nfinal class FixtureApi {}\n" },
  { root: "legacy", path: "src/AppBundle/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController {}\n" },
  { root: "legacy", path: "src/AppBundle/Service/Fixture.php", contents: "<?php\nfinal class FixtureService {}\n" },
  { root: "mono", path: "apps/server/config/routes.yaml", contents: "fixture_base:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /fixture/base\n    methods: ['GET']\n" },
  { root: "mono", path: "apps/server/src/App/Api/Resource/Fixture.php", contents: "<?php\nfinal class FixtureResource {}\n" },
  { root: "mono", path: "apps/server/src/App/Fixture/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController {}\n" },
  { root: "mono", path: "apps/server/src/App/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController2 {}\n" },
  { root: "mono", path: "apps/server/src/App/Infrastructure/Fixture.php", contents: "<?php\nfinal class FixtureInfrastructure {}\n" },
  { root: "mono", path: "apps/homepage/src/routes/home.tsx", contents: "export default function Home(){return null}\n" },
  { root: "mono", path: "apps/server/tools/security-h3/0015/generate.ts", contents: "export const fixture = true\n" },
]

const createFixtureWorkspace = (_options: RunOptions): FixtureWorkspace => {
  const directory = mkdtempSync(join(tmpdir(), "functional-parity-falsifier-"))
  const root = join(directory, "mono")
  const legacyRoot = join(directory, "legacy")
  try {
    for (const fixture of syntheticFixtureFiles) {
      const targetRoot = fixture.root === "legacy" ? legacyRoot : root
      const target = join(targetRoot, fixture.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, fixture.contents, "utf8")
    }
    return { directory, root, legacyRoot }
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true })
    throw cause
  }
}


const appendText = (path: string, text: string): void => {
  if (!existsSync(path)) throw new Error(`fixture source unavailable: ${path}`)
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${text}\n`, "utf8")
}

const routeYaml = (name: string, path: string, method: string): string => `${name}:\n  path: ${path}\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [${method}]`
const monoRouteYaml = (name: string, path: string, method: string): string => `${name}:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: ${path}\n    methods: ['${method}']`

const mutateFixture = (falsifierId: FalsifierId, workspace: FixtureWorkspace): void => {
  const legacyRouting = join(workspace.legacyRoot, "app/config/routing.yml")
  const monoRouting = join(workspace.root, "apps/server/config/routes.yaml")
  switch (falsifierId) {
    case "F1_missing_required_source":
      for (const name of ["routing.yml", "routing_api.yml", "routing_dev.yml"]) rmSync(join(workspace.legacyRoot, "app/config", name), { force: true })
      rmSync(join(workspace.legacyRoot, "src/AppBundle/Controller"), { recursive: true, force: true })
      return
    case "F3_duplicate_legacy_route":
      appendText(legacyRouting, `${routeYaml("fixture_duplicate", "/fixture/duplicate", "GET")}\n${routeYaml("fixture_duplicate", "/fixture/duplicate", "GET")}`)
      return
    case "F4_dead_unimported_source": {
      const orphan = join(workspace.legacyRoot, "src/AppBundle/Orphan/Controller")
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, "FixtureController.php"), `<?php\nnamespace AppBundle\\Orphan\\Controller;\n/** @Route("/fixture/dead", name="fixture_dead", methods={"GET"}) */\nfinal class FixtureController { public function indexAction(): void {} }\n`, "utf8")
      return
    }
    case "F5_missing_counterpart":
      appendText(legacyRouting, routeYaml("fixture_missing", "/fixture/missing", "GET"))
      return
    case "F6_extra_counterpart":
      mkdirSync(join(workspace.root, "apps/server/config"), { recursive: true })
      if (!existsSync(monoRouting)) writeFileSync(monoRouting, "# fixture route declarations\n", "utf8")
      appendText(monoRouting, monoRouteYaml("fixture_extra", "/fixture/extra", "GET"))
      return
    case "F7_method_path_mismatch":
      mkdirSync(join(workspace.root, "apps/server/config"), { recursive: true })
      if (!existsSync(monoRouting)) writeFileSync(monoRouting, "# fixture route declarations\n", "utf8")
      appendText(legacyRouting, routeYaml("fixture_changed", "/fixture/legacy", "GET"))
      appendText(monoRouting, monoRouteYaml("fixture_changed", "/fixture/mono", "GET"))
      return
    default:
      return
  }
}

const fixtureResultReport = (falsifierId: FalsifierId, generated: GeneratedArtifacts, expectation: FixtureExpectation, observedStatus: ZeroGapReport["status"], observedReason: string, deterministic: boolean): RunResult => {
  const rowIds = generated.routeRows.map((row) => row.row_id)
  const sourceRefIds = generated.routeRows.flatMap((row) => row.source_ref_ids)
  const matched = deterministic && observedStatus === expectation.status && observedReason === expectation.reasonCode
  const observedFailure = buildFailure(matched && falsifierId === "F0_deterministic_replay" ? "gaps_found" : generated.report.status === "falsifier_passed" ? "unresolved" : generated.report.status === "zero_gap" ? "gaps_found" : generated.report.status as ReportFailure["status"], matched && falsifierId === "F0_deterministic_replay" ? expectation.reasonCode : observedReason, rowIds, sourceRefIds)
  const failures = matched ? [...generated.failures, observedFailure] : [...generated.failures, buildFailure("command_error", "FALSIFIER_EXPECTATION_MISMATCH", rowIds, sourceRefIds), observedFailure]
  const reportStatus: ZeroGapReport["status"] = matched ? "falsifier_passed" : "command_error"
  const report = reportWith({ mode: "fixture_injection", falsifierId, status: reportStatus, exitCode: matched ? 13 : 12, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes], failures, mismatches: generated.report.mismatches, deterministicDiff: deterministic ? "equal" : "different", schemaValidation: generated.report.verification.schema_validation, crossReferenceValidation: generated.report.verification.cross_reference_validation })
  return { exitCode: report.exit_code, report, artifacts: generated, projectionDiff: false }
}

const runFixtureFalsifier = (options: RunOptions): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    const falsifierId = options.falsifierId
    if (falsifierId === undefined || C0_FALSIFIERS[falsifierId] !== true) return unimplementedFixture(falsifierId ?? "F8_openapi_stale")
    const expectation = fixtureExpectation(falsifierId)
    if (expectation === null) return unimplementedFixture(falsifierId)
    const workspace = yield* Effect.try({ try: () => createFixtureWorkspace(options), catch: (cause) => new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: cause instanceof Error ? cause.message : "fixture source unavailable" }) })
    try {
      if (falsifierId === "F0_deterministic_replay") {
        const first = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
        const second = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
        const deterministic = COMMITTED_PROJECTIONS.every((name) => first.bytes[name] === second.bytes[name])
        return fixtureResultReport(falsifierId, first, expectation, deterministic ? "falsifier_passed" : "command_error", deterministic ? expectation.reasonCode : "NONDETERMINISTIC_OUTPUT", deterministic)
      }
      if (falsifierId === "F2_source_hash_drift") {
        const generated = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
        const source = join(workspace.legacyRoot, "app/config/routing.yml")
        appendText(source, routeYaml("fixture_drift", "/fixture/drift", "GET"))
        const after = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
        const drifted = sourceDigestForManifest(after.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest)
        return fixtureResultReport(falsifierId, after, expectation, drifted ? "source_hash_drift" : "command_error", drifted ? expectation.reasonCode : "SOURCE_HASH_DRIFT_NOT_DETECTED", drifted)
      }
      const baseline = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
      const baselineRowIds = new Set(baseline.routeRows.map((row) => row.row_id))
      const baselineSourceIds = new Set(baseline.sourceManifest.sources.map((source) => source.source_id))
      mutateFixture(falsifierId, workspace)
      const generated = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff" })
      const routeNameOf = (row: InventoryRow): string | null => "route_name" in row.details ? row.details.route_name : null
      const injectedRows = expectation.routeName === undefined
        ? []
        : generated.routeRows.filter((row) =>
          !baselineRowIds.has(row.row_id) &&
          routeNameOf(row) === expectation.routeName &&
          (expectation.routeAuthority === undefined || row.authority_line === expectation.routeAuthority),
        )
      const injectedRowIds = new Set(injectedRows.map((row) => row.row_id))
      const injectedSourceIds = new Set(injectedRows.flatMap((row) => row.source_ref_ids))
      if (expectation.routeName === undefined) {
        for (const failure of generated.failures) {
          if (failure.reason_code !== expectation.reasonCode) continue
          for (const sourceRefId of failure.source_ref_ids) if (!baselineSourceIds.has(sourceRefId)) injectedSourceIds.add(sourceRefId)
        }
      }
      const touchesInjectedIdentity = (failure: ReportFailure): boolean =>
        failure.row_ids.some((rowId) => injectedRowIds.has(rowId)) ||
        failure.source_ref_ids.some((sourceRefId) => injectedSourceIds.has(sourceRefId))
      const observedFailure = generated.failures.find((failure) =>
        failure.reason_code === expectation.reasonCode &&
        failure.status === expectation.status &&
        touchesInjectedIdentity(failure),
      ) ?? generated.failures.find((failure) =>
        failure.reason_code === expectation.reasonCode &&
        touchesInjectedIdentity(failure),
      )
      const observedStatus = observedFailure?.status === "duplicate" ? "duplicate" : observedFailure?.status === "source_unavailable" ? "source_unavailable" : observedFailure?.status === "source_hash_drift" ? "source_hash_drift" : observedFailure?.status === "gaps_found" ? "gaps_found" : generated.report.status
      return fixtureResultReport(falsifierId, generated, expectation, observedStatus, observedFailure?.reason_code ?? generated.report.status, true)
    } finally {
      yield* Effect.sync(() => rmSync(workspace.directory, { recursive: true, force: true }))
    }
  })
export const run = (options: RunOptions): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    if (options.mode === "fixture_injection") {
      if (options.falsifierId === undefined) {
        return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture_injection requires --falsifier F0..F19" }))
      }
      return yield* runFixtureFalsifier(options)
    }
    const generated = yield* generateFromRootsEffect(options)
    const committed: Record<string, string | null> = {}
    for (const name of COMMITTED_PROJECTIONS) committed[name] = yield* readProjectionEffect(options.root, PROJECTION_DIRECTORY, name)
    const diff = COMMITTED_PROJECTIONS.some((name) => committed[name] !== generated.bytes[name])
    let failures = diff && options.mode === "diff" ? [...generated.failures, buildFailure("stale", "STALE_ARTIFACT", [], [])] : [...generated.failures]
    if (options.mode === "write") {
      const latestGenerated = yield* generateFromRootsEffect(options)
      const latestDigest = sourceDigestForManifest(latestGenerated.sourceManifest)
      if (latestDigest !== sourceDigestForManifest(generated.sourceManifest)) failures = [...failures, buildFailure("source_hash_drift", "SOURCE_HASH_DRIFT", [], [])]
    }
    const primary = primaryFailure(failures, options.mode === "diff" && diff)
    let report = generated.report
    const schemaValidation = generated.report.verification.schema_validation
    const crossReferencesValid = generated.report.verification.cross_reference_validation
    const hasUnsafe = generated.sourceManifest.sources.some((source) => source.failure_reason === "UNSAFE_SOURCE") ||
      generated.routeRows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
      failures.some((failure) => failure.reason_code === "UNSAFE_SOURCE")
    if (options.mode === "write" && !hasUnsafe && !failures.some((failure) => ["source_unavailable", "schema_invalid", "source_hash_drift", "runtime_unavailable"].includes(failure.status))) {
      yield* writeProjectionSetEffect(options.root, PROJECTION_DIRECTORY, generated.bytes, COMMITTED_PROJECTIONS)
      report = reportWith({ mode: "write", falsifierId: null, status: "projection_written", exitCode: 14, projectionWrite: { status: "written", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes], failures, mismatches: generated.report.mismatches, deterministicDiff: "not_run", schemaValidation, crossReferenceValidation: crossReferencesValid })
    } else {
      report = reportWith({ mode: options.mode, falsifierId: null, status: primary.status, exitCode: primary.exitCode, projectionWrite: options.mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes], failures, mismatches: generated.report.mismatches, deterministicDiff: options.mode === "write" ? "not_run" : diff ? "different" : "equal", schemaValidation, crossReferenceValidation: crossReferencesValid })
    }
    return { exitCode: report.exit_code, report, artifacts: generated, projectionDiff: diff }
  })
