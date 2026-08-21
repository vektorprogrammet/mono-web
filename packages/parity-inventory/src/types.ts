import type { AcceptedIntentRegister } from "./coverage.js";
export interface RuntimeEvidenceReceipt {
  readonly receipt_ref_id: string
  readonly journey_ref_id: string
  readonly step_ids: readonly string[]
  readonly legacy_revision_ref_id: string
  readonly mono_revision_ref_id: string
  readonly runner_source_ref_ids: readonly string[]
  readonly runner_digest: string
  readonly fixture_digest: string
  readonly environment_kind: "local_disposable" | "e2e" | "ci_non_production"
  readonly exit_code: number
  readonly result: "passed" | "failed"
  readonly artifact_digest: string
}

export interface RuntimeEvidenceRegister {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema"
  readonly schema_version: "functional-parity-runtime-evidence/v1"
  readonly receipts: readonly RuntimeEvidenceReceipt[]
}

export interface EvidenceAuthorityRecord {
  readonly repository_ref: "external_runtime_evidence_authority"
  readonly authority_path: string
  readonly revision_ref_id: string
  readonly revision: string
  readonly blob_oid: string
  readonly digest: string
  readonly source_ref_ids: readonly string[]
  readonly immutable: true
}

export type AuthorityLine = "legacy" | "mono" | "cross_line";

export type InventoryKind =
  | "legacy_route"
  | "mono_route"
  | "api_operation"
  | "command_write"
  | "schedule_background"
  | "external_integration"
  | "user_journey";

export type RowStatus =
  | "covered"
  | "accounted"
  | "missing"
  | "extra"
  | "changed"
  | "uncovered"
  | "unresolved"
  | "duplicate"
  | "stale"
  | "dead_unimported"
  | "absent"
  | "not_applicable";

export type MismatchKind =
  | "none"
  | "missing"
  | "extra"
  | "changed"
  | "renamed"
  | "split"
  | "merged"
  | "dead_unimported"
  | "absent"
  | "uncovered"
  | "unresolved"
  | "duplicate"
  | "stale"
  | "openapi_stale";

export type Disposition =
  | "none"
  | "accepted_missing"
  | "accepted_extra"
  | "accepted_changed"
  | "accepted_renamed"
  | "accepted_split"
  | "accepted_merged"
  | "accepted_dead_source"
  | "accepted_absent"
  | "accepted_not_applicable"
  | "rejected";

export type ObservationKind =
  | "static_source"
  | "runtime_resolution"
  | "runtime_evidence"
  | "generated_projection"
  | "accepted_intent"
  | "derived_h3";

export interface Mismatch {
  readonly kind: MismatchKind;
  readonly disposition: Disposition;
  readonly accepted_intent_ref_ids: readonly string[];
  readonly counterpart_row_ids: readonly string[];
  readonly reason: string | null;
}

export interface LegacyRouteDetails {
  readonly declaration_kind:
    | "yaml_route_block"
    | "controller_annotation"
    | "imported_route"
    | "vendor_route"
    | "unknown";
  readonly route_name: string | null;
  readonly path_template: string | null;
  readonly method: string | null;
  readonly methods_declared: readonly string[];
  readonly controller_ref: string | null;
  readonly import_ref: string | null;
  readonly deprecated: boolean;
}

export interface MonoRouteDetails {
  readonly declaration_kind:
    | "controller_attribute"
    | "api_platform"
    | "imported_route"
    | "vendor_route"
    | "unknown";
  readonly route_origin: "controller" | "api_platform" | "imported" | "vendor";
  readonly route_name: string | null;
  readonly path_template: string | null;
  readonly method: string | null;
  readonly owner_ref: string | null;
  readonly runtime_resolved: boolean;
  readonly imported_from_ref: string | null;
}

export interface ApiOperationDetails {
  readonly resource_class_ref: string | null;
  readonly resource_key: string | null;
  readonly operation_name: string | null;
  readonly method: string | null;
  readonly uri_template: string | null;
  readonly operation_id: string | null;
  readonly provider_ref: string | null;
  readonly processor_ref: string | null;
  readonly schema_ref: string | null;
  readonly openapi_projection_ref: string | null;
}

export interface CommandWriteDetails {
  readonly entry_kind:
    | "custom_command"
    | "controller_write"
    | "repository_write"
    | "api_processor"
    | "event_handler"
    | "message_consumer"
    | "integration_write"
    | "unknown";
  readonly owner_ref: string | null;
  readonly command_name: string | null;
  readonly symbol_ref: string | null;
  readonly effect_classes: readonly (
    | "read_only"
    | "durable_write"
    | "identity_or_authority"
    | "outbound"
    | "filesystem"
    | "scheduler"
    | "unknown"
  )[];
  readonly target_refs: readonly string[];
  readonly write_contract_ref: string | null;
}

export interface ScheduleBackgroundDetails {
  readonly trigger_kind:
    | "cron"
    | "queue"
    | "event"
    | "manual"
    | "workflow_dispatch"
    | "startup"
    | "webhook"
    | "unknown";
  readonly trigger_identity: string | null;
  readonly schedule_expression: string | null;
  readonly owner_ref: string | null;
  readonly handler_ref: string | null;
  readonly enabled: boolean | null;
  readonly repository_owned: boolean;
  readonly runtime_registered: boolean | null;
}

export interface ExternalIntegrationDetails {
  readonly provider_ref: string | null;
  readonly direction: "inbound" | "outbound" | "bidirectional";
  readonly protocol: string | null;
  readonly endpoint_ref: string | null;
  readonly credential_slot_ref: string | null;
  readonly call_site_ref: string | null;
  readonly contract_ref: string | null;
  readonly effect_classes: readonly (
    | "read_only"
    | "durable_write"
    | "identity_or_authority"
    | "outbound"
    | "filesystem"
    | "scheduler"
    | "unknown"
  )[];
}

export interface JourneyStep {
  readonly step_id: string;
  readonly surface:
    | "legacy_route"
    | "mono_route"
    | "api_operation"
    | "command_write"
    | "schedule_background"
    | "external_integration";
  readonly row_ids: readonly string[];
  readonly canonical_signatures: readonly string[];
  readonly expected_contract_ref: string | null;
  readonly runtime_evidence_ref_ids: readonly string[];
}

export interface UserJourneyDetails {
  readonly journey_ref_id: string;
  readonly journey_key: string;
  readonly intent_ref_id: string;
  readonly steps: readonly JourneyStep[];
  readonly coverage_scope:
    | "user_visible"
    | "operator_visible"
    | "background"
    | "accepted_non_user_facing";
}

export type RowDetails =
  | LegacyRouteDetails
  | MonoRouteDetails
  | ApiOperationDetails
  | CommandWriteDetails
  | ScheduleBackgroundDetails
  | ExternalIntegrationDetails
  | UserJourneyDetails;

export interface InventoryRow {
  readonly row_id: string;
  readonly declaration_id: string;
  readonly inventory_kind: InventoryKind;
  readonly authority_line: AuthorityLine;
  readonly canonical_key: string;
  readonly signature: string;
  readonly status: RowStatus;
  readonly observation_kinds: readonly ObservationKind[];
  readonly source_ref_ids: readonly string[];
  readonly revision_ref_ids: readonly string[];
  readonly runtime_observation_ref_ids: readonly string[];
  readonly coverage_ref_ids: readonly string[];
  readonly accepted_intent_ref_ids: readonly string[];
  readonly duplicate_group_id: string | null;
  readonly mismatch: Mismatch;
  readonly reason_codes: readonly string[];
  readonly related_row_ids: readonly string[];
  readonly details: RowDetails;
}

export interface InventoryLink {
  readonly relation_id: string;
  readonly relation_kind: "matches" | "derives" | "imports" | "covers" | "observes" | "reconciles";
  readonly from_row_id: string;
  readonly to_row_id: string;
  readonly source_ref_ids: readonly string[];
}

export interface InventoryObservation {
  readonly observation_id: string;
  readonly observation_kind: ObservationKind;
  readonly source_ref_ids: readonly string[];
  readonly value_digest: string;
  readonly normative: false;
  readonly label?: string;
  readonly count?: number | null;
}

export interface DerivationEdge {
  readonly edge_id: string;
  readonly edge_type:
    | "authority_input"
    | "observed_inventory"
    | "derived_projection"
    | "reconciles"
    | "coverage"
    | "accepted_intent";
  readonly from_ref_ids: readonly string[];
  readonly to_row_ids: readonly string[];
  readonly derivation: string;
}

export interface InventoryEnvelope {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-inventory/v1";
  readonly inventory_kind: InventoryKind;
  readonly authority_line: AuthorityLine;
  readonly source_manifest_sha256: string;
  readonly revision_ref_ids: readonly string[];
  readonly observation_kinds: readonly ObservationKind[];
  readonly rows: readonly InventoryRow[];
  readonly links: readonly InventoryLink[];
  readonly observations: readonly InventoryObservation[];
  readonly derivation_edges: readonly DerivationEdge[];
}

export interface CensusRoot {
  readonly root_ref: "legacy" | "mono";
  readonly authority_line: "legacy" | "mono";
  readonly repository_ref: string;
  readonly revision_ref_id: string;
  readonly root_kind: "repository";
  readonly scan_mode: "all_regular_files";
}

export interface RevisionRecord {
  readonly revision_ref_id: string;
  readonly repository_ref: string;
  readonly revision_kind: "git_commit" | "archive_digest" | "file_set_digest";
  readonly revision: string;
  readonly immutable: true;
}

export interface CollectorExecutables {
  readonly phpExecutable: string
  readonly bwrapExecutable: string
}

export type CollectorExecutableProvenance = "usr-bin" | "nix-store"

export interface RuntimeExecutableDigests {
  readonly php: string | null
  readonly bwrap: string | null
}

export interface RuntimeExecutableProvenance {
  readonly php: CollectorExecutableProvenance | null
  readonly bwrap: CollectorExecutableProvenance | null
}

export interface RuntimeObservation {
  readonly runtime_observation_ref_id: string;
  readonly revision_ref_id: string;
  readonly collector_kind: string;
  readonly logical_command_id: string;
  readonly command: string;
  readonly argument_digest: string;
  readonly executable_digests: RuntimeExecutableDigests;
  readonly executable_provenance: RuntimeExecutableProvenance;
  readonly stdout_sha256: string;
  readonly stderr_sha256: string;
  readonly exit_code: number;
  readonly result_sha256: string;
  readonly availability: "available" | "unavailable";
  readonly out_of_band?: true;
}

export interface IgnoreRule {
  readonly ignore_rule_id: string;
  readonly authority_line: "legacy" | "mono";
  readonly root_ref: "legacy" | "mono";
  readonly precedence: number;
  readonly pattern: string;
  readonly selection: "ordered_set_difference";
  readonly rule_kind:
    | "repository_metadata"
    | "dependency_cache"
    | "runtime_cache"
    | "runtime_log"
    | "build_cache"
    | "generated_output"
    | "test_support"
    | "binary_tool";
  readonly rationale: string;
}

export interface SourceRecord {
  readonly source_id: string;
  readonly authority_line: AuthorityLine;
  readonly authority_role: string;
  readonly repository_ref: string;
  readonly revision_ref_id: string;
  readonly path: string;
  readonly line_start: number | null;
  readonly line_end: number | null;
  readonly symbol: string | null;
  readonly byte_length: number | null;
  readonly sha256: string | null;
  readonly capture_mode: "static" | "runtime" | "generated" | "accepted_intent";
  readonly availability: "available" | "unavailable";
  readonly classification_status: "classified" | "unclassified";
  readonly out_of_band?: true;
  readonly failure_status?: "source_unavailable" | "unresolved" | null;
  readonly failure_reason?: string | null;
}

export interface RootCensusRecord {
  readonly census_id: string;
  readonly authority_line: "legacy" | "mono";
  readonly root_ref: "legacy" | "mono";
  readonly path: string;
  readonly byte_length: number | null;
  readonly sha256: string | null;
  readonly availability: "available" | "unavailable";
  readonly classification: "matched" | "ignored" | "unclassified";
  readonly source_ref_ids: readonly string[];
  readonly ignore_rule_id: string | null;
}

export interface IntentAuthorityRecord {
  readonly repository_ref: "external_intent_authority";
  readonly authority_path: string;
  readonly revision_ref_id: string;
  readonly revision: string;
  readonly blob_oid: string;
  readonly digest: string;
  readonly immutable: true;
}

export interface SourceManifest {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-source-manifest/v1";
  readonly manifest_id: string;
  readonly source_set: string;
  readonly census_roots: readonly CensusRoot[];
  readonly revisions: readonly RevisionRecord[];
  readonly runtime_observations: readonly RuntimeObservation[];
  readonly root_census: readonly RootCensusRecord[];
  readonly ignore_rules: readonly IgnoreRule[];
  readonly sources: readonly SourceRecord[];
  readonly intent_authority?: IntentAuthorityRecord;
  readonly evidence_authority?: EvidenceAuthorityRecord;
}

export interface OpenApiReconciliation {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-openapi-reconciliation/v1";
  readonly status: "current" | "stale" | "unresolved";
  readonly source_manifest_sha256: string | null;
  readonly committed_source_ref_ids: readonly string[];
  readonly regenerated_source_ref_ids: readonly string[];
  readonly committed_document_sha256: string | null;
  readonly regenerated_document_sha256: string | null;
  readonly committed_sha256: string | null;
  readonly regenerated_sha256: string | null;
  readonly only_committed: readonly string[];
  readonly only_regenerated: readonly string[];
  readonly changed_operations: readonly string[];
}

export type FailureStatus =
  | "gaps_found"
  | "unresolved"
  | "duplicate"
  | "stale"
  | "source_unavailable"
  | "source_hash_drift"
  | "schema_invalid"
  | "nondeterministic_output"
  | "runtime_unavailable"
  | "accepted_intent_invalid"
  | "command_error";

export type ReportStatus = "zero_gap" | "falsifier_passed" | "projection_written" | FailureStatus;

export interface ReportFailure {
  readonly failure_id: string;
  readonly status: FailureStatus;
  readonly reason_code: string;
  readonly row_ids: readonly string[];
  readonly source_ref_ids: readonly string[];
  readonly accepted_intent_ref_ids: readonly string[];
}

export interface ReportMismatch {
  readonly kind: Exclude<MismatchKind, "none">;
  readonly row_ids: readonly string[];
  readonly disposition: Disposition;
  readonly accepted_intent_ref_ids: readonly string[];
}

export interface ProjectionWrite {
  readonly status: "not_requested" | "written" | "blocked";
  readonly target_ref: string | null;
}

export interface Verification {
  readonly canonical_json: "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline";
  readonly schema_validation: boolean;
  readonly cross_reference_validation: boolean;
  readonly deterministic_diff: "equal" | "different" | "not_run";
  readonly forbidden_states_empty: boolean;
}

export interface ZeroGapReport {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-zero-gap-report/v1";
  readonly status: ReportStatus;
  readonly exit_code: number;
  readonly mode: "diff" | "write" | "fixture_injection";
  readonly falsifier_id: string | null;
  readonly projection_write: ProjectionWrite;
  readonly source_manifest_sha256: string | null;
  readonly inventory_artifact_sha256: Readonly<Record<string, string>>;
  readonly row_counts: Readonly<Record<string, number>>;
  readonly status_counts: Readonly<Record<string, number>>;
  readonly failures: readonly ReportFailure[];
  readonly mismatches: readonly ReportMismatch[];
  readonly openapi_reconciliation_ref: "openapi-reconciliation.json";
  readonly verification: Verification;
}
export interface IntentAuthorityEvidence extends IntentAuthorityRecord {
  readonly authority_root: string;
  readonly relative_path: string;
  readonly bytes: Uint8Array;
}

export interface EvidenceAuthorityEvidence extends EvidenceAuthorityRecord {
  readonly authority_root: string
  readonly relative_path: string
  readonly bytes: Uint8Array
}

export interface RouteParseFailure {
  readonly source_ref_id: string;
  readonly reason_code: string;
  readonly status: "source_unavailable" | "unresolved";
}
export interface RouteCollection {
  readonly inventory: InventoryEnvelope;
  readonly failures: readonly RouteParseFailure[];
}

export interface GeneratedArtifacts {
  readonly sourceManifest: SourceManifest;
  readonly legacyRoutes: InventoryEnvelope;
  readonly monoRoutes: InventoryEnvelope;
  readonly apiOperations: InventoryEnvelope;
  readonly commandWrites: InventoryEnvelope;
  readonly scheduledBackgroundWorkflows: InventoryEnvelope;
  readonly externalIntegrations: InventoryEnvelope;
  readonly userJourneyCoverage: InventoryEnvelope;
  readonly openapiReconciliation: OpenApiReconciliation;
  readonly report: ZeroGapReport;
  readonly acceptedIntentRegister?: AcceptedIntentRegister;
  readonly intentAuthority?: IntentAuthorityEvidence;
  readonly runtimeEvidenceRegister?: RuntimeEvidenceRegister;
  readonly evidenceAuthority?: EvidenceAuthorityEvidence;
  readonly bytes: Readonly<Record<string, string>>;
  readonly failures: readonly ReportFailure[];
  readonly routeRows: readonly InventoryRow[];
  readonly apiRows: readonly InventoryRow[];
  readonly c2Rows: readonly InventoryRow[];
}
