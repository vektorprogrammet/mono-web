import Ajv2020 from "ajv/dist/2020.js";
import acceptedIntentV1Schema from "../schemas/accepted-intent.json";
import acceptedIntentV2Schema from "../schemas/accepted-intent-v2.json";
import atomicCatalogSchema from "../schemas/atomic-operation-catalog.json";
import capabilityReportSchema from "../schemas/capability-parity-report.json";
import capabilityEvidenceV2Schema from "../schemas/capability-runtime-evidence-v2.json";
import runtimeEvidenceV1Schema from "../schemas/runtime-evidence.json";
import { isJsonObject } from "./json-safety.js";
import { canonicalJson, compareByteOrder, sha256, sortUnique, stableId } from "./canonical.js";

export type Backend = "legacy_symfony" | "native_effect";
export type CapabilityClaim = "supported" | "unsupported" | "unknown";
export type CapabilityVerdict = "equivalent" | "not_equivalent" | "unknown";

export interface AuthorityPin {
  readonly repository_ref: string;
  readonly authority_path: string;
  readonly revision: string;
  readonly blob_oid: string;
  readonly digest: string;
  readonly source_schema_version: string;
}

export interface CatalogDiagnostic {
  readonly code: string;
  readonly operation_ref_id: string | null;
  readonly detail: string;
}

export interface SecurityRequirement {
  readonly scheme_ref: string;
  readonly scopes: readonly string[];
}

export interface EffectiveSecurity {
  readonly effective_from: "operation" | "root";
  readonly mode: "required" | "optional" | "none" | "unknown";
  readonly alternatives: readonly { readonly all_of: readonly SecurityRequirement[] }[];
}

export interface AtomicOperation {
  readonly operation_ref_id: string;
  readonly operation_id: string;
  readonly method: string;
  readonly path_template: string;
  readonly security: EffectiveSecurity;
  readonly inputs: readonly {
    readonly location: "path" | "query" | "header" | "cookie" | "body";
    readonly name: string | null;
    readonly required: boolean;
    readonly media_type: string | null;
    readonly schema_sha256: string | null;
    readonly source_pointer: string;
  }[];
  readonly responses: readonly {
    readonly status: string;
    readonly role: "success" | "error" | "unknown";
    readonly media_type: string | null;
    readonly schema_sha256: string | null;
    readonly header_schema_sha256: string | null;
    readonly source_pointer: string;
  }[];
  readonly effects: {
    readonly completeness: "declared_subset" | "complete" | "unknown";
    readonly requests: readonly {
      readonly effect_ref_id: string;
      readonly kind: string;
      readonly claim_kind: "source_declaration";
      readonly source_ref_ids: readonly string[];
    }[];
  };
  readonly source_metadata: LegacyOperationMetadata;
  readonly provenance: {
    readonly openapi_document_sha256: string;
    readonly canonical_operation_sha256: string;
    readonly json_pointer: string;
    readonly source_ref_ids: readonly string[];
    readonly generator_ref: string;
  };
}

export interface AtomicOperationCatalog {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "backend-atomic-operation-catalog/v1";
  readonly backend: Backend;
  readonly openapi_sha256: string;
  readonly generator_ref: string;
  readonly source_revision_ref: string;
  readonly operations: readonly AtomicOperation[];
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export interface LegacyOperationMetadata {
  readonly resource_class_ref: string | null;
  readonly operation_name: string | null;
  readonly security_expression: string | null;
  readonly security_post_denormalize: string | null;
  readonly status: number | null;
  readonly input_ref: string | null;
  readonly output_ref: string | null;
  readonly provider_ref: string | null;
  readonly processor_ref: string | null;
  readonly read: boolean | null;
  readonly deserialize: boolean | null;
  readonly validate: boolean | null;
  readonly output: boolean | null;
  readonly validation_groups: readonly string[];
  readonly source_ref_ids: readonly string[];
}

export interface LegacyMetadataRecord extends LegacyOperationMetadata {
  readonly method: string | null;
  readonly uri_template: string | null;
  readonly operation_id: string | null;
}

export interface MigrationDiagnostic {
  readonly code:
    | "MISSING_PRECONDITION_ASSERTION"
    | "MISSING_OUTCOME_ASSERTION"
    | "MISSING_REJECTION_ASSERTION"
    | "MISSING_EFFECT_ASSERTION"
    | "MISSING_FRESHNESS_ASSERTION"
    | "MISSING_WITNESS_BINDING"
    | "MISSING_CLAIM_SPECIFIC_EVIDENCE";
  readonly intent_ref_id: string;
  readonly step_id: string | null;
  readonly detail: string;
}

export interface PredicateDefinition {
  readonly predicate_ref: string;
  readonly implies: readonly string[];
  readonly source_ref_ids: readonly string[];
}

export interface ProjectionDefinition {
  readonly projection_ref: string;
  readonly input_selector: string;
  readonly output_selector: string;
  readonly source_ref_ids: readonly string[];
}

export interface IntentStage {
  readonly stage_id: string;
  readonly kind: "command" | "query" | "observation";
  readonly source_step_ids: readonly string[];
}

export interface IntentPrecondition {
  readonly precondition_id: string;
  readonly predicate_ref: string;
  readonly subject: "actor" | "resource" | "input" | "clock";
}

export interface IntentOutcome {
  readonly assertion_id: string;
  readonly semantic_path: string;
  readonly predicate: "equals" | "exists" | "absent" | "set_equals" | "transitioned_to";
  readonly expected_json: string;
  readonly visibility: "user" | "operator" | "internal_evidence";
}

export interface IntentSideEffect {
  readonly effect_id: string;
  readonly kind: string;
  readonly cardinality: { readonly min: number; readonly max: number | null };
  readonly order_after_stage_id: string;
  readonly required_claim: "requested" | "persisted_outbox" | "delivered";
}

export interface IntentRejection {
  readonly rejection_id: string;
  readonly trigger_predicate_ref: string;
  readonly boundary_semantic: string;
  readonly disclosure: "ordinary" | "conceal_existence";
  readonly must_not_change_state: boolean;
  readonly must_not_request_effects: boolean;
}

export interface IntentFreshness {
  readonly freshness_id: string;
  readonly mode: "read_after_write" | "independent_read" | "command_response";
  readonly write_stage_id: string;
  readonly observation_stage_id: string;
  readonly assertion_ids: readonly string[];
}

export interface OperationNode {
  readonly node_id: string;
  readonly kind: "operation";
  readonly operation_ref_id: string;
  readonly expected_operation_sha256: string;
  readonly realizes_stage_ids: readonly string[];
  readonly predicate_refs: readonly string[];
}

export interface ObservationNode {
  readonly node_id: string;
  readonly kind: "local_observation";
  readonly observation_kind: "browser" | "persistence" | "outbox" | "effect";
  readonly assertion_ids: readonly string[];
}

export type WitnessNode = OperationNode | ObservationNode;

export type WitnessEdge =
  | {
      readonly edge_id: string;
      readonly kind: "data";
      readonly from: string;
      readonly to: string;
      readonly from_selector: string;
      readonly to_selector: string;
      readonly transform_ref: string;
    }
  | {
      readonly edge_id: string;
      readonly kind: "authority";
      readonly from: string;
      readonly to: string;
      readonly precondition_id: string;
    }
  | {
      readonly edge_id: string;
      readonly kind: "order";
      readonly from: string;
      readonly to: string;
      readonly relation: "must_precede" | "read_after_write";
    };

export interface ImplementationWitness {
  readonly witness_id: string;
  readonly purpose: "accepted" | "rejection" | "freshness";
  readonly nodes: readonly WitnessNode[];
  readonly edges: readonly WitnessEdge[];
  readonly satisfies: {
    readonly precondition_ids: readonly string[];
    readonly assertion_ids: readonly string[];
    readonly effect_ids: readonly string[];
    readonly rejection_ids: readonly string[];
    readonly freshness_ids: readonly string[];
  };
  readonly evidence_receipt_ref_ids: readonly string[];
}

export interface ImplementationDefinition {
  readonly backend: Backend;
  readonly claim: CapabilityClaim;
  readonly reason_code: string | null;
  readonly witnesses: readonly ImplementationWitness[];
}

export interface CapabilityIntent {
  readonly intent_ref_id: string;
  readonly intent_revision: string;
  readonly intent_digest: string;
  readonly source_ref_ids: readonly string[];
  readonly source_v1_selection: Record<string, unknown> | null;
  readonly semantic_stages: readonly IntentStage[];
  readonly required_preconditions: readonly IntentPrecondition[];
  readonly warranted_outcomes: readonly IntentOutcome[];
  readonly side_effects: readonly IntentSideEffect[];
  readonly rejections: readonly IntentRejection[];
  readonly freshness: readonly IntentFreshness[];
  readonly implementations: readonly ImplementationDefinition[];
}

export interface AcceptedIntentV2 {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-accepted-intent/v2";
  readonly source_authority: AuthorityPin;
  readonly source_v1_intents: readonly Record<string, unknown>[];
  readonly predicates: readonly PredicateDefinition[];
  readonly projections: readonly ProjectionDefinition[];
  readonly intents: readonly CapabilityIntent[];
  readonly migration_diagnostics: readonly MigrationDiagnostic[];
}

export type EvidenceClaimKind =
  | "journey_executed"
  | "operation_observed"
  | "authorization_observed"
  | "boundary_observation"
  | "rejection_observed"
  | "persistence_observed"
  | "effect_requested"
  | "effect_delivered"
  | "transaction_rollback_observed"
  | "fresh_read_observed";

export interface CapabilityEvidenceClaim {
  readonly claim_id: string;
  readonly kind: EvidenceClaimKind;
  readonly witness_id: string | null;
  readonly node_id: string | null;
  readonly precondition_id: string | null;
  readonly assertion_id: string | null;
  readonly effect_id: string | null;
  readonly rejection_id: string | null;
  readonly freshness_id: string | null;
  readonly artifact: {
    readonly artifact_digest: string;
    readonly artifact_pointer: string;
  };
}

export interface CapabilityEvidenceReceipt {
  readonly receipt_ref_id: string;
  readonly backend: Backend;
  readonly intent_ref_id: string;
  readonly intent_revision: string;
  readonly implementation_digest: string;
  readonly backend_revision_ref: string;
  readonly openapi_sha256: string;
  readonly operation_sha256: readonly string[];
  readonly runner_digest: string;
  readonly fixture_digest: string;
  readonly result: "passed" | "failed";
  readonly exit_code: number;
  readonly claims: readonly CapabilityEvidenceClaim[];
}

export interface CapabilityEvidenceV2 {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-capability-runtime-evidence/v2";
  readonly source_authority: AuthorityPin;
  readonly receipts: readonly CapabilityEvidenceReceipt[];
}

export type CapabilityDiagnosticCode =
  | "MISSING_WITNESS"
  | "UNKNOWN_OPERATION"
  | "OPERATION_DRIFT"
  | "SECURITY_METADATA_CONFLICT"
  | "AUTHORIZATION_UNWARRANTED"
  | "CLAIM_SCOPE_INVALID"
  | "WEAKER_PRECONDITION"
  | "MISSING_OUTCOME"
  | "MISSING_REJECTION"
  | "WEAKER_REJECTION"
  | "EFFECT_DECLARATION_MISSING"
  | "EFFECT_CLAIM_UNWARRANTED"
  | "EFFECT_MISMATCH"
  | "READ_AFTER_WRITE_MISSING"
  | "FRESHNESS_UNWARRANTED"
  | "RECEIPT_STALE"
  | "MISSING_SEMANTIC_ASSERTION"
  | "MISSING_CLAIM_SPECIFIC_EVIDENCE"
  | "UNSUPPORTED"
  | "UNKNOWN";

export interface CapabilityDiagnostic {
  readonly code: CapabilityDiagnosticCode;
  readonly backend: Backend | null;
  readonly intent_ref_id: string | null;
  readonly claim_kind: string | null;
  readonly detail: string;
}

export interface BackendComparisonResult {
  readonly claim: CapabilityClaim;
  readonly witness_digest: string | null;
  readonly evidence_status: "current" | "missing" | "stale" | "unsupported";
  readonly missing_claim_kinds: readonly string[];
  readonly diagnostics: readonly CapabilityDiagnostic[];
}

export interface CapabilityReportRow {
  readonly comparison_ref_id: string;
  readonly intent_ref_ids: readonly string[];
  readonly intent_revision: string;
  readonly legacy: BackendComparisonResult;
  readonly native: BackendComparisonResult;
  readonly equivalence: CapabilityVerdict;
  readonly diagnostics: readonly CapabilityDiagnostic[];
}

interface ReportAuthorityPin {
  readonly revision: string;
  readonly blob_oid: string;
  readonly digest: string;
  readonly schema_version: string;
}

export interface CapabilityParityReport {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly schema_version: "functional-parity-capability-report/v1";
  readonly canonicalization: "recursive-key-sort/contract-array-sort/compact-utf8/no-newline";
  readonly provenance: {
    readonly legacy_openapi_sha256: string;
    readonly native_openapi_sha256: string;
    readonly legacy_catalog_sha256: string;
    readonly native_catalog_sha256: string;
    readonly intent_authority: ReportAuthorityPin;
    readonly evidence_authority: ReportAuthorityPin;
  };
  readonly rows: readonly CapabilityReportRow[];
  readonly diagnostics: readonly CapabilityDiagnostic[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateAtomic = ajv.compile<AtomicOperationCatalog>(atomicCatalogSchema);
const validateIntentV2 = ajv.compile<AcceptedIntentV2>(acceptedIntentV2Schema);
const validateEvidenceV2 = ajv.compile<CapabilityEvidenceV2>(capabilityEvidenceV2Schema);
const validateReport = ajv.compile<CapabilityParityReport>(capabilityReportSchema);
const validateIntentV1 = ajv.compile<Record<string, unknown>>(acceptedIntentV1Schema);
const validateEvidenceV1 = ajv.compile<Record<string, unknown>>(runtimeEvidenceV1Schema);

export const validateAtomicOperationCatalog = (value: unknown): value is AtomicOperationCatalog =>
  validateAtomic(value) === true;

export const validateAcceptedIntentV2 = (value: unknown): value is AcceptedIntentV2 =>
  validateIntentV2(value) === true;

export const validateCapabilityEvidenceV2 = (value: unknown): value is CapabilityEvidenceV2 =>
  validateEvidenceV2(value) === true;

export const validateCapabilityParityReport = (value: unknown): value is CapabilityParityReport =>
  validateReport(value) === true;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const pointerEscape = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

const pointerValue = (root: unknown, reference: string): unknown => {
  if (!reference.startsWith("#/")) throw new Error(`EXTERNAL_REFERENCE_UNSUPPORTED:${reference}`);
  let current = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error(`UNRESOLVED_REFERENCE:${reference}`);
      current = current[Number(key)];
    } else if (isJsonObject(current) && hasOwn(current, key)) {
      current = current[key];
    } else {
      throw new Error(`UNRESOLVED_REFERENCE:${reference}`);
    }
  }
  return current;
};

const canonicalizeSchemaValue = (
  root: unknown,
  value: unknown,
  activeReferences: ReadonlySet<string>,
  seenObjects: ReadonlySet<object>,
): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value))
    return value.map((item) => canonicalizeSchemaValue(root, item, activeReferences, seenObjects));
  if (!isJsonObject(value)) throw new Error("OPENAPI_SCHEMA_VALUE_INVALID");
  if (seenObjects.has(value)) return { $recursiveObject: true };

  const nextSeen = new Set(seenObjects);
  nextSeen.add(value);
  const reference = typeof value.$ref === "string" ? value.$ref : null;
  const output: Record<string, unknown> = {};
  if (reference !== null) {
    if (!reference.startsWith("#/")) throw new Error(`EXTERNAL_REFERENCE_UNSUPPORTED:${reference}`);
    if (activeReferences.has(reference)) output.$recursiveRef = reference;
    else {
      const nextActive = new Set(activeReferences);
      nextActive.add(reference);
      output.$resolved = canonicalizeSchemaValue(
        root,
        pointerValue(root, reference),
        nextActive,
        nextSeen,
      );
    }
  }
  for (const key of Object.keys(value).sort(compareByteOrder)) {
    if (key === "$ref") continue;
    output[key] = canonicalizeSchemaValue(root, value[key], activeReferences, nextSeen);
  }
  return output;
};

export const canonicalizeOpenApiSchema = (root: unknown, schema: unknown): unknown =>
  canonicalizeSchemaValue(root, schema, new Set(), new Set());

const schemaDigest = (root: unknown, schema: unknown): string | null => {
  if (schema === undefined) return null;
  return sha256(canonicalJson(canonicalizeOpenApiSchema(root, schema)));
};

const effectiveSecurity = (
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
): EffectiveSecurity => {
  const effectiveFrom = hasOwn(operation, "security") ? "operation" : "root";
  const raw = effectiveFrom === "operation" ? operation.security : root.security;
  if (!Array.isArray(raw))
    return { effective_from: effectiveFrom, mode: "unknown", alternatives: [] };
  if (raw.length === 0) return { effective_from: effectiveFrom, mode: "none", alternatives: [] };
  const alternatives: { all_of: SecurityRequirement[] }[] = [];
  let optional = false;
  for (const item of raw) {
    if (!isJsonObject(item))
      return { effective_from: effectiveFrom, mode: "unknown", alternatives: [] };
    const allOf = Object.keys(item)
      .sort(compareByteOrder)
      .map((schemeRef) => {
        const scopes = item[schemeRef];
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))
          throw new Error("OPENAPI_SECURITY_SCOPES_INVALID");
        return { scheme_ref: schemeRef, scopes: sortUnique(scopes as string[]) };
      });
    if (allOf.length === 0) optional = true;
    alternatives.push({ all_of: allOf });
  }
  return { effective_from: effectiveFrom, mode: optional ? "optional" : "required", alternatives };
};

const resolveMaybeReference = (root: unknown, value: unknown): unknown =>
  isJsonObject(value) && typeof value.$ref === "string" ? pointerValue(root, value.$ref) : value;

const collectInputs = (
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  pointer: string,
): AtomicOperation["inputs"] => {
  const parameters = new Map<string, { value: Record<string, unknown>; pointer: string }>();
  for (const [owner, raw] of [
    ["path", pathItem.parameters],
    ["operation", operation.parameters],
  ] as const) {
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new Error("OPENAPI_PARAMETERS_INVALID");
    raw.forEach((entry, index) => {
      const resolved = resolveMaybeReference(root, entry);
      if (!isJsonObject(resolved)) throw new Error("OPENAPI_PARAMETER_INVALID");
      const location = resolved.in;
      const name = resolved.name;
      if (typeof location !== "string" || typeof name !== "string")
        throw new Error("OPENAPI_PARAMETER_IDENTITY_MISSING");
      parameters.set(`${location}:${name}`, {
        value: resolved,
        pointer: `${pointer}/${owner}/parameters/${index}`,
      });
    });
  }

  const inputs: AtomicOperation["inputs"][number][] = [...parameters.values()].map(
    ({ value, pointer: sourcePointer }) => {
      const location = value.in;
      if (
        location !== "path" &&
        location !== "query" &&
        location !== "header" &&
        location !== "cookie"
      )
        throw new Error("OPENAPI_PARAMETER_LOCATION_INVALID");
      return {
        location,
        name: typeof value.name === "string" ? value.name : null,
        required: value.required === true || location === "path",
        media_type: null,
        schema_sha256: schemaDigest(root, value.schema),
        source_pointer: sourcePointer,
      };
    },
  );

  if (operation.requestBody !== undefined) {
    const requestBody = resolveMaybeReference(root, operation.requestBody);
    if (!isJsonObject(requestBody) || !isJsonObject(requestBody.content))
      throw new Error("OPENAPI_REQUEST_BODY_INVALID");
    for (const mediaType of Object.keys(requestBody.content).sort(compareByteOrder)) {
      const media = requestBody.content[mediaType];
      if (!isJsonObject(media)) throw new Error("OPENAPI_REQUEST_MEDIA_INVALID");
      inputs.push({
        location: "body",
        name: null,
        required: requestBody.required === true,
        media_type: mediaType,
        schema_sha256: schemaDigest(root, media.schema),
        source_pointer: `${pointer}/requestBody/content/${pointerEscape(mediaType)}`,
      });
    }
  }
  return inputs.sort((left, right) =>
    compareByteOrder(
      `${left.location}:${left.name ?? ""}:${left.media_type ?? ""}:${left.source_pointer}`,
      `${right.location}:${right.name ?? ""}:${right.media_type ?? ""}:${right.source_pointer}`,
    ),
  );
};

const collectResponses = (
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
  pointer: string,
): AtomicOperation["responses"] => {
  if (!isJsonObject(operation.responses)) throw new Error("OPENAPI_RESPONSES_MISSING");
  const responses: AtomicOperation["responses"][number][] = [];
  for (const status of Object.keys(operation.responses).sort(compareByteOrder)) {
    const response = resolveMaybeReference(root, operation.responses[status]);
    if (!isJsonObject(response)) throw new Error("OPENAPI_RESPONSE_INVALID");
    const role = /^2[0-9][0-9]$/.test(status)
      ? "success"
      : /^[1-5][0-9][0-9]$/.test(status)
        ? "error"
        : "unknown";
    const headers = isJsonObject(response.headers) ? response.headers : {};
    const headerDigest = Object.keys(headers).length === 0 ? null : schemaDigest(root, headers);
    const content = isJsonObject(response.content) ? response.content : null;
    if (content === null || Object.keys(content).length === 0) {
      responses.push({
        status,
        role,
        media_type: null,
        schema_sha256: null,
        header_schema_sha256: headerDigest,
        source_pointer: `${pointer}/responses/${pointerEscape(status)}`,
      });
      continue;
    }
    for (const mediaType of Object.keys(content).sort(compareByteOrder)) {
      const media = content[mediaType];
      if (!isJsonObject(media)) throw new Error("OPENAPI_RESPONSE_MEDIA_INVALID");
      responses.push({
        status,
        role,
        media_type: mediaType,
        schema_sha256: schemaDigest(root, media.schema),
        header_schema_sha256: headerDigest,
        source_pointer: `${pointer}/responses/${pointerEscape(status)}/content/${pointerEscape(mediaType)}`,
      });
    }
  }
  return responses;
};

const emptySourceMetadata = (sourceRefIds: readonly string[] = []): LegacyOperationMetadata => ({
  resource_class_ref: null,
  operation_name: null,
  security_expression: null,
  security_post_denormalize: null,
  status: null,
  input_ref: null,
  output_ref: null,
  provider_ref: null,
  processor_ref: null,
  read: null,
  deserialize: null,
  validate: null,
  output: null,
  validation_groups: [],
  source_ref_ids: sortUnique(sourceRefIds),
});

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const nullableBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
const nullableInteger = (value: unknown): number | null =>
  Number.isInteger(value) ? (value as number) : null;

export const decodeLegacyMetadataRecords = (value: unknown): readonly LegacyMetadataRecord[] => {
  if (!Array.isArray(value)) throw new Error("LEGACY_METADATA_INVALID");
  return value.map((item, index) => {
    if (!isJsonObject(item)) throw new Error(`LEGACY_METADATA_INVALID:${index}`);
    const nullableStrings = [
      "resource_class_ref",
      "operation_name",
      "method",
      "uri_template",
      "operation_id",
      "security_expression",
      "security_post_denormalize",
      "input_ref",
      "output_ref",
      "provider_ref",
      "processor_ref",
    ] as const;
    const nullableBooleans = ["read", "deserialize", "validate", "output"] as const;
    if (nullableStrings.some((key) => item[key] !== null && typeof item[key] !== "string"))
      throw new Error(`LEGACY_METADATA_INVALID:${index}`);
    if (nullableBooleans.some((key) => item[key] !== null && typeof item[key] !== "boolean"))
      throw new Error(`LEGACY_METADATA_INVALID:${index}`);
    if (item.status !== null && !Number.isInteger(item.status))
      throw new Error(`LEGACY_METADATA_INVALID:${index}`);
    if (
      !Array.isArray(item.validation_groups) ||
      item.validation_groups.some((group) => typeof group !== "string") ||
      !Array.isArray(item.source_ref_ids) ||
      item.source_ref_ids.some((sourceRef) => typeof sourceRef !== "string")
    )
      throw new Error(`LEGACY_METADATA_INVALID:${index}`);
    return {
      resource_class_ref: item.resource_class_ref as string | null,
      operation_name: item.operation_name as string | null,
      method: item.method as string | null,
      uri_template: item.uri_template as string | null,
      operation_id: item.operation_id as string | null,
      security_expression: item.security_expression as string | null,
      security_post_denormalize: item.security_post_denormalize as string | null,
      status: item.status as number | null,
      input_ref: item.input_ref as string | null,
      output_ref: item.output_ref as string | null,
      provider_ref: item.provider_ref as string | null,
      processor_ref: item.processor_ref as string | null,
      read: item.read as boolean | null,
      deserialize: item.deserialize as boolean | null,
      validate: item.validate as boolean | null,
      output: item.output as boolean | null,
      validation_groups: sortUnique(item.validation_groups),
      source_ref_ids: sortUnique(item.source_ref_ids),
    };
  });
};

const sourceMetadataFromExtension = (
  operation: Record<string, unknown>,
): LegacyOperationMetadata => {
  const extension = operation["x-vektorprogrammet-operation"];
  if (!isJsonObject(extension)) {
    const provenance = operation["x-vektorprogrammet-provenance"];
    const sourceRefs =
      isJsonObject(provenance) && typeof provenance.contract === "string"
        ? [provenance.contract]
        : [];
    return emptySourceMetadata(sourceRefs);
  }
  const refs = Array.isArray(extension.source_ref_ids)
    ? extension.source_ref_ids.filter((item): item is string => typeof item === "string")
    : [];
  const groups = Array.isArray(extension.validation_groups)
    ? extension.validation_groups.filter((item): item is string => typeof item === "string")
    : [];
  return {
    resource_class_ref: nullableString(extension.resource_class_ref),
    operation_name: nullableString(extension.operation_name),
    security_expression: nullableString(extension.security_expression),
    security_post_denormalize: nullableString(extension.security_post_denormalize),
    status: nullableInteger(extension.status),
    input_ref: nullableString(extension.input_ref),
    output_ref: nullableString(extension.output_ref),
    provider_ref: nullableString(extension.provider_ref),
    processor_ref: nullableString(extension.processor_ref),
    read: nullableBoolean(extension.read),
    deserialize: nullableBoolean(extension.deserialize),
    validate: nullableBoolean(extension.validate),
    output: nullableBoolean(extension.output),
    validation_groups: sortUnique(groups),
    source_ref_ids: sortUnique(refs),
  };
};

const effectsFromExtension = (
  operation: Record<string, unknown>,
  sourceMetadata: LegacyOperationMetadata,
): AtomicOperation["effects"] => {
  const extension = operation["x-vektorprogrammet-operation"];
  if (isJsonObject(extension) && isJsonObject(extension.effects)) {
    const completeness = extension.effects.completeness;
    const requests = extension.effects.requests;
    if (
      (completeness === "declared_subset" ||
        completeness === "complete" ||
        completeness === "unknown") &&
      Array.isArray(requests)
    ) {
      const normalized = requests.flatMap((request) => {
        if (
          !isJsonObject(request) ||
          typeof request.effect_ref_id !== "string" ||
          typeof request.kind !== "string"
        )
          return [];
        const refs = Array.isArray(request.source_ref_ids)
          ? request.source_ref_ids.filter((item): item is string => typeof item === "string")
          : sourceMetadata.source_ref_ids;
        if (refs.length === 0) return [];
        return [
          {
            effect_ref_id: request.effect_ref_id,
            kind: request.kind,
            claim_kind: "source_declaration" as const,
            source_ref_ids: sortUnique(refs),
          },
        ];
      });
      return {
        completeness,
        requests: normalized.sort((left, right) =>
          compareByteOrder(left.effect_ref_id, right.effect_ref_id),
        ),
      };
    }
  }
  return { completeness: "unknown", requests: [] };
};

const operationDescriptor = (operation: Omit<AtomicOperation, "provenance">): unknown => operation;

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export const extractAtomicOperationCatalog = (input: {
  readonly backend: Backend;
  readonly openapiBytes: string;
  readonly generatorRef: string;
  readonly sourceRevisionRef: string;
}): AtomicOperationCatalog => {
  const document: unknown = JSON.parse(input.openapiBytes);
  if (
    !isJsonObject(document) ||
    typeof document.openapi !== "string" ||
    !isJsonObject(document.paths)
  )
    throw new Error("OPENAPI_DOCUMENT_INVALID");
  const openapiSha256 = sha256(input.openapiBytes);
  const seenIds = new Set<string>();
  const operations: AtomicOperation[] = [];
  for (const pathTemplate of Object.keys(document.paths).sort(compareByteOrder)) {
    const pathItem = document.paths[pathTemplate];
    if (!isJsonObject(pathItem)) throw new Error(`OPENAPI_PATH_ITEM_INVALID:${pathTemplate}`);
    for (const method of Object.keys(pathItem).sort(compareByteOrder)) {
      if (!HTTP_METHODS.has(method)) continue;
      const rawOperation = pathItem[method];
      if (!isJsonObject(rawOperation))
        throw new Error(`OPENAPI_OPERATION_INVALID:${method.toUpperCase()} ${pathTemplate}`);
      if (typeof rawOperation.operationId !== "string" || rawOperation.operationId.length === 0)
        throw new Error(`MISSING_OPERATION_ID:${method.toUpperCase()} ${pathTemplate}`);
      if (seenIds.has(rawOperation.operationId))
        throw new Error(`DUPLICATE_OPERATION_ID:${rawOperation.operationId}`);
      seenIds.add(rawOperation.operationId);
      const operationRefId = `operation://${input.backend}/${rawOperation.operationId}`;
      const pointer = `#/paths/${pointerEscape(pathTemplate)}/${method}`;
      const sourceMetadata = sourceMetadataFromExtension(rawOperation);
      const partial: Omit<AtomicOperation, "provenance"> = {
        operation_ref_id: operationRefId,
        operation_id: rawOperation.operationId,
        method: method.toUpperCase(),
        path_template: pathTemplate,
        security: effectiveSecurity(document, rawOperation),
        inputs: collectInputs(document, pathItem, rawOperation, pointer),
        responses: collectResponses(document, rawOperation, pointer),
        effects: effectsFromExtension(rawOperation, sourceMetadata),
        source_metadata: sourceMetadata,
      };
      operations.push({
        ...partial,
        provenance: {
          openapi_document_sha256: openapiSha256,
          canonical_operation_sha256: sha256(canonicalJson(operationDescriptor(partial))),
          json_pointer: pointer,
          source_ref_ids: sourceMetadata.source_ref_ids,
          generator_ref: input.generatorRef,
        },
      });
    }
  }
  const catalog: AtomicOperationCatalog = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "backend-atomic-operation-catalog/v1",
    backend: input.backend,
    openapi_sha256: openapiSha256,
    generator_ref: input.generatorRef,
    source_revision_ref: input.sourceRevisionRef,
    operations: operations.sort((left, right) =>
      compareByteOrder(left.operation_ref_id, right.operation_ref_id),
    ),
    diagnostics: [],
  };
  if (!validateAtomicOperationCatalog(catalog)) throw new Error("ATOMIC_CATALOG_SCHEMA_INVALID");
  return catalog;
};

const normalizedLegacyPath = (value: string): string => {
  const withoutFormat = value.replace(/\{\._format\}$/u, "");
  const withSlash = withoutFormat.startsWith("/") ? withoutFormat : `/${withoutFormat}`;
  return withSlash === "/api" || withSlash.startsWith("/api/") ? withSlash : `/api${withSlash}`;
};

const normalizedSecurityArray = (value: unknown): string => canonicalJson(value);

const metadataExtension = (metadata: LegacyMetadataRecord): Record<string, unknown> => {
  const requests =
    metadata.processor_ref === null || metadata.source_ref_ids.length === 0
      ? []
      : [
          {
            effect_ref_id: `processor:${metadata.processor_ref}`,
            kind: "processor",
            claim_kind: "source_declaration",
            source_ref_ids: sortUnique(metadata.source_ref_ids),
          },
        ];
  return {
    resource_class_ref: metadata.resource_class_ref,
    operation_name: metadata.operation_name,
    security_expression: metadata.security_expression,
    security_post_denormalize: metadata.security_post_denormalize,
    status: metadata.status,
    input_ref: metadata.input_ref,
    output_ref: metadata.output_ref,
    provider_ref: metadata.provider_ref,
    processor_ref: metadata.processor_ref,
    read: metadata.read,
    deserialize: metadata.deserialize,
    validate: metadata.validate,
    output: metadata.output,
    validation_groups: sortUnique(metadata.validation_groups),
    source_ref_ids: sortUnique(metadata.source_ref_ids),
    effects: {
      completeness: requests.length === 0 ? "unknown" : "declared_subset",
      requests,
    },
  };
};

export const enrichLegacyOpenApi = (
  openapi: unknown,
  metadataRecords: readonly LegacyMetadataRecord[],
): Record<string, unknown> => {
  if (!isJsonObject(openapi) || !isJsonObject(openapi.paths))
    throw new Error("OPENAPI_DOCUMENT_INVALID");
  const output = structuredClone(openapi);
  if (!isJsonObject(output.paths)) throw new Error("OPENAPI_DOCUMENT_INVALID");
  const locations: {
    readonly path: string;
    readonly method: string;
    readonly operationId: string;
    readonly operation: Record<string, unknown>;
  }[] = [];
  for (const [path, rawPathItem] of Object.entries(output.paths)) {
    if (!isJsonObject(rawPathItem)) continue;
    for (const [method, rawOperation] of Object.entries(rawPathItem)) {
      if (
        !HTTP_METHODS.has(method) ||
        !isJsonObject(rawOperation) ||
        typeof rawOperation.operationId !== "string"
      )
        continue;
      locations.push({
        path,
        method: method.toUpperCase(),
        operationId: rawOperation.operationId,
        operation: rawOperation,
      });
    }
  }

  const usedMetadata = new Set<number>();
  for (const location of locations.sort((left, right) =>
    compareByteOrder(`${left.path}:${left.method}`, `${right.path}:${right.method}`),
  )) {
    const candidates = metadataRecords
      .map((metadata, index) => ({ metadata, index }))
      .filter(
        ({ metadata }) =>
          metadata.method?.toUpperCase() === location.method &&
          metadata.uri_template !== null &&
          normalizedLegacyPath(metadata.uri_template) === location.path,
      );
    const exact = candidates.filter(
      ({ metadata }) => metadata.operation_id === location.operationId,
    );
    const selected = exact.length === 1 ? exact : candidates;
    if (selected.length !== 1)
      throw new Error(
        `${selected.length === 0 ? "MISSING" : "AMBIGUOUS"}_METADATA_MAPPING:${location.method} ${location.path}`,
      );
    const selectedMetadata = selected[0];
    if (selectedMetadata === undefined)
      throw new Error(`MISSING_METADATA_MAPPING:${location.method} ${location.path}`);
    const { metadata, index } = selectedMetadata;
    if (usedMetadata.has(index))
      throw new Error(`AMBIGUOUS_METADATA_MAPPING:${location.method} ${location.path}`);
    usedMetadata.add(index);

    const declaredSecurity =
      metadata.security_expression === null
        ? null
        : metadata.security_expression === "PUBLIC_ACCESS"
          ? []
          : [{ JWT: [] }];
    if (hasOwn(location.operation, "security") && declaredSecurity !== null) {
      if (
        normalizedSecurityArray(location.operation.security) !==
        normalizedSecurityArray(declaredSecurity)
      )
        throw new Error(`SECURITY_METADATA_CONFLICT:${location.operationId}`);
    }
    if (declaredSecurity !== null) location.operation.security = declaredSecurity;
    location.operation["x-vektorprogrammet-operation"] = metadataExtension(metadata);
  }
  return output;
};

const sortedCopy = (value: unknown): unknown => JSON.parse(canonicalJson(value));

const migrationCodes: readonly MigrationDiagnostic["code"][] = [
  "MISSING_PRECONDITION_ASSERTION",
  "MISSING_OUTCOME_ASSERTION",
  "MISSING_REJECTION_ASSERTION",
  "MISSING_EFFECT_ASSERTION",
  "MISSING_FRESHNESS_ASSERTION",
  "MISSING_WITNESS_BINDING",
  "MISSING_CLAIM_SPECIFIC_EVIDENCE",
];

export const migrateAcceptedIntentV1 = (
  value: unknown,
  sourceAuthority: AuthorityPin,
): AcceptedIntentV2 => {
  if (
    !validateIntentV1(value) ||
    !isJsonObject(value) ||
    !Array.isArray(value.intents) ||
    !Array.isArray(value.journeys)
  )
    throw new Error("ACCEPTED_INTENT_V1_SCHEMA_INVALID");
  const sourceV1Intents = value.intents.map((raw) => {
    if (!isJsonObject(raw)) throw new Error("ACCEPTED_INTENT_V1_RECORD_INVALID");
    return sortedCopy({
      intent_ref_id: raw.intent_ref_id,
      intent_revision: raw.intent_revision,
      source_ref_ids: raw.source_ref_ids,
      purpose: raw.purpose,
      disposition: raw.disposition,
      row_ids: raw.row_ids,
      canonical_signatures: raw.canonical_signatures,
      inventory_kinds: raw.inventory_kinds,
      journey_ref_ids: raw.journey_ref_ids,
      selected_revision_ref_ids: raw.selected_revision_ref_ids,
    }) as Record<string, unknown>;
  });
  const diagnostics: MigrationDiagnostic[] = [];
  const intents = value.journeys.map((raw): CapabilityIntent => {
    if (
      !isJsonObject(raw) ||
      typeof raw.journey_ref_id !== "string" ||
      typeof raw.journey_revision !== "string" ||
      !Array.isArray(raw.steps)
    )
      throw new Error("ACCEPTED_JOURNEY_V1_RECORD_INVALID");
    const steps = raw.steps.map((step) => {
      if (!isJsonObject(step) || typeof step.step_id !== "string")
        throw new Error("ACCEPTED_JOURNEY_V1_STEP_INVALID");
      diagnostics.push({
        code: "MISSING_WITNESS_BINDING",
        intent_ref_id: raw.journey_ref_id as string,
        step_id: step.step_id,
        detail: "The v1 step has no reviewed backend operation graph.",
      });
      diagnostics.push({
        code: "MISSING_CLAIM_SPECIFIC_EVIDENCE",
        intent_ref_id: raw.journey_ref_id as string,
        step_id: step.step_id,
        detail: "The v1 receipt reference establishes journey execution only.",
      });
      return sortedCopy({
        step_id: step.step_id,
        surface: step.surface,
        row_ids: step.row_ids,
        canonical_signatures: step.canonical_signatures,
        expected_contract_ref: step.expected_contract_ref,
        runtime_evidence_ref_ids: step.runtime_evidence_ref_ids,
      }) as Record<string, unknown>;
    });
    for (const code of migrationCodes.slice(0, 5)) {
      diagnostics.push({
        code,
        intent_ref_id: raw.journey_ref_id,
        step_id: null,
        detail: `The v1 journey does not define ${code.toLowerCase().replaceAll("_", " ")}.`,
      });
    }
    const withoutDigest = {
      intent_ref_id: raw.journey_ref_id,
      intent_revision: raw.journey_revision,
      source_ref_ids: Array.isArray(raw.source_ref_ids)
        ? sortUnique(raw.source_ref_ids.filter((item): item is string => typeof item === "string"))
        : [],
      source_v1_selection: {
        journey_key: raw.journey_key,
        coverage_scope: raw.coverage_scope,
        selected_revision_ref_ids: raw.selected_revision_ref_ids,
        steps,
      },
      semantic_stages: [],
      required_preconditions: [],
      warranted_outcomes: [],
      side_effects: [],
      rejections: [],
      freshness: [],
      implementations: [
        {
          backend: "legacy_symfony" as const,
          claim: "unknown" as const,
          reason_code: "MISSING_SEMANTIC_ASSERTION",
          witnesses: [],
        },
        {
          backend: "native_effect" as const,
          claim: "unknown" as const,
          reason_code: "MISSING_SEMANTIC_ASSERTION",
          witnesses: [],
        },
      ],
    };
    return { ...withoutDigest, intent_digest: sha256(canonicalJson(withoutDigest)) };
  });
  const migrated: AcceptedIntentV2 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-accepted-intent/v2",
    source_authority: sourceAuthority,
    source_v1_intents: sourceV1Intents.sort((left, right) =>
      compareByteOrder(String(left.intent_ref_id), String(right.intent_ref_id)),
    ),
    predicates: [],
    projections: [],
    intents: intents.sort((left, right) =>
      compareByteOrder(left.intent_ref_id, right.intent_ref_id),
    ),
    migration_diagnostics: diagnostics.sort((left, right) =>
      compareByteOrder(
        `${left.intent_ref_id}:${left.step_id ?? ""}:${left.code}`,
        `${right.intent_ref_id}:${right.step_id ?? ""}:${right.code}`,
      ),
    ),
  };
  if (!validateAcceptedIntentV2(migrated)) throw new Error("ACCEPTED_INTENT_V2_SCHEMA_INVALID");
  return migrated;
};

export interface MigratedV1Evidence {
  readonly receipt_ref_id: string;
  readonly journey_ref_id: string;
  readonly kind: "journey_executed";
  readonly artifact_digest: string;
  readonly runner_source_ref_ids: readonly string[];
}

export const migrateRuntimeEvidenceV1 = (value: unknown): readonly MigratedV1Evidence[] => {
  if (!validateEvidenceV1(value) || !isJsonObject(value) || !Array.isArray(value.receipts))
    throw new Error("RUNTIME_EVIDENCE_V1_SCHEMA_INVALID");
  return value.receipts
    .map((raw) => {
      if (
        !isJsonObject(raw) ||
        typeof raw.receipt_ref_id !== "string" ||
        typeof raw.journey_ref_id !== "string" ||
        typeof raw.artifact_digest !== "string"
      )
        throw new Error("RUNTIME_EVIDENCE_V1_RECEIPT_INVALID");
      return {
        receipt_ref_id: raw.receipt_ref_id,
        journey_ref_id: raw.journey_ref_id,
        kind: "journey_executed" as const,
        artifact_digest: raw.artifact_digest,
        runner_source_ref_ids: Array.isArray(raw.runner_source_ref_ids)
          ? sortUnique(
              raw.runner_source_ref_ids.filter((item): item is string => typeof item === "string"),
            )
          : [],
      };
    })
    .sort((left, right) => compareByteOrder(left.receipt_ref_id, right.receipt_ref_id));
};

const duplicateValues = (values: readonly string[]): readonly string[] =>
  sortUnique(values.filter((value, index) => values.indexOf(value) !== index));

const cycleMembers = (graph: ReadonlyMap<string, readonly string[]>): readonly string[] => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      cycles.add(node);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return [...cycles].sort(compareByteOrder);
};

export const predicateImplies = (
  predicates: readonly PredicateDefinition[],
  supplied: string,
  required: string,
): boolean => {
  if (supplied === required) return true;
  const byId = new Map(
    predicates.map((predicate) => [predicate.predicate_ref, predicate] as const),
  );
  const seen = new Set<string>();
  const visit = (current: string): boolean => {
    if (current === required) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return (byId.get(current)?.implies ?? []).some(visit);
  };
  return visit(supplied);
};

const diagnostic = (
  code: CapabilityDiagnosticCode,
  backend: Backend | null,
  intentRefId: string | null,
  claimKind: string | null,
  detail: string,
): CapabilityDiagnostic => ({
  code,
  backend,
  intent_ref_id: intentRefId,
  claim_kind: claimKind,
  detail,
});

const diagnosticSort = (left: CapabilityDiagnostic, right: CapabilityDiagnostic): number =>
  compareByteOrder(
    `${left.backend ?? ""}:${left.intent_ref_id ?? ""}:${left.code}:${left.claim_kind ?? ""}:${left.detail}`,
    `${right.backend ?? ""}:${right.intent_ref_id ?? ""}:${right.code}:${right.claim_kind ?? ""}:${right.detail}`,
  );

export const validateIntentGraph = (
  register: Pick<AcceptedIntentV2, "predicates" | "projections">,
  intent: CapabilityIntent,
  implementation: ImplementationDefinition,
  catalog: AtomicOperationCatalog,
): readonly CapabilityDiagnostic[] => {
  const diagnostics: CapabilityDiagnostic[] = [];
  const backend = implementation.backend;
  const predicateIds = register.predicates.map((item) => item.predicate_ref);
  const projectionIds = new Set(register.projections.map((item) => item.projection_ref));
  const stageIds = new Set(intent.semantic_stages.map((item) => item.stage_id));
  const preconditions = new Map(
    intent.required_preconditions.map((item) => [item.precondition_id, item] as const),
  );
  const assertionIds = new Set(intent.warranted_outcomes.map((item) => item.assertion_id));
  const effectIds = new Set(intent.side_effects.map((item) => item.effect_id));
  const rejectionIds = new Set(intent.rejections.map((item) => item.rejection_id));
  const freshnessIds = new Set(intent.freshness.map((item) => item.freshness_id));
  const catalogByRef = new Map(
    catalog.operations.map((operation) => [operation.operation_ref_id, operation] as const),
  );

  if (duplicateValues(predicateIds).length > 0)
    diagnostics.push(
      diagnostic(
        "UNKNOWN",
        backend,
        intent.intent_ref_id,
        "predicate",
        "The predicate register contains duplicate identifiers.",
      ),
    );
  const identifierFamilies: readonly [string, readonly string[]][] = [
    ["projection", register.projections.map((item) => item.projection_ref)],
    ["stage", intent.semantic_stages.map((item) => item.stage_id)],
    ["precondition", intent.required_preconditions.map((item) => item.precondition_id)],
    ["assertion", intent.warranted_outcomes.map((item) => item.assertion_id)],
    ["effect", intent.side_effects.map((item) => item.effect_id)],
    ["rejection", intent.rejections.map((item) => item.rejection_id)],
    ["freshness", intent.freshness.map((item) => item.freshness_id)],
    ["witness", implementation.witnesses.map((item) => item.witness_id)],
  ];
  for (const [kind, identifiers] of identifierFamilies)
    if (duplicateValues(identifiers).length > 0)
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          kind,
          `The intent contains duplicate ${kind} identifiers.`,
        ),
      );
  const predicateGraph = new Map(
    register.predicates.map((item) => [item.predicate_ref, item.implies] as const),
  );
  if (cycleMembers(predicateGraph).length > 0)
    diagnostics.push(
      diagnostic(
        "UNKNOWN",
        backend,
        intent.intent_ref_id,
        "predicate",
        "The predicate implication graph contains a cycle.",
      ),
    );
  for (const predicate of register.predicates)
    for (const target of predicate.implies)
      if (!predicateGraph.has(target))
        diagnostics.push(
          diagnostic(
            "UNKNOWN",
            backend,
            intent.intent_ref_id,
            "predicate",
            `Predicate ${predicate.predicate_ref} implies unknown predicate ${target}.`,
          ),
        );

  if (implementation.witnesses.length === 0) {
    diagnostics.push(
      diagnostic(
        "MISSING_WITNESS",
        backend,
        intent.intent_ref_id,
        null,
        "The backend has no finite implementation witness.",
      ),
    );
    return diagnostics;
  }

  for (const witness of implementation.witnesses) {
    const nodeIds = witness.nodes.map((node) => node.node_id);
    const edgeIds = witness.edges.map((edge) => edge.edge_id);
    if (duplicateValues(nodeIds).length > 0)
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          "graph",
          `Witness ${witness.witness_id} has duplicate node identifiers.`,
        ),
      );
    if (duplicateValues(edgeIds).length > 0)
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          "graph",
          `Witness ${witness.witness_id} has duplicate edge identifiers.`,
        ),
      );
    const nodes = new Set(nodeIds);
    const fullGraph = new Map<string, string[]>(nodeIds.map((nodeId) => [nodeId, []]));
    for (const edge of witness.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to))
        diagnostics.push(
          diagnostic(
            "UNKNOWN",
            backend,
            intent.intent_ref_id,
            "graph",
            `Edge ${edge.edge_id} has a dangling endpoint.`,
          ),
        );
      fullGraph.get(edge.from)?.push(edge.to);
      if (edge.kind === "data" && !projectionIds.has(edge.transform_ref))
        diagnostics.push(
          diagnostic(
            "UNKNOWN",
            backend,
            intent.intent_ref_id,
            "projection",
            `Edge ${edge.edge_id} references unknown transform ${edge.transform_ref}.`,
          ),
        );
      if (edge.kind === "authority" && !preconditions.has(edge.precondition_id))
        diagnostics.push(
          diagnostic(
            "WEAKER_PRECONDITION",
            backend,
            intent.intent_ref_id,
            "precondition",
            `Edge ${edge.edge_id} references unknown precondition ${edge.precondition_id}.`,
          ),
        );
    }
    if (cycleMembers(fullGraph).length > 0)
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          "graph",
          `Witness ${witness.witness_id} contains a cycle.`,
        ),
      );
    const terminalIds = new Set(
      [...fullGraph.entries()]
        .filter(([, targets]) => targets.length === 0)
        .map(([nodeId]) => nodeId),
    );
    if (terminalIds.size === 0)
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          "graph",
          `Witness ${witness.witness_id} has no terminal node.`,
        ),
      );
    else if (
      witness.purpose === "accepted" &&
      !witness.nodes.some(
        (node) => node.kind === "local_observation" && terminalIds.has(node.node_id),
      )
    )
      diagnostics.push(
        diagnostic(
          "UNKNOWN",
          backend,
          intent.intent_ref_id,
          "graph",
          `Witness ${witness.witness_id} has no terminal observation.`,
        ),
      );

    for (const node of witness.nodes) {
      if (node.kind === "operation") {
        const operation = catalogByRef.get(node.operation_ref_id);
        if (operation === undefined)
          diagnostics.push(
            diagnostic(
              "UNKNOWN_OPERATION",
              backend,
              intent.intent_ref_id,
              "operation_observed",
              `Node ${node.node_id} references unknown operation ${node.operation_ref_id}.`,
            ),
          );
        else if (operation.provenance.canonical_operation_sha256 !== node.expected_operation_sha256)
          diagnostics.push(
            diagnostic(
              "OPERATION_DRIFT",
              backend,
              intent.intent_ref_id,
              "operation_observed",
              `Node ${node.node_id} operation digest is stale.`,
            ),
          );
        for (const stageId of node.realizes_stage_ids)
          if (!stageIds.has(stageId))
            diagnostics.push(
              diagnostic(
                "UNKNOWN",
                backend,
                intent.intent_ref_id,
                "stage",
                `Node ${node.node_id} references unknown stage ${stageId}.`,
              ),
            );
        for (const predicateRef of node.predicate_refs)
          if (!predicateGraph.has(predicateRef))
            diagnostics.push(
              diagnostic(
                "WEAKER_PRECONDITION",
                backend,
                intent.intent_ref_id,
                "precondition",
                `Node ${node.node_id} references unknown predicate ${predicateRef}.`,
              ),
            );
      } else {
        for (const assertionId of node.assertion_ids)
          if (!assertionIds.has(assertionId))
            diagnostics.push(
              diagnostic(
                "MISSING_OUTCOME",
                backend,
                intent.intent_ref_id,
                "boundary_observation",
                `Node ${node.node_id} references unknown assertion ${assertionId}.`,
              ),
            );
      }
    }

    const satisfactionSets: readonly [
      readonly string[],
      ReadonlySet<string>,
      CapabilityDiagnosticCode,
      string,
    ][] = [
      [
        witness.satisfies.precondition_ids,
        new Set(preconditions.keys()),
        "WEAKER_PRECONDITION",
        "precondition",
      ],
      [witness.satisfies.assertion_ids, assertionIds, "MISSING_OUTCOME", "assertion"],
      [witness.satisfies.effect_ids, effectIds, "EFFECT_MISMATCH", "effect"],
      [witness.satisfies.rejection_ids, rejectionIds, "WEAKER_REJECTION", "rejection"],
      [witness.satisfies.freshness_ids, freshnessIds, "READ_AFTER_WRITE_MISSING", "freshness"],
    ];
    for (const [values, allowed, code, kind] of satisfactionSets)
      for (const id of values)
        if (!allowed.has(id))
          diagnostics.push(
            diagnostic(
              code,
              backend,
              intent.intent_ref_id,
              kind,
              `Witness ${witness.witness_id} satisfies unknown ${kind} ${id}.`,
            ),
          );
  }

  const allNodes = implementation.witnesses.flatMap((witness) => witness.nodes);
  for (const precondition of intent.required_preconditions) {
    const satisfied = allNodes.some(
      (node) =>
        node.kind === "operation" &&
        node.predicate_refs.some((predicateRef) =>
          predicateImplies(register.predicates, predicateRef, precondition.predicate_ref),
        ),
    );
    if (!satisfied)
      diagnostics.push(
        diagnostic(
          "WEAKER_PRECONDITION",
          backend,
          intent.intent_ref_id,
          "precondition",
          `No witness predicate implies ${precondition.predicate_ref}.`,
        ),
      );
  }

  return diagnostics.sort(diagnosticSort);
};

const unionSatisfied = (
  implementation: ImplementationDefinition,
  key: keyof ImplementationWitness["satisfies"],
): Set<string> => new Set(implementation.witnesses.flatMap((witness) => witness.satisfies[key]));

const implementationDigest = (implementation: ImplementationDefinition): string =>
  sha256(canonicalJson(implementation));

const requiredEvidenceKinds = (
  intent: CapabilityIntent,
  implementation: ImplementationDefinition,
): readonly string[] => {
  const kinds = new Set<string>();
  if (
    implementation.witnesses.some((witness) =>
      witness.nodes.some((node) => node.kind === "operation"),
    )
  )
    kinds.add("operation_observed");
  if (intent.required_preconditions.length > 0) kinds.add("authorization_observed");
  if (intent.warranted_outcomes.length > 0) kinds.add("boundary_observation");
  if (intent.rejections.length > 0) kinds.add("rejection_observed");
  for (const effect of intent.side_effects) {
    if (effect.required_claim === "delivered") kinds.add("effect_delivered");
    else if (effect.required_claim === "persisted_outbox") kinds.add("persistence_observed");
    else kinds.add("effect_requested");
  }
  if (intent.freshness.length > 0) kinds.add("fresh_read_observed");
  return [...kinds].sort(compareByteOrder);
};

const claimWarrants = (
  claim: CapabilityEvidenceClaim,
  kind: string,
  semanticId: string | null,
): boolean => {
  if (claim.kind !== kind) return false;
  if (semanticId === null) return true;
  if (kind === "authorization_observed") return claim.precondition_id === semanticId;
  if (kind === "boundary_observation" || kind === "persistence_observed")
    return claim.assertion_id === semanticId || claim.effect_id === semanticId;
  if (kind === "rejection_observed") return claim.rejection_id === semanticId;
  if (kind === "effect_requested" || kind === "effect_delivered")
    return claim.effect_id === semanticId;
  if (kind === "fresh_read_observed") return claim.freshness_id === semanticId;
  return true;
};

const claimIsInWitnessScope = (
  claim: CapabilityEvidenceClaim,
  implementation: ImplementationDefinition,
): boolean => {
  if (claim.kind === "journey_executed") return true;
  if (claim.witness_id === null) return false;
  const witness = implementation.witnesses.find((item) => item.witness_id === claim.witness_id);
  if (witness === undefined) return false;
  if (claim.node_id !== null && !witness.nodes.some((node) => node.node_id === claim.node_id))
    return false;
  if (
    claim.precondition_id !== null &&
    !witness.satisfies.precondition_ids.includes(claim.precondition_id)
  )
    return false;
  if (claim.assertion_id !== null && !witness.satisfies.assertion_ids.includes(claim.assertion_id))
    return false;
  if (claim.effect_id !== null && !witness.satisfies.effect_ids.includes(claim.effect_id))
    return false;
  if (claim.rejection_id !== null && !witness.satisfies.rejection_ids.includes(claim.rejection_id))
    return false;
  if (claim.freshness_id !== null && !witness.satisfies.freshness_ids.includes(claim.freshness_id))
    return false;
  switch (claim.kind) {
    case "operation_observed":
      return (
        claim.node_id !== null &&
        witness.nodes.some((node) => node.kind === "operation" && node.node_id === claim.node_id)
      );
    case "authorization_observed":
      return claim.precondition_id !== null;
    case "boundary_observation":
      return claim.assertion_id !== null;
    case "rejection_observed":
    case "transaction_rollback_observed":
      return claim.rejection_id !== null;
    case "effect_requested":
    case "effect_delivered":
      return claim.effect_id !== null;
    case "persistence_observed":
      return claim.assertion_id !== null || claim.effect_id !== null;
    case "fresh_read_observed":
      return claim.freshness_id !== null;
  }
};

const evidenceForImplementation = (
  intent: CapabilityIntent,
  implementation: ImplementationDefinition,
  catalog: AtomicOperationCatalog,
  evidence: CapabilityEvidenceV2 | null,
): {
  readonly status: BackendComparisonResult["evidence_status"];
  readonly missing: readonly string[];
  readonly diagnostics: readonly CapabilityDiagnostic[];
} => {
  const backend = implementation.backend;
  const requiredKinds = requiredEvidenceKinds(intent, implementation);
  const v1MissingKinds =
    requiredKinds.length === 0
      ? [
          "authorization_observed",
          "boundary_observation",
          "effect_requested",
          "fresh_read_observed",
          "persistence_observed",
          "rejection_observed",
        ]
      : requiredKinds;
  if (evidence === null) {
    return {
      status: "stale",
      missing: v1MissingKinds,
      diagnostics: [
        diagnostic(
          "RECEIPT_STALE",
          backend,
          intent.intent_ref_id,
          null,
          "The supplied authority contains v1 journey receipts only.",
        ),
      ],
    };
  }
  const expectedImplementationDigest = implementationDigest(implementation);
  const operationByRef = new Map(
    catalog.operations.map((operation) => [operation.operation_ref_id, operation] as const),
  );
  const expectedOperationDigests = sortUnique(
    implementation.witnesses.flatMap((witness) =>
      witness.nodes.flatMap((node) => {
        if (node.kind !== "operation") return [];
        const operation = operationByRef.get(node.operation_ref_id);
        return operation === undefined ? [] : [operation.provenance.canonical_operation_sha256];
      }),
    ),
  );
  const receipts = evidence.receipts.filter(
    (receipt) =>
      receipt.backend === backend &&
      receipt.intent_ref_id === intent.intent_ref_id &&
      receipt.intent_revision === intent.intent_revision,
  );
  const current = receipts.filter(
    (receipt) =>
      receipt.result === "passed" &&
      receipt.exit_code === 0 &&
      receipt.implementation_digest === expectedImplementationDigest &&
      receipt.backend_revision_ref === catalog.source_revision_ref &&
      receipt.openapi_sha256 === catalog.openapi_sha256 &&
      canonicalJson(sortUnique(receipt.operation_sha256)) ===
        canonicalJson(expectedOperationDigests),
  );
  if (current.length === 0) {
    return {
      status: receipts.length === 0 ? "missing" : "stale",
      missing: requiredKinds,
      diagnostics: [
        diagnostic(
          receipts.length === 0 ? "MISSING_CLAIM_SPECIFIC_EVIDENCE" : "RECEIPT_STALE",
          backend,
          intent.intent_ref_id,
          null,
          receipts.length === 0
            ? "No backend-specific v2 receipt exists."
            : "The backend-specific v2 receipt has stale provenance.",
        ),
      ],
    };
  }
  const scopeDiagnostics: CapabilityDiagnostic[] = [];
  const claims = current.flatMap((receipt) =>
    receipt.claims.filter((claim) => {
      if (claimIsInWitnessScope(claim, implementation)) return true;
      scopeDiagnostics.push(
        diagnostic(
          "CLAIM_SCOPE_INVALID",
          backend,
          intent.intent_ref_id,
          claim.kind,
          `Claim ${claim.claim_id} references an identifier outside its implementation witness.`,
        ),
      );
      return false;
    }),
  );
  const missing = new Set<string>();
  for (const witness of implementation.witnesses)
    for (const node of witness.nodes)
      if (
        node.kind === "operation" &&
        !claims.some(
          (claim) => claim.kind === "operation_observed" && claim.node_id === node.node_id,
        )
      )
        missing.add("operation_observed");
  for (const precondition of intent.required_preconditions)
    if (
      !claims.some((claim) =>
        claimWarrants(claim, "authorization_observed", precondition.precondition_id),
      )
    )
      missing.add("authorization_observed");
  for (const outcome of intent.warranted_outcomes)
    if (!claims.some((claim) => claimWarrants(claim, "boundary_observation", outcome.assertion_id)))
      missing.add("boundary_observation");
  for (const rejection of intent.rejections)
    if (!claims.some((claim) => claimWarrants(claim, "rejection_observed", rejection.rejection_id)))
      missing.add("rejection_observed");
  for (const effect of intent.side_effects) {
    const kind =
      effect.required_claim === "delivered"
        ? "effect_delivered"
        : effect.required_claim === "persisted_outbox"
          ? "persistence_observed"
          : "effect_requested";
    if (!claims.some((claim) => claimWarrants(claim, kind, effect.effect_id))) missing.add(kind);
  }
  for (const freshness of intent.freshness)
    if (
      !claims.some((claim) => claimWarrants(claim, "fresh_read_observed", freshness.freshness_id))
    )
      missing.add("fresh_read_observed");
  const missingKinds = [...missing].sort(compareByteOrder);
  return {
    status: missingKinds.length === 0 && scopeDiagnostics.length === 0 ? "current" : "missing",
    missing: missingKinds,
    diagnostics: [
      ...scopeDiagnostics,
      ...missingKinds.map((kind) =>
        diagnostic(
          kind === "authorization_observed"
            ? "AUTHORIZATION_UNWARRANTED"
            : kind === "effect_requested" || kind === "effect_delivered"
              ? "EFFECT_CLAIM_UNWARRANTED"
              : kind === "fresh_read_observed"
                ? "FRESHNESS_UNWARRANTED"
                : "MISSING_CLAIM_SPECIFIC_EVIDENCE",
          backend,
          intent.intent_ref_id,
          kind,
          `No current claim warrants ${kind}.`,
        ),
      ),
    ].sort(diagnosticSort),
  };
};

const missingSemanticDiagnostics = (
  intent: CapabilityIntent,
  backend: Backend,
): readonly CapabilityDiagnostic[] => {
  const diagnostics: CapabilityDiagnostic[] = [];
  const missing: readonly [readonly unknown[], string][] = [
    [intent.semantic_stages, "semantic stages"],
    [intent.required_preconditions, "preconditions"],
    [intent.warranted_outcomes, "warranted outcomes"],
    [intent.rejections, "rejections"],
    [intent.side_effects, "side effects"],
    [intent.freshness, "freshness requirements"],
  ];
  for (const [values, label] of missing)
    if (values.length === 0)
      diagnostics.push(
        diagnostic(
          "MISSING_SEMANTIC_ASSERTION",
          backend,
          intent.intent_ref_id,
          label,
          `The accepted intent does not define ${label}.`,
        ),
      );
  return diagnostics;
};

export const compareCapabilityIntent = (
  register: AcceptedIntentV2,
  intent: CapabilityIntent,
  legacyCatalog: AtomicOperationCatalog,
  nativeCatalog: AtomicOperationCatalog,
  evidence: CapabilityEvidenceV2 | null,
): CapabilityReportRow => {
  const evaluate = (backend: Backend, catalog: AtomicOperationCatalog): BackendComparisonResult => {
    const implementation = intent.implementations.find((item) => item.backend === backend);
    if (implementation === undefined) {
      const item = diagnostic(
        "MISSING_WITNESS",
        backend,
        intent.intent_ref_id,
        null,
        "The intent has no backend implementation entry.",
      );
      return {
        claim: "unknown",
        witness_digest: null,
        evidence_status: "missing",
        missing_claim_kinds: [],
        diagnostics: [item],
      };
    }
    const graphDiagnostics = validateIntentGraph(register, intent, implementation, catalog);
    const semanticDiagnostics = missingSemanticDiagnostics(intent, backend);
    const satisfiedAssertions = unionSatisfied(implementation, "assertion_ids");
    const satisfiedRejections = unionSatisfied(implementation, "rejection_ids");
    const satisfiedEffects = unionSatisfied(implementation, "effect_ids");
    const satisfiedFreshness = unionSatisfied(implementation, "freshness_ids");
    const coverageDiagnostics: CapabilityDiagnostic[] = [];
    for (const outcome of intent.warranted_outcomes)
      if (!satisfiedAssertions.has(outcome.assertion_id))
        coverageDiagnostics.push(
          diagnostic(
            "MISSING_OUTCOME",
            backend,
            intent.intent_ref_id,
            "boundary_observation",
            `No witness satisfies assertion ${outcome.assertion_id}.`,
          ),
        );
    for (const rejection of intent.rejections)
      if (!satisfiedRejections.has(rejection.rejection_id))
        coverageDiagnostics.push(
          diagnostic(
            "MISSING_REJECTION",
            backend,
            intent.intent_ref_id,
            "rejection_observed",
            `No witness satisfies rejection ${rejection.rejection_id}.`,
          ),
        );
    for (const effect of intent.side_effects)
      if (!satisfiedEffects.has(effect.effect_id))
        coverageDiagnostics.push(
          diagnostic(
            "EFFECT_DECLARATION_MISSING",
            backend,
            intent.intent_ref_id,
            effect.required_claim,
            `No witness satisfies effect ${effect.effect_id}.`,
          ),
        );
    for (const freshness of intent.freshness)
      if (!satisfiedFreshness.has(freshness.freshness_id))
        coverageDiagnostics.push(
          diagnostic(
            "READ_AFTER_WRITE_MISSING",
            backend,
            intent.intent_ref_id,
            "fresh_read_observed",
            `No witness satisfies freshness ${freshness.freshness_id}.`,
          ),
        );

    const evidenceResult = evidenceForImplementation(intent, implementation, catalog, evidence);
    const allDiagnostics = [
      ...semanticDiagnostics,
      ...graphDiagnostics,
      ...coverageDiagnostics,
      ...evidenceResult.diagnostics,
    ].sort(diagnosticSort);
    const structuralMismatch = allDiagnostics.some(
      (item) =>
        item.code === "MISSING_OUTCOME" ||
        item.code === "MISSING_REJECTION" ||
        item.code === "WEAKER_REJECTION" ||
        item.code === "WEAKER_PRECONDITION" ||
        item.code === "EFFECT_DECLARATION_MISSING" ||
        item.code === "EFFECT_MISMATCH" ||
        item.code === "READ_AFTER_WRITE_MISSING" ||
        item.code === "UNKNOWN_OPERATION" ||
        item.code === "OPERATION_DRIFT",
    );
    const unknown =
      semanticDiagnostics.length > 0 ||
      evidenceResult.status !== "current" ||
      graphDiagnostics.some((item) => item.code === "UNKNOWN");
    const claim: CapabilityClaim =
      implementation.claim === "unsupported" || structuralMismatch
        ? "unsupported"
        : unknown || implementation.claim === "unknown"
          ? "unknown"
          : "supported";
    return {
      claim,
      witness_digest:
        implementation.witnesses.length === 0 ? null : implementationDigest(implementation),
      evidence_status:
        claim === "unsupported" && evidenceResult.status === "current"
          ? "unsupported"
          : evidenceResult.status,
      missing_claim_kinds: evidenceResult.missing,
      diagnostics: allDiagnostics,
    };
  };

  const legacy = evaluate("legacy_symfony", legacyCatalog);
  const native = evaluate("native_effect", nativeCatalog);
  const combinedDiagnostics = [...legacy.diagnostics, ...native.diagnostics].sort(diagnosticSort);
  const equivalence: CapabilityVerdict =
    legacy.claim === "supported" && native.claim === "supported"
      ? "equivalent"
      : legacy.claim === "unsupported" || native.claim === "unsupported"
        ? "not_equivalent"
        : "unknown";
  return {
    comparison_ref_id: intent.intent_ref_id,
    intent_ref_ids: [intent.intent_ref_id],
    intent_revision: intent.intent_revision,
    legacy,
    native,
    equivalence,
    diagnostics: combinedDiagnostics,
  };
};

const unknownBackendResult = (
  backend: Backend,
  intentRefs: readonly string[],
  code: CapabilityDiagnosticCode,
  detail: string,
): BackendComparisonResult => ({
  claim: "unknown",
  witness_digest: null,
  evidence_status: "stale",
  missing_claim_kinds: [
    "authorization_observed",
    "boundary_observation",
    "effect_requested",
    "fresh_read_observed",
    "persistence_observed",
    "rejection_observed",
  ],
  diagnostics: [diagnostic(code, backend, intentRefs[0] ?? null, null, detail)],
});

const tracerDefinitions = [
  {
    comparisonRefId: "intent://journey:parity:applicant_admission:v1",
    intentRefs: ["intent://journey:parity:applicant_admission:v1"],
  },
  {
    comparisonRefId: "intent://composition:recruitment:interview-scheduling-invitation-response:v1",
    intentRefs: [
      "intent://journey:recruitment:interview-scheduling:v1",
      "intent://journey:recruitment:invitation-response:v1",
    ],
  },
  {
    comparisonRefId: "intent://composition:receipts:owner-scoped-approval:v1",
    intentRefs: [
      "intent://journey:parity:finance_operations:v1",
      "intent://journey:parity:receipt_self:v1",
    ],
  },
  {
    comparisonRefId: "intent://journey:recruitment:applicant-assignment:v1",
    intentRefs: ["intent://journey:recruitment:applicant-assignment:v1"],
  },
] as const;

export const generateTracerRows = (
  register: AcceptedIntentV2,
  legacyCatalog: AtomicOperationCatalog,
  nativeCatalog: AtomicOperationCatalog,
  evidence: CapabilityEvidenceV2 | null,
): readonly CapabilityReportRow[] =>
  tracerDefinitions
    .map((tracer): CapabilityReportRow => {
      if (tracer.intentRefs.length === 1) {
        const intent = register.intents.find((item) => item.intent_ref_id === tracer.intentRefs[0]);
        if (intent !== undefined)
          return compareCapabilityIntent(register, intent, legacyCatalog, nativeCatalog, evidence);
      }
      const composedIntent = register.intents.find(
        (item) => item.intent_ref_id === tracer.comparisonRefId,
      );
      if (composedIntent !== undefined)
        return compareCapabilityIntent(
          register,
          composedIntent,
          legacyCatalog,
          nativeCatalog,
          evidence,
        );
      const detail =
        tracer.intentRefs.length > 1
          ? "The v1 authority has component intents but no reviewed composed capability intent."
          : "The accepted intent is not present in the authority register.";
      const legacy = unknownBackendResult(
        "legacy_symfony",
        tracer.intentRefs,
        "MISSING_SEMANTIC_ASSERTION",
        detail,
      );
      const native = unknownBackendResult(
        "native_effect",
        tracer.intentRefs,
        "MISSING_SEMANTIC_ASSERTION",
        detail,
      );
      return {
        comparison_ref_id: tracer.comparisonRefId,
        intent_ref_ids: [...tracer.intentRefs].sort(compareByteOrder),
        intent_revision: "unreviewed-composition",
        legacy,
        native,
        equivalence: "unknown",
        diagnostics: [...legacy.diagnostics, ...native.diagnostics].sort(diagnosticSort),
      };
    })
    .sort((left, right) => compareByteOrder(left.comparison_ref_id, right.comparison_ref_id));

export interface GeneratedCapabilityArtifacts {
  readonly legacyCatalog: AtomicOperationCatalog;
  readonly nativeCatalog: AtomicOperationCatalog;
  readonly migratedIntent: AcceptedIntentV2;
  readonly migratedV1Evidence: readonly MigratedV1Evidence[];
  readonly report: CapabilityParityReport;
  readonly bytes: Readonly<Record<string, string>>;
}

const pinForReport = (pin: AuthorityPin): ReportAuthorityPin => ({
  revision: pin.revision,
  blob_oid: pin.blob_oid,
  digest: pin.digest,
  schema_version: pin.source_schema_version,
});

export const generateCapabilityArtifacts = (input: {
  readonly legacyOpenApiBytes: string;
  readonly nativeOpenApiBytes: string;
  readonly intentAuthority: unknown;
  readonly intentPin: AuthorityPin;
  readonly evidenceAuthority: unknown;
  readonly evidencePin: AuthorityPin;
  readonly sourceRevisionRef: string;
}): GeneratedCapabilityArtifacts => {
  const legacyCatalog = extractAtomicOperationCatalog({
    backend: "legacy_symfony",
    openapiBytes: input.legacyOpenApiBytes,
    generatorRef: "apps/server:api:spec",
    sourceRevisionRef: input.sourceRevisionRef,
  });
  const nativeCatalog = extractAtomicOperationCatalog({
    backend: "native_effect",
    openapiBytes: input.nativeOpenApiBytes,
    generatorRef: "packages/http-api:generate",
    sourceRevisionRef: input.sourceRevisionRef,
  });
  const intentV2 = validateAcceptedIntentV2(input.intentAuthority)
    ? input.intentAuthority
    : migrateAcceptedIntentV1(input.intentAuthority, input.intentPin);
  const evidenceV2 = validateCapabilityEvidenceV2(input.evidenceAuthority)
    ? input.evidenceAuthority
    : null;
  const migratedV1Evidence =
    evidenceV2 === null ? migrateRuntimeEvidenceV1(input.evidenceAuthority) : [];
  const legacyBytes = canonicalJson(legacyCatalog);
  const nativeBytes = canonicalJson(nativeCatalog);
  const report: CapabilityParityReport = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-capability-report/v1",
    canonicalization: "recursive-key-sort/contract-array-sort/compact-utf8/no-newline",
    provenance: {
      legacy_openapi_sha256: legacyCatalog.openapi_sha256,
      native_openapi_sha256: nativeCatalog.openapi_sha256,
      legacy_catalog_sha256: sha256(legacyBytes),
      native_catalog_sha256: sha256(nativeBytes),
      intent_authority: pinForReport(input.intentPin),
      evidence_authority: pinForReport(input.evidencePin),
    },
    rows: generateTracerRows(intentV2, legacyCatalog, nativeCatalog, evidenceV2),
    diagnostics: [],
  };
  if (!validateCapabilityParityReport(report))
    throw new Error(
      `CAPABILITY_PARITY_REPORT_SCHEMA_INVALID:${JSON.stringify(validateReport.errors)}`,
    );
  const reportBytes = canonicalJson(report);
  const names = {
    "atomic-legacy.json": legacyBytes,
    "atomic-native.json": nativeBytes,
    "capability-parity-report.json": reportBytes,
  };
  const sidecar = canonicalJson({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-capability-report-receipt/v1",
    report_sha256: sha256(reportBytes),
    artifact_sha256: Object.fromEntries(
      Object.entries(names)
        .sort(([left], [right]) => compareByteOrder(left, right))
        .map(([name, bytes]) => [name, sha256(bytes)]),
    ),
  });
  return {
    legacyCatalog,
    nativeCatalog,
    migratedIntent: intentV2,
    migratedV1Evidence,
    report,
    bytes: { ...names, "capability-parity-report.receipt.json": sidecar },
  };
};

export const capabilityReceiptRef = (
  receipt: Omit<CapabilityEvidenceReceipt, "receipt_ref_id">,
): string => stableId("receipt", receipt);
