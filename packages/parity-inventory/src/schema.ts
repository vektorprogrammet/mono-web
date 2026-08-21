import Ajv2020 from "ajv/dist/2020.js"
import inventorySchema from "../schemas/inventory.json"
import sourceManifestSchema from "../schemas/source-manifest.json"
import reportSchema from "../schemas/report.json"
import openapiReconciliationSchema from "../schemas/openapi-reconciliation.json"
import runtimeEvidenceSchema from "../schemas/runtime-evidence.json"
import { canonicalJson, compareByteOrder, sha256 } from "./canonical.js"
import type { GeneratedArtifacts, InventoryEnvelope, OpenApiReconciliation, ReportFailure, RuntimeEvidenceRegister, SourceManifest, ZeroGapReport } from "./types.js"
import { validateCrossArtifactInvariants } from "./coverage.js"

export const INVENTORY_SCHEMA = inventorySchema as Record<string, unknown>
export const SOURCE_MANIFEST_SCHEMA = sourceManifestSchema as Record<string, unknown>
export const REPORT_SCHEMA = reportSchema as Record<string, unknown>
export const OPENAPI_RECONCILIATION_SCHEMA = openapiReconciliationSchema as Record<string, unknown>
export const RUNTIME_EVIDENCE_SCHEMA = runtimeEvidenceSchema as Record<string, unknown>

const ajv = new Ajv2020({ allErrors: true, strict: false })
const inventoryValidator = ajv.compile<InventoryEnvelope>(INVENTORY_SCHEMA)
const sourceManifestValidator = ajv.compile<SourceManifest>(SOURCE_MANIFEST_SCHEMA)
const reportValidator = ajv.compile<ZeroGapReport>(REPORT_SCHEMA)
const openapiReconciliationValidator = ajv.compile<OpenApiReconciliation>(OPENAPI_RECONCILIATION_SCHEMA)
const runtimeEvidenceValidator = ajv.compile<RuntimeEvidenceRegister>(RUNTIME_EVIDENCE_SCHEMA)

export const validateInventory = (value: unknown): value is InventoryEnvelope => inventoryValidator(value) === true

export const validateSourceManifest = (value: unknown): value is SourceManifest => sourceManifestValidator(value) === true

export const validateOpenApiReconciliation = (value: unknown): value is OpenApiReconciliation => openapiReconciliationValidator(value) === true
export const validateRuntimeEvidence = (value: unknown): value is RuntimeEvidenceRegister => runtimeEvidenceValidator(value) === true

const decodeReportShape = (value: unknown): value is ZeroGapReport => reportValidator(value) === true

export type GeneratedArtifactBundle = Pick<
  GeneratedArtifacts,
  | "sourceManifest"
  | "legacyRoutes"
  | "monoRoutes"
  | "apiOperations"
  | "commandWrites"
  | "scheduledBackgroundWorkflows"
  | "externalIntegrations"
  | "userJourneyCoverage"
  | "openapiReconciliation"
  | "acceptedIntentRegister"
  | "report"
  | "bytes"
  | "failures"
>

export interface ProjectionObservation {
  readonly entries: readonly string[]
  readonly bytes: Readonly<Record<string, string | null>>
  readonly writeReceipt: boolean
}

const GENERATED_ARTIFACT_NAMES = [
  "source-manifest.json",
  "legacy-routes.json",
  "mono-routes.json",
  "api-operations.json",
  "command-write-paths.json",
  "scheduled-background-workflows.json",
  "external-integrations.json",
  "user-journey-coverage.json",
  "openapi-reconciliation.json",
] as const
const PROJECTION_ARTIFACT_NAMES = GENERATED_ARTIFACT_NAMES.slice(0, 8)

const generatedInventories = (objects: Record<string, unknown>): readonly InventoryEnvelope[] => [
  objects["legacy-routes.json"] as InventoryEnvelope,
  objects["mono-routes.json"] as InventoryEnvelope,
  objects["api-operations.json"] as InventoryEnvelope,
  objects["command-write-paths.json"] as InventoryEnvelope,
  objects["scheduled-background-workflows.json"] as InventoryEnvelope,
  objects["external-integrations.json"] as InventoryEnvelope,
  objects["user-journey-coverage.json"] as InventoryEnvelope,
]

const sameStringKeys = (left: Record<string, unknown>, right: readonly string[]): boolean => {
  const expected = [...right].sort(compareByteOrder)
  const actual = Object.keys(left).sort(compareByteOrder)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const countBy = (inventories: readonly InventoryEnvelope[], field: "inventory_kind" | "status"): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const inventory of inventories) {
    if (field === "inventory_kind") counts[inventory.inventory_kind] = (counts[inventory.inventory_kind] ?? 0) + inventory.rows.length
    else for (const row of inventory.rows) counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareByteOrder(left, right)))
}

const bundleForbiddenStatesEmpty = (
  inventories: readonly InventoryEnvelope[],
  reconciliation: OpenApiReconciliation,
  failures: readonly unknown[],
  crossReferencesValid: boolean,
): boolean => {
  const forbiddenStatuses = new Set(["missing", "extra", "changed", "uncovered", "unresolved", "stale", "duplicate", "dead_unimported", "absent"])
  const forbiddenKinds = new Set(["missing", "extra", "changed", "uncovered", "unresolved", "stale", "openapi_stale", "duplicate"])
  return crossReferencesValid &&
    reconciliation.status === "current" &&
    failures.length === 0 &&
    inventories.every((inventory) =>
      inventory.inventory_kind === "user_journey" ||
      inventory.rows.every((row) =>
        !forbiddenStatuses.has(row.status) &&
        !forbiddenKinds.has(row.mismatch.kind) &&
        row.coverage_ref_ids.length > 0,
      ),
    )
}

const parseCanonicalArtifact = (value: unknown): unknown | null => {
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value) as unknown
    return canonicalJson(parsed) === value ? parsed : null
  } catch {
    return null
  }
}

const mismatchKey = (value: { readonly kind: string; readonly row_ids: readonly string[] }): string => canonicalJson({ kind: value.kind, row_ids: value.row_ids })
const derivedMismatches = (inventories: readonly InventoryEnvelope[], reconciliation: OpenApiReconciliation): readonly ZeroGapReport["mismatches"][number][] => {
  const unique = new Map<string, ZeroGapReport["mismatches"][number]>()
  for (const row of inventories.flatMap((inventory) => inventory.rows)) {
    if (row.mismatch.kind === "none") continue
    const mismatch = {
      kind: row.mismatch.kind as ZeroGapReport["mismatches"][number]["kind"],
      row_ids: [...new Set([row.row_id, ...row.mismatch.counterpart_row_ids])].sort(compareByteOrder),
      disposition: row.mismatch.disposition,
      accepted_intent_ref_ids: [...row.mismatch.accepted_intent_ref_ids].sort(compareByteOrder),
    }
    unique.set(mismatchKey(mismatch), mismatch)
  }
  if (reconciliation.status === "stale") {
    const mismatch = { kind: "openapi_stale" as const, row_ids: inventories[2]?.rows.map((row) => row.row_id).sort(compareByteOrder) ?? [], disposition: "none" as const, accepted_intent_ref_ids: [] }
    unique.set(mismatchKey(mismatch), mismatch)
  }
  return [...unique.values()].sort((left, right) => compareByteOrder(mismatchKey(left), mismatchKey(right)))
}
export const deriveReportMismatches = derivedMismatches

const observedProjection = (observation: ProjectionObservation): { readonly bytes: Record<string, string | null>; readonly unknown: readonly string[] } | null => {
  if (observation === null || typeof observation !== "object" || !Array.isArray(observation.entries) || observation.entries.some((entry) => typeof entry !== "string")) return null
  const bytes = observation.bytes
  if (bytes === null || typeof bytes !== "object" || Array.isArray(bytes) || !sameStringKeys(bytes as Record<string, unknown>, PROJECTION_ARTIFACT_NAMES)) return null
  const normalized: Record<string, string | null> = {}
  for (const name of PROJECTION_ARTIFACT_NAMES) {
    const value = bytes[name]
    if (value !== null && typeof value !== "string") return null
    normalized[name] = value
  }
  const unknown = observation.entries.filter((entry) => !PROJECTION_ARTIFACT_NAMES.includes(entry as (typeof PROJECTION_ARTIFACT_NAMES)[number]))
  return { bytes: normalized, unknown }
}

const derivedPrimary = (failures: readonly ReportFailure[], projectionDiff: boolean): { readonly status: ZeroGapReport["status"]; readonly exitCode: number } => {
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

/**
 * Validate the generated artifact set independently of any provisional terminal report.
 * This is the pre-write gate: it validates canonical bytes, schemas, references, and
 * forbidden states without accepting report terminal claims.
 */
export const validateGeneratedArtifactSet = (bundle: GeneratedArtifactBundle): boolean => {
  try {
    if (bundle === null || typeof bundle !== "object" || bundle.bytes === null || typeof bundle.bytes !== "object") return false
    const bytes = bundle.bytes as Record<string, unknown>
    if (!sameStringKeys(bytes, GENERATED_ARTIFACT_NAMES)) return false
    const objects: Record<string, unknown> = {
      "source-manifest.json": bundle.sourceManifest,
      "legacy-routes.json": bundle.legacyRoutes,
      "mono-routes.json": bundle.monoRoutes,
      "api-operations.json": bundle.apiOperations,
      "command-write-paths.json": bundle.commandWrites,
      "scheduled-background-workflows.json": bundle.scheduledBackgroundWorkflows,
      "external-integrations.json": bundle.externalIntegrations,
      "user-journey-coverage.json": bundle.userJourneyCoverage,
      "openapi-reconciliation.json": bundle.openapiReconciliation,
    }
    const parsed: Record<string, unknown> = {}
    for (const name of GENERATED_ARTIFACT_NAMES) {
      const value = bytes[name]
      if (typeof value !== "string") return false
      const artifact = parseCanonicalArtifact(value)
      if (artifact === null || canonicalJson(artifact) !== canonicalJson(objects[name])) return false
      parsed[name] = artifact
    }
    const manifest = parsed["source-manifest.json"]
    const inventories = generatedInventories(parsed)
    const reconciliation = parsed["openapi-reconciliation.json"] as OpenApiReconciliation
    if (!validateSourceManifest(manifest) ||
      inventories.some((inventory) => !validateInventory(inventory)) ||
      !validateOpenApiReconciliation(reconciliation)) return false
    const sourceManifestBytes = bytes["source-manifest.json"]
    if (typeof sourceManifestBytes !== "string") return false
    const sourceManifestSha256 = sha256(sourceManifestBytes)
    if (inventories.some((inventory) => inventory.source_manifest_sha256 !== sourceManifestSha256) || reconciliation.source_manifest_sha256 !== sourceManifestSha256) return false
    const sourceIds = new Set((manifest as SourceManifest).sources.map((source) => source.source_id))
    const rowIds = new Set(inventories.flatMap((inventory) => inventory.rows.map((row) => row.row_id)))
    if (!Array.isArray(bundle.failures) || bundle.failures.some((failure) =>
      failure === null ||
      typeof failure !== "object" ||
      !Array.isArray(failure.row_ids) ||
      !Array.isArray(failure.source_ref_ids) ||
      !failure.row_ids.every((rowId: unknown) => typeof rowId === "string" && rowIds.has(rowId)) ||
      !failure.source_ref_ids.every((sourceRefId: unknown) => typeof sourceRefId === "string" && sourceIds.has(sourceRefId)))) return false
    const failures = [...bundle.failures].sort((left, right) => compareByteOrder(left.failure_id, right.failure_id))
    const userJourneyCoverage = inventories[6]
    if (userJourneyCoverage === undefined) return false
    const crossReferencesValid = validateCrossArtifactInvariants({
      manifest: manifest as SourceManifest,
      inventories: inventories.slice(0, 6),
      userJourneyCoverage,
      register: bundle.acceptedIntentRegister ?? null,
      links: inventories.flatMap((inventory) => inventory.links),
    })
    const forbiddenStatesEmpty = bundleForbiddenStatesEmpty(inventories, reconciliation, failures, crossReferencesValid)
    return crossReferencesValid && (forbiddenStatesEmpty || failures.length > 0)
  } catch {
    return false
  }
}

/**
 * Validate the final observed report against the generated artifacts and the
 * exact-eight projection read captured by the terminal stage.
 */
export const validateReportBundle = (bundle: GeneratedArtifactBundle, observation: ProjectionObservation): boolean => {
  try {
    const bytes = bundle.bytes as Record<string, unknown>
    const report = bundle.report
    const parsed: Record<string, unknown> = {}
    if (!validateGeneratedArtifactSet(bundle) || !decodeReportShape(bundle.report)) return false
    for (const name of GENERATED_ARTIFACT_NAMES) {
      const value = bytes[name]
      if (typeof value !== "string") return false
      const artifact = parseCanonicalArtifact(value)
      if (artifact === null) return false
      parsed[name] = artifact
    }
    const inventories = generatedInventories(parsed)
    const reconciliation = parsed["openapi-reconciliation.json"] as OpenApiReconciliation
    const manifest = parsed["source-manifest.json"] as SourceManifest
    const sourceManifestBytes = bytes["source-manifest.json"]
    if (typeof sourceManifestBytes !== "string") return false
    const sourceManifestSha256 = sha256(sourceManifestBytes)
    const failures = [...bundle.failures].sort((left, right) => compareByteOrder(left.failure_id, right.failure_id))
    if (report.verification.schema_validation !== true ||
      report.source_manifest_sha256 !== sourceManifestSha256 ||
      !sameStringKeys(report.inventory_artifact_sha256, GENERATED_ARTIFACT_NAMES) ||
      GENERATED_ARTIFACT_NAMES.some((name) => typeof bytes[name] !== "string" || report.inventory_artifact_sha256[name] !== sha256(bytes[name] as string)) ||
      canonicalJson(report.failures) !== canonicalJson(failures) ||
      canonicalJson(report.mismatches) !== canonicalJson(derivedMismatches(inventories, reconciliation)) ||
      canonicalJson(report.row_counts) !== canonicalJson(countBy(inventories, "inventory_kind")) ||
      canonicalJson(report.status_counts) !== canonicalJson(countBy(inventories, "status"))) return false
    const userJourneyCoverage = inventories[6]
    if (userJourneyCoverage === undefined) return false
    const crossReferencesValid = validateCrossArtifactInvariants({
      manifest,
      inventories: inventories.slice(0, 6),
      userJourneyCoverage,
      register: bundle.acceptedIntentRegister ?? null,
      links: inventories.flatMap((inventory) => inventory.links),
    })
    if (report.verification.cross_reference_validation !== crossReferencesValid) return false
    const projection = observedProjection(observation)
    if (projection === null) return false
    const projectionDiff = projection.unknown.length > 0 || PROJECTION_ARTIFACT_NAMES.some((name) => projection.bytes[name] !== bytes[name])
    const effectiveFailures: readonly ReportFailure[] = projection.unknown.length === 0
      ? failures
      : [...failures, { status: "stale" } as ReportFailure]
    const forbiddenStatesEmpty = bundleForbiddenStatesEmpty(inventories, reconciliation, effectiveFailures, crossReferencesValid)
    if (report.verification.forbidden_states_empty !== forbiddenStatesEmpty) return false
    const expectedDeterministicDiff = report.mode === "diff" ? (projectionDiff || effectiveFailures.length > 0 ? "different" : "equal") : "not_run"
    if (report.verification.deterministic_diff !== expectedDeterministicDiff) return false
    if (report.mode === "diff") {
      const expectedPrimary = derivedPrimary(effectiveFailures, projectionDiff)
      if (report.status !== expectedPrimary.status || report.exit_code !== expectedPrimary.exitCode) return false
    }
    if (report.mode === "diff" && report.projection_write.status !== "not_requested") return false
    if (report.status === "projection_written" && (!forbiddenStatesEmpty || failures.length > 0 || report.mode !== "write" || report.projection_write.status !== "written" || report.verification.deterministic_diff !== "not_run" || !observation.writeReceipt || projectionDiff)) return false
    if (report.status === "zero_gap" && (projectionDiff || !forbiddenStatesEmpty || failures.length > 0 || report.mode !== "diff" || report.verification.deterministic_diff !== "equal")) return false
    return true
  } catch {
    return false
  }
}
