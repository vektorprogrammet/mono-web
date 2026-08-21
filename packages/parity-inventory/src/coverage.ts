import { validateAcceptedIntentShape } from "./accepted-intent-schema.js"
import {
  canonicalJson,
  compareByteOrder,
  declarationId,
  edgeId,
  relationId,
  rowId,
  sha256,
  sortUnique,
  stableId,
} from "./canonical.js"
import { unsafeScalarReason, type ManifestContext } from "./source-manifest.js"
import { hasDuplicateJsonMembers } from "./json-safety.js"
import type {
  Disposition,
  InventoryEnvelope,
  InventoryKind,
  InventoryLink,
  InventoryRow,
  JourneyStep,
  MismatchKind,
  ObservationKind,
  ReportFailure,
  RevisionRecord,
  RuntimeEvidenceRegister,
  SourceManifest,
  UserJourneyDetails,
} from "./types.js"


const SURFACES = [
  "legacy_route",
  "mono_route",
  "api_operation",
  "command_write",
  "schedule_background",
  "external_integration",
] as const

export type JourneySurface = (typeof SURFACES)[number]
export type CoverageScope = UserJourneyDetails["coverage_scope"]
export type AcceptedDisposition = Exclude<Disposition, "none" | "rejected">
export type IntentPurpose = "coverage" | "disposition"

const ACCEPTED_DISPOSITIONS: readonly AcceptedDisposition[] = [
  "accepted_missing",
  "accepted_extra",
  "accepted_changed",
  "accepted_renamed",
  "accepted_split",
  "accepted_merged",
  "accepted_dead_source",
  "accepted_absent",
  "accepted_not_applicable",
]
const MISMATCH_DISPOSITIONS: Readonly<Record<string, AcceptedDisposition>> = {
  missing: "accepted_missing",
  extra: "accepted_extra",
  changed: "accepted_changed",
  renamed: "accepted_renamed",
  split: "accepted_split",
  merged: "accepted_merged",
  dead_unimported: "accepted_dead_source",
  absent: "accepted_absent",
}
const FORBIDDEN_INTENT_KINDS = new Set<MismatchKind>(["duplicate", "stale", "openapi_stale", "unresolved", "uncovered"])
const PARITY_KINDS = new Set<InventoryKind>([
  "legacy_route",
  "mono_route",
  "api_operation",
  "command_write",
  "schedule_background",
  "external_integration",
])
const REF_ID = /^intent:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ROW_ID = /^row-[a-f0-9]{64}$/
const SOURCE_ID = /^src-[a-f0-9]{64}$/
const REVISION_ID = /^rev-[A-Za-z0-9:_-]{1,160}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const SAFE_INTENT_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/
export interface AcceptedIntentRecord {
  readonly intent_ref_id: string
  readonly intent_revision: string
  readonly intent_digest: string
  readonly selected_revision_ref_ids: readonly string[]
  readonly source_ref_ids: readonly string[]
  readonly purpose: IntentPurpose
  readonly disposition: AcceptedDisposition | null
  readonly row_ids: readonly string[]
  readonly canonical_signatures: readonly string[]
  readonly inventory_kinds: readonly InventoryKind[]
  readonly journey_ref_ids: readonly string[]
}

export interface AcceptedJourneyRecord {
  readonly journey_ref_id: string
  readonly journey_key: string
  readonly intent_ref_id: string
  readonly journey_revision: string
  readonly journey_digest: string
  readonly selected_revision_ref_ids: readonly string[]
  readonly source_ref_ids: readonly string[]
  readonly steps: readonly JourneyStep[]
  readonly coverage_scope: CoverageScope
}

export interface AcceptedIntentRegister {
  readonly schema_version: "functional-parity-accepted-intent/v1"
  readonly intents: readonly AcceptedIntentRecord[]
  readonly journeys: readonly AcceptedJourneyRecord[]
}

export interface CoverageIssue {
  readonly status: "accepted_intent_invalid" | "gaps_found" | "unresolved"
  readonly reasonCode: string
  readonly rowIds: readonly string[]
  readonly sourceRefIds: readonly string[]
  readonly acceptedIntentRefIds: readonly string[]
}

export interface IntentDecodeResult {
  readonly register: AcceptedIntentRegister | null
  readonly issues: readonly CoverageIssue[]
}

export interface IntentSourceInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly revisionRefId: string
  readonly repositoryRef: string
  readonly revision: string
  readonly blobOid: string
  readonly digest: string
}
export interface IntentLoadResult extends IntentDecodeResult {
  readonly path: string | null
  readonly sourceRefId: string | null
  readonly sourceRevisionRefId: string | null
  readonly sourceDigest: string | null
}

export interface CoverageResolution {
  readonly register: AcceptedIntentRegister | null
  readonly userJourneyCoverage: InventoryEnvelope
  readonly inventories: readonly InventoryEnvelope[]
  readonly links: readonly InventoryLink[]
  readonly issues: readonly CoverageIssue[]
  readonly coverageRefIds: ReadonlyMap<string, readonly string[]>
}

export interface CrossArtifactInvariantInput {
  readonly manifest: SourceManifest
  readonly inventories: readonly InventoryEnvelope[]
  readonly userJourneyCoverage: InventoryEnvelope
  readonly register: AcceptedIntentRegister | null
  readonly links: readonly InventoryLink[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const hasExactly = (value: Record<string, unknown>, required: readonly string[]): boolean => Object.keys(value).length === required.length && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
const safeIntentScalar = (value: unknown, field: string): value is string => typeof value === "string" && value.length <= 128 && SAFE_INTENT_SCALAR.test(value) && unsafeScalarReason(value, field) === null
const safeCanonicalSignature = (value: string): boolean => value.length <= 512 && unsafeScalarReason(value, "accepted_intent_signature") === null
const stringValue = (value: unknown): value is string => typeof value === "string" && value.length > 0
const stringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(stringValue) && new Set(value).size === value.length
const isDisposition = (value: unknown): value is AcceptedDisposition => typeof value === "string" && (ACCEPTED_DISPOSITIONS as readonly string[]).includes(value)
const isSurface = (value: unknown): value is JourneySurface => typeof value === "string" && (SURFACES as readonly string[]).includes(value)
const isCoverageScope = (value: unknown): value is CoverageScope => value === "user_visible" || value === "operator_visible" || value === "background" || value === "accepted_non_user_facing"
const sorted = (values: readonly string[]): string[] => sortUnique(values)
const issue = (reasonCode: string, status: CoverageIssue["status"] = "accepted_intent_invalid", rowIds: readonly string[] = [], sourceRefIds: readonly string[] = [], acceptedIntentRefIds: readonly string[] = []): CoverageIssue => ({ status, reasonCode, rowIds: sorted(rowIds), sourceRefIds: sorted(sourceRefIds), acceptedIntentRefIds: sorted(acceptedIntentRefIds) })
const currentRevisionIds = (revisions: readonly RevisionRecord[]): string[] => sorted(revisions.map((revision) => revision.revision_ref_id))
export const acceptedIntentRevisionRefId = (context: ManifestContext): string => context.scans.mono.revisionRefId

const canonicalSignature = (value: string): boolean => {
  if (value.length === 0 || value.includes("*") || value.includes("..") || value.includes("/tmp/") || /(?:^|[^A-Za-z])(?:src|rev)-[a-f0-9]{16,}(?:$|[^A-Za-z0-9])/.test(value)) return false
  try {
    return canonicalJson(JSON.parse(value)) === value
  } catch {
    return false
  }
}

const intentPayload = (intent: Omit<AcceptedIntentRecord, "intent_digest">): unknown => ({
  intent_ref_id: intent.intent_ref_id,
  intent_revision: intent.intent_revision,
  selected_revision_ref_ids: intent.selected_revision_ref_ids,
  source_ref_ids: intent.source_ref_ids,
  purpose: intent.purpose,
  disposition: intent.disposition,
  row_ids: intent.row_ids,
  canonical_signatures: intent.canonical_signatures,
  inventory_kinds: intent.inventory_kinds,
  journey_ref_ids: intent.journey_ref_ids,
})

const journeyPayload = (journey: Omit<AcceptedJourneyRecord, "journey_digest">): unknown => ({
  journey_ref_id: journey.journey_ref_id,
  journey_key: journey.journey_key,
  intent_ref_id: journey.intent_ref_id,
  journey_revision: journey.journey_revision,
  selected_revision_ref_ids: journey.selected_revision_ref_ids,
  source_ref_ids: journey.source_ref_ids,
  steps: journey.steps,
  coverage_scope: journey.coverage_scope,
})

const parseStep = (value: unknown, index: number): { readonly step: JourneyStep | null; readonly issues: readonly CoverageIssue[] } => {
  const allowed = ["step_id", "surface", "row_ids", "canonical_signatures", "expected_contract_ref", "runtime_evidence_ref_ids"]
  if (!isRecord(value) || !hasExactly(value, allowed)) return { step: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  const rowIds = value.row_ids
  const signatures = value.canonical_signatures
  const runtimeEvidenceRefs = value.runtime_evidence_ref_ids
  const expected = value.expected_contract_ref
  if (!safeIntentScalar(value.step_id, "journey_step") || !isSurface(value.surface) || !stringArray(rowIds) || !stringArray(signatures) || (expected !== null && !safeIntentScalar(expected, "expected_contract_ref")) || !stringArray(runtimeEvidenceRefs)) return { step: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  const canonicalSignatures = sorted(signatures)
  if (rowIds.length === 0 && canonicalSignatures.length === 0) return { step: null, issues: [issue("COVERAGE_REF_REQUIRED")] }
  if (canonicalSignatures.some((signature) => !canonicalSignature(signature) || !safeCanonicalSignature(signature))) return { step: null, issues: [issue("CANONICAL_SIGNATURE_INVALID")] }
  if (rowIds.some((rowIdValue) => !ROW_ID.test(rowIdValue)) || runtimeEvidenceRefs.some((ref) => !safeIntentScalar(ref, "runtime_evidence_ref"))) return { step: null, issues: [issue("ROW_REF_INVALID")] }
  return {
    step: {
      step_id: value.step_id,
      surface: value.surface,
      row_ids: sorted(rowIds),
      canonical_signatures: canonicalSignatures,
      expected_contract_ref: expected,
      runtime_evidence_ref_ids: sorted(runtimeEvidenceRefs),
    },
    issues: index < 0 ? [issue("INTENT_SCHEMA_INVALID")] : [],
  }
}
const parseIntent = (value: unknown, expectedRevisionIds: readonly string[]): { readonly intent: AcceptedIntentRecord | null; readonly issues: readonly CoverageIssue[] } => {
  const allowed = ["intent_ref_id", "intent_revision", "intent_digest", "selected_revision_ref_ids", "source_ref_ids", "purpose", "disposition", "row_ids", "canonical_signatures", "inventory_kinds", "journey_ref_ids"]
  if (!isRecord(value) || !hasExactly(value, allowed)) return { intent: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  const intentRef = value.intent_ref_id
  const intentRevision = value.intent_revision
  const digest = value.intent_digest
  const revisions = value.selected_revision_ref_ids
  const sourceRefs = value.source_ref_ids
  const purpose = value.purpose
  const disposition = value.disposition
  const rowIds = value.row_ids
  const signatures = value.canonical_signatures
  const kinds = value.inventory_kinds
  const journeyRefs = value.journey_ref_ids
  if (!safeIntentScalar(intentRef, "intent_ref_id") || !REF_ID.test(intentRef) || !safeIntentScalar(intentRevision, "intent_revision") || !stringValue(digest) || !DIGEST.test(digest) || !stringArray(revisions) || !stringArray(sourceRefs) || !stringValue(purpose) || !stringArray(rowIds) || !stringArray(signatures) || !stringArray(kinds) || !stringArray(journeyRefs) || (purpose !== "coverage" && purpose !== "disposition") || (disposition !== null && !isDisposition(disposition))) return { intent: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  if (!revisions.every((revision) => REVISION_ID.test(revision)) || sorted(revisions).join("\u0000") !== sorted(expectedRevisionIds).join("\u0000")) return { intent: null, issues: [issue("ACCEPTED_INTENT_STALE", "accepted_intent_invalid")] }
  if (sourceRefs.some((sourceRef) => !SOURCE_ID.test(sourceRef)) || rowIds.some((rowIdValue) => !ROW_ID.test(rowIdValue)) || kinds.some((kind) => !PARITY_KINDS.has(kind as InventoryKind)) || journeyRefs.some((journeyRef) => !REF_ID.test(journeyRef))) return { intent: null, issues: [issue("INTENT_REF_INVALID", "accepted_intent_invalid")] }
  const canonicalSignatures = sorted(signatures)
  if (canonicalSignatures.some((signature) => !canonicalSignature(signature) || !safeCanonicalSignature(signature))) return { intent: null, issues: [issue("CANONICAL_SIGNATURE_INVALID", "accepted_intent_invalid")] }
  if (purpose === "disposition" && disposition === null) return { intent: null, issues: [issue("INTENT_DISPOSITION_REQUIRED")] }
  if (purpose === "coverage" && disposition !== null) return { intent: null, issues: [issue("INTENT_PURPOSE_CONFLICT")] }
  if (purpose === "coverage" && journeyRefs.length === 0) return { intent: null, issues: [issue("JOURNEY_REF_REQUIRED")] }
  if (purpose === "disposition" && rowIds.length === 0 && canonicalSignatures.length === 0) return { intent: null, issues: [issue("ACCEPTED_INTENT_REQUIRED")] }
  const intent: AcceptedIntentRecord = {
    intent_ref_id: intentRef,
    intent_revision: intentRevision,
    intent_digest: digest,
    selected_revision_ref_ids: sorted(revisions),
    source_ref_ids: sorted(sourceRefs),
    purpose,
    disposition,
    row_ids: sorted(rowIds),
    canonical_signatures: canonicalSignatures,
    inventory_kinds: sorted(kinds) as InventoryKind[],
    journey_ref_ids: sorted(journeyRefs),
  }
  const expectedDigest = sha256(canonicalJson(intentPayload(intent)))
  if (expectedDigest !== intent.intent_digest) return { intent: null, issues: [issue("ACCEPTED_INTENT_STALE")] }
  return { intent, issues: [] }
}

const parseJourney = (value: unknown, expectedRevisionIds: readonly string[]): { readonly journey: AcceptedJourneyRecord | null; readonly issues: readonly CoverageIssue[] } => {
  const allowed = ["journey_ref_id", "journey_key", "intent_ref_id", "journey_revision", "journey_digest", "selected_revision_ref_ids", "source_ref_ids", "steps", "coverage_scope"]
  if (!isRecord(value) || !hasExactly(value, allowed)) return { journey: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  const journeyRef = value.journey_ref_id
  const journeyKey = value.journey_key
  const intentRef = value.intent_ref_id
  const revision = value.journey_revision
  const digest = value.journey_digest
  const revisions = value.selected_revision_ref_ids
  const sourceRefs = value.source_ref_ids
  const rawSteps = value.steps
  if (!safeIntentScalar(journeyRef, "journey_ref_id") || !REF_ID.test(journeyRef) || !safeIntentScalar(journeyKey, "journey_key") || !safeIntentScalar(intentRef, "intent_ref_id") || !REF_ID.test(intentRef) || !safeIntentScalar(revision, "journey_revision") || !stringValue(digest) || !DIGEST.test(digest) || !stringArray(revisions) || !stringArray(sourceRefs) || !Array.isArray(rawSteps) || !isCoverageScope(value.coverage_scope)) return { journey: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  if (!revisions.every((revisionRef) => REVISION_ID.test(revisionRef)) || sorted(revisions).join("\u0000") !== sorted(expectedRevisionIds).join("\u0000")) return { journey: null, issues: [issue("ACCEPTED_INTENT_STALE")] }
  if (sourceRefs.some((sourceRef) => !SOURCE_ID.test(sourceRef))) return { journey: null, issues: [issue("INTENT_REF_INVALID")] }
  const steps: JourneyStep[] = []
  const issues: CoverageIssue[] = []
  for (const [index, rawStep] of rawSteps.entries()) {
    const parsed = parseStep(rawStep, index)
    if (parsed.step !== null) steps.push(parsed.step)
    issues.push(...parsed.issues)
  }
  if (steps.length === 0 || new Set(steps.map((step) => step.step_id)).size !== steps.length) issues.push(issue("JOURNEY_STEPS_INVALID"))
  const journey: AcceptedJourneyRecord = {
    journey_ref_id: journeyRef,
    journey_key: journeyKey,
    intent_ref_id: intentRef,
    journey_revision: revision,
    journey_digest: digest,
    selected_revision_ref_ids: sorted(revisions),
    source_ref_ids: sorted(sourceRefs),
    steps: steps.sort((left, right) => compareByteOrder(left.step_id, right.step_id)),
    coverage_scope: value.coverage_scope,
  }
  const expectedDigest = sha256(canonicalJson(journeyPayload(journey)))
  if (expectedDigest !== journey.journey_digest) issues.push(issue("ACCEPTED_INTENT_STALE"))
  return { journey: issues.length === 0 ? journey : null, issues }
}
const decodeIntent = (value: unknown, expectedRevisionIds: readonly string[]): IntentDecodeResult => {
  if (!validateAcceptedIntentShape(value)) return { register: null, issues: [issue("INTENT_SCHEMA_INVALID")] }
  if (value.intents.length === 0 && value.journeys.length === 0) return { register: null, issues: [issue("ACCEPTED_INTENT_EMPTY")] }
  const issues: CoverageIssue[] = []
  const intents: AcceptedIntentRecord[] = []
  for (const rawIntent of value.intents) {
    const parsed = parseIntent(rawIntent, expectedRevisionIds)
    issues.push(...parsed.issues)
    if (parsed.intent !== null) intents.push(parsed.intent)
  }
  const journeys: AcceptedJourneyRecord[] = []
  for (const rawJourney of value.journeys) {
    const parsed = parseJourney(rawJourney, expectedRevisionIds)
    issues.push(...parsed.issues)
    if (parsed.journey !== null) journeys.push(parsed.journey)
  }
  const intentRefs = new Set(intents.map((intent) => intent.intent_ref_id))
  if (intentRefs.size !== intents.length) issues.push(issue("ACCEPTED_INTENT_AMBIGUOUS"))
  const journeyRefs = new Set(journeys.map((journey) => journey.journey_ref_id))
  if (journeyRefs.size !== journeys.length) issues.push(issue("JOURNEY_REF_AMBIGUOUS"))
  for (const journey of journeys) {
    const owner = intents.find((intent) => intent.intent_ref_id === journey.intent_ref_id)
    if (owner === undefined || owner.purpose !== "coverage" || !owner.journey_ref_ids.includes(journey.journey_ref_id)) issues.push(issue("JOURNEY_INTENT_OWNERSHIP_INVALID"))
  }
  for (const intent of intents) {
    if (intent.purpose !== "coverage") continue
    const ownedJourneys = journeys.filter((journey) => journey.intent_ref_id === intent.intent_ref_id)
    const ownedRefs = new Set(ownedJourneys.map((journey) => journey.journey_ref_id))
    if (intent.journey_ref_ids.some((journeyRef) => !journeyRefs.has(journeyRef)) || ownedRefs.size !== intent.journey_ref_ids.length || intent.journey_ref_ids.some((journeyRef) => !ownedRefs.has(journeyRef))) issues.push(issue("JOURNEY_REF_MISSING"))
    if ((intent.row_ids.length > 0 || intent.canonical_signatures.length > 0) && (ownedJourneys.length === 0 || ownedJourneys.some((journey) => journey.coverage_scope !== "accepted_non_user_facing"))) issues.push(issue("INTENT_SCOPE_INVALID"))
  }
  if (intents.length === 0 && journeys.length === 0 && issues.length === 0) issues.push(issue("ACCEPTED_INTENT_EMPTY"))
  if (issues.length > 0) return { register: null, issues }
  return {
    register: {
      schema_version: "functional-parity-accepted-intent/v1",
      intents: intents.sort((left, right) => compareByteOrder(left.intent_ref_id, right.intent_ref_id)),
      journeys: journeys.sort((left, right) => compareByteOrder(left.journey_ref_id, right.journey_ref_id)),
    },
    issues: [],
  }
}

export const tryDecodeAcceptedIntentRegister = (value: unknown, expectedRevisionIds: readonly string[] = []): IntentDecodeResult => decodeIntent(value, sorted(expectedRevisionIds))

export const decodeAcceptedIntentRegister = (value: unknown, expectedRevisionIds: readonly string[] = []): AcceptedIntentRegister => {
  const result = decodeIntent(value, sorted(expectedRevisionIds))
  if (result.register === null) throw new Error(result.issues[0]?.reasonCode ?? "accepted intent register is invalid")
  return result.register
}

const acceptedIntentSource = (context: ManifestContext, input: IntentSourceInput): string => {
  if (!context.revisions.some((revision) => revision.revision_ref_id === input.revisionRefId)) {
    context.revisions.push({
      revision_ref_id: input.revisionRefId,
      repository_ref: input.repositoryRef,
      revision_kind: input.repositoryRef === "external_intent_authority" ? "git_commit" : "file_set_digest",
      revision: input.revision,
      immutable: true,
    })
  }
  const existing = context.sources.find((source) => source.authority_role === "accepted_intent_register" && source.path === input.path)
  if (existing !== undefined) return existing.source_id
  const sourceId = stableId("src", { authority_line: "cross_line", authority_role: "accepted_intent_register", repository_ref: input.repositoryRef, revision_ref_id: input.revisionRefId, path: input.path, line_start: null, line_end: null, symbol: null })
  context.sources.push({
    source_id: sourceId,
    authority_line: "cross_line",
    authority_role: "accepted_intent_register",
    repository_ref: input.repositoryRef,
    revision_ref_id: input.revisionRefId,
    path: input.path,
    line_start: null,
    line_end: null,
    symbol: null,
    byte_length: input.bytes.byteLength,
    sha256: input.digest,
    capture_mode: "accepted_intent",
    availability: "available",
    classification_status: "classified",
  })
  context.sourcePathById.set(sourceId, { rootRef: "mono", path: input.path })
  return sourceId
}

const unsafeIntentText = (text: string): boolean =>
  /"(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret|payload|raw[_-]?payload|user[_-]?id|account[_-]?id|customer[_-]?id|email|phone)"\s*:/i.test(text) ||
  /(?:sk_(?:live|test)_|bearer\s+|(?:password|passphrase|secret|token|api[_-]?key|payload|email|phone|user[_-]?id|account[_-]?id|customer[_-]?id)\s*[:=]|[A-Z0-9._%+-]+@[^\s]+)/i.test(text)
const hasForbiddenIntentKey = (entry: unknown): boolean => {
  if (Array.isArray(entry)) return entry.some(hasForbiddenIntentKey)
  if (entry === null || typeof entry !== "object") return false
  return Object.entries(entry).some(([key, child]) => /^(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret|payload|raw[_-]?payload|user[_-]?id|account[_-]?id|customer[_-]?id|member[_-]?id|identity[_-]?id|email|phone)(?:[_-].*)?$/i.test(key) || hasForbiddenIntentKey(child))
}
export const assertSafeAcceptedIntentBytes = (bytes: Uint8Array, requireCanonical = true): void => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("INTENT_UTF8_INVALID")
  }
  if (text.length > 256 * 1024 || unsafeIntentText(text)) throw new Error("UNSAFE_SOURCE")
  if (hasDuplicateJsonMembers(text)) throw new Error("INTENT_DUPLICATE_KEY")
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error("INTENT_SCHEMA_INVALID")
  }
  if (hasForbiddenIntentKey(value)) throw new Error("UNSAFE_SOURCE")
  if (requireCanonical && canonicalJson(value) !== text) throw new Error("INTENT_NOT_CANONICAL")
}
export const loadAcceptedIntentRegister = (context: ManifestContext, supplied?: IntentSourceInput): IntentLoadResult => {
  const input: IntentSourceInput | null = supplied ?? null
  if (input === null) return { path: null, sourceRefId: null, sourceRevisionRefId: null, sourceDigest: null, register: null, issues: [issue("ACCEPTED_INTENT_MISSING")] }
  const bytes = input.bytes
  const textPath = input.path
  try {
    assertSafeAcceptedIntentBytes(bytes)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "INTENT_SCHEMA_INVALID"
    return { path: textPath, sourceRefId: null, sourceRevisionRefId: input.revisionRefId, sourceDigest: input.digest || null, register: null, issues: [issue(reason)] }
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  const expectedRevisionIds = [context.scans.legacy.revisionRefId, acceptedIntentRevisionRefId(context)]
  const result = tryDecodeAcceptedIntentRegister(value, expectedRevisionIds)
  if (result.register === null) return { path: textPath, sourceRefId: null, sourceRevisionRefId: input.revisionRefId, sourceDigest: null, register: null, issues: result.issues }
  const digest = sha256(bytes)
  if (input.digest.length > 0 && input.digest !== digest) return { path: textPath, sourceRefId: null, sourceRevisionRefId: input.revisionRefId, sourceDigest: null, register: null, issues: [issue("INTENT_DIGEST_MISMATCH")] }
  const normalizedInput: IntentSourceInput = { ...input, digest }
  const sourceRefId = acceptedIntentSource(context, normalizedInput)
  const register = {
    ...result.register,
    intents: result.register.intents.map((intent) => ({ ...intent, source_ref_ids: sortUnique([...intent.source_ref_ids, sourceRefId]) })),
    journeys: result.register.journeys.map((journey) => ({ ...journey, source_ref_ids: sortUnique([...journey.source_ref_ids, sourceRefId]) })),
  }
  return { path: textPath, sourceRefId, sourceRevisionRefId: normalizedInput.revisionRefId, sourceDigest: digest, register, issues: [] }
}

const emptyJourneyEnvelope = (manifestDigest: string, revisionRefIds: readonly string[]): InventoryEnvelope => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-inventory/v1",
  inventory_kind: "user_journey",
  authority_line: "cross_line",
  source_manifest_sha256: manifestDigest,
  revision_ref_ids: sorted(revisionRefIds),
  observation_kinds: ["accepted_intent"],
  rows: [],
  links: [],
  observations: [],
  derivation_edges: [],
})

const surfaceRows = (inventories: readonly InventoryEnvelope[]): ReadonlyMap<JourneySurface, readonly InventoryRow[]> => {
  const result = new Map<JourneySurface, InventoryRow[]>()
  for (const inventory of inventories) {
    if (!PARITY_KINDS.has(inventory.inventory_kind)) continue
    const existing = result.get(inventory.inventory_kind as JourneySurface)
    const rows = existing === undefined ? [] : [...existing]
    rows.push(...inventory.rows)
    result.set(inventory.inventory_kind as JourneySurface, rows)
  }
  return result
}

const updateCoverage = (row: InventoryRow, refs: readonly string[]): InventoryRow => {
  const coverageRefs = sortUnique([...row.coverage_ref_ids, ...refs])
  if (coverageRefs.length === 0) return row
  return { ...row, coverage_ref_ids: coverageRefs, observation_kinds: sortUnique([...row.observation_kinds, "accepted_intent"]) as ObservationKind[] }
}

const resolveTargets = (step: JourneyStep, rows: readonly InventoryRow[]): { readonly rows: readonly InventoryRow[]; readonly issues: readonly string[] } => {
  const byId = new Map(rows.map((row) => [row.row_id, row]))
  const selected: InventoryRow[] = []
  const missing: string[] = []
  for (const rowIdValue of step.row_ids) {
    const row = byId.get(rowIdValue)
    if (row === undefined) missing.push("ROW_REF_MISSING")
    else selected.push(row)
  }
  for (const signature of step.canonical_signatures) {
    const matches = rows.filter((row) => row.signature === signature)
    if (matches.length === 0) {
      missing.push("CANONICAL_SIGNATURE_MISSING")
      continue
    }
    const matchedIds = new Set(matches.map((row) => row.row_id))
    const reconciledMatches = matches.length > 1 && matches.every((row) => row.related_row_ids.some((relatedRowId) => matchedIds.has(relatedRowId)))
    if (!reconciledMatches && matches.length > 1) {
      missing.push("CANONICAL_SIGNATURE_AMBIGUOUS")
      continue
    }
    selected.push(...matches)
  }
  const unique = new Map(selected.map((row) => [row.row_id, row]))
  return { rows: [...unique.values()].sort((left, right) => compareByteOrder(left.row_id, right.row_id)), issues: sorted(missing) }
}

const intentTargets = (intent: AcceptedIntentRecord, rows: readonly InventoryRow[]): { readonly rows: readonly InventoryRow[]; readonly issues: readonly string[] } => {
  const byId = new Map(rows.map((row) => [row.row_id, row]))
  const selected: InventoryRow[] = []
  const issues: string[] = []
  for (const rowIdValue of intent.row_ids) {
    const row = byId.get(rowIdValue)
    if (row === undefined) issues.push("ROW_REF_MISSING")
    else selected.push(row)
  }
  for (const signature of intent.canonical_signatures) {
    const matches = rows.filter((row) => row.signature === signature && (intent.inventory_kinds.length === 0 || intent.inventory_kinds.includes(row.inventory_kind)))
    if (matches.length === 0) issues.push("CANONICAL_SIGNATURE_MISSING")
    else if (matches.some((row) => !intent.row_ids.includes(row.row_id))) issues.push("CANONICAL_SIGNATURE_BROAD")
    selected.push(...matches)
  }
  const unique = new Map(selected.map((row) => [row.row_id, row]))
  return { rows: [...unique.values()].sort((left, right) => compareByteOrder(left.row_id, right.row_id)), issues: sorted(issues) }
}

const dispositionFor = (kind: MismatchKind): AcceptedDisposition | null => MISMATCH_DISPOSITIONS[kind] ?? null

const applyDispositions = (inventories: readonly InventoryEnvelope[], register: AcceptedIntentRegister, issues: CoverageIssue[]): readonly InventoryEnvelope[] => {
  const rows = inventories.flatMap((inventory) => inventory.rows)
  const changes = new Map<string, { readonly intent: AcceptedIntentRecord; readonly disposition: AcceptedDisposition }>()
  for (const intent of register.intents) {
    if (intent.purpose !== "disposition" || intent.disposition === null) continue
    const target = intentTargets(intent, rows)
    if (target.issues.length > 0 || target.rows.length === 0) {
      issues.push(issue(target.issues[0] ?? "ACCEPTED_INTENT_REQUIRED", "accepted_intent_invalid", intent.row_ids, intent.source_ref_ids, [intent.intent_ref_id]))
      continue
    }
    const expectedKinds = new Set(target.rows.map((row) => row.mismatch.kind))
    if (expectedKinds.size !== 1 || [...expectedKinds][0] === "none" || FORBIDDEN_INTENT_KINDS.has([...expectedKinds][0] as MismatchKind)) {
      issues.push(issue("ACCEPTED_INTENT_FORBIDDEN_KIND", "accepted_intent_invalid", target.rows.map((row) => row.row_id), intent.source_ref_ids, [intent.intent_ref_id]))
      continue
    }
    const kind = [...expectedKinds][0] as MismatchKind
    if (dispositionFor(kind) !== intent.disposition) {
      issues.push(issue("ACCEPTED_INTENT_DISPOSITION_MISMATCH", "accepted_intent_invalid", target.rows.map((row) => row.row_id), intent.source_ref_ids, [intent.intent_ref_id]))
      continue
    }
    for (const row of target.rows) {
      const existing = changes.get(row.row_id)
      if (existing !== undefined && existing.intent.intent_ref_id !== intent.intent_ref_id) {
        issues.push(issue("ACCEPTED_INTENT_AMBIGUOUS", "accepted_intent_invalid", [row.row_id], intent.source_ref_ids, [existing.intent.intent_ref_id, intent.intent_ref_id]))
      } else changes.set(row.row_id, { intent, disposition: intent.disposition })
    }
  }
  return inventories.map((inventory): InventoryEnvelope => ({
    ...inventory,
    rows: inventory.rows.map((row): InventoryRow => {
      const change = changes.get(row.row_id)
      if (change === undefined) return row
      return {
        ...row,
        status: "accounted" as const,
        accepted_intent_ref_ids: sortUnique([...row.accepted_intent_ref_ids, change.intent.intent_ref_id]),
        observation_kinds: sortUnique([...row.observation_kinds, "accepted_intent"]) as ObservationKind[],
        mismatch: {
          ...row.mismatch,
          disposition: change.disposition,
          accepted_intent_ref_ids: sortUnique([...row.mismatch.accepted_intent_ref_ids, change.intent.intent_ref_id]),
        },
      }
    }).sort((left, right) => compareByteOrder(left.row_id, right.row_id)),
  }))
}
interface RuntimeEvidenceStepResolution {
  readonly step: JourneyStep
  readonly receiptIds: readonly string[]
  readonly successfulReceiptIds: readonly string[]
  readonly issues: readonly CoverageIssue[]
}
const runnerDigestForSources = (
  manifest: SourceManifest,
  sourceRefIds: readonly string[],
): { readonly digest: string | null; readonly unavailable: readonly string[] } => {
  const sourceById = new Map(manifest.sources.map((source) => [source.source_id, source]))
  const unavailable = sourceRefIds.filter((sourceRefId) => {
    const source = sourceById.get(sourceRefId)
    return source === undefined || source.availability !== "available" || source.sha256 === null
  })
  if (unavailable.length > 0) return { digest: null, unavailable: sortUnique(unavailable) }
  const pairs = sourceRefIds
    .map((sourceRefId) => {
      const source = sourceById.get(sourceRefId) as SourceManifest["sources"][number]
      return [sourceRefId, source.sha256] as const
    })
    .sort(([left], [right]) => compareByteOrder(left, right))
  return { digest: sha256(canonicalJson(pairs)), unavailable: [] }
}

const resolveRuntimeEvidence = (
  manifest: SourceManifest,
  register: AcceptedIntentRegister,
  evidence: RuntimeEvidenceRegister | null | undefined,
  requireEvidence: boolean,
): ReadonlyMap<string, RuntimeEvidenceStepResolution> => {
  const resolutions = new Map<string, RuntimeEvidenceStepResolution>()
  const journeysByRef = new Map(register.journeys.map((journey) => [journey.journey_ref_id, journey]))
  const receipts = evidence?.receipts ?? []
  const currentRevisionSet = new Set(currentRevisionIds(manifest.revisions))
  const sourceIds = new Set(manifest.sources.map((source) => source.source_id))
  for (const receipt of receipts) {
    const journey = journeysByRef.get(receipt.journey_ref_id)
    if (journey === undefined) {
      resolutions.set(`receipt:${receipt.receipt_ref_id}`, {
        step: {
          step_id: receipt.step_ids[0] ?? "unknown",
          surface: "api_operation",
          row_ids: [],
          canonical_signatures: [],
          expected_contract_ref: null,
          runtime_evidence_ref_ids: [receipt.receipt_ref_id],
        },
        receiptIds: [],
        successfulReceiptIds: [],
        issues: [issue("RUNTIME_EVIDENCE_UNKNOWN_JOURNEY", "unresolved", [], [], [])],
      })
      continue
    }
    const journeySteps = new Set(journey.steps.map((step) => step.step_id))
    const stale = receipt.legacy_revision_ref_id !== journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-legacy-")) ||
      receipt.mono_revision_ref_id !== journey.selected_revision_ref_ids.find((ref) => ref.startsWith("rev-mono-")) ||
      !currentRevisionSet.has(receipt.legacy_revision_ref_id) ||
      !currentRevisionSet.has(receipt.mono_revision_ref_id)
    const unknownSteps = receipt.step_ids.filter((stepId) => !journeySteps.has(stepId))
    const unknownSources = receipt.runner_source_ref_ids.filter((sourceId) => !sourceIds.has(sourceId))
    const runnerDigestResolution = runnerDigestForSources(manifest, receipt.runner_source_ref_ids)
    const receiptIssues: CoverageIssue[] = []
    if (stale) receiptIssues.push(issue("RUNTIME_EVIDENCE_STALE", "accepted_intent_invalid", [], unknownSources, []))
    if (unknownSteps.length > 0) receiptIssues.push(issue("RUNTIME_EVIDENCE_UNKNOWN_STEP", "unresolved", [], unknownSources, []))
    if (unknownSources.length > 0) receiptIssues.push(issue("RUNTIME_EVIDENCE_SOURCE_REF_MISSING", "unresolved", [], unknownSources, []))
    if (runnerDigestResolution.unavailable.length > 0) receiptIssues.push(issue("RUNTIME_EVIDENCE_RUNNER_SOURCE_UNAVAILABLE", "unresolved", [], runnerDigestResolution.unavailable, []))
    else if (runnerDigestResolution.digest !== receipt.runner_digest) receiptIssues.push(issue("RUNTIME_EVIDENCE_RUNNER_DIGEST_MISMATCH", "unresolved", [], receipt.runner_source_ref_ids, []))
    if (receipt.result === "failed") receiptIssues.push(issue("RUNTIME_EVIDENCE_FAILED", "gaps_found", [], unknownSources, []))
    let matchedStep = false
    for (const step of journey.steps) {
      if (!receipt.step_ids.includes(step.step_id)) continue
      matchedStep = true
      const key = `${journey.journey_ref_id}:${step.step_id}`
      const existing = resolutions.get(key)
      const existingReceiptIds = existing?.receiptIds ?? []
      const existingSuccessful = existing?.successfulReceiptIds ?? []
      const receiptAccepted = receipt.result === "passed" && receiptIssues.length === 0
      resolutions.set(key, {
        step,
        receiptIds: sortUnique([...existingReceiptIds, ...(receiptIssues.some((entry) => entry.reasonCode === "RUNTIME_EVIDENCE_UNKNOWN_STEP") ? [] : [receipt.receipt_ref_id])]),
        successfulReceiptIds: sortUnique([
          ...existingSuccessful,
          ...(receiptAccepted ? [receipt.receipt_ref_id] : []),
        ]),
        issues: [...(existing?.issues ?? []), ...receiptIssues],
      })
    }
    if (!matchedStep && receiptIssues.length > 0) {
      resolutions.set(`receipt:${receipt.receipt_ref_id}`, {
        step: {
          step_id: receipt.step_ids[0] ?? "unknown",
          surface: "api_operation",
          row_ids: [],
          canonical_signatures: [],
          expected_contract_ref: null,
          runtime_evidence_ref_ids: [receipt.receipt_ref_id],
        },
        receiptIds: [],
        successfulReceiptIds: [],
        issues: receiptIssues,
      })
    }
  }
  for (const journey of register.journeys) {
    for (const step of journey.steps) {
      const key = `${journey.journey_ref_id}:${step.step_id}`
      const existing = resolutions.get(key)
      const declared = step.runtime_evidence_ref_ids
      const declaredReceipts = receipts.filter((receipt) => declared.includes(receipt.receipt_ref_id))
      const crossJourney = declaredReceipts.filter((receipt) => receipt.journey_ref_id !== journey.journey_ref_id)
      const unknownDeclared = declared.filter((ref) => !receipts.some((receipt) => receipt.receipt_ref_id === ref))
      const issues = [...(existing?.issues ?? [])]
      if (crossJourney.length > 0) issues.push(issue("RUNTIME_EVIDENCE_CROSS_JOURNEY", "unresolved", [], [], [journey.intent_ref_id]))
      if (unknownDeclared.length > 0) issues.push(issue("RUNTIME_EVIDENCE_UNKNOWN_REF", "unresolved", [], [], [journey.intent_ref_id]))
      const receiptIds = sortUnique([...(existing?.receiptIds ?? []), ...declaredReceipts.filter((receipt) => receipt.journey_ref_id === journey.journey_ref_id).map((receipt) => receipt.receipt_ref_id)])
      const successfulReceiptIds = existing?.successfulReceiptIds ?? []
      if (requireEvidence && journey.coverage_scope === "user_visible" && successfulReceiptIds.length === 0) {
        issues.push(issue(
          "RUNTIME_EVIDENCE_REQUIRED",
          "gaps_found",
          [],
          journey.source_ref_ids,
          [journey.intent_ref_id],
        ))
      }
      resolutions.set(key, {
        step: {
          ...step,
          runtime_evidence_ref_ids: receiptIds,
        },
        receiptIds,
        successfulReceiptIds,
        issues,
      })
    }
  }
  return resolutions
}


export const resolveJourneyCoverage = (params: {
  readonly manifest: SourceManifest
  readonly inventories: readonly InventoryEnvelope[]
  readonly register: AcceptedIntentRegister | null
  readonly registerSourceRefId?: string | null
  readonly registerIssues?: readonly CoverageIssue[]
  readonly runtimeEvidence?: RuntimeEvidenceRegister | null
  readonly requireRuntimeEvidence?: boolean
}): CoverageResolution => {
  const revisionRefIds = currentRevisionIds(params.manifest.revisions)
  const baseRows = params.inventories.flatMap((inventory) => inventory.rows)
  const issues: CoverageIssue[] = [...(params.registerIssues ?? [])]
  const sourceRefId = params.registerSourceRefId ?? null
  if (params.register === null) {
    const empty = emptyJourneyEnvelope(sha256(canonicalJson(params.manifest)), revisionRefIds)
    return { register: null, userJourneyCoverage: empty, inventories: params.inventories, links: [], issues, coverageRefIds: new Map() }
  }
  const runtimeResolution = resolveRuntimeEvidence(
    params.manifest,
    params.register,
    params.runtimeEvidence,
    params.requireRuntimeEvidence === true,
  )
  for (const [key, resolution] of runtimeResolution.entries()) {
    if (key.startsWith("receipt:")) issues.push(...resolution.issues)
  }
  const rowsBySurface = surfaceRows(params.inventories)
  const coverageByRow = new Map<string, string[]>()
  const acceptedNonUserFacingByRow = new Map<string, string[]>()
  const links: InventoryLink[] = []
  const journeyRows: InventoryRow[] = []
  for (const journey of params.register.journeys) {
    const targetRows = new Map<string, InventoryRow>()
    const resolvedSteps: JourneyStep[] = []
    let unresolved = false
    for (const step of journey.steps) {
      const runtime = runtimeResolution.get(`${journey.journey_ref_id}:${step.step_id}`)
      if (runtime !== undefined) {
        if (runtime.issues.length > 0) {
          unresolved = true
          issues.push(...runtime.issues.map((entry) => ({
            ...entry,
            rowIds: entry.rowIds,
            sourceRefIds: sortUnique([...entry.sourceRefIds, ...journey.source_ref_ids, ...(sourceRefId === null ? [] : [sourceRefId])]),
            acceptedIntentRefIds: sortUnique([...entry.acceptedIntentRefIds, journey.intent_ref_id]),
          })))
        }
      }
      const resolvedStep = runtime?.step ?? step
      const targets = resolveTargets(resolvedStep, rowsBySurface.get(resolvedStep.surface) ?? [])
      if (targets.issues.length > 0) {
        unresolved = true
        issues.push(issue(targets.issues[0] ?? "COVERAGE_REF_REQUIRED", "unresolved", targets.rows.map((row) => row.row_id), [...journey.source_ref_ids, ...(sourceRefId === null ? [] : [sourceRefId])], [journey.intent_ref_id]))
      }
      for (const row of targets.rows) {
        targetRows.set(row.row_id, row)
        const current = coverageByRow.get(row.row_id) ?? []
        current.push(journey.journey_ref_id)
        coverageByRow.set(row.row_id, current)
      }
      resolvedSteps.push(resolvedStep)
    }
    if (targetRows.size === 0) {
      unresolved = true
      issues.push(issue("COVERAGE_REF_REQUIRED", "unresolved", [], [...journey.source_ref_ids, ...(sourceRefId === null ? [] : [sourceRefId])], [journey.intent_ref_id]))
    }
    const declaration = declarationId("cross_line", "accepted_intent", journey.journey_ref_id, "user_journey", 0)
    const signature = canonicalJson(["user_journey", journey.intent_ref_id, journey.journey_key, journey.steps.map((step) => step.step_id)])
    const journeyRow: InventoryRow = {
      row_id: rowId("user_journey", declaration, signature),
      declaration_id: declaration,
      inventory_kind: "user_journey",
      authority_line: "cross_line",
      canonical_key: signature,
      signature,
      status: unresolved ? "unresolved" : "covered",
      observation_kinds: ["accepted_intent"],
      source_ref_ids: sortUnique([...journey.source_ref_ids, ...(sourceRefId === null ? [] : [sourceRefId])]),
      revision_ref_ids: revisionRefIds,
      runtime_observation_ref_ids: sortUnique(resolvedSteps.flatMap((step) => step.runtime_evidence_ref_ids)),
      coverage_ref_ids: [journey.journey_ref_id],
      accepted_intent_ref_ids: [journey.intent_ref_id],
      duplicate_group_id: null,
      mismatch: {
        kind: unresolved ? "unresolved" : "none",
        disposition: "none",
        accepted_intent_ref_ids: [],
        counterpart_row_ids: [],
        reason: unresolved ? "UNRESOLVED_COVERAGE_REF" : null,
      },
      reason_codes: unresolved ? ["UNRESOLVED_COVERAGE_REF"] : [],
      related_row_ids: [...targetRows.keys()].sort(compareByteOrder),
      details: {
        journey_ref_id: journey.journey_ref_id,
        journey_key: journey.journey_key,
        intent_ref_id: journey.intent_ref_id,
        steps: resolvedSteps,
        coverage_scope: journey.coverage_scope,
      },
    }
    journeyRows.push(journeyRow)
    for (const row of targetRows.values()) {
      const sourceRefs = sortUnique([...journey.source_ref_ids, ...(sourceRefId === null ? [] : [sourceRefId]), ...row.source_ref_ids])
      links.push({ relation_id: relationId("covers", journeyRow.row_id, row.row_id, sourceRefs), relation_kind: "covers", from_row_id: journeyRow.row_id, to_row_id: row.row_id, source_ref_ids: sourceRefs })
    }
  }
  const journeyRowsByRef = new Map(journeyRows.map((row) => [(row.details as UserJourneyDetails).journey_ref_id, row]))
  for (const intent of params.register.intents) {
    if (intent.purpose !== "coverage") continue
    const target = intentTargets(intent, baseRows)
    if (target.issues.length > 0) {
      issues.push(issue(target.issues[0] ?? "COVERAGE_REF_REQUIRED", "accepted_intent_invalid", intent.row_ids, intent.source_ref_ids, [intent.intent_ref_id]))
      continue
    }
    if (target.rows.length === 0) continue
    const ownedJourneys = params.register.journeys.filter((journey) => intent.journey_ref_ids.includes(journey.journey_ref_id))
    const directScopeAllowed = ownedJourneys.length > 0 && ownedJourneys.every((journey) => journey.coverage_scope === "accepted_non_user_facing")
    if (target.rows.length > 0 && !directScopeAllowed) {
      issues.push(issue("INTENT_SCOPE_INVALID", "accepted_intent_invalid", target.rows.map((row) => row.row_id), intent.source_ref_ids, [intent.intent_ref_id]))
      continue
    }
    const linkedJourneyRowIds = new Set(intent.journey_ref_ids.flatMap((journeyRef) => journeyRowsByRef.get(journeyRef)?.related_row_ids ?? []))
    if (target.rows.some((row) => !linkedJourneyRowIds.has(row.row_id)) && !directScopeAllowed) issues.push(issue("INTENT_JOURNEY_LINK_MISMATCH", "accepted_intent_invalid", target.rows.map((row) => row.row_id), intent.source_ref_ids, [intent.intent_ref_id]))
    if (directScopeAllowed) {
      for (const row of target.rows) {
        const refs = coverageByRow.get(row.row_id) ?? []
        refs.push(intent.intent_ref_id)
        coverageByRow.set(row.row_id, refs)
        const acceptedRefs = acceptedNonUserFacingByRow.get(row.row_id) ?? []
        acceptedRefs.push(intent.intent_ref_id)
        acceptedNonUserFacingByRow.set(row.row_id, acceptedRefs)
      }
    }
  }
  let resolvedInventories: readonly InventoryEnvelope[] = params.inventories.map((inventory) => ({ ...inventory, rows: inventory.rows.map((row) => {
    const updated = updateCoverage(row, coverageByRow.get(row.row_id) ?? [])
    const acceptedRefs = acceptedNonUserFacingByRow.get(row.row_id) ?? []
    return acceptedRefs.length === 0 ? updated : { ...updated, accepted_intent_ref_ids: sortUnique([...updated.accepted_intent_ref_ids, ...acceptedRefs]) }
  }) }))
  resolvedInventories = applyDispositions(resolvedInventories, params.register, issues)
  const allWithCoverage = resolvedInventories.flatMap((inventory) => inventory.rows)
  for (const row of allWithCoverage) {
    if (!PARITY_KINDS.has(row.inventory_kind)) continue
    if ((coverageByRow.get(row.row_id) ?? []).length > 0) continue
    if (row.status === "covered") {
      const updated: InventoryRow = {
        ...row,
        status: "uncovered",
        mismatch: { ...row.mismatch, kind: "uncovered", disposition: "none", accepted_intent_ref_ids: [], reason: "COVERAGE_REF_REQUIRED" },
        reason_codes: sortUnique([...row.reason_codes, "COVERAGE_REF_REQUIRED"]),
      }
      resolvedInventories = resolvedInventories.map((inventory) => inventory.rows.some((candidate) => candidate.row_id === row.row_id) ? { ...inventory, rows: inventory.rows.map((candidate) => candidate.row_id === row.row_id ? updated : candidate) } : inventory)
      issues.push(issue("COVERAGE_REF_REQUIRED", "gaps_found", [row.row_id], row.source_ref_ids))
    } else {
      issues.push(issue("COVERAGE_REF_REQUIRED", "gaps_found", [row.row_id], row.source_ref_ids, row.accepted_intent_ref_ids))
    }
  }
  const journeyCoverage: InventoryEnvelope = {
    ...emptyJourneyEnvelope(sha256(canonicalJson(params.manifest)), revisionRefIds),
    rows: journeyRows.sort((left, right) => compareByteOrder(left.row_id, right.row_id)),
    links: links.sort((left, right) => compareByteOrder(left.relation_id, right.relation_id)),
    derivation_edges: journeyRows.filter((row) => row.related_row_ids.length > 0).map((row) => ({ edge_id: edgeId("coverage", row.source_ref_ids, row.related_row_ids), edge_type: "coverage" as const, from_ref_ids: row.source_ref_ids, to_row_ids: row.related_row_ids, derivation: "accepted journey step covers exact row or canonical signature" })).sort((left, right) => compareByteOrder(left.edge_id, right.edge_id)),
  }
  return { register: params.register, userJourneyCoverage: journeyCoverage, inventories: resolvedInventories, links, issues, coverageRefIds: new Map([...coverageByRow.entries()].map(([rowIdValue, refs]) => [rowIdValue, sorted(refs)])) }
}

const rowStatusMismatchValid = (row: InventoryRow): boolean => {
  const kind = row.mismatch.kind
  if (kind === "none") return row.status === "covered" || (row.status === "not_applicable" && row.mismatch.disposition === "accepted_not_applicable" && row.accepted_intent_ref_ids.length > 0)
  if (kind === "uncovered") return row.status === "uncovered" && row.mismatch.disposition === "none" && row.mismatch.accepted_intent_ref_ids.length === 0
  if (FORBIDDEN_INTENT_KINDS.has(kind)) return row.status === kind || (kind === "openapi_stale" && row.status === "stale")
  if (row.status === "accounted") return row.mismatch.disposition === MISMATCH_DISPOSITIONS[kind] && row.mismatch.accepted_intent_ref_ids.length > 0
  return row.status === kind && (row.mismatch.disposition === "none" || row.mismatch.disposition === "rejected") && row.mismatch.accepted_intent_ref_ids.length === 0
}

export const validateCrossArtifactInvariants = (input: CrossArtifactInvariantInput): boolean => {
  const rowInventories = [...input.inventories, input.userJourneyCoverage]
  const rows = rowInventories.flatMap((inventory) => inventory.rows)
  const rowIds = new Set<string>()
  const sourceIds = new Set(input.manifest.sources.map((source) => source.source_id))
  const revisionIds = new Set(input.manifest.revisions.map((revision) => revision.revision_ref_id))
  const runtimeIds = new Set(input.manifest.runtime_observations.map((observation) => observation.runtime_observation_ref_id))
  const intentIds = new Set(input.register?.intents.map((intent) => intent.intent_ref_id) ?? [])
  const journeyRefs = new Set(input.register?.journeys.map((journey) => journey.journey_ref_id) ?? [])
  for (const row of rows) {
    if (rowIds.has(row.row_id) || row.source_ref_ids.length === 0 || row.revision_ref_ids.length === 0 || !row.source_ref_ids.every((sourceRef) => sourceIds.has(sourceRef)) || !row.revision_ref_ids.every((revisionRef) => revisionIds.has(revisionRef)) || !row.runtime_observation_ref_ids.every((runtimeRef) => runtimeIds.has(runtimeRef)) || !row.coverage_ref_ids.every((coverageRef) => journeyRefs.has(coverageRef) || intentIds.has(coverageRef)) || !row.accepted_intent_ref_ids.every((intentRef) => intentIds.has(intentRef)) || !row.related_row_ids.every((related) => rows.some((candidate) => candidate.row_id === related)) || !rowStatusMismatchValid(row)) return false
    rowIds.add(row.row_id)
  }
  for (const intent of input.register?.intents ?? []) {
    if (!intent.source_ref_ids.every((sourceRef) => sourceIds.has(sourceRef)) || !intent.selected_revision_ref_ids.every((revisionRef) => revisionIds.has(revisionRef)) || !intent.row_ids.every((rowIdValue) => rowIds.has(rowIdValue)) || !intent.canonical_signatures.every((signature) => rows.some((row) => row.signature === signature)) || !intent.journey_ref_ids.every((journeyRef) => journeyRefs.has(journeyRef))) return false
    if (intent.purpose === "coverage") {
      const ownedJourneys = input.register?.journeys.filter((journey) => journey.intent_ref_id === intent.intent_ref_id) ?? []
      const ownedRefs = new Set(ownedJourneys.map((journey) => journey.journey_ref_id))
      if (ownedRefs.size !== intent.journey_ref_ids.length || intent.journey_ref_ids.some((journeyRef) => !ownedRefs.has(journeyRef))) return false
      if ((intent.row_ids.length > 0 || intent.canonical_signatures.length > 0) && (ownedJourneys.length === 0 || ownedJourneys.some((journey) => journey.coverage_scope !== "accepted_non_user_facing"))) return false
    }
  }
  for (const journey of input.register?.journeys ?? []) {
    if (!journey.source_ref_ids.every((sourceRef) => sourceIds.has(sourceRef)) || !journey.selected_revision_ref_ids.every((revisionRef) => revisionIds.has(revisionRef)) || !intentIds.has(journey.intent_ref_id)) return false
    const owner = input.register?.intents.find((intent) => intent.intent_ref_id === journey.intent_ref_id)
    if (owner === undefined || owner.purpose !== "coverage" || !owner.journey_ref_ids.includes(journey.journey_ref_id)) return false
  }
  for (const link of [...input.links, ...input.userJourneyCoverage.links]) {
    if (!rowIds.has(link.from_row_id) || !rowIds.has(link.to_row_id) || link.source_ref_ids.length === 0 || !link.source_ref_ids.every((sourceRef) => sourceIds.has(sourceRef) || intentIds.has(sourceRef) || journeyRefs.has(sourceRef))) return false
  }
  for (const journey of input.register?.journeys ?? []) {
    const intent = input.register?.intents.find((candidate) => candidate.intent_ref_id === journey.intent_ref_id)
    const row = input.userJourneyCoverage.rows.find((candidate) => (candidate.details as UserJourneyDetails).journey_ref_id === journey.journey_ref_id)
    if (intent === undefined || intent.purpose !== "coverage" || !intent.journey_ref_ids.includes(journey.journey_ref_id) || row === undefined) return false
    const details = row.details as UserJourneyDetails
    if (details.intent_ref_id !== journey.intent_ref_id || details.steps.length !== journey.steps.length) return false
    for (const step of journey.steps) {
      if (!step.row_ids.every((rowIdValue) => rowIds.has(rowIdValue))) return false
      if (step.canonical_signatures.some((signature) => !rows.some((row) => row.signature === signature))) return false
      if (!step.runtime_evidence_ref_ids.every((runtimeRef) => runtimeIds.has(runtimeRef))) return false
      const resolvedStep = details.steps.find((candidate) => candidate.step_id === step.step_id)
      if (resolvedStep === undefined || !step.runtime_evidence_ref_ids.every((runtimeRef) => resolvedStep.runtime_evidence_ref_ids.includes(runtimeRef))) return false
    }
  }
  for (const inventory of input.inventories) if (inventory.rows.some((row) => row.inventory_kind !== inventory.inventory_kind)) return false
  return true
}

export const coverageFailuresAsReportFailures = (issues: readonly CoverageIssue[]): readonly ReportFailure[] => issues.map((failure) => ({
  failure_id: stableId("failure", { status: failure.status, reason_code: failure.reasonCode, row_ids: sorted(failure.rowIds), source_ref_ids: sorted(failure.sourceRefIds) }),
  status: failure.status,
  reason_code: failure.reasonCode,
  row_ids: sorted(failure.rowIds),
  source_ref_ids: sorted(failure.sourceRefIds),
  accepted_intent_ref_ids: sorted(failure.acceptedIntentRefIds),
}))
