import { Effect } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import {
  canonicalJson,
  compareByteOrder,
  failureId,
  relationId,
  sha256,
  sortUnique,
} from "./canonical.js"
import { API_RUNTIME_FIXTURE_PATH, collectApiOperations, reportFailuresFromApi, type ApiRuntimeFixtureInput } from "./api.js"
import { collectC2 } from "./effects.js"
import { collectRoutes, routeRowsBySignature, setRowMismatch, updateEnvelopeRows, type CollectedRouteArtifacts } from "./routes.js"
import { finalizeManifest, sourceDigestForManifest, type ManifestContext } from "./source-manifest.js"
import {
  createManifestContextEffect,
  ParityRuntimeError,
  assertIndependentAuthorityRoots,
  readPinnedIntentRegisterEffect,
  readPinnedRuntimeEvidenceRegisterEffect,
  readProjectionDirectoryEffect,
  readProjectionEffect,
  registerRuntimeEvidenceAuthority,
  writeProjectionSetEffect,
  type PinnedIntentRegister,
  type PinnedRuntimeEvidenceRegister,
} from "./runtime.js"
import { canonicalRuntimeEvidenceBytes, makeRuntimeEvidenceReceipt, makeRuntimeEvidenceRegister, runtimeEvidenceObservation } from "./runtime-evidence.js"
import {
  acceptedIntentRevisionRefId,
  coverageFailuresAsReportFailures,
  loadAcceptedIntentRegister,
  resolveJourneyCoverage,
  validateCrossArtifactInvariants,
  type IntentSourceInput,
} from "./coverage.js"
import {
  deriveReportMismatches,
  validateGeneratedArtifactSet,
  validateReportBundle,
  validateInventory,
  validateOpenApiReconciliation,
  validateSourceManifest,
  type ProjectionObservation,
} from "./schema.js"
import type { C2Collection } from "./effects.js"
import type {
  CollectorExecutables,
  EvidenceAuthorityEvidence,
  GeneratedArtifacts,
  IntentAuthorityEvidence,
  InventoryEnvelope,
  InventoryRow,
  OpenApiReconciliation,
  ReportFailure,
  ReportMismatch,
  RuntimeEvidenceRegister,
  SourceManifest,
  ZeroGapReport,
} from "./types.js"

export const PROJECTION_DIRECTORY = "evidence/functional-parity"
export const COMMITTED_PROJECTIONS = ["source-manifest.json", "legacy-routes.json", "mono-routes.json", "api-operations.json", "command-write-paths.json", "scheduled-background-workflows.json", "external-integrations.json", "user-journey-coverage.json"] as const
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
  readonly intentRegisterPath?: string
  readonly evidenceRegisterPath?: string
  readonly collectorExecutables?: CollectorExecutables
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
  userJourneyCoverage: InventoryEnvelope,
  reconciliation: OpenApiReconciliation,
): Record<string, string> => ({
  "source-manifest.json": canonicalJson(manifest),
  "legacy-routes.json": canonicalJson(legacy),
  "mono-routes.json": canonicalJson(mono),
  "api-operations.json": canonicalJson(api),
  "command-write-paths.json": canonicalJson(commandWrites),
  "scheduled-background-workflows.json": canonicalJson(schedules),
  "external-integrations.json": canonicalJson(integrations),
  "user-journey-coverage.json": canonicalJson(userJourneyCoverage),
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
  if (failures.some((failure) => failure.status === "gaps_found")) return { status: "gaps_found", exitCode: 2 }
  return { status: "zero_gap", exitCode: 0 }
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
  readonly forbiddenStatesEmpty?: boolean
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
    forbidden_states_empty: params.forbiddenStatesEmpty ?? false,
  },
})

class UnsafeSourceProjectionError extends Error {}
const hasUnsafeProjectionMetadata = (context: ManifestContext, preliminary: CollectedRouteArtifacts, preliminaryC2: C2Collection): boolean =>
  context.sources.some((source) => source.failure_reason === "UNSAFE_SOURCE") ||
  preliminary.failures.some((failure) => failure.reason_code === "UNSAFE_SOURCE") ||
  preliminary.legacy.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
  preliminary.mono.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE")) ||
  preliminaryC2.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE") ||
  preliminaryC2.rows.some((row) => row.reason_codes.includes("UNSAFE_SOURCE"))

const reportMismatchesFromRows = (rows: readonly InventoryRow[]): readonly ReportMismatch[] => {
  const unique = new Map<string, ReportMismatch>()
  for (const row of rows) {
    if (row.mismatch.kind === "none") continue
    const mismatch: ReportMismatch = {
      kind: row.mismatch.kind as ReportMismatch["kind"],
      row_ids: sortUnique([row.row_id, ...row.mismatch.counterpart_row_ids]),
      disposition: row.mismatch.disposition,
      accepted_intent_ref_ids: row.mismatch.accepted_intent_ref_ids,
    }
    unique.set(mismatchKey(mismatch), mismatch)
  }
  return [...unique.values()]
}

const forbiddenStatesEmpty = (inventories: readonly InventoryEnvelope[], reconciliation: OpenApiReconciliation, failures: readonly ReportFailure[], crossReferencesValid: boolean): boolean => {
  const forbiddenStatuses = new Set(["missing", "extra", "changed", "uncovered", "unresolved", "stale", "duplicate", "dead_unimported", "absent"])
  const forbiddenKinds = new Set(["missing", "extra", "changed", "uncovered", "unresolved", "stale", "openapi_stale", "duplicate"])
  return crossReferencesValid && reconciliation.status === "current" && failures.length === 0 && inventories.every((inventory) => inventory.inventory_kind === "user_journey" || inventory.rows.every((row) => !forbiddenStatuses.has(row.status) && !forbiddenKinds.has(row.mismatch.kind) && row.coverage_ref_ids.length > 0))
}

const generateFromContext = (
  context: ManifestContext,
  mode: RunMode,
  falsifierId: string | null = null,
  intentAuthority: PinnedIntentRegister | null = null,
  fixtureIntent?: IntentSourceInput,
  collectorExecutables?: CollectorExecutables,
  fixtureRuntimeInput?: ApiRuntimeFixtureInput,
  evidenceAuthority: EvidenceAuthorityEvidence | null = null,
  runtimeEvidenceRegister: RuntimeEvidenceRegister | null = null,
): GeneratedArtifacts => {
  const intentInput: IntentSourceInput | undefined = intentAuthority === null
    ? fixtureIntent
    : {
      path: `authority://blob/${intentAuthority.blobOid}`,
      bytes: intentAuthority.bytes,
      revisionRefId: intentAuthority.revisionRefId,
      repositoryRef: "external_intent_authority",
      revision: intentAuthority.revision,
      blobOid: intentAuthority.blobOid,
      digest: intentAuthority.digest,
    }
  const intentLoad = loadAcceptedIntentRegister(context, intentInput)
  const fixtureUnsafeProbe = mode === "fixture_injection" && falsifierId === "F15_secret_or_pii_input"
  if (intentLoad.issues.some((entry) => entry.reasonCode === "UNSAFE_SOURCE") && !fixtureUnsafeProbe) throw new UnsafeSourceProjectionError("unsafe source metadata encountered during intent loading")
  const preliminary = collectRoutes(context, sha256("c1-source-manifest-pending"), collectorExecutables, mode === "fixture_injection" || falsifierId === "F18_stale_artifact_diff")
  const preliminaryApi = collectApiOperations(context, sha256("c1-source-manifest-pending"), preliminary.mono.rows, mode === "fixture_injection" || falsifierId === "F18_stale_artifact_diff", collectorExecutables, fixtureRuntimeInput)
  const preliminaryC2 = collectC2(context, sha256("c2-source-manifest-pending"))
  if ((hasUnsafeProjectionMetadata(context, preliminary, preliminaryC2) || preliminaryApi.failures.some((failure) => failure.reasonCode === "UNSAFE_SOURCE")) && !fixtureUnsafeProbe) throw new UnsafeSourceProjectionError("unsafe source metadata encountered during projection construction")
  if (runtimeEvidenceRegister !== null) {
    const existingRuntimeRefs = new Set(context.runtimeObservations.map((observation) => observation.runtime_observation_ref_id))
    for (const receipt of runtimeEvidenceRegister.receipts) {
      if (!existingRuntimeRefs.has(receipt.receipt_ref_id)) context.runtimeObservations.push(runtimeEvidenceObservation(receipt))
    }
  }
  const finalizedManifest = finalizeManifest(context)
  const manifest: SourceManifest = {
    ...finalizedManifest,
    ...(intentAuthority === null
      ? {}
      : {
          intent_authority: {
            repository_ref: "external_intent_authority" as const,
            authority_path: `authority://blob/${intentAuthority.blobOid}`,
            revision_ref_id: intentAuthority.revisionRefId,
            revision: intentAuthority.revision,
            blob_oid: intentAuthority.blobOid,
            digest: intentAuthority.digest,
            immutable: true as const,
          },
        }),
    ...(evidenceAuthority === null
      ? {}
      : {
          evidence_authority: {
            repository_ref: evidenceAuthority.repository_ref,
            authority_path: evidenceAuthority.authority_path,
            revision_ref_id: evidenceAuthority.revision_ref_id,
            revision: evidenceAuthority.revision,
            blob_oid: evidenceAuthority.blob_oid,
            digest: evidenceAuthority.digest,
            source_ref_ids: evidenceAuthority.source_ref_ids,
            immutable: true as const,
          },
        }),
  }
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
  const preCoverageInventories = [legacy, mono, api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations]
  const registerIssues = intentLoad.issues
  const coverage = resolveJourneyCoverage({
    manifest,
    inventories: preCoverageInventories,
    register: intentLoad.register,
    registerSourceRefId: intentLoad.sourceRefId,
    registerIssues,
    runtimeEvidence: runtimeEvidenceRegister,
    requireRuntimeEvidence: mode !== "fixture_injection",
  })
  const coveredInventories = coverage.inventories
  legacy = coveredInventories[0] as InventoryEnvelope
  mono = coveredInventories[1] as InventoryEnvelope
  api = coveredInventories[2] as InventoryEnvelope
  commandWrites = coveredInventories[3] as InventoryEnvelope
  scheduledBackgroundWorkflows = coveredInventories[4] as InventoryEnvelope
  externalIntegrations = coveredInventories[5] as InventoryEnvelope
  const inventories = [legacy, mono, api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, coverage.userJourneyCoverage]
  const allRows = inventories.flatMap((inventory) => inventory.rows)
  const reportMismatches = [...new Map([...reconciled.mismatches, ...reportMismatchesFromRows(allRows), ...(reconciliation.status === "stale" ? [{ kind: "openapi_stale" as const, row_ids: api.rows.map((row) => row.row_id), disposition: "none" as const, accepted_intent_ref_ids: [] as string[] }] : [])].map((entry) => [mismatchKey(entry), { ...entry, row_ids: sortUnique(entry.row_ids) }])).values()]
  const bytes = artifactBytes(manifest, legacy, mono, api, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, coverage.userJourneyCoverage, reconciliation)
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
  for (const failure of preliminary.failures) failures.push(buildFailure(failure.reason_code === "RUNTIME_UNAVAILABLE" || failure.reason_code.startsWith("COLLECTOR_") ? "runtime_unavailable" : failure.status === "source_unavailable" ? "source_unavailable" : "unresolved", failure.reason_code, [], [failure.source_ref_id]))
  failures.push(...reportFailuresFromApi(preliminaryApi.failures))
  failures.push(...preliminaryC2.failures.map((failure) => buildFailure(failure.status, failure.reasonCode, failure.rowIds, failure.sourceRefIds)))
  failures.push(...coverageFailuresAsReportFailures(coverage.issues))
  if (reconciliation.status === "stale") failures.push(buildFailure("stale", "STALE_OPENAPI_PROJECTION", api.rows.map((row) => row.row_id), []))
  if (reconciliation.status === "unresolved") failures.push(buildFailure("unresolved", "OPENAPI_RECONCILIATION_UNRESOLVED", api.rows.map((row) => row.row_id), []))
  for (const row of allRows) {
    if (row.reason_codes.includes("UNSAFE_SOURCE")) {
      failures.push(buildFailure("source_unavailable", "UNSAFE_SOURCE", [row.row_id], row.source_ref_ids))
      continue
    }
    if (row.status === "duplicate") failures.push(buildFailure("duplicate", "DUPLICATE_CANONICAL_IDENTITY", [row.row_id, ...row.mismatch.counterpart_row_ids], row.source_ref_ids))
    else if (row.status === "unresolved") failures.push(buildFailure("unresolved", row.reason_codes[0] ?? "SOURCE_PARSE_ERROR", [row.row_id], row.source_ref_ids))
    else if (row.status === "dead_unimported") failures.push(buildFailure("gaps_found", "DEAD_UNIMPORTED_SOURCE", [row.row_id], row.source_ref_ids))
    else if (row.status === "missing") failures.push(buildFailure("gaps_found", "MISSING_COUNTERPART", [row.row_id], row.source_ref_ids))
    else if (row.status === "extra") failures.push(buildFailure("gaps_found", "EXTRA_COUNTERPART", [row.row_id], row.source_ref_ids))
    else if (row.status === "changed") failures.push(buildFailure("gaps_found", row.reason_codes.includes("STATIC_RUNTIME_MISMATCH") ? "STATIC_RUNTIME_MISMATCH" : "CHANGED_SIGNATURE", [row.row_id, ...row.related_row_ids], row.source_ref_ids))
    else if (row.status === "uncovered") failures.push(buildFailure("gaps_found", "COVERAGE_REF_REQUIRED", [row.row_id], row.source_ref_ids))
    else if (row.status === "absent") failures.push(buildFailure("gaps_found", "ABSENT_SCHEDULE", [row.row_id], row.source_ref_ids))
  }
  const schemaValidation = validateSourceManifest(manifest) && validateInventory(legacy) && validateInventory(mono) && validateInventory(api) && validateInventory(commandWrites) && validateInventory(scheduledBackgroundWorkflows) && validateInventory(externalIntegrations) && validateInventory(coverage.userJourneyCoverage) && validateOpenApiReconciliation(reconciliation)
  if (!schemaValidation) failures.push(buildFailure("schema_invalid", "SCHEMA_VALIDATION_FAILED", [], []))
  const crossReferencesValid = crossReferenceValidation(manifest, inventories, reportMismatches) && validateCrossArtifactInvariants({ manifest, inventories: inventories.slice(0, 6), userJourneyCoverage: coverage.userJourneyCoverage, register: coverage.register, links: [...reconciled.links, ...coverage.links] })
  if (!crossReferencesValid) failures.push(buildFailure("schema_invalid", "CROSS_REFERENCE_VALIDATION_FAILED", [], []))
  const dedupedFailures = [...new Map(failures.map((failure) => [failure.failure_id, failure])).values()].sort((left, right) => compareByteOrder(left.failure_id, right.failure_id))
  const primary = primaryFailure(dedupedFailures, false)
  const noForbidden = forbiddenStatesEmpty(inventories, reconciliation, dedupedFailures, schemaValidation && crossReferencesValid)
  const report = reportWith({ mode, falsifierId, status: primary.status, exitCode: primary.exitCode, projectionWrite: mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: manifestDigest, artifactBytes: bytes, inventories, failures: dedupedFailures, mismatches: reportMismatches, deterministicDiff: mode === "write" ? "not_run" : "different", schemaValidation, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: noForbidden })
  return {
    sourceManifest: manifest,
    legacyRoutes: legacy,
    monoRoutes: mono,
    acceptedIntentRegister: coverage.register ?? undefined,
    apiOperations: api,
    commandWrites,
    scheduledBackgroundWorkflows,
    externalIntegrations,
    userJourneyCoverage: coverage.userJourneyCoverage,
    openapiReconciliation: reconciliation,
    report,
    intentAuthority: intentAuthority === null ? undefined : {
      ...manifest.intent_authority,
      authority_root: intentAuthority.authorityRoot,
      relative_path: intentAuthority.relativePath,
      bytes: intentAuthority.bytes,
    } as IntentAuthorityEvidence,
    runtimeEvidenceRegister: runtimeEvidenceRegister ?? undefined,
    evidenceAuthority: evidenceAuthority ?? undefined,
    bytes,
    failures: dedupedFailures,
    routeRows: [...legacy.rows, ...mono.rows],
    apiRows: [...api.rows],
    c2Rows: [...commandWrites.rows, ...scheduledBackgroundWorkflows.rows, ...externalIntegrations.rows],
  }
}
export const generateFromRootsEffect = (options: RunOptions, fixtureRuntimeInput?: ApiRuntimeFixtureInput, fixtureIntentBytes?: Uint8Array): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
  Effect.gen(function* () {
    if ((fixtureRuntimeInput !== undefined || fixtureIntentBytes !== undefined) && options.mode !== "fixture_injection") {
      return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture runtime input is only valid in fixture_injection mode" }))
    }
    const context = yield* createManifestContextEffect(options.legacyRoot, options.root)
    const fixtureIntent: IntentSourceInput | undefined = fixtureIntentBytes === undefined ? undefined : {
      path: "fixture://trusted-intent",
      bytes: fixtureIntentBytes,
      revisionRefId: acceptedIntentRevisionRefId(context),
      repositoryRef: "mono",
      revision: context.scans.mono.revision.revision,
      blobOid: context.scans.mono.revision.revision,
      digest: sha256(fixtureIntentBytes),
    }
    const intentAuthority = options.mode === "fixture_injection"
      ? null
      : options.intentRegisterPath === undefined
        ? yield* Effect.fail(new ParityRuntimeError({ operation: "intent_authority", path: options.root, message: "--intent-register is required for diff and write modes" }))
        : yield* readPinnedIntentRegisterEffect(options.intentRegisterPath, options.legacyRoot, options.root, PROJECTION_DIRECTORY)
    if (options.mode === "fixture_injection" && options.evidenceRegisterPath !== undefined)
      return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture_injection cannot consume runtime evidence authority" }))
    const runtimeEvidenceAuthority = options.mode === "fixture_injection"
      ? null
      : options.evidenceRegisterPath === undefined
        ? yield* Effect.fail(new ParityRuntimeError({ operation: "runtime_evidence_authority", path: options.root, message: "--evidence-register is required for diff and write modes" }))
        : yield* readPinnedRuntimeEvidenceRegisterEffect(options.evidenceRegisterPath, options.legacyRoot, options.root, PROJECTION_DIRECTORY)
    if (intentAuthority !== null && runtimeEvidenceAuthority !== null) {
      yield* Effect.try({
        try: () => assertIndependentAuthorityRoots(intentAuthority.authorityRoot, runtimeEvidenceAuthority.authorityRoot),
        catch: (cause) => new ParityRuntimeError({
          operation: "authority_separation",
          path: options.evidenceRegisterPath ?? options.root,
          message: cause instanceof Error ? cause.message : "intent and evidence authorities overlap",
        }),
      })
    }
    const evidenceAuthority = runtimeEvidenceAuthority === null
      ? null
      : (() => {
        const record = registerRuntimeEvidenceAuthority(context, runtimeEvidenceAuthority)
        return {
          ...record,
          authority_root: runtimeEvidenceAuthority.authorityRoot,
          relative_path: runtimeEvidenceAuthority.relativePath,
          bytes: runtimeEvidenceAuthority.bytes,
        }
      })()
    return yield* Effect.try({
      try: () => generateFromContext(
        context,
        options.mode,
        options.falsifierId ?? null,
        intentAuthority,
        fixtureIntent,
        options.collectorExecutables,
        fixtureRuntimeInput,
        evidenceAuthority,
        runtimeEvidenceAuthority?.register ?? null,
      ),
      catch: (cause) => new ParityRuntimeError({
        operation: cause instanceof UnsafeSourceProjectionError ? "unsafe_source" : "generate",
        path: options.root,
        message: cause instanceof Error ? cause.message : "projection generation failed",
      }),
    })
  })
const fixtureRuntimeInputForRoot = (root: string): ApiRuntimeFixtureInput | undefined => {
  const path = join(root, API_RUNTIME_FIXTURE_PATH)
  if (!existsSync(path)) return undefined
  try {
    return { path: API_RUNTIME_FIXTURE_PATH, bytes: readFileSync(path) }
  } catch {
    return undefined
  }
}

const generateFixtureFromWorkspaceEffect = (options: RunOptions, workspace: FixtureWorkspace): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
  Effect.gen(function* () {
    const context = yield* createManifestContextEffect(workspace.legacyRoot, workspace.root)
    refreshFixtureIntentRegister(workspace)
    const fixtureIntent: IntentSourceInput | undefined = workspace.intentBytes === null ? undefined : {
      path: "fixture://trusted-intent",
      bytes: workspace.intentBytes,
      revisionRefId: acceptedIntentRevisionRefId(context),
      repositoryRef: "mono",
      revision: context.scans.mono.revision.revision,
      blobOid: context.scans.mono.revision.revision,
      digest: sha256(workspace.intentBytes),
    }
    const fixtureRuntimeInput = fixtureRuntimeInputForRoot(workspace.root)
    return yield* Effect.try({
      try: () => generateFromContext(context, "fixture_injection", options.falsifierId ?? null, null, fixtureIntent, options.collectorExecutables, fixtureRuntimeInput),
      catch: (cause) => new ParityRuntimeError({
        operation: cause instanceof UnsafeSourceProjectionError ? "unsafe_source" : "fixture_generate",
        path: workspace.root,
        message: cause instanceof Error ? cause.message : "fixture projection generation failed",
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
  intentBytes: Uint8Array | null
}
const freshReplayBytes = (workspace: FixtureWorkspace, locale: string): Readonly<Record<string, string>> => {
  const runnerUrl = new URL("./runner.ts", import.meta.url).href
  const childCode = [
    `const { Effect } = await import("effect")`,
    `const { generateFromRootsEffect } = await import(${JSON.stringify(runnerUrl)})`,
    `const options = JSON.parse(process.argv.at(-1) ?? "{}")`,
    `const fixtureRuntimeInput = options.fixtureRuntimeInput === null ? undefined : { path: options.fixtureRuntimeInput.path, bytes: Buffer.from(options.fixtureRuntimeInput.bytesBase64, "base64") }`,
    `const fixtureIntentBytes = options.fixtureIntentBytesBase64 === null ? undefined : Buffer.from(options.fixtureIntentBytesBase64, "base64")`,
    `const generated = await Effect.runPromise(generateFromRootsEffect(options, fixtureRuntimeInput, fixtureIntentBytes))`,
    `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(generated.bytes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))))`,
  ].join(";")
  const fixtureInput = fixtureRuntimeInputForRoot(workspace.root)
  const childOptions = {
    root: workspace.root,
    legacyRoot: workspace.legacyRoot,
    mode: "fixture_injection",
    fixtureRuntimeInput: fixtureInput === undefined ? null : { path: fixtureInput.path, bytesBase64: Buffer.from(fixtureInput.bytes).toString("base64") },
    fixtureIntentBytesBase64: workspace.intentBytes === null ? null : Buffer.from(workspace.intentBytes).toString("base64"),
  }
  const child = spawnSync(process.execPath, ["-e", childCode, JSON.stringify(childOptions)], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, LANG: locale, LC_ALL: locale, TZ: "UTC", TMPDIR: workspace.directory },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0) throw new Error(`fresh replay failed: ${child.stderr.trim().slice(0, 200)}`)
  const value: unknown = JSON.parse(child.stdout)
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("fresh replay artifact map is invalid")
  const bytes: Record<string, string> = {}
  for (const [name, contents] of Object.entries(value)) {
    if (typeof contents !== "string") throw new Error("fresh replay artifact payload is invalid")
    bytes[name] = contents
  }
  return bytes
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
  F11_intent_missing_or_stale: true,
  F12_uncovered_journey: true,
  F13_unknown_effect: true,
  F14_absent_schedule: true,
  F15_secret_or_pii_input: true,
  F16_h3_authority_copy: true,
  F17_locale_order: true,
  F18_stale_artifact_diff: true,
  F19_ignore_residual_precedence: true,
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
    case "F10_static_runtime_mismatch": return { status: "unresolved", reasonCode: "STATIC_RUNTIME_MISMATCH", routeName: "fixture_api" }
    case "F11_intent_missing_or_stale": return { status: "accepted_intent_invalid", reasonCode: "ACCEPTED_INTENT_MISSING" }
    case "F12_uncovered_journey": return { status: "gaps_found", reasonCode: "COVERAGE_REF_REQUIRED" }
    case "F13_unknown_effect": return { status: "unresolved", reasonCode: "UNKNOWN_EFFECT" }
    case "F14_absent_schedule": return { status: "gaps_found", reasonCode: "ABSENT_SCHEDULE" }
    case "F15_secret_or_pii_input": return { status: "source_unavailable", reasonCode: "UNSAFE_SOURCE" }
    case "F16_h3_authority_copy": return { status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY" }
    case "F17_locale_order": return { status: "falsifier_passed", reasonCode: "LOCALE_ORDER_CANONICAL" }
    case "F18_stale_artifact_diff": return { status: "stale", reasonCode: "STALE_ARTIFACT" }
    case "F19_ignore_residual_precedence": return { status: "falsifier_passed", reasonCode: "RESIDUAL_PRECEDENCE" }
    default: return null
  }
}



const syntheticFixtureFiles: readonly { readonly root: "legacy" | "mono"; readonly path: string; readonly contents: string }[] = [
  { root: "legacy", path: "app/config/routing.yml", contents: "fixture_base:\n  path: /fixture/base\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [GET]\nfixture_alt:\n  path: /fixture/alt\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [GET]\n" },
  { root: "legacy", path: "src/AppBundle/Controller/Api/FixtureController.php", contents: "<?php\nfinal class FixtureApi {}\n" },
  { root: "legacy", path: "src/AppBundle/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController {}\n" },
  { root: "mono", path: "package.json", contents: JSON.stringify({ scripts: { runtime: "bun infra/schedules.ts" }, exports: { ".": { default: "./infra/schedules.ts" } } }) },
  { root: "mono", path: "infra/schedules.ts", contents: "export function FixtureHandler(): void {}\nschedule('fixture_cron', '0 0 * * *', FixtureHandler)\n" },
  { root: "legacy", path: "src/AppBundle/Service/Fixture.php", contents: "<?php\nfinal class FixtureService {}\n" },
  { root: "mono", path: "apps/server/config/routes.yaml", contents: "fixture_base:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /fixture/base\n    methods: ['GET']\nfixture_alt:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /fixture/alt\n    methods: ['GET']\n" },
  { root: "mono", path: "apps/server/src/App/Api/Resource/Fixture.php", contents: "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(shortName: 'Fixture', operations: [new Get(uriTemplate: '/fixture/api', name: 'fixture_api')])]\nfinal class FixtureResource {}\n" },
  { root: "mono", path: "apps/server/src/App/Fixture/Controller/FixtureController.php", contents: "<?php\nfinal class FixtureController {}\n" },
  { root: "mono", path: "evidence/security-h3/0015/source-manifest.json", contents: "[]" },
  { root: "legacy", path: "src/AppBundle/Command/FixtureCommand.php", contents: "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Repository\\FixtureRepository;\nfinal class FixtureCommand { public static $defaultName = 'legacy:send'; private FixtureRepository $repository; public function __invoke(): void { $this->repository->save('fixture'); } }\n" },
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
  { root: "mono", path: "packages/sdk/openapi.json", contents: JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture API", version: "1.0.0" }, paths: { "/api/fixture/api": { get: { operationId: "fixture_api", responses: { "200": { description: "OK" } } } } }, components: {} }) },
  { root: "mono", path: "evidence/security-h3/0015/current-route-inventory.json", contents: JSON.stringify([{ path_template: "/fixture/base", methods: ["GET"], operation_id: "route:fixture_base", source_ref_ids: ["source:apps/server/src/App/Api/Resource/Fixture.php:1:fixture"] }]) },
  { root: "mono", path: "evidence/security-h3/0015/current-resource-inventory.json", contents: JSON.stringify([{ path_template: "/fixture/api", methods: ["GET"], operation_id: "api:App\\Fixture\\Api\\Resource\\FixtureResource:Get:1", source_ref_ids: ["source:apps/server/src/App/Api/Resource/Fixture.php:1:fixture"] }]) },
]
const seedFixtureIntentRegister = (root: string, legacyRoot: string): Uint8Array => {
  const context = Effect.runSync(createManifestContextEffect(legacyRoot, root))
  const route = collectRoutes(context, sha256("fixture-register-pending"), undefined, true)
  const api = collectApiOperations(context, sha256("fixture-register-pending"), route.mono.rows, true, undefined, fixtureRuntimeInputForRoot(root))
  const c2 = collectC2(context, sha256("fixture-register-pending"))
  const rowsBySurface: Readonly<Record<"legacy_route" | "mono_route" | "api_operation" | "command_write" | "schedule_background" | "external_integration", readonly InventoryRow[]>> = {
    legacy_route: route.legacy.rows,
    mono_route: route.mono.rows,
    api_operation: api.inventory.rows,
    command_write: c2.commandWrites.rows,
    schedule_background: c2.schedules.rows,
    external_integration: c2.integrations.rows,
  }
  const steps = (Object.entries(rowsBySurface) as readonly [keyof typeof rowsBySurface, readonly InventoryRow[]][])
    .map(([surface, rows]) => {
      const safeRows = rows.filter((row) => row.signature.length <= 512 && !row.signature.includes("*") && !row.signature.includes("..") && !row.signature.includes("/tmp/") && !/(?:^|[^A-Za-z])(?:src|rev)-[a-f0-9]{16,}(?:$|[^A-Za-z0-9])/.test(row.signature))
      const canonicalSignatures = surface === "legacy_route" ? [] : sortUnique(safeRows.map((row) => row.signature))
      const rowIds = surface === "api_operation" ? [] : sortUnique(rows.map((row) => row.row_id))
      return { step_id: `fixture-step-${surface}`, surface, row_ids: rowIds, canonical_signatures: canonicalSignatures, expected_contract_ref: null, runtime_evidence_ref_ids: [] }
    })
    .filter((step) => step.canonical_signatures.length > 0 || step.row_ids.length > 0)
    .sort((left, right) => compareByteOrder(left.step_id, right.step_id))
  const targetCoverageRows = route.legacy.rows.slice(0, 2)
  if (targetCoverageRows.length < 2) throw new Error("fixture register has fewer than two target coverage rows")
  const coverageSteps = [...steps, { step_id: "fixture-step-00-target-row", surface: "legacy_route" as const, row_ids: targetCoverageRows.map((row) => row.row_id), canonical_signatures: [], expected_contract_ref: null, runtime_evidence_ref_ids: [] }]
    .sort((left, right) => compareByteOrder(left.step_id, right.step_id))
  const sourceRefIds = context.sources.filter((source) => source.availability === "available").map((source) => source.source_id).slice(0, 1)
  const selectedRevisionRefIds = sortUnique([context.scans.legacy.revisionRefId, acceptedIntentRevisionRefId(context)])
  const intentRefId = "intent://fixture-coverage"
  const journeyRefId = "intent://fixture-journey"
  const intent = {
    intent_ref_id: intentRefId,
    intent_revision: "fixture-intent-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: sourceRefIds,
    purpose: "coverage" as const,
    disposition: null,
    row_ids: [],
    canonical_signatures: [],
    inventory_kinds: [],
    journey_ref_ids: [journeyRefId],
  }
  const journey = {
    journey_ref_id: journeyRefId,
    journey_key: "fixture-journey",
    intent_ref_id: intentRefId,
    journey_revision: "fixture-journey-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: sourceRefIds,
    steps: coverageSteps,
    coverage_scope: "user_visible" as const,
  }
  const register = {
    schema_version: "functional-parity-accepted-intent/v1" as const,
    intents: [{ ...intent, intent_digest: sha256(canonicalJson(intent)) }],
    journeys: [{ ...journey, journey_digest: sha256(canonicalJson(journey)) }],
  }
  return Buffer.from(canonicalJson(register), "utf8")
}
const refreshFixtureIntentRegister = (workspace: FixtureWorkspace): void => {
  if (workspace.intentBytes === null) return
  const context = Effect.runSync(createManifestContextEffect(workspace.legacyRoot, workspace.root))
  const selectedRevisionRefIds = sortUnique([context.scans.legacy.revisionRefId, acceptedIntentRevisionRefId(context)])
  const value = JSON.parse(new TextDecoder().decode(workspace.intentBytes)) as { readonly schema_version: string; readonly intents: readonly Record<string, unknown>[]; readonly journeys: readonly Record<string, unknown>[] }
  const intents = value.intents.map((intent) => {
    const { intent_digest: _intentDigest, ...withoutDigest } = intent
    const next = { ...withoutDigest, selected_revision_ref_ids: selectedRevisionRefIds }
    return { ...next, intent_digest: sha256(canonicalJson(next)) }
  })
  const journeys = value.journeys.map((journey) => {
    const { journey_digest: _journeyDigest, ...withoutDigest } = journey
    const next = { ...withoutDigest, selected_revision_ref_ids: selectedRevisionRefIds }
    return { ...next, journey_digest: sha256(canonicalJson(next)) }
  })
  workspace.intentBytes = Buffer.from(canonicalJson({ schema_version: value.schema_version, intents, journeys }), "utf8")
}
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
    const intentBytes = seedFixtureIntentRegister(root, legacyRoot)
    return { directory, root, legacyRoot, intentBytes }
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true })
    throw cause
  }
}
interface FixtureIntentAuthority {
  readonly directory: string
  readonly path: string
}
const createFixtureIntentAuthority = (workspace: FixtureWorkspace): FixtureIntentAuthority => {
  const directory = join(workspace.directory, "intent-authority")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "accepted-intent.json")
  if (workspace.intentBytes === null) throw new Error("fixture intent authority is unavailable")
  writeFileSync(path, workspace.intentBytes)
  execFileSync("git", ["-C", directory, "init", "--quiet"])
  execFileSync("git", ["-C", directory, "config", "user.email", "fixture@example.invalid"])
  execFileSync("git", ["-C", directory, "config", "user.name", "fixture"])
  execFileSync("git", ["-C", directory, "add", "--", "accepted-intent.json"])
  execFileSync("git", ["-C", directory, "commit", "--quiet", "-m", "fixture intent authority"])
  return { directory, path }
}
interface FixtureEvidenceAuthority {
  readonly directory: string
  readonly path: string
}
const createFixtureEvidenceAuthority = (workspace: FixtureWorkspace): FixtureEvidenceAuthority => {
  if (workspace.intentBytes === null) throw new Error("fixture intent authority is unavailable")
  const accepted = JSON.parse(new TextDecoder().decode(workspace.intentBytes)) as {
    readonly journeys: readonly [{
      readonly journey_ref_id: string
      readonly selected_revision_ref_ids: readonly [string, string, ...string[]]
      readonly source_ref_ids: readonly string[]
      readonly steps: readonly { readonly step_id: string }[]
    }]
  }
  const journey = accepted.journeys[0]
  if (journey === undefined) throw new Error("fixture journey authority is unavailable")
  const receipt = makeRuntimeEvidenceReceipt({
    journey_ref_id: journey.journey_ref_id,
    step_ids: [journey.steps[0]?.step_id ?? "fixture-step"],
    legacy_revision_ref_id: journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-legacy-")) ?? journey.selected_revision_ref_ids[0],
    mono_revision_ref_id: journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-mono-")) ?? journey.selected_revision_ref_ids[1],
    runner_source_ref_ids: journey.source_ref_ids.length > 0 ? journey.source_ref_ids : [`src-${"0".repeat(64)}`],
    runner_digest: sha256("fixture-runner-input"),
    fixture_digest: sha256("fixture-database-input"),
    environment_kind: "ci_non_production",
    exit_code: 1,
    result: "failed",
    artifact_digest: sha256("fixture-sanitized-artifact"),
  })
  const directory = join(workspace.directory, "evidence-authority")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "runtime-evidence.json")
  writeFileSync(path, canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt])))
  execFileSync("git", ["-C", directory, "init", "--quiet"])
  execFileSync("git", ["-C", directory, "config", "user.email", "fixture@example.invalid"])
  execFileSync("git", ["-C", directory, "config", "user.name", "fixture"])
  execFileSync("git", ["-C", directory, "add", "--", "runtime-evidence.json"])
  execFileSync("git", ["-C", directory, "commit", "--quiet", "-m", "fixture runtime evidence authority"])
  return { directory, path }
}


const appendText = (path: string, text: string): void => {
  if (!existsSync(path)) throw new Error(`fixture source unavailable: ${path}`)
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${text}\n`, "utf8")
}

interface FixtureSourceInput {
  readonly path: string
  readonly bytes: Uint8Array
}


const c2SecurityFixtureInputs = (): readonly FixtureSourceInput[] => {
  const credential = new TextDecoder().decode(Uint8Array.from([
    115, 107, 95, 108, 105, 118, 101, 95, 99, 50, 95, 102, 105, 120, 116, 117, 114, 101, 95, 115, 101, 99, 114, 101, 116, 95, 118, 97, 108, 117, 101,
  ]))
  const payload = new TextDecoder().decode(Uint8Array.from([
    114, 97, 119, 45, 112, 97, 121, 108, 111, 97, 100, 45, 99, 50, 45, 102, 105, 120, 116, 117, 114, 101,
  ]))
  const endpointSecret = new TextDecoder().decode(Uint8Array.from([
    84, 84, 69, 65, 77, 47, 66, 67, 72, 65, 78, 47, 65, 98, 67, 100, 69, 102, 71, 104, 73, 106, 75, 108, 77, 110, 79, 112, 81, 114, 83, 116, 85, 118, 87, 120, 89, 122, 95, 49, 50, 51, 52, 53,
  ]))
  const tracked = [
    "export const call = () => fetch(\"https://api.example.test/v1/send?token=",
    credential,
    "\", { body: \"",
    payload,
    "\" })\nexport const send = () => fetch(\"https://hooks.slack.com/services/",
    endpointSecret,
    "\")\n",
  ].map((value) => new TextEncoder().encode(value))
  const ignored = [
    "export const ignored = () => fetch(\"https://hooks.slack.com/services/",
    endpointSecret,
    "\")\n",
  ].map((value) => new TextEncoder().encode(value))
  const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    return bytes
  }
  return [
    { path: "packages/fixture-integration.ts", bytes: joinBytes(tracked) },
    { path: "packages/sdk/dist/Slack/client.js", bytes: joinBytes(ignored) },
  ]
}

const writeFixtureSource = (root: string, fixture: FixtureSourceInput): void => {
  const target = join(root, fixture.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, fixture.bytes)
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
    case "F11_intent_missing_or_stale":
      workspace.intentBytes = null
      return
    case "F12_uncovered_journey": {
      if (workspace.intentBytes === null) throw new Error("fixture intent is unavailable")
      const register = JSON.parse(new TextDecoder().decode(workspace.intentBytes)) as { readonly schema_version: string; readonly intents: readonly Record<string, unknown>[]; readonly journeys: readonly Record<string, unknown>[] }
      const targetRowId = register.journeys.flatMap((journey) => Array.isArray(journey.steps) ? journey.steps : []).flatMap((step) => {
        if (step === null || typeof step !== "object" || Array.isArray(step)) return []
        const rowIds = (step as Record<string, unknown>).row_ids
        return Array.isArray(rowIds) && rowIds.length > 0 ? rowIds.filter((value): value is string => typeof value === "string") : []
      })[0]
      if (targetRowId === undefined) throw new Error("fixture journey has no row coverage ref")
      let removed = 0
      const journeys = register.journeys.map((journey) => {
        const steps = Array.isArray(journey.steps) ? journey.steps : []
        let changed = false
        const nextSteps = steps.map((step) => {
          if (step === null || typeof step !== "object" || Array.isArray(step)) return step
          const record = step as Record<string, unknown>
          const rowIds = Array.isArray(record.row_ids) ? record.row_ids.filter((value): value is string => typeof value === "string") : []
          if (!rowIds.includes(targetRowId)) return step
          changed = true
          removed += 1
          return { ...record, row_ids: rowIds.filter((value) => value !== targetRowId) }
        })
        if (!changed) return journey
        const { journey_digest: _journeyDigest, ...withoutDigest } = journey
        const payload = { ...withoutDigest, steps: nextSteps }
        return { ...payload, journey_digest: sha256(canonicalJson(payload)) }
      })
      if (removed === 0) throw new Error("fixture coverage ref was not removed")
      workspace.intentBytes = Buffer.from(canonicalJson({ schema_version: register.schema_version, intents: register.intents, journeys }), "utf8")
      return
    }
    case "F16_h3_authority_copy": {
      const path = join(workspace.root, "evidence/security-h3/0015/current-resource-inventory.json")
      const records = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>
      const sourceRefIds = records[0]?.source_ref_ids
      if (!Array.isArray(sourceRefIds) || sourceRefIds.some((value) => typeof value !== "string")) throw new Error("fixture H3 source refs unavailable")
      records.push({ path_template: "/fixture/h3-authority-copy", methods: ["GET"], operation_id: "api:App\\Fixture\\Api\\Resource\\FixtureResource:Get:99", source_ref_ids: sourceRefIds })
      writeFileSync(path, JSON.stringify(records), "utf8")
      return
    }
    case "F15_secret_or_pii_input": {
      appendText(legacyRouting, "fixture_secret: { path: /fixture/secret, token: sk_live_fixture_secret, methods: [GET] }")
      for (const fixture of c2SecurityFixtureInputs()) writeFixtureSource(workspace.root, fixture)
      return
    }
    case "F18_stale_artifact_diff":
      mkdirSync(join(workspace.root, PROJECTION_DIRECTORY), { recursive: true })
      writeFileSync(join(workspace.root, PROJECTION_DIRECTORY, "legacy-routes.json"), "stale-generated-artifact", "utf8")
      return
    case "F19_ignore_residual_precedence": {
      const residuals = [
        "packages/sdk/dist/module.js",
        "packages/sdk/dist/vendor/module.js",
        "packages/sdk/node_modules/nested/module.js",
      ]
      for (const relative of residuals) {
        const target = join(workspace.root, relative)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, "export const residual = true\n", "utf8")
      }
      return
    }
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

const fixtureResultReport = (
  falsifierId: FalsifierId,
  generated: GeneratedArtifacts,
  expectation: FixtureExpectation,
  observedStatus: ZeroGapReport["status"],
  observedReason: string,
  deterministic: boolean,
  causalFailure: ReportFailure | null = null,
  projectionDiff = false,
  deterministicDiff: ZeroGapReport["verification"]["deterministic_diff"] | undefined = undefined,
): RunResult => {
  const allRows = [...generated.routeRows, ...generated.apiRows, ...generated.c2Rows]
  const rowIds = allRows.map((row) => row.row_id)
  const sourceRefIds = allRows.flatMap((row) => row.source_ref_ids)
  const matched = deterministic && observedStatus === expectation.status && observedReason === expectation.reasonCode
  const observedFailureStatus: ReportFailure["status"] = (matched && falsifierId === "F0_deterministic_replay" ? "gaps_found" : generated.report.status === "falsifier_passed" ? "unresolved" : generated.report.status === "zero_gap" ? "gaps_found" : generated.report.status) as ReportFailure["status"]
  const observedFailure = causalFailure ?? buildFailure(observedFailureStatus, matched && falsifierId === "F0_deterministic_replay" ? expectation.reasonCode : observedReason, rowIds, sourceRefIds)
  const failures = matched ? [...generated.failures, observedFailure] : [...generated.failures, buildFailure("command_error", "FALSIFIER_EXPECTATION_MISMATCH", rowIds, sourceRefIds), observedFailure]
  const reportStatus: ZeroGapReport["status"] = matched ? "falsifier_passed" : "command_error"
  const report = reportWith({ mode: "fixture_injection", falsifierId, status: reportStatus, exitCode: matched ? 13 : 12, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories: [generated.legacyRoutes, generated.monoRoutes, generated.apiOperations, generated.commandWrites, generated.scheduledBackgroundWorkflows, generated.externalIntegrations, generated.userJourneyCoverage], failures, mismatches: generated.report.mismatches, deterministicDiff: deterministicDiff ?? (deterministic ? "equal" : "different"), schemaValidation: generated.report.verification.schema_validation, crossReferenceValidation: generated.report.verification.cross_reference_validation, forbiddenStatesEmpty: false })
  return { exitCode: report.exit_code, report, artifacts: generated, projectionDiff }
}

const runFixtureFalsifier = (options: RunOptions): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    const falsifierId = options.falsifierId
    if (falsifierId === undefined || C0_FALSIFIERS[falsifierId] !== true) return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture_injection requires a registered falsifier" }))
    const expectation = fixtureExpectation(falsifierId)
    if (expectation === null) return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture falsifier has no expectation" }))
    const workspace = yield* Effect.try({ try: () => createFixtureWorkspace(options), catch: (cause) => new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: cause instanceof Error ? cause.message : "fixture source unavailable" }) })
    try {
      if (falsifierId === "F0_deterministic_replay") {
        const first = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const secondWorkspace = yield* Effect.try({ try: () => createFixtureWorkspace(options), catch: (cause) => new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: cause instanceof Error ? cause.message : "second replay fixture unavailable" }) })
        try {
          // A child process is required here: a static import cannot prove fresh module state, locale, environment, and temporary output roots.
          const firstBytes = freshReplayBytes(workspace, "C")
          const secondBytes = freshReplayBytes(secondWorkspace, "sv_SE.UTF-8")
          const expectedNames = Object.keys(first.bytes).sort(compareByteOrder)
          const firstNames = Object.keys(firstBytes).sort(compareByteOrder)
          const secondNames = Object.keys(secondBytes).sort(compareByteOrder)
          const closed = expectedNames.length === firstNames.length && expectedNames.every((name, index) => name === firstNames[index]) && expectedNames.length === secondNames.length && expectedNames.every((name, index) => name === secondNames[index])
          const deterministic = closed && expectedNames.every((name) => firstBytes[name] === secondBytes[name] && firstBytes[name] === first.bytes[name])
          return fixtureResultReport(falsifierId, first, expectation, deterministic ? "falsifier_passed" : "command_error", deterministic ? expectation.reasonCode : "NONDETERMINISTIC_OUTPUT", deterministic)
        } finally {
          yield* Effect.sync(() => rmSync(secondWorkspace.directory, { recursive: true, force: true }))
        }
      }
      if (falsifierId === "F2_source_hash_drift") {
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const source = join(workspace.legacyRoot, "app/config/routing.yml")
        appendText(source, routeYaml("fixture_drift", "/fixture/drift", "GET"))
        refreshFixtureIntentRegister(workspace)
        const after = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const drifted = sourceDigestForManifest(after.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest)
        return fixtureResultReport(falsifierId, after, expectation, drifted ? "source_hash_drift" : "command_error", drifted ? expectation.reasonCode : "SOURCE_HASH_DRIFT_NOT_DETECTED", drifted)
      }
      if (falsifierId === "F11_intent_missing_or_stale") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        mutateFixture(falsifierId, workspace)
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const causal = generated.failures.find((failure) => failure.reason_code === expectation.reasonCode)
        const deterministic = causal !== undefined && sourceDigestForManifest(baseline.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest)
        return fixtureResultReport(falsifierId, generated, expectation, deterministic ? (causal?.status ?? "command_error") : "command_error", deterministic ? (causal?.reason_code ?? "FALSIFIER_CAUSALITY_MISMATCH") : "FALSIFIER_CAUSALITY_MISMATCH", deterministic, deterministic ? causal ?? null : null)
      }
      if (falsifierId === "F12_uncovered_journey") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        mutateFixture(falsifierId, workspace)
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const causal = generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && !baseline.failures.some((previous) => previous.failure_id === failure.failure_id))
        const changed = causal !== undefined && baseline.bytes["user-journey-coverage.json"] !== generated.bytes["user-journey-coverage.json"]
        return fixtureResultReport(falsifierId, generated, expectation, changed ? (causal?.status ?? "command_error") : "command_error", changed ? (causal?.reason_code ?? "FALSIFIER_CAUSALITY_MISMATCH") : "FALSIFIER_CAUSALITY_MISMATCH", changed, changed ? causal ?? null : null)
      }
      if (falsifierId === "F15_secret_or_pii_input") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        mutateFixture(falsifierId, workspace)
        refreshFixtureIntentRegister(workspace)
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const causal = generated.failures.find((failure) => failure.reason_code === expectation.reasonCode)
        const changed = causal !== undefined && sourceDigestForManifest(baseline.sourceManifest) !== sourceDigestForManifest(generated.sourceManifest)
        return fixtureResultReport(falsifierId, generated, expectation, changed ? (causal?.status ?? "command_error") : "command_error", changed ? (causal?.reason_code ?? "FALSIFIER_CAUSALITY_MISMATCH") : "FALSIFIER_CAUSALITY_MISMATCH", changed, changed ? causal ?? null : null)
      }
      if (falsifierId === "F17_locale_order") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const values = ["ä", "a", "z", "å", "A"]
        const hostileOrder = [...values].sort(new Intl.Collator("sv-SE").compare)
        const canonicalOrder = [...values].sort(compareByteOrder)
        const canonicalBytes = canonicalJson(canonicalOrder)
        const replayBytes = canonicalJson([...values].sort(compareByteOrder))
        const hostileDiffers = canonicalJson(hostileOrder) !== canonicalBytes
        const deterministic = hostileDiffers && canonicalBytes === replayBytes
        const observation = deterministic ? buildFailure("stale", expectation.reasonCode, [], []) : null
        return fixtureResultReport(falsifierId, baseline, expectation, deterministic ? "falsifier_passed" : "command_error", deterministic ? expectation.reasonCode : "LOCALE_ORDER_NONDETERMINISTIC", deterministic, observation)
      }
      if (falsifierId === "F18_stale_artifact_diff") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const authority = createFixtureIntentAuthority(workspace)
        const evidenceAuthority = createFixtureEvidenceAuthority(workspace)
        const corrupted = "stale-generated-artifact"
        try {
          const projectionDirectory = join(workspace.root, PROJECTION_DIRECTORY)
          mkdirSync(projectionDirectory, { recursive: true })
          for (const name of COMMITTED_PROJECTIONS) {
            const bytes = baseline.bytes[name]
            if (bytes === undefined) throw new Error(`fixture projection missing: ${name}`)
            writeFileSync(join(projectionDirectory, name), bytes, "utf8")
          }
          mutateFixture(falsifierId, workspace)
          const diffResult = yield* run({ root: workspace.root, legacyRoot: workspace.legacyRoot, intentRegisterPath: authority.path, evidenceRegisterPath: evidenceAuthority.path, mode: "diff" })
          const generated = diffResult.artifacts
          const causal = diffResult.report.failures.find((failure) => failure.reason_code === expectation.reasonCode && failure.status === "stale")
          const stale = generated !== undefined &&
            diffResult.projectionDiff &&
            diffResult.report.verification.deterministic_diff === "different" &&
            corrupted !== generated?.bytes["legacy-routes.json"] &&
            canonicalJson(baseline.legacyRoutes.rows) === canonicalJson(generated?.legacyRoutes.rows ?? [])
          return generated === undefined
            ? fixtureResultReport(falsifierId, baseline, expectation, "command_error", "FALSIFIER_CAUSALITY_MISMATCH", false)
            : fixtureResultReport(falsifierId, generated, expectation, stale ? "stale" : "command_error", stale ? expectation.reasonCode : "FALSIFIER_CAUSALITY_MISMATCH", stale, stale ? causal ?? null : null, diffResult.projectionDiff, diffResult.report.verification.deterministic_diff)
        } finally {
          rmSync(authority.directory, { recursive: true, force: true })
          rmSync(evidenceAuthority.directory, { recursive: true, force: true })
        }
      }
      if (falsifierId === "F19_ignore_residual_precedence") {
        const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        mutateFixture(falsifierId, workspace)
        refreshFixtureIntentRegister(workspace)
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const residualPaths = ["packages/sdk/dist/module.js", "packages/sdk/dist/vendor/module.js", "packages/sdk/node_modules/nested/module.js"]
        const residualCensus = generated.sourceManifest.root_census.filter((record) => residualPaths.includes(record.path))
        const residualIgnored = residualCensus.length === residualPaths.length && residualCensus.every((record) => record.classification === "ignored" && record.ignore_rule_id !== null)
        const residualRefs = [...generated.routeRows, ...generated.apiRows, ...generated.c2Rows].flatMap((row) => row.source_ref_ids).some((sourceRef) => generated.sourceManifest.sources.find((source) => source.source_id === sourceRef && residualPaths.includes(source.path)) !== undefined)
        const deterministic = residualIgnored && !residualRefs && generated.externalIntegrations.rows.length === baseline.externalIntegrations.rows.length
        const observation = deterministic ? buildFailure("stale", expectation.reasonCode, [], []) : null
        return fixtureResultReport(falsifierId, generated, expectation, deterministic ? "falsifier_passed" : "command_error", deterministic ? expectation.reasonCode : "RESIDUAL_PRECEDENCE_BROKEN", deterministic, observation)
      }
      if (falsifierId === "F16_h3_authority_copy") {
        mutateFixture(falsifierId, workspace)
        refreshFixtureIntentRegister(workspace)
        const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
        const injected = generated.apiRows.find((row) => {
          const details = row.details as unknown as Record<string, unknown>
          return details.uri_template === "/fixture/h3-authority-copy"
        })
        const causal = generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && (injected === undefined || failure.row_ids.includes(injected.row_id))) ?? null
        const h3InputObserved = injected !== undefined && generated.apiOperations.derivation_edges.some((edge) => edge.to_row_ids.includes(injected.row_id))
        const h3AuthorityRejected = injected !== undefined && injected.authority_line === "cross_line" && injected.status === "unresolved" && causal !== null
        const passed = h3InputObserved && h3AuthorityRejected
        return fixtureResultReport(falsifierId, generated, expectation, passed ? "schema_invalid" : "command_error", passed ? expectation.reasonCode : "H3_AUTHORITY_COPY_ACCEPTED", passed, causal)
      }
      const baseline = yield* generateFixtureFromWorkspaceEffect(options, workspace)
      const baselineFailureIds = new Set(baseline.failures.map((failure) => failure.failure_id))
      const baselineCausalRow = falsifierId === "F13_unknown_effect"
        ? baseline.c2Rows.find((row) => row.authority_line === "mono" && row.inventory_kind === "command_write" && "command_name" in row.details && row.details.command_name === "fixture:send")
        : undefined
      const baselineRowIds = new Set([...baseline.routeRows, ...baseline.apiRows, ...baseline.c2Rows].map((row) => row.row_id))
      const baselineCausalKey = baselineCausalRow === undefined ? null : c2FixtureSemanticKey(baselineCausalRow)
      const baselineCausalClean = falsifierId === "F13_unknown_effect"
        ? baselineCausalRow !== undefined && baselineCausalRow.status !== "unresolved" && baselineCausalRow.status !== "duplicate" && !baselineCausalRow.reason_codes.includes("UNKNOWN_EFFECT") && baselineCausalRow.coverage_ref_ids.length > 0
        : falsifierId === "F14_absent_schedule"
          ? !baseline.c2Rows.some((row) => row.authority_line === "mono" && row.inventory_kind === "schedule_background" && row.status === "absent")
          : true
      mutateFixture(falsifierId, workspace)
      refreshFixtureIntentRegister(workspace)
      const generated = yield* generateFixtureFromWorkspaceEffect(options, workspace)
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
      const generatedTarget = baselineCausalKey === null ? undefined : generated.c2Rows.find((row) => c2FixtureSemanticKey(row) === baselineCausalKey)
      let causalMatch = true
      if (falsifierId === "F13_unknown_effect") {
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
          ? generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && failure.status === expectation.status && mutationChanged && !baselineFailureIds.has(failure.failure_id)) ?? null
          : generated.failures.find((failure) => failure.reason_code === expectation.reasonCode && failure.status === expectation.status && touchesInjectedIdentity(failure)) ?? null
      const observedStatus = causalMatch && observedFailure !== null && observedFailure !== undefined ? observedFailure.status : observedFailure?.status ?? generated.report.status
      const observedReason = causalMatch && observedFailure !== null && observedFailure !== undefined ? observedFailure.reason_code : causalMatch ? observedFailure?.reason_code ?? generated.report.status : "FALSIFIER_CAUSALITY_MISMATCH"
      return fixtureResultReport(falsifierId, generated, expectation, observedStatus, observedReason, true, causalMatch ? observedFailure ?? null : null)
    } finally {
      yield* Effect.sync(() => rmSync(workspace.directory, { recursive: true, force: true }))
    }
  })
interface ProjectionStageEffects {
  readonly readDirectory: typeof readProjectionDirectoryEffect
  readonly readProjection: typeof readProjectionEffect
  readonly writeProjectionSet: typeof writeProjectionSetEffect
}

const productionProjectionStageEffects: ProjectionStageEffects = {
  readDirectory: readProjectionDirectoryEffect,
  readProjection: readProjectionEffect,
  writeProjectionSet: writeProjectionSetEffect,
}

const observeProjectionEffect = (effects: ProjectionStageEffects, root: string, writeReceipt: boolean): Effect.Effect<ProjectionObservation, ParityRuntimeError> =>
  Effect.gen(function* () {
    const entries = yield* effects.readDirectory(root, PROJECTION_DIRECTORY)
    const bytes: Record<string, string | null> = {}
    for (const name of COMMITTED_PROJECTIONS) bytes[name] = yield* effects.readProjection(root, PROJECTION_DIRECTORY, name)
    return { entries, bytes, writeReceipt }
  })

const runTerminalStageEffect = (
  options: RunOptions,
  generated: GeneratedArtifacts,
  projectionEffects: ProjectionStageEffects = productionProjectionStageEffects,
): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    const before = yield* observeProjectionEffect(projectionEffects, options.root, false)
    const unknownEntries = before.entries.filter((entry) => !COMMITTED_PROJECTIONS.includes(entry as (typeof COMMITTED_PROJECTIONS)[number]))
    const projectionDiff = unknownEntries.length > 0 || COMMITTED_PROJECTIONS.some((name) => before.bytes[name] !== generated.bytes[name])
    let failures = [...generated.failures]
    if (unknownEntries.length > 0) failures.push(buildFailure("stale", "EXTRA_PROJECTION_ENTRY", [], []))
    if (projectionDiff && options.mode === "diff") failures.push(buildFailure("stale", "STALE_ARTIFACT", [], []))
    const inventories = [generated.legacyRoutes, generated.monoRoutes, generated.apiOperations, generated.commandWrites, generated.scheduledBackgroundWorkflows, generated.externalIntegrations, generated.userJourneyCoverage]
    const reportMismatches = deriveReportMismatches(inventories, generated.openapiReconciliation)
    const schemaValidation = validateSourceManifest(generated.sourceManifest) &&
      inventories.every((inventory) => validateInventory(inventory)) &&
      validateOpenApiReconciliation(generated.openapiReconciliation)
    const crossReferencesValid = validateCrossArtifactInvariants({
      manifest: generated.sourceManifest,
      inventories: inventories.slice(0, 6),
      userJourneyCoverage: generated.userJourneyCoverage,
      register: generated.acceptedIntentRegister ?? null,
      links: inventories.flatMap((inventory) => inventory.links),
    })
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
    const evidenceRequired = options.mode !== "fixture_injection"
    const writeDenied = generated.intentAuthority === undefined || (evidenceRequired && generated.evidenceAuthority === undefined) || hasUnsafe || c2WriteBlocked || failures.length > 0 || !schemaValidation || !crossReferencesValid
    const forbiddenEmpty = (extraFailures: readonly ReportFailure[]): boolean => forbiddenStatesEmpty(inventories, generated.openapiReconciliation, extraFailures, crossReferencesValid)
    let report: ZeroGapReport
    if (options.mode === "write" && !writeDenied) {
      const pinnedAuthority: PinnedIntentRegister = {
        authorityRoot: generated.intentAuthority?.authority_root as string,
        relativePath: generated.intentAuthority?.relative_path as string,
        revisionRefId: generated.intentAuthority?.revision_ref_id as string,
        revision: generated.intentAuthority?.revision as string,
        blobOid: generated.intentAuthority?.blob_oid as string,
        bytes: generated.intentAuthority?.bytes as Uint8Array,
        digest: generated.intentAuthority?.digest as string,
      }
      const pinnedRuntimeEvidenceAuthority: PinnedRuntimeEvidenceRegister | undefined = generated.evidenceAuthority === undefined || generated.runtimeEvidenceRegister === undefined
        ? undefined
        : {
            authorityRoot: generated.evidenceAuthority.authority_root,
            relativePath: generated.evidenceAuthority.relative_path,
            revisionRefId: generated.evidenceAuthority.revision_ref_id,
            revision: generated.evidenceAuthority.revision,
            blobOid: generated.evidenceAuthority.blob_oid,
            bytes: generated.evidenceAuthority.bytes,
            digest: generated.evidenceAuthority.digest,
            register: generated.runtimeEvidenceRegister,
          }
      if (!validateGeneratedArtifactSet(generated)) {
        failures.push(buildFailure("schema_invalid", "REPORT_SCHEMA_VALIDATION_FAILED", [], []))
        report = reportWith({ mode: options.mode, falsifierId: null, status: "schema_invalid", exitCode: 8, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: "not_run", schemaValidation: false, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: false })
      } else {
        yield* projectionEffects.writeProjectionSet(options.root, PROJECTION_DIRECTORY, generated.bytes, COMMITTED_PROJECTIONS, pinnedAuthority, options.legacyRoot, pinnedRuntimeEvidenceAuthority)
        const after = yield* observeProjectionEffect(projectionEffects, options.root, true)
        const written = after.entries.length === COMMITTED_PROJECTIONS.length && COMMITTED_PROJECTIONS.every((name) => after.bytes[name] === generated.bytes[name])
        if (!written) {
          failures.push(buildFailure("schema_invalid", "PROJECTION_WRITE_NOT_OBSERVED", [], []))
          report = reportWith({ mode: options.mode, falsifierId: null, status: "schema_invalid", exitCode: 8, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: "not_run", schemaValidation: false, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: false })
        } else {
          const writeReport = reportWith({ mode: "write", falsifierId: null, status: "projection_written", exitCode: 14, projectionWrite: { status: "written", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: "not_run", schemaValidation, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: forbiddenEmpty(failures) })
          const writtenBundle = { ...generated, failures, report: writeReport }
          if (!validateReportBundle(writtenBundle, after)) {
            failures.push(buildFailure("schema_invalid", "REPORT_SCHEMA_VALIDATION_FAILED", [], []))
            report = reportWith({ mode: options.mode, falsifierId: null, status: "schema_invalid", exitCode: 8, projectionWrite: { status: "blocked", target_ref: PROJECTION_DIRECTORY }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: "not_run", schemaValidation: false, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: false })
          } else {
            report = writeReport
          }
        }
      }
    } else {
      const primary = primaryFailure(failures, options.mode === "diff" && projectionDiff)
      report = reportWith({ mode: options.mode, falsifierId: null, status: primary.status, exitCode: primary.exitCode, projectionWrite: options.mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: options.mode === "write" ? "not_run" : projectionDiff || failures.length > 0 ? "different" : "equal", schemaValidation, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: forbiddenEmpty(failures) })
      const candidate = { ...generated, failures, report }
      if (!validateReportBundle(candidate, before)) {
        failures.push(buildFailure("schema_invalid", "REPORT_SCHEMA_VALIDATION_FAILED", [], []))
        report = reportWith({ mode: options.mode, falsifierId: null, status: "schema_invalid", exitCode: 8, projectionWrite: options.mode === "write" ? { status: "blocked", target_ref: PROJECTION_DIRECTORY } : { status: "not_requested", target_ref: null }, sourceManifestSha256: sourceDigestForManifest(generated.sourceManifest), artifactBytes: generated.bytes, inventories, failures, mismatches: reportMismatches, deterministicDiff: options.mode === "write" ? "not_run" : "different", schemaValidation: false, crossReferenceValidation: crossReferencesValid, forbiddenStatesEmpty: false })
      }
    }
    const artifacts = { ...generated, failures, report }
    return { exitCode: report.exit_code, report, artifacts, projectionDiff }
  })

interface RunServices {
  readonly collect: (options: RunOptions) => Effect.Effect<GeneratedArtifacts, ParityRuntimeError>
}

const runWithServices = (options: RunOptions, services: RunServices): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    const generated = yield* services.collect(options)
    const terminalGenerated = options.mode === "write"
      ? yield* Effect.gen(function* () {
        const latestGenerated = yield* services.collect(options)
        const latestDigest = sourceDigestForManifest(latestGenerated.sourceManifest)
        const generatedDigest = sourceDigestForManifest(generated.sourceManifest)
        const replayBytesDiffer = Object.keys(generated.bytes).some((name) => generated.bytes[name] !== latestGenerated.bytes[name])
        const replayFailure = latestDigest !== generatedDigest
          ? buildFailure("source_hash_drift", "SOURCE_HASH_DRIFT", [], [])
          : replayBytesDiffer
            ? buildFailure("nondeterministic_output", "NONDETERMINISTIC_OUTPUT", [], [])
            : null
        return replayFailure === null ? generated : { ...generated, failures: [...generated.failures, replayFailure] }
      })
      : generated
    return yield* runTerminalStageEffect(options, terminalGenerated)
  })

export const run = (options: RunOptions): Effect.Effect<RunResult, ParityRuntimeError> =>
  Effect.gen(function* () {
    if (options.mode === "fixture_injection") {
      if (options.falsifierId === undefined) {
        return yield* Effect.fail(new ParityRuntimeError({ operation: "fixture_injection", path: options.root, message: "fixture_injection requires --falsifier F0..F19" }))
      }
      return yield* runFixtureFalsifier(options)
    }
    return yield* runWithServices(options, { collect: generateFromRootsEffect })
  })
const trustedEmptyInventory = (inventory: InventoryEnvelope, sourceManifestSha256: string): InventoryEnvelope => ({
  ...inventory,
  source_manifest_sha256: sourceManifestSha256,
  rows: [],
  links: [],
  observations: [],
  derivation_edges: [],
})

const trustedFixtureArtifacts = (source: GeneratedArtifacts, mode: "diff" | "write"): GeneratedArtifacts => {
  const sourceManifestSha256 = sourceDigestForManifest(source.sourceManifest)
  const legacyRoutes = trustedEmptyInventory(source.legacyRoutes, sourceManifestSha256)
  const monoRoutes = trustedEmptyInventory(source.monoRoutes, sourceManifestSha256)
  const apiOperations = trustedEmptyInventory(source.apiOperations, sourceManifestSha256)
  const commandWrites = trustedEmptyInventory(source.commandWrites, sourceManifestSha256)
  const scheduledBackgroundWorkflows = trustedEmptyInventory(source.scheduledBackgroundWorkflows, sourceManifestSha256)
  const externalIntegrations = trustedEmptyInventory(source.externalIntegrations, sourceManifestSha256)
  const userJourneyCoverage = trustedEmptyInventory(source.userJourneyCoverage, sourceManifestSha256)
  const openapiReconciliation: OpenApiReconciliation = {
    ...source.openapiReconciliation,
    source_manifest_sha256: sourceManifestSha256,
    status: "current",
    only_committed: [],
    only_regenerated: [],
    changed_operations: [],
  }
  const inventories = [legacyRoutes, monoRoutes, apiOperations, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, userJourneyCoverage]
  const bytes = artifactBytes(source.sourceManifest, legacyRoutes, monoRoutes, apiOperations, commandWrites, scheduledBackgroundWorkflows, externalIntegrations, userJourneyCoverage, openapiReconciliation)
  const report = reportWith({
    mode: "diff",
    falsifierId: null,
    status: mode === "write" ? "stale" : "zero_gap",
    exitCode: mode === "write" ? 5 : 0,
    projectionWrite: { status: "not_requested", target_ref: null },
    sourceManifestSha256,
    artifactBytes: bytes,
    inventories,
    failures: [],
    mismatches: [],
    deterministicDiff: mode === "write" ? "different" : "equal",
    schemaValidation: true,
    crossReferenceValidation: true,
    forbiddenStatesEmpty: true,
  })
  return {
    sourceManifest: source.sourceManifest,
    legacyRoutes,
    monoRoutes,
    acceptedIntentRegister: undefined,
    apiOperations,
    commandWrites,
    scheduledBackgroundWorkflows,
    externalIntegrations,
    userJourneyCoverage,
    openapiReconciliation,
    report,
    bytes,
    failures: [],
    routeRows: [],
    apiRows: [],
    c2Rows: [],
  }
}

const collectTrustedFixtureArtifacts = (workspace: FixtureWorkspace, mode: "diff" | "write"): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
  generateFixtureFromWorkspaceEffect({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "fixture_injection" }, workspace).pipe(Effect.map((source) => trustedFixtureArtifacts(source, mode)))

export const runTrustedFixtureTerminalCycle = (): Effect.Effect<{
  readonly writeReport: ZeroGapReport
  readonly idempotentWriteReport: ZeroGapReport
  readonly diffReport: ZeroGapReport
  readonly missingDiffReport: ZeroGapReport
  readonly differentDiffReport: ZeroGapReport
  readonly projectionEntries: readonly string[]
  readonly projectionBytes: Readonly<Record<string, string>>
}, ParityRuntimeError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const workspace = createFixtureWorkspace({ root: ".", legacyRoot: ".", mode: "fixture_injection" })
        for (const root of [workspace.root, workspace.legacyRoot]) {
          execFileSync("git", ["-C", root, "init", "--quiet"])
          execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"])
          execFileSync("git", ["-C", root, "config", "user.name", "fixture"])
          execFileSync("git", ["-C", root, "add", "--all"])
          execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture source"])
        }
        refreshFixtureIntentRegister(workspace)
        return workspace
      },
      catch: (cause) => new ParityRuntimeError({ operation: "fixture_terminal_setup", path: ".", message: cause instanceof Error ? cause.message : "fixture terminal setup failed" }),
    }),
    (workspace) => Effect.gen(function* () {
      const authority = createFixtureIntentAuthority(workspace)
      const evidenceAuthority = createFixtureEvidenceAuthority(workspace)
      try {
        const pinned = yield* readPinnedIntentRegisterEffect(authority.path, workspace.legacyRoot, workspace.root, PROJECTION_DIRECTORY)
        const pinnedEvidence = yield* readPinnedRuntimeEvidenceRegisterEffect(evidenceAuthority.path, workspace.legacyRoot, workspace.root, PROJECTION_DIRECTORY)
        const attachAuthority = (generated: GeneratedArtifacts): GeneratedArtifacts => ({
          ...generated,
          intentAuthority: {
            repository_ref: "external_intent_authority",
            authority_path: authority.path,
            revision_ref_id: pinned.revisionRefId,
            revision: pinned.revision,
            blob_oid: pinned.blobOid,
            digest: pinned.digest,
            immutable: true,
            authority_root: pinned.authorityRoot,
            relative_path: pinned.relativePath,
            bytes: pinned.bytes,
          },
          evidenceAuthority: {
            repository_ref: "external_runtime_evidence_authority",
            authority_path: `authority://blob/${pinnedEvidence.blobOid}`,
            revision_ref_id: pinnedEvidence.revisionRefId,
            revision: pinnedEvidence.revision,
            blob_oid: pinnedEvidence.blobOid,
            digest: pinnedEvidence.digest,
            immutable: true,
            authority_root: pinnedEvidence.authorityRoot,
            relative_path: pinnedEvidence.relativePath,
            bytes: pinnedEvidence.bytes,
            source_ref_ids: [],
          },
          runtimeEvidenceRegister: pinnedEvidence.register,
        })
        const collect = (options: RunOptions): Effect.Effect<GeneratedArtifacts, ParityRuntimeError> =>
          collectTrustedFixtureArtifacts(workspace, options.mode === "write" ? "write" : "diff").pipe(Effect.map(attachAuthority))
        const writeResult = yield* runWithServices({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "write", intentRegisterPath: authority.path }, { collect })
        if (writeResult.exitCode !== 14) throw new Error(`fixture write did not return exit 14: ${writeResult.exitCode}`)
        execFileSync("git", ["-C", workspace.root, "add", "--", ...COMMITTED_PROJECTIONS.map((name) => `${PROJECTION_DIRECTORY}/${name}`)])
        execFileSync("git", ["-C", workspace.root, "commit", "--quiet", "-m", "projection promotion"])
        const diffResult = yield* runWithServices({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff", intentRegisterPath: authority.path }, { collect })
        const beforeIdempotentWrite = Object.fromEntries(COMMITTED_PROJECTIONS.map((name) => [name, readFileSync(join(workspace.root, PROJECTION_DIRECTORY, name), "utf8")]))
        const idempotentWriteResult = yield* runWithServices({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "write", intentRegisterPath: authority.path }, { collect })
        if (idempotentWriteResult.exitCode !== 14) throw new Error(`fixture idempotent write did not return exit 14: ${idempotentWriteResult.exitCode}`)
        const afterIdempotentWrite = Object.fromEntries(COMMITTED_PROJECTIONS.map((name) => [name, readFileSync(join(workspace.root, PROJECTION_DIRECTORY, name), "utf8")]))
        if (COMMITTED_PROJECTIONS.some((name) => beforeIdempotentWrite[name] !== afterIdempotentWrite[name])) throw new Error("fixture idempotent write changed projection bytes")
        const projectionEntries = readdirSync(join(workspace.root, PROJECTION_DIRECTORY)).sort(compareByteOrder)
        const projectionBytes = Object.fromEntries(COMMITTED_PROJECTIONS.map((name) => [name, readFileSync(join(workspace.root, PROJECTION_DIRECTORY, name), "utf8")]))
        const projectionDirectory = join(workspace.root, PROJECTION_DIRECTORY)
        const missingPath = join(projectionDirectory, "legacy-routes.json")
        const legacyProjection = projectionBytes["legacy-routes.json"]
        const monoProjection = projectionBytes["mono-routes.json"]
        if (legacyProjection === undefined || monoProjection === undefined) throw new Error("fixture projection snapshot missing")
        rmSync(missingPath)
        const missingDiffResult = yield* runWithServices({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff", intentRegisterPath: authority.path }, { collect })
        writeFileSync(missingPath, legacyProjection, "utf8")
        const differentPath = join(projectionDirectory, "mono-routes.json")
        writeFileSync(differentPath, "stale-generated-artifact", "utf8")
        const differentDiffResult = yield* runWithServices({ root: workspace.root, legacyRoot: workspace.legacyRoot, mode: "diff", intentRegisterPath: authority.path }, { collect })
        writeFileSync(differentPath, monoProjection, "utf8")
        return { writeReport: writeResult.report, idempotentWriteReport: idempotentWriteResult.report, diffReport: diffResult.report, missingDiffReport: missingDiffResult.report, differentDiffReport: differentDiffResult.report, projectionEntries, projectionBytes }
      } finally {
        rmSync(authority.directory, { recursive: true, force: true })
      }
    }),
    (workspace) => Effect.sync(() => rmSync(workspace.directory, { recursive: true, force: true })),
  )
