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
import { collectApiOperations, reportFailuresFromApi } from "./api.js"
import { collectC2 } from "./effects.js"
import { collectRoutes, routeRowsBySignature, setRowMismatch, updateEnvelopeRows } from "./routes.js"
import { finalizeManifest, sourceDigestForManifest, type ManifestContext } from "./source-manifest.js"
import { createManifestContextEffect, ParityRuntimeError, readProjectionEffect, writeProjectionSetEffect } from "./runtime.js"
import { validateInventory, validateOpenApiReconciliation, validateReport, validateSourceManifest } from "./schema.js"
import type { C2Collection } from "./effects.js"
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
export const COMMITTED_PROJECTIONS = ["source-manifest.json", "legacy-routes.json", "mono-routes.json", "api-operations.json", "command-write-paths.json", "scheduled-background-workflows.json", "external-integrations.json", "openapi-reconciliation.json"] as const
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
  const runtimeObservationIds = new Set(manifest.runtime_observations.map((observation) => observation.runtime_observation_ref_id))
  const allRowIds = inventories.flatMap((inventory) => inventory.rows.map((row) => row.row_id))
  const rowIds = new Set(allRowIds)
  if (rowIds.size !== allRowIds.length) return false
  if (inventories.some((inventory) => new Set(inventory.rows.map((row) => row.row_id)).size !== inventory.rows.length)) return false
  if (inventories.some((inventory) => inventory.source_manifest_sha256 !== sourceDigestForManifest(manifest))) return false
  for (const inventory of inventories) {
    for (const row of inventory.rows) {
      if (row.source_ref_ids.some((id) => !sourceIds.has(id)) || row.revision_ref_ids.some((id) => !revisionIds.has(id)) || row.runtime_observation_ref_ids.some((id) => !runtimeObservationIds.has(id))) return false
      if (row.mismatch.counterpart_row_ids.some((id) => !rowIds.has(id))) return false
      if (row.related_row_ids.some((id) => !rowIds.has(id))) return false
    }
    for (const link of inventory.links) {
      if (!rowIds.has(link.from_row_id) || !rowIds.has(link.to_row_id) || link.source_ref_ids.some((id) => !sourceIds.has(id))) return false
    }
    for (const observation of inventory.observations) {
      if (observation.source_ref_ids.some((id) => !sourceIds.has(id))) return false
    }
    for (const edge of inventory.derivation_edges) {
      if (edge.from_ref_ids.some((id) => !sourceIds.has(id)) || edge.to_row_ids.some((id) => !rowIds.has(id))) return false
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

const artifactBytes = (
  manifest: SourceManifest,
  legacy: InventoryEnvelope,
  mono: InventoryEnvelope,
  api: InventoryEnvelope,
  commandWrites: InventoryEnvelope,
  schedules: InventoryEnvelope,
  integrations: InventoryEnvelope,
  reconciliation: OpenApiReconciliation,
): Record<string, string> => ({
  "source-manifest.json": canonicalJson(manifest),
  "legacy-routes.json": canonicalJson(legacy),
  "mono-routes.json": canonicalJson(mono),
  "api-operations.json": canonicalJson(api),
  "command-write-paths.json": canonicalJson(commandWrites),
  "scheduled-background-workflows.json": canonicalJson(schedules),
  "external-integrations.json": canonicalJson(integrations),
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
  if (failures.some((failure) => failure.status === "stale") || projectionDiff) return { status: "stale", exitCode: 5 }
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
const hasUnsafeProjectionMetadata = (context: ManifestContext, preliminary: ReturnType<typeof collectRoutes>, preliminaryC2: C2Collection): boolean =>
  context.sources.some((source) => source.failure_reason === "UNSAFE_SOURCE") ||
  preliminary.failures.some((failure) => failure.reason_code === "UNSAFE_SOURCE") ||
  preliminary.legacy.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
  preliminary.mono.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
  preliminaryC2.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE") ||
  preliminaryC2.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE"))
const generateFromContext = (context: ManifestContext, mode: RunMode, falsifierId: string | null = null): GeneratedArtifacts => {

  const preliminary = collectRoutes(context, sha256("c1-source-manifest-pending"))
  const preliminaryApi = collectApiOperations(context, sha256("c1-source-manifest-pending"), preliminary.mono.rows, mode === "fixture_injection")
  const preliminaryC2 = collectC2(context, sha256("c2-source-manifest-pending"))
  if (hasUnsafeProjectionMetadata(context, preliminary, preliminaryC2) || preliminaryApi.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE")) throw new UnsafeSourceProjectionError("unsafe source metadata encountered during projection construction")
  const manifest = finalizeManifest(context)
  const manifestDigest = sourceDigestForManifest(manifest)
  let legacy = { ...preliminary.legacy, source_manifest_sha256: manifestDigest }
  let mono = { ...preliminary.mono, source_manifest_sha256: manifestDigest }
  let api = { ...preliminaryApi.inventory, source_manifest_sha256: manifestDigest }
  let commandWrites = { ...preliminaryC2.commandWrites, source_manifest_sha256: manifestDigest }
  let scheduledBackgroundWorkflows = { ...preliminaryC2.schedules, source_manifest_sha256: manifestDigest }
  let externalIntegrations = { ...preliminaryC2.integrations, source_manifest_sha256: manifestDigest }
  const reconciled = reconcileRoutes(legacy, mono)
  legacy = reconciled.legacy
  mono = reconciled.mono
  if (preliminaryApi.h3RouteRows.length > 0) {
    const h3RowsById = new Map(preliminaryApi.h3RouteRows.map((row) => [row.row_id, row]))
    const existingIds = new Set(mono.rows.map((row) => row.row_id))
    const mergedRows = mono.rows.map((row) => {
      const h3Row = h3RowsById.get(row.row_id)
      return h3Row === undefined
        ? row
        : { ...row, observation_kinds: h3Row.observation_kinds, source_ref_ids: sortUnique([...row.source_ref_ids, ...h3Row.source_ref_ids]), runtime_observation_ref_ids: sortUnique([...row.runtime_observation_ref_ids, ...h3Row.runtime_observation_ref_ids]) }
    })
    const additions = preliminaryApi.h3RouteRows.filter((row) => !existingIds.has(row.row_id))
    mono = { ...mono, rows: [...mergedRows, ...additions], observations: [...mono.observations, ...preliminaryApi.h3RouteObservations], observation_kinds: [...new Set([...mono.observation_kinds, "derived_h3"])] as typeof mono.observation_kinds, derivation_edges: [...mono.derivation_edges, ...preliminaryApi.h3RouteEdges] }
  }
  const reconciliation = { ...preliminaryApi.reconciliation, source_manifest_sha256: manifestDigest }
  const apiMismatches: ReportMismatch[] = []
  for (const row of api.rows) {
    if (row.mismatch.kind === "none") continue
    apiMismatches.push({ kind: row.mismatch.kind as ReportMismatch["kind"], row_ids: sortUnique([row.row_id, ...row.mismatch.counterpart_row_ids]), disposition: row.mismatch.disposition, accepted_intent_ref_ids: row.mismatch.accepted_intent_ref_ids })
  }
  if (reconciliation.status === "stale" && api.rows.length > 0) apiMismatches.push({ kind: "openapi_stale", row_ids: api.rows.map((row) => row.row_id), disposition: "none", accepted_intent_ref_ids: [] })
  const c2Mismatches: ReportMismatch[] = [...commandWrites.rows, ...scheduledBackgroundWorkflows.rows, ...externalIntegrations.rows]
    .filter((row) => row.mismatch.kind !== "none")
    .map((row) => ({ kind: row.mismatch.kind as ReportMismatch["kind"], row_ids: sortUnique([row.row_id, ...row.mismatch.counterpart_row_ids]), disposition: row.mismatch.disposition, accepted_intent_ref_ids: row.mismatch.accepted_intent_ref_ids }))
  const reportMismatches = [...new Map([...reconciled.mismatches, ...apiMismatches, ...c2Mismatches].map((entry) => [mismatchKey(entry), { ...entry, row_ids: sortUnique(entry.row_ids) }])).values()]
  const bytes = artifactBytes(manifest, legacy, mono, api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, reconciliation)
  const failures: ReportFailure[] = []
  const unavailableSources = manifest.sources.filter((source) => source.availability === "unavailable")
  const runtimeUnavailable = preliminaryApi.failures.some((failure) => failure.status === "runtime_unavailable")
  for (const source of unavailableSources) {
    if (source.failure_reason === "ABSENT_SOURCE_FAMILY") continue
    if (runtimeUnavailable && source.authority_role === "mono_api_runtime_observation") continue
    failures.push(buildFailure("source_unavailable", source.failure_reason ?? "SOURCE_UNAVAILABLE", [], [source.source_id]))
  }
  const unclassified = manifest.root_census.filter((record) => record.classification === "unclassified")
  for (const record of unclassified) failures.push(buildFailure("unresolved", "UNCLASSIFIED_SOURCE", [], record.source_ref_ids))
  for (const failure of preliminary.failures) failures.push(buildFailure(failure.status === "source_unavailable" ? "source_unavailable" : "unresolved", failure.reason_code, [], [failure.source_ref_id]))
  failures.push(...reportFailuresFromApi(preliminaryApi.failures))
  failures.push(...preliminaryC2.failures.map((failure) => buildFailure(failure.status, failure.reasonCode, failure.rowIds, failure.sourceRefIds)))
  const allRows = [...legacy.rows, ...mono.rows, ...api.rows, ...commandWrites.rows, ...scheduledBackgroundWorkflows.rows, ...externalIntegrations.rows]
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
    else if (row.status === "changed") failures.push(buildFailure("gaps_found", row.reason_codes.includes("STATIC_RUNTIME_MISMATCH") ? "STATIC_RUNTIME_MISMATCH" : "CHANGED_SIGNATURE", [row.row_id, ...row.related_row_ids], row.source_ref_ids))
  }
  const inventories = [legacy, mono, api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations]
  const schemaValidation = validateSourceManifest(manifest) && validateInventory(legacy) && validateInventory(mono) && validateInventory(api) && validateInventory(commandWrites) && validateInventory(scheduledBackgroundWorkflows) && validateInventory(externalIntegrations) && validateOpenApiReconciliation(reconciliation)
  if (!schemaValidation) failures.push(buildFailure("schema_invalid", "SCHEMA_VALIDATION_FAILED", [], []))
  const crossReferencesValid = crossReferenceValidation(manifest, inventories, reportMismatches)
  if (!crossReferencesValid) failures.push(buildFailure("schema_invalid", "CROSS_REFERENCE_VALIDATION_FAILED", [], []))
  failures.push(buildFailure("gaps_found", "C0_BOUNDED_SCOPE", [], []))
  const primary = primaryFailure(failures, false)
  let report = reportWith({ mode, falsifierId, status: primary.status, exitCode: primary.exitCode, projectionWrite: mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: manifestDigest, artifactBytes: bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: mode === "write" ? "not_run" : "different", schemaValidation, crossReferenceValidation: crossReferencesValid })
  if (!validateReport(report)) {
    failures.push(buildFailure("schema_invalid", "REPORT_SCHEMA_VALIDATION_FAILED", [], []))
    const reportPrimary = primaryFailure(failures, false)
    report = reportWith({ mode, falsifierId, status: reportPrimary.status, exitCode: reportPrimary.exitCode, projectionWrite: mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: manifestDigest, artifactBytes: bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: mode === "write" ? "not_run" : "different", schemaValidation: false, crossReferenceValidation: crossReferencesValid })
  }
  return { sourceManifest: manifest, legacyRoutes: legacy, monoRoutes: mono, apiOperations: api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, openapiReconciliation: reconciliation, report, bytes, failures, routeRows: [...legacy.rows, ...mono.rows], apiRows: [...api.rows], c2Rows: [...commandWrites.rows, ...scheduledBackgroundWorkflows.rows, ...externalIntegrations.rows] }
}
const generateFromRootsEffect = (options: RunOptions): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
  Effect.gen(function* () {
    const context = yield* createManifestContextEffect(options.legacyRoot, options.root)
    return yield* Effect.try({
      try: () => generateFromContext(context, options.mode, options.falsifierId ?? null),
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
  F8_openapi_stale: true,
  F9_runtime_unavailable: true,
  F10_static_runtime_mismatch: true,
  F13_unknown_effect: true,
  F14_absent_schedule: true,
  F16_h3_authority_copy: true,
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
    case "F8_openapi_stale": return { status: "stale", reasonCode: "STALE_OPENAPI_PROJECTION" }
    case "F9_runtime_unavailable": return { status: "runtime_unavailable", reasonCode: "RUNTIME_UNAVAILABLE" }
    case "F13_unknown_effect": return { status: "unresolved", reasonCode: "UNKNOWN_EFFECT" }
    case "F10_static_runtime_mismatch": return { status: "unresolved", reasonCode: "STATIC_RUNTIME_MISMATCH", routeName: "fixture_api" }
    case "F14_absent_schedule": return { status: "gaps_found", reasonCode: "ABSENT_SCHEDULE" }
    case "F16_h3_authority_copy": return { status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY" }
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
  { root: "mono", path: "package.json", contents: JSON.stringify({ scripts: { "fixture-schedule": "bun infra/schedules.ts" }, exports: { "./schedule": "./infra/schedules.ts" } }) },
  { root: "mono", path: "infra/schedules.ts", contents: "export function FixtureHandler(): void {}\nschedule('fixture_cron', '0 0 * * *', FixtureHandler)\n" },
  { root: "legacy", path: "src/AppBundle/Service/Fixture.php", contents: "<?php\nfinal class FixtureService {}\n" },
  { root: "mono", path: "apps/server/config/routes.yaml", contents: "fixture_base:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /fixture/base\n    methods: ['GET']\n" },
  { root: "mono", path: "apps/server/src/App/Api/Resource/Fixture.php", contents: "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(shortName: 'Fixture', operations: [new Get(uriTemplate: '/fixture/api', name: 'fixture_api')])]\nfinal class FixtureResource {}\n" },
  { root: "mono", path: "apps/server/src/App/Fixture/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController {}\n" },
  { root: "mono", path: "evidence/security-h3/0015/source-manifest.json", contents: "[]" },
  { root: "legacy", path: "src/AppBundle/Command/FixtureCommand.php", contents: "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Repository\\FixtureRepository;\nfinal class FixtureCommand { public static $defaultName = 'fixture:send'; private FixtureRepository $repository; public function __invoke(): void { $this->repository->save('fixture'); } }\n" },
  { root: "legacy", path: "src/AppBundle/Repository/FixtureRepository.php", contents: "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nfinal class FixtureRepository { public function save(string $value): void {} }\n" },
  { root: "legacy", path: "app/config/services.yml", contents: "services:\n  fixture_command:\n    class: App\\Fixture\\Infrastructure\\Command\\FixtureCommand\n" },
  { root: "legacy", path: "app/config/scheduler.yml", contents: "fixture_cron:\n  cron: '0 0 * * *'\n  handler: AppBundle\\Fixture\\Command\\FixtureCommand\n" },
  { root: "mono", path: "apps/server/src/App/Infrastructure/Command/FixtureCommand.php", contents: "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Repository\\FixtureRepository;\n#[AsCommand(name: 'fixture:send')]\nfinal class FixtureCommand { private FixtureRepository $repository; public function __invoke(): void { $this->repository->save('fixture'); } }\n" },
  { root: "mono", path: "apps/server/src/App/Infrastructure/Repository/FixtureRepository.php", contents: "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nfinal class FixtureRepository { public function save(string $value): void {} }\n" },
  { root: "mono", path: "apps/server/config/services.yaml", contents: "services:\n  fixture_command:\n    class: App\\Fixture\\Infrastructure\\Command\\FixtureCommand\n" },
  { root: "mono", path: "evidence/security-h3/0015/route-collector.json", contents: "{}" },
  { root: "mono", path: "apps/server/src/App/Infrastructure/Fixture.php", contents: "<?php\nfinal class FixtureInfrastructure {}\n" },
  { root: "mono", path: "apps/server/tools/security-h3/0015/generate.ts", contents: "export const fixture = true\n" },
  { root: "mono", path: "apps/homepage/src/routes/home.tsx", contents: "export default function Home(){return null}\n" },
  { root: "mono", path: "apps/server/var/parity/api-operations.json", contents: JSON.stringify([{ resource_class_ref: "App\\Fixture\\Api\\Resource\\FixtureResource", operation_name: "Get", method: "GET", uri_template: "/fixture/api", operation_id: "fixture_api" }]) },
  { root: "mono", path: "packages/sdk/openapi.json", contents: JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture API", version: "1.0.0" }, paths: { "/fixture/api": { get: { operationId: "fixture_api", responses: { "200": { description: "OK" } } } } }, components: {} }) },
  { root: "mono", path: "evidence/security-h3/0015/current-route-inventory.json", contents: JSON.stringify([{ path_template: "/fixture/base", methods: ["GET"], operation_id: "route:fixture_base", source_ref_ids: ["source:apps/server/src/App/Api/Resource/Fixture.php:1:fixture"] }]) },
  { root: "mono", path: "evidence/security-h3/0015/current-resource-inventory.json", contents: JSON.stringify([{ path_template: "/fixture/api", methods: ["GET"], operation_id: "api:App\\Fixture\\Api\\Resource\\FixtureResource:Get:fixture_api", source_ref_ids: ["source:apps/server/src/App/Api/Resource/Fixture.php:1:fixture"] }]) },
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
    const resourcePath = join(root, "apps/server/src/App/Api/Resource/Fixture.php")
    const resourceBytes = readFileSync(resourcePath)
    const resourceDigest = sha256(resourceBytes.toString("utf8")).slice("sha256:".length)
    const resourceRef = `source:apps/server/src/App/Api/Resource/Fixture.php:1:${resourceDigest}`
    writeFileSync(join(root, "evidence/security-h3/0015/source-manifest.json"), JSON.stringify([{ bytes: resourceBytes.byteLength, path: "apps/server/src/App/Api/Resource/Fixture.php", sha256: resourceDigest }]), "utf8")
    for (const artifactPath of ["evidence/security-h3/0015/current-route-inventory.json", "evidence/security-h3/0015/current-resource-inventory.json"]) {
      const artifact = JSON.parse(readFileSync(join(root, artifactPath), "utf8")) as Array<Record<string, unknown>>
      writeFileSync(join(root, artifactPath), JSON.stringify(artifact.map((record) => ({ ...record, source_ref_ids: [resourceRef] }))), "utf8")
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
    case "F8_openapi_stale":
      writeFileSync(join(workspace.root, "packages/sdk/openapi.json"), JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture API", version: "1.0.0" }, paths: { "/fixture/api": { get: { operationId: "fixture_api_changed", responses: { "200": { description: "OK" } } } } }, components: {} }), "utf8")
      return
    case "F9_runtime_unavailable":
      rmSync(join(workspace.root, "apps/server/var/parity/api-operations.json"), { force: true })
      return
    case "F10_static_runtime_mismatch":
      writeFileSync(join(workspace.root, "apps/server/var/parity/api-operations.json"), JSON.stringify([{ resource_class_ref: "App\\Fixture\\Api\\Resource\\FixtureResource", operation_name: "Get", method: "POST", uri_template: "/fixture/api-mismatch", operation_id: "fixture_api" }]), "utf8")
      writeFileSync(join(workspace.root, "packages/sdk/openapi.json"), JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture API", version: "1.0.0" }, paths: { "/fixture/api-mismatch": { post: { operationId: "fixture_api", responses: { "200": { description: "OK" } } } } }, components: {} }), "utf8")
      return
    case "F13_unknown_effect": {
      const commandPath = join(workspace.root, "apps/server/src/App/Infrastructure/Command/FixtureCommand.php")
      const current = readFileSync(commandPath, "utf8")
      writeFileSync(commandPath, current.replace("$this->repository->save", "$this->delegate->perform"), "utf8")
      return
    }
    case "F14_absent_schedule":
      for (const relative of [".github/workflows", "infra", "apps/server/config", "apps/server/src/App/Infrastructure/Command", "apps/server/src/App/Infrastructure/EventSubscriber"]) {
        rmSync(join(workspace.root, relative), { recursive: true, force: true })
      }
      return
    case "F16_h3_authority_copy":
      writeFileSync(join(workspace.root, "evidence/security-h3/0015/current-resource-inventory.json"), JSON.stringify([{ path_template: "/fixture/api", methods: ["GET"], operation_id: "fixture_api" }]), "utf8")
      return
    default:
      return
  }
}
const c2FixtureSemanticKey = (row: InventoryRow): string => {
  const details = row.details as unknown as Record<string, unknown>
  if (row.inventory_kind === "command_write") return canonicalJson(["command_write", row.authority_line, row.declaration_id, details.owner_ref ?? null, details.command_name ?? null])
  if (row.inventory_kind === "schedule_background") return canonicalJson(["schedule_background", row.authority_line, row.declaration_id, details.trigger_kind ?? null, details.trigger_identity ?? null])
  return canonicalJson([row.inventory_kind, row.authority_line, row.declaration_id])
}

const fixtureResultReport = (falsifierId: FalsifierId, generated: GeneratedArtifacts, expectation: FixtureExpectation, observedStatus: ZeroGapReport["status"], observedReason: string, deterministic: boolean, causalFailure: ReportFailure | null = null): RunResult => {
  const allRows = [...generated.routeRows, ...generated.apiRows, ...generated.c2Rows]
  const rowIds = allRows.map((row) => row.row_id)
  const sourceRefIds = allRows.flatMap((row) => row.source_ref_ids)
  const matched = deterministic && observedStatus === expectation.status && observedReason === expectation.reasonCode
  const observedFailureStatus: ReportFailure["status"] = (matched && falsifierId === "F0_deterministic_replay" ? "gaps_found" : generated.report.status === "falsifier_passed" ? "unresolved" : generated.report.status === "zero_gap" ? "gaps_found" : generated.report.status) as ReportFailure["status"]
  const observedFailure = causalFailure ?? buildFailure(observedFailureStatus, matched && falsifierId === "F0_deterministic_replay" ? expectation.reasonCode : observedReason, rowIds, sourceRefIds)
  const failures = matched ? [...generated.failures, observedFailure] : [...generated.failures, buildFailure("command_error", "FALSIFIER_EXPECTATION_MISMATCH", rowIds, sourceRefIds), observedFailure]
  const reportStatus: ZeroGapReport["status"] = matched ? "falsifier_passed" : "command_error"
  const report = reportWith({ mode: "fixture_injection", falsifierId, status: reportStatus, exitCode: matched ? 13 : 12, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes, generated.apiOperations, generated.commandWrites, generated.scheduledBackgroundWorkflows, generated.externalIntegrations], failures, mismatches: generated.report.mismatches, deterministicDiff: deterministic ? "equal" : "different", schemaValidation: generated.report.verification.schema_validation, crossReferenceValidation: generated.report.verification.cross_reference_validation })
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
        const first = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
        const second = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
        const deterministic = COMMITTED_PROJECTIONS.every((name) => first.bytes[name] === second.bytes[name])
        return fixtureResultReport(falsifierId, first, expectation, deterministic ? "falsifier_passed" : "command_error", deterministic ? expectation.reasonCode : "NONDETERMINISTIC_OUTPUT", deterministic)
      }
      if (falsifierId === "F2_source_hash_drift") {
        const generated = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
        const source = join(workspace.legacyRoot, "app/config/routing.yml")
        appendText(source, routeYaml("fixture_drift", "/fixture/drift", "GET"))
        const after = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
        const drifted = sourceDigestForManifest(after.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest)
        return fixtureResultReport(falsifierId, after, expectation, drifted ? "source_hash_drift" : "command_error", drifted ? expectation.reasonCode : "SOURCE_HASH_DRIFT_NOT_DETECTED", drifted)
      }
      const baseline = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
      const baselineFailureIds = new Set(baseline.failures.map((failure) => failure.failure_id))
      const baselineCausalRow = falsifierId === "F13_unknown_effect"
        ? baseline.c2Rows.find((row) => row.authority_line === "mono" && row.inventory_kind === "command_write" && "command_name" in row.details && row.details.command_name === "fixture:send")
        : undefined
      const baselineRowIds = new Set([...baseline.routeRows, ...baseline.apiRows, ...baseline.c2Rows].map((row) => row.row_id))
      const baselineCausalKey = baselineCausalRow === undefined ? null : c2FixtureSemanticKey(baselineCausalRow)
      const baselineCausalClean = falsifierId === "F13_unknown_effect"
        ? baselineCausalRow !== undefined && baselineCausalRow.status === "covered" && !baselineCausalRow.reason_codes.includes("UNKNOWN_EFFECT")
        : falsifierId === "F14_absent_schedule"
          ? !baseline.c2Rows.some((row) => row.authority_line === "mono" && row.inventory_kind === "schedule_background" && row.status === "absent")
          : true
      mutateFixture(falsifierId, workspace)
      const generated = yield* generateFromRootsEffect({ ...options, root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" })
      const routeNameOf = (row: InventoryRow): string | null => {
        if ("route_name" in row.details) return row.details.route_name
        if ("operation_id" in row.details) return row.details.operation_id
        if ("operation_name" in row.details) {
          const operationName = row.details.operation_name
          return typeof operationName === "string" ? operationName : null
        }
        return null
      }
      const generatedRows = [...generated.routeRows, ...generated.apiRows]
      const injectedRows = expectation.routeName === undefined
        ? []
        : generatedRows.filter((row) =>
          !baselineRowIds.has(row.row_id) &&
          routeNameOf(row) === expectation.routeName &&
          (expectation.routeAuthority === undefined || row.authority_line === expectation.routeAuthority),
        )
      const injectedRowIds = new Set(injectedRows.map((row) => row.row_id))
      const injectedSourceIds = new Set(injectedRows.flatMap((row) => row.source_ref_ids))
      const mutationChanged = sourceDigestForManifest(baseline.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest) ||
        COMMITTED_PROJECTIONS.some((name) => baseline.bytes[name] !== generated.bytes[name])
      let causalFailure: ReportFailure | null = null
      let causalMatch = true
      if (falsifierId === "F13_unknown_effect") {
        const generatedTarget = baselineCausalKey === null ? undefined : generated.c2Rows.find((row) => c2FixtureSemanticKey(row) === baselineCausalKey)
        causalFailure = generatedTarget === undefined ? null : generated.failures.find((failure) =>
          failure.reason_code === expectation.reasonCode &&
          failure.status === expectation.status &&
          failure.row_ids.includes(generatedTarget.row_id),
        ) ?? null
        causalMatch = mutationChanged && baselineCausalClean && generatedTarget !== undefined && generatedTarget.status === "unresolved" && generatedTarget.reason_codes.includes("UNKNOWN_EFFECT") && causalFailure !== null
      } else if (falsifierId === "F14_absent_schedule") {
        const generatedAbsentRows = generated.c2Rows.filter((row) => row.authority_line === "mono" && row.inventory_kind === "schedule_background" && row.status === "absent" && row.reason_codes.includes("ABSENT_SCHEDULE"))
        const generatedTarget = generatedAbsentRows.length === 1 ? generatedAbsentRows[0] : undefined
        causalFailure = generatedTarget === undefined ? null : generated.failures.find((failure) =>
          failure.reason_code === expectation.reasonCode &&
          failure.status === expectation.status &&
          failure.row_ids.includes(generatedTarget.row_id),
        ) ?? null
        causalMatch = mutationChanged && baselineCausalClean && generatedTarget !== undefined && causalFailure !== null
      }
      const touchesInjectedIdentity = (failure: ReportFailure): boolean =>
        failure.row_ids.some((rowId) => injectedRowIds.has(rowId)) || failure.source_ref_ids.some((sourceRefId) => injectedSourceIds.has(sourceRefId))
      const observedFailure = falsifierId === "F13_unknown_effect" || falsifierId === "F14_absent_schedule"
        ? causalFailure
        : expectation.routeName === undefined
          ? generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && mutationChanged && !baselineFailureIds.has(failure.failure_id)) ?? null
          : generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && touchesInjectedIdentity(failure)) ?? null
      const observedStatus = causalMatch && observedFailure !== null && observedFailure !== undefined ? observedFailure.status : observedFailure?.status ?? generated.report.status
      const observedReason = causalMatch && observedFailure !== null && observedFailure !== undefined ? observedFailure.reason_code : causalMatch ? observedFailure?.reason_code ?? generated.report.status : "FALSIFIER_CAUSALITY_MISMATCH"
      return fixtureResultReport(falsifierId, generated, expectation, observedStatus, observedReason, true, causalMatch ? observedFailure ?? null : null)
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
      [...generated.routeRows, ...generated.apiRows, ...generated.c2Rows].some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
      failures.some((failure) => failure.reason_code === "UNSAFE_SOURCE")
    const c2WriteBlocked = generated.c2Rows.some((row) =>
      row.status === "unresolved" ||
      row.status === "duplicate" ||
      row.status === "dead_unimported" ||
      row.reason_codes.includes("UNKNOWN_EFFECT") ||
      row.reason_codes.includes("UNKNOWN_INTEGRATION") ||
      row.reason_codes.includes("SCHEDULE_PARSE_INCOMPLETE") ||
      row.reason_codes.includes("SCHEDULE_EXPRESSION_UNRESOLVED") ||
      row.reason_codes.includes("SCHEDULE_REGISTRATION_UNRESOLVED") ||
      row.reason_codes.includes("ABSENT_SCHEDULE") ||
      (row.mismatch.kind === "absent" && row.mismatch.disposition !== "accepted_absent"),
    )
    const writeDenied = hasUnsafe || c2WriteBlocked || failures.some((failure) =>
      ["source_unavailable", "schema_invalid", "source_hash_drift", "runtime_unavailable", "stale"].includes(failure.status) ||
      ["UNSAFE_SOURCE", "OPENAPI_SCHEMA_INVALID", "OPENAPI_SOURCE_PARSE_ERROR", "STATIC_RUNTIME_MISMATCH"].includes(failure.reason_code),
    )
    if (options.mode === "write" && !writeDenied) {
      yield* writeProjectionSetEffect(options.root, PROJECTION_DIRECTORY, generated.bytes, COMMITTED_PROJECTIONS)
      report = reportWith({ mode: "write", falsifierId: null, status: "projection_written", exitCode: 14, projectionWrite: { status: "written", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes, generated.apiOperations, generated.commandWrites, generated.scheduledBackgroundWorkflows, generated.externalIntegrations], failures, mismatches: generated.report.mismatches, deterministicDiff: "not_run", schemaValidation, crossReferenceValidation: crossReferencesValid })
    } else {
      report = reportWith({ mode: options.mode, falsifierId: null, status: primary.status, exitCode: primary.exitCode, projectionWrite: options.mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes, generated.apiOperations, generated.commandWrites, generated.scheduledBackgroundWorkflows, generated.externalIntegrations], failures, mismatches: generated.report.mismatches, deterministicDiff: options.mode === "write" ? "not_run" : diff ? "different" : "equal", schemaValidation, crossReferenceValidation: crossReferencesValid })
    }
    return { exitCode: report.exit_code, report, artifacts: generated, projectionDiff: diff }
  })
