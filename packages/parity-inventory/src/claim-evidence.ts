import {
  capabilityReceiptRef,
  type AcceptedIntentV2,
  type AtomicOperation,
  type AtomicOperationCatalog,
  type AuthorityPin,
  type Backend,
  type CapabilityEvidenceClaim,
  type CapabilityEvidenceReceipt,
  type CapabilityEvidenceV2,
  type CapabilityIntent,
  type EvidenceClaimKind,
  type ImplementationDefinition,
  type ImplementationWitness,
  type IntentFreshness,
  type IntentOutcome,
  type IntentPrecondition,
  type IntentRejection,
  type IntentSideEffect,
  type IntentStage,
  type PredicateDefinition,
  type WitnessEdge,
  type WitnessNode,
} from "./capability-parity.js";
import { canonicalJson, compareByteOrder, sha256, sortUnique, stableId } from "./canonical.js";

const APPLICANT_ADMISSION_REF = "intent://journey:parity:applicant_admission:v1";
const INTERVIEW_INVITATION_REF =
  "intent://composition:recruitment:interview-scheduling-invitation-response:v1";
const OWNER_APPROVAL_REF = "intent://composition:receipts:owner-scoped-approval:v1";
const APPLICANT_ASSIGNMENT_REF = "intent://journey:recruitment:applicant-assignment:v1";

const INTERVIEW_SCHEDULING_SOURCE_REF = "intent://journey:recruitment:interview-scheduling:v1";
const INVITATION_RESPONSE_SOURCE_REF = "intent://journey:recruitment:invitation-response:v1";
const RECEIPT_SELF_SOURCE_REF = "intent://journey:parity:receipt_self:v1";
const FINANCE_OPERATIONS_SOURCE_REF = "intent://journey:parity:finance_operations:v1";
const SPEC_SOURCE_REF = "design-specs/0078.1-claim-specific-evidence-amendment.md";

export const TARGET_INTENT_REFS = [
  APPLICANT_ADMISSION_REF,
  INTERVIEW_INVITATION_REF,
  OWNER_APPROVAL_REF,
  APPLICANT_ASSIGNMENT_REF,
] as const;

export type TargetIntentRef = (typeof TARGET_INTENT_REFS)[number];
export type ReviewedTargetIntentRef = Exclude<TargetIntentRef, typeof APPLICANT_ASSIGNMENT_REF>;

export interface ClaimEvidenceCatalogs {
  readonly legacy: AtomicOperationCatalog;
  readonly native: AtomicOperationCatalog;
}

export interface ClaimEvidenceReceiptRef {
  readonly intent_ref_id: ReviewedTargetIntentRef;
  readonly backend: Backend;
  readonly receipt_ref_id: string;
}

export type ClaimObservationMethod =
  | "bounded_exit_status"
  | "exact_http_operation"
  | "authorization_boundary_request"
  | "user_visible_boundary_read"
  | "invalid_transition_with_state_readback"
  | "fresh_database_readback"
  | "ordered_durable_outbox_readback"
  | "provider_delivery_observation"
  | "second_fresh_http_read";

export interface ClaimOperationPlanEntry {
  readonly operation_semantic: string;
  readonly node_id: string;
  readonly witness_id: string;
  readonly method: string;
  readonly path_template: string;
  readonly operation_ref_id: string;
  readonly expected_operation_sha256: string;
  readonly realizes_stage_ids: readonly string[];
  readonly predicate_refs: readonly string[];
}

export interface ClaimObservationPlanEntry {
  readonly observation_id: string;
  readonly observation_method: ClaimObservationMethod;
  readonly kind: EvidenceClaimKind;
  readonly witness_id: string | null;
  readonly node_id: string | null;
  readonly precondition_id: string | null;
  readonly assertion_id: string | null;
  readonly effect_id: string | null;
  readonly rejection_id: string | null;
  readonly freshness_id: string | null;
}

export interface ClaimBackendEvidencePlan {
  readonly backend: Backend;
  readonly witness_ids: {
    readonly accepted: string;
    readonly authorization: string;
    readonly rejection: string;
  };
  readonly local_observation_node_ids: {
    readonly accepted_outbox: string;
    readonly accepted_boundary: string;
    readonly authorization_boundary: string;
    readonly rejection_state_readback: string;
  };
  readonly operation_nodes: readonly ClaimOperationPlanEntry[];
  readonly observations: readonly ClaimObservationPlanEntry[];
  readonly unsatisfied: BackendUnsatisfiedDeclarations;
}

export interface ClaimIntentEvidencePlan {
  readonly intent_ref_id: ReviewedTargetIntentRef;
  readonly intent_revision: string;
  readonly slug: "applicant-admission" | "interview-invitation" | "owner-approval";
  readonly source_intent_ref_ids: readonly string[];
  readonly semantic_ids: {
    readonly stage_ids: readonly string[];
    readonly precondition_ids: readonly string[];
    readonly assertion_ids: readonly string[];
    readonly effect_ids: readonly string[];
    readonly rejection_ids: readonly string[];
    readonly freshness_ids: readonly string[];
  };
  readonly backends: {
    readonly legacy_symfony: ClaimBackendEvidencePlan;
    readonly native_effect: ClaimBackendEvidencePlan;
  };
}

export interface CapabilityEvidenceReceiptInput {
  readonly accepted_intent: AcceptedIntentV2;
  readonly catalogs: ClaimEvidenceCatalogs;
  readonly backend: Backend;
  readonly intent_ref_id: ReviewedTargetIntentRef;
  readonly receipt_ref_id?: string;
  readonly artifact_pointer: string;
  readonly artifact_digest: string;
  readonly observed_observation_ids: readonly string[];
  readonly runner_digest: string;
  readonly fixture_digest: string;
  readonly result: "passed" | "failed";
  readonly exit_code: number;
}

interface OperationBindingSpec {
  readonly operation_semantic: string;
  readonly method: string;
  readonly path_template: string;
  readonly realizes_stage_ids: readonly string[];
  readonly predicate_refs: readonly string[];
}

interface BackendBindingDefinition {
  readonly accepted: readonly OperationBindingSpec[];
  readonly authorization: readonly OperationBindingSpec[];
  readonly rejection: readonly OperationBindingSpec[];
  readonly freshness_operations: readonly {
    readonly freshness_id: string;
    readonly write_operation_semantic: string;
    readonly read_operation_semantic: string;
  }[];
  /**
   * Semantic identifiers the backend demonstrably does NOT satisfy. Empty by
   * default (full satisfaction). Listed identifiers are subtracted from the
   * implementation witness `satisfies` sets so the capability comparator
   * records a structural mismatch instead of an unsupported blanket claim.
   * Only the legacy backend declares unsatisfied identifiers today.
   */
  readonly unsatisfied?: BackendUnsatisfiedDeclarations;
}

export interface BackendUnsatisfiedDeclarations {
  readonly assertion_ids?: readonly string[];
  readonly effect_ids?: readonly string[];
  readonly freshness_ids?: readonly string[];
  readonly precondition_ids?: readonly string[];
  readonly rejection_ids?: readonly string[];
}

interface TargetDefinition {
  readonly intent_ref_id: ReviewedTargetIntentRef;
  readonly intent_revision: string;
  readonly slug: ClaimIntentEvidencePlan["slug"];
  readonly source_intent_ref_ids: readonly string[];
  readonly semantic_stages: readonly IntentStage[];
  readonly required_preconditions: readonly IntentPrecondition[];
  readonly warranted_outcomes: readonly IntentOutcome[];
  readonly side_effects: readonly IntentSideEffect[];
  readonly rejections: readonly IntentRejection[];
  readonly freshness: readonly IntentFreshness[];
  readonly backends: Readonly<Record<Backend, BackendBindingDefinition>>;
}

const applicantDefinition: TargetDefinition = {
  intent_ref_id: APPLICANT_ADMISSION_REF,
  intent_revision: "applicant-admission-claim-evidence-v2",
  slug: "applicant-admission",
  source_intent_ref_ids: [APPLICANT_ADMISSION_REF],
  semantic_stages: [
    {
      stage_id: "stage-applicant-admission-catalog",
      kind: "query",
      source_step_ids: ["applicant-admission-api-operation"],
    },
    {
      stage_id: "stage-applicant-admission-submit",
      kind: "command",
      source_step_ids: ["applicant-admission-command-write"],
    },
    {
      stage_id: "stage-applicant-admission-confirmation",
      kind: "query",
      source_step_ids: ["applicant-admission-api-operation"],
    },
    {
      stage_id: "stage-applicant-admission-effects",
      kind: "observation",
      source_step_ids: ["applicant-admission-command-write"],
    },
  ],
  required_preconditions: [
    {
      precondition_id: "precondition-applicant-admission-period-management",
      predicate_ref: "predicate://claim-evidence/applicant-admission/period-management",
      subject: "actor",
    },
  ],
  warranted_outcomes: [
    {
      assertion_id: "assertion-applicant-admission-submitted",
      semantic_path: "$.application.status",
      predicate: "transitioned_to",
      expected_json: '"Submitted"',
      visibility: "user",
    },
    {
      assertion_id: "assertion-applicant-admission-privacy-safe-confirmation",
      semantic_path: "$.confirmation._tag",
      predicate: "equals",
      expected_json: '"ApplicationConfirmed"',
      visibility: "user",
    },
  ],
  side_effects: [
    {
      effect_id: "effect-applicant-admission-outbox-persisted",
      kind: "application_outbox",
      cardinality: { min: 1, max: 3 },
      order_after_stage_id: "stage-applicant-admission-submit",
      required_claim: "persisted_outbox",
    },
    {
      effect_id: "effect-applicant-admission-activation-requested",
      kind: "applicant_activation_or_confirmation",
      cardinality: { min: 1, max: 1 },
      order_after_stage_id: "stage-applicant-admission-submit",
      required_claim: "requested",
    },
  ],
  rejections: [
    {
      rejection_id: "rejection-applicant-admission-duplicate",
      trigger_predicate_ref: "predicate://claim-evidence/applicant-admission/duplicate",
      boundary_semantic: "conflict:duplicate_application",
      disclosure: "ordinary",
      must_not_change_state: true,
      must_not_request_effects: true,
    },
  ],
  freshness: [
    {
      freshness_id: "freshness-applicant-admission-confirmation",
      mode: "read_after_write",
      write_stage_id: "stage-applicant-admission-submit",
      observation_stage_id: "stage-applicant-admission-confirmation",
      assertion_ids: ["assertion-applicant-admission-privacy-safe-confirmation"],
    },
  ],
  backends: {
    legacy_symfony: {
      accepted: [
        {
          operation_semantic: "catalog-read",
          method: "GET",
          path_template: "/api/admission_periods",
          realizes_stage_ids: ["stage-applicant-admission-catalog"],
          predicate_refs: [],
        },
        {
          operation_semantic: "submit",
          method: "POST",
          path_template: "/api/applications",
          realizes_stage_ids: ["stage-applicant-admission-submit"],
          predicate_refs: [],
        },
        {
          operation_semantic: "fresh-confirmation",
          method: "GET",
          path_template: "/api/admin/applications/{id}",
          realizes_stage_ids: ["stage-applicant-admission-confirmation"],
          predicate_refs: [],
        },
      ],
      authorization: [
        {
          operation_semantic: "period-management-boundary",
          method: "POST",
          path_template: "/api/admin/admission-periods",
          realizes_stage_ids: ["stage-applicant-admission-catalog"],
          predicate_refs: ["predicate://claim-evidence/applicant-admission/period-management"],
        },
      ],
      rejection: [
        {
          operation_semantic: "duplicate-submission",
          method: "POST",
          path_template: "/api/applications",
          realizes_stage_ids: ["stage-applicant-admission-submit"],
          predicate_refs: ["predicate://claim-evidence/applicant-admission/duplicate"],
        },
        {
          operation_semantic: "duplicate-state-readback",
          method: "GET",
          path_template: "/api/admin/applications/{id}",
          realizes_stage_ids: ["stage-applicant-admission-confirmation"],
          predicate_refs: [],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-applicant-admission-confirmation",
          write_operation_semantic: "submit",
          read_operation_semantic: "fresh-confirmation",
        },
      ],
      unsatisfied: {
        assertion_ids: ["assertion-applicant-admission-privacy-safe-confirmation"],
        effect_ids: ["effect-applicant-admission-outbox-persisted"],
        rejection_ids: ["rejection-applicant-admission-duplicate"],
      },
    },
    native_effect: {
      accepted: [
        {
          operation_semantic: "catalog-read",
          method: "GET",
          path_template: "/api/application-options",
          realizes_stage_ids: ["stage-applicant-admission-catalog"],
          predicate_refs: [],
        },
        {
          operation_semantic: "submit",
          method: "POST",
          path_template: "/api/applications",
          realizes_stage_ids: ["stage-applicant-admission-submit"],
          predicate_refs: [],
        },
        {
          operation_semantic: "fresh-confirmation",
          method: "GET",
          path_template: "/api/applications/{applicationId}",
          realizes_stage_ids: ["stage-applicant-admission-confirmation"],
          predicate_refs: [],
        },
      ],
      authorization: [
        {
          operation_semantic: "period-management-boundary",
          method: "GET",
          path_template: "/api/admission-periods",
          realizes_stage_ids: ["stage-applicant-admission-catalog"],
          predicate_refs: ["predicate://claim-evidence/applicant-admission/period-management"],
        },
      ],
      rejection: [
        {
          operation_semantic: "duplicate-submission",
          method: "POST",
          path_template: "/api/applications",
          realizes_stage_ids: ["stage-applicant-admission-submit"],
          predicate_refs: ["predicate://claim-evidence/applicant-admission/duplicate"],
        },
        {
          operation_semantic: "duplicate-state-readback",
          method: "GET",
          path_template: "/api/applications/{applicationId}",
          realizes_stage_ids: ["stage-applicant-admission-confirmation"],
          predicate_refs: [],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-applicant-admission-confirmation",
          write_operation_semantic: "submit",
          read_operation_semantic: "fresh-confirmation",
        },
      ],
    },
  },
};

const interviewDefinition: TargetDefinition = {
  intent_ref_id: INTERVIEW_INVITATION_REF,
  intent_revision: "interview-invitation-claim-evidence-v2",
  slug: "interview-invitation",
  source_intent_ref_ids: [INTERVIEW_SCHEDULING_SOURCE_REF, INVITATION_RESPONSE_SOURCE_REF],
  semantic_stages: [
    {
      stage_id: "stage-interview-invitation-scheduling-board",
      kind: "query",
      source_step_ids: ["load-assigned-interviews"],
    },
    {
      stage_id: "stage-interview-invitation-schedule",
      kind: "command",
      source_step_ids: ["schedule-interview"],
    },
    {
      stage_id: "stage-interview-invitation-read",
      kind: "query",
      source_step_ids: ["applicant-loads-invitation"],
    },
    {
      stage_id: "stage-interview-invitation-respond",
      kind: "command",
      source_step_ids: ["applicant-rejects-invitation"],
    },
    {
      stage_id: "stage-interview-invitation-fresh-read",
      kind: "query",
      source_step_ids: [
        "fresh-read-accepted-interview",
        "fresh-applicant-response-read",
        "fresh-interviewer-response-read",
      ],
    },
    {
      stage_id: "stage-interview-invitation-effects",
      kind: "observation",
      source_step_ids: ["schedule-interview"],
    },
  ],
  required_preconditions: [
    {
      precondition_id: "precondition-interview-invitation-interviewer-scope",
      predicate_ref: "predicate://claim-evidence/interview-invitation/interviewer-scope",
      subject: "actor",
    },
    {
      precondition_id: "precondition-interview-invitation-response-capability",
      predicate_ref: "predicate://claim-evidence/interview-invitation/response-capability",
      subject: "input",
    },
  ],
  warranted_outcomes: [
    {
      assertion_id: "assertion-interview-invitation-scheduled",
      semantic_path: "$.interview.status",
      predicate: "transitioned_to",
      expected_json: '"Scheduled"',
      visibility: "operator",
    },
    {
      assertion_id: "assertion-interview-invitation-rejected",
      semantic_path: "$.alternate_invitation.response",
      predicate: "transitioned_to",
      expected_json: '"Rejected"',
      visibility: "user",
    },
  ],
  side_effects: [
    {
      effect_id: "effect-interview-invitation-outbox-persisted",
      kind: "interview_invitation_outbox",
      cardinality: { min: 1, max: 1 },
      order_after_stage_id: "stage-interview-invitation-schedule",
      required_claim: "persisted_outbox",
    },
    {
      effect_id: "effect-interview-invitation-notification-requested",
      kind: "interview_invitation_notification",
      cardinality: { min: 1, max: 1 },
      order_after_stage_id: "stage-interview-invitation-schedule",
      required_claim: "requested",
    },
  ],
  rejections: [
    {
      rejection_id: "rejection-interview-invitation-already-responded",
      trigger_predicate_ref: "predicate://claim-evidence/interview-invitation/already-responded",
      boundary_semantic: "conflict:invitation_already_responded",
      disclosure: "ordinary",
      must_not_change_state: true,
      must_not_request_effects: true,
    },
  ],
  freshness: [
    {
      freshness_id: "freshness-interview-invitation-scheduling-board",
      mode: "read_after_write",
      write_stage_id: "stage-interview-invitation-schedule",
      observation_stage_id: "stage-interview-invitation-fresh-read",
      assertion_ids: ["assertion-interview-invitation-scheduled"],
    },
    {
      freshness_id: "freshness-interview-invitation-response",
      mode: "read_after_write",
      write_stage_id: "stage-interview-invitation-respond",
      observation_stage_id: "stage-interview-invitation-fresh-read",
      assertion_ids: ["assertion-interview-invitation-rejected"],
    },
  ],
  backends: {
    legacy_symfony: {
      accepted: [
        {
          operation_semantic: "scheduling-board-read",
          method: "GET",
          path_template: "/api/admin/interviews",
          realizes_stage_ids: ["stage-interview-invitation-scheduling-board"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "schedule",
          method: "POST",
          path_template: "/api/admin/interviews/{id}/schedule",
          realizes_stage_ids: ["stage-interview-invitation-schedule"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "invitation-read",
          method: "GET",
          path_template: "/api/interview-responses/{responseCode}",
          realizes_stage_ids: ["stage-interview-invitation-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "confirm",
          method: "POST",
          path_template: "/api/interview-responses/{responseCode}/accept",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "alternate-reject",
          method: "POST",
          path_template: "/api/interview-responses/{responseCode}/cancel",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "alternate-request-new-time",
          method: "POST",
          path_template: "/api/interview-responses/{responseCode}/request-new-time",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "fresh-scheduling-board",
          method: "GET",
          path_template: "/api/admin/interviews",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "fresh-invitation-response",
          method: "GET",
          path_template: "/api/interview-responses/{responseCode}",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
      ],
      authorization: [
        {
          operation_semantic: "schedule-authorization-boundary",
          method: "POST",
          path_template: "/api/admin/interviews/{id}/schedule",
          realizes_stage_ids: ["stage-interview-invitation-schedule"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "response-capability-boundary",
          method: "GET",
          path_template: "/api/interview-responses/{responseCode}",
          realizes_stage_ids: ["stage-interview-invitation-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
      ],
      rejection: [
        {
          operation_semantic: "already-responded-confirm",
          method: "POST",
          path_template: "/api/interview-responses/{responseCode}/accept",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: [
            "predicate://claim-evidence/interview-invitation/response-capability",
            "predicate://claim-evidence/interview-invitation/already-responded",
          ],
        },
        {
          operation_semantic: "rejection-state-readback",
          method: "GET",
          path_template: "/api/admin/interviews",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-interview-invitation-scheduling-board",
          write_operation_semantic: "schedule",
          read_operation_semantic: "fresh-scheduling-board",
        },
        {
          freshness_id: "freshness-interview-invitation-response",
          write_operation_semantic: "alternate-reject",
          read_operation_semantic: "fresh-invitation-response",
        },
      ],
      unsatisfied: {
        assertion_ids: [
          "assertion-interview-invitation-rejected",
          "assertion-interview-invitation-scheduled",
        ],
        effect_ids: ["effect-interview-invitation-outbox-persisted"],
      },
    },
    native_effect: {
      accepted: [
        {
          operation_semantic: "scheduling-board-read",
          method: "GET",
          path_template: "/api/recruitment/interviews",
          realizes_stage_ids: ["stage-interview-invitation-scheduling-board"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "schedule",
          method: "POST",
          path_template: "/api/recruitment/interviews/{interviewId}:schedule",
          realizes_stage_ids: ["stage-interview-invitation-schedule"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "invitation-read",
          method: "GET",
          path_template: "/api/recruitment/invitation-response",
          realizes_stage_ids: ["stage-interview-invitation-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "alternate-reject",
          method: "POST",
          path_template: "/api/recruitment/invitation-response:reject",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
        {
          operation_semantic: "fresh-scheduling-board",
          method: "GET",
          path_template: "/api/recruitment/interviews",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "fresh-invitation-response",
          method: "GET",
          path_template: "/api/recruitment/invitation-response",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
      ],
      authorization: [
        {
          operation_semantic: "schedule-authorization-boundary",
          method: "GET",
          path_template: "/api/recruitment/interviews",
          realizes_stage_ids: ["stage-interview-invitation-scheduling-board"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
        {
          operation_semantic: "response-capability-boundary",
          method: "GET",
          path_template: "/api/recruitment/invitation-response",
          realizes_stage_ids: ["stage-interview-invitation-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/response-capability"],
        },
      ],
      rejection: [
        {
          operation_semantic: "already-responded-confirm",
          method: "POST",
          path_template: "/api/recruitment/invitation-response:confirm",
          realizes_stage_ids: ["stage-interview-invitation-respond"],
          predicate_refs: [
            "predicate://claim-evidence/interview-invitation/response-capability",
            "predicate://claim-evidence/interview-invitation/already-responded",
          ],
        },
        {
          operation_semantic: "rejection-state-readback",
          method: "GET",
          path_template: "/api/recruitment/interviews",
          realizes_stage_ids: ["stage-interview-invitation-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/interview-invitation/interviewer-scope"],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-interview-invitation-scheduling-board",
          write_operation_semantic: "schedule",
          read_operation_semantic: "fresh-scheduling-board",
        },
        {
          freshness_id: "freshness-interview-invitation-response",
          write_operation_semantic: "alternate-reject",
          read_operation_semantic: "fresh-invitation-response",
        },
      ],
    },
  },
};

const receiptDefinition: TargetDefinition = {
  intent_ref_id: OWNER_APPROVAL_REF,
  intent_revision: "owner-approval-claim-evidence-v2",
  slug: "owner-approval",
  source_intent_ref_ids: [RECEIPT_SELF_SOURCE_REF, FINANCE_OPERATIONS_SOURCE_REF],
  semantic_stages: [
    {
      stage_id: "stage-owner-approval-submit",
      kind: "command",
      source_step_ids: ["receipt-self-command-write"],
    },
    {
      stage_id: "stage-owner-approval-owner-read",
      kind: "query",
      source_step_ids: ["receipt-self-api-operation"],
    },
    {
      stage_id: "stage-owner-approval-queue-read",
      kind: "query",
      source_step_ids: ["finance-operations-api-operation"],
    },
    {
      stage_id: "stage-owner-approval-approve",
      kind: "command",
      source_step_ids: ["finance-operations-command-write"],
    },
    {
      stage_id: "stage-owner-approval-fresh-read",
      kind: "query",
      source_step_ids: ["receipt-self-api-operation", "finance-operations-api-operation"],
    },
    {
      stage_id: "stage-owner-approval-audit",
      kind: "observation",
      source_step_ids: ["receipt-self-command-write", "finance-operations-command-write"],
    },
  ],
  required_preconditions: [
    {
      precondition_id: "precondition-owner-approval-owner-session",
      predicate_ref: "predicate://claim-evidence/owner-approval/owner-session",
      subject: "actor",
    },
    {
      precondition_id: "precondition-owner-approval-approver-scope",
      predicate_ref: "predicate://claim-evidence/owner-approval/approver-scope",
      subject: "actor",
    },
  ],
  warranted_outcomes: [
    {
      assertion_id: "assertion-owner-approval-submitted-pending",
      semantic_path: "$.receipt.status",
      predicate: "transitioned_to",
      expected_json: '"Pending"',
      visibility: "user",
    },
    {
      assertion_id: "assertion-owner-approval-owner-scoped-list",
      semantic_path: "$.owner_receipts[*].owner_id",
      predicate: "set_equals",
      expected_json: '["current_actor"]',
      visibility: "user",
    },
    {
      assertion_id: "assertion-owner-approval-queue-scoped",
      semantic_path: "$.approval_receipts[*].department_id",
      predicate: "set_equals",
      expected_json: '["authorized_department"]',
      visibility: "operator",
    },
    {
      assertion_id: "assertion-owner-approval-rejected",
      semantic_path: "$.receipt.status",
      predicate: "transitioned_to",
      expected_json: '"Rejected"',
      visibility: "user",
    },
  ],
  side_effects: [
    {
      effect_id: "effect-owner-approval-submission-audit-persisted",
      kind: "receipt_submission_audit",
      cardinality: { min: 1, max: 1 },
      order_after_stage_id: "stage-owner-approval-submit",
      required_claim: "persisted_outbox",
    },
    {
      effect_id: "effect-owner-approval-decision-audit-persisted",
      kind: "receipt_approval_audit",
      cardinality: { min: 1, max: 1 },
      order_after_stage_id: "stage-owner-approval-approve",
      required_claim: "persisted_outbox",
    },
  ],
  rejections: [
    {
      rejection_id: "rejection-owner-approval-not-pending",
      trigger_predicate_ref: "predicate://claim-evidence/owner-approval/not-pending",
      boundary_semantic: "conflict:receipt_not_pending",
      disclosure: "ordinary",
      must_not_change_state: true,
      must_not_request_effects: true,
    },
  ],
  freshness: [
    {
      freshness_id: "freshness-owner-approval-owner-list",
      mode: "read_after_write",
      write_stage_id: "stage-owner-approval-submit",
      observation_stage_id: "stage-owner-approval-fresh-read",
      assertion_ids: ["assertion-owner-approval-submitted-pending"],
    },
    {
      freshness_id: "freshness-owner-approval-approval-list",
      mode: "read_after_write",
      write_stage_id: "stage-owner-approval-approve",
      observation_stage_id: "stage-owner-approval-fresh-read",
      assertion_ids: ["assertion-owner-approval-rejected"],
    },
  ],
  backends: {
    legacy_symfony: {
      accepted: [
        {
          operation_semantic: "submit",
          method: "POST",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-submit"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "owner-read",
          method: "GET",
          path_template: "/api/my/receipts",
          realizes_stage_ids: ["stage-owner-approval-owner-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "approval-queue-read",
          method: "GET",
          path_template: "/api/admin/receipts",
          realizes_stage_ids: ["stage-owner-approval-queue-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
        {
          operation_semantic: "approve",
          method: "PUT",
          path_template: "/api/admin/receipts/{id}/status",
          realizes_stage_ids: ["stage-owner-approval-approve"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
        {
          operation_semantic: "fresh-owner-list",
          method: "GET",
          path_template: "/api/my/receipts",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "fresh-approval-list",
          method: "GET",
          path_template: "/api/admin/receipts",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
      ],
      authorization: [
        {
          operation_semantic: "owner-session-boundary",
          method: "GET",
          path_template: "/api/my/receipts",
          realizes_stage_ids: ["stage-owner-approval-owner-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "approver-scope-boundary",
          method: "GET",
          path_template: "/api/admin/receipts",
          realizes_stage_ids: ["stage-owner-approval-queue-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
      ],
      rejection: [
        {
          operation_semantic: "not-pending-approval",
          method: "PUT",
          path_template: "/api/admin/receipts/{id}/status",
          realizes_stage_ids: ["stage-owner-approval-approve"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/not-pending"],
        },
        {
          operation_semantic: "rejection-owner-readback",
          method: "GET",
          path_template: "/api/my/receipts",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-owner-approval-owner-list",
          write_operation_semantic: "submit",
          read_operation_semantic: "fresh-owner-list",
        },
        {
          freshness_id: "freshness-owner-approval-approval-list",
          write_operation_semantic: "approve",
          read_operation_semantic: "fresh-approval-list",
        },
      ],
      unsatisfied: {
        effect_ids: [
          "effect-owner-approval-decision-audit-persisted",
          "effect-owner-approval-submission-audit-persisted",
        ],
      },
    },
    native_effect: {
      accepted: [
        {
          operation_semantic: "submit",
          method: "POST",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-submit"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "owner-read",
          method: "GET",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-owner-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "approval-queue-read",
          method: "GET",
          path_template: "/api/receipt-approval-queue",
          realizes_stage_ids: ["stage-owner-approval-queue-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
        {
          operation_semantic: "approve",
          method: "POST",
          path_template: "/api/receipts/{receiptId}:reject",
          realizes_stage_ids: ["stage-owner-approval-approve"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
        {
          operation_semantic: "fresh-owner-list",
          method: "GET",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "fresh-approval-list",
          method: "GET",
          path_template: "/api/receipt-approval-queue",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
      ],
      authorization: [
        {
          operation_semantic: "owner-session-boundary",
          method: "GET",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-owner-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
        {
          operation_semantic: "approver-scope-boundary",
          method: "GET",
          path_template: "/api/receipt-approval-queue",
          realizes_stage_ids: ["stage-owner-approval-queue-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/approver-scope"],
        },
      ],
      rejection: [
        {
          operation_semantic: "not-pending-approval",
          method: "POST",
          path_template: "/api/receipts/{receiptId}:reject",
          realizes_stage_ids: ["stage-owner-approval-approve"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/not-pending"],
        },
        {
          operation_semantic: "rejection-owner-readback",
          method: "GET",
          path_template: "/api/receipts",
          realizes_stage_ids: ["stage-owner-approval-fresh-read"],
          predicate_refs: ["predicate://claim-evidence/owner-approval/owner-session"],
        },
      ],
      freshness_operations: [
        {
          freshness_id: "freshness-owner-approval-owner-list",
          write_operation_semantic: "submit",
          read_operation_semantic: "fresh-owner-list",
        },
        {
          freshness_id: "freshness-owner-approval-approval-list",
          write_operation_semantic: "approve",
          read_operation_semantic: "fresh-approval-list",
        },
      ],
    },
  },
};

const targetDefinitions = [applicantDefinition, interviewDefinition, receiptDefinition] as const;

const catalogForBackend = (
  catalogs: ClaimEvidenceCatalogs,
  backend: Backend,
): AtomicOperationCatalog => (backend === "legacy_symfony" ? catalogs.legacy : catalogs.native);

const assertCatalogBackends = (catalogs: ClaimEvidenceCatalogs): void => {
  if (catalogs.legacy.backend !== "legacy_symfony") {
    throw new Error("CLAIM_EVIDENCE_LEGACY_CATALOG_BACKEND_INVALID");
  }
  if (catalogs.native.backend !== "native_effect") {
    throw new Error("CLAIM_EVIDENCE_NATIVE_CATALOG_BACKEND_INVALID");
  }
};

const selectOperation = (
  catalog: AtomicOperationCatalog,
  binding: OperationBindingSpec,
): AtomicOperation => {
  const matches = catalog.operations.filter(
    (operation) =>
      operation.method === binding.method && operation.path_template === binding.path_template,
  );
  if (matches.length !== 1) {
    throw new Error(
      `CLAIM_EVIDENCE_OPERATION_BINDING_INVALID:${catalog.backend}:${binding.method}:${binding.path_template}:${matches.length}`,
    );
  }
  return matches[0]!;
};

const witnessIds = (
  slug: TargetDefinition["slug"],
  backend: Backend,
): ClaimBackendEvidencePlan["witness_ids"] => ({
  accepted: `${slug}-${backend}-accepted`,
  authorization: `${slug}-${backend}-authorization`,
  rejection: `${slug}-${backend}-rejection`,
});

const localObservationNodeIds = (
  slug: TargetDefinition["slug"],
  backend: Backend,
): ClaimBackendEvidencePlan["local_observation_node_ids"] => ({
  accepted_outbox: `${slug}-${backend}-accepted-outbox-observation`,
  accepted_boundary: `${slug}-${backend}-accepted-boundary-observation`,
  authorization_boundary: `${slug}-${backend}-authorization-boundary-observation`,
  rejection_state_readback: `${slug}-${backend}-rejection-state-readback-observation`,
});

const nullClaimReferences = {
  witness_id: null,
  node_id: null,
  precondition_id: null,
  assertion_id: null,
  effect_id: null,
  rejection_id: null,
  freshness_id: null,
} as const;

const observationEntry = (
  observationId: string,
  observationMethod: ClaimObservationMethod,
  kind: EvidenceClaimKind,
  references: Partial<
    Pick<
      ClaimObservationPlanEntry,
      | "witness_id"
      | "node_id"
      | "precondition_id"
      | "assertion_id"
      | "effect_id"
      | "rejection_id"
      | "freshness_id"
    >
  > = {},
): ClaimObservationPlanEntry => ({
  observation_id: observationId,
  observation_method: observationMethod,
  kind,
  witness_id: references.witness_id ?? nullClaimReferences.witness_id,
  node_id: references.node_id ?? nullClaimReferences.node_id,
  precondition_id: references.precondition_id ?? nullClaimReferences.precondition_id,
  assertion_id: references.assertion_id ?? nullClaimReferences.assertion_id,
  effect_id: references.effect_id ?? nullClaimReferences.effect_id,
  rejection_id: references.rejection_id ?? nullClaimReferences.rejection_id,
  freshness_id: references.freshness_id ?? nullClaimReferences.freshness_id,
});

const backendPlan = (
  definition: TargetDefinition,
  backend: Backend,
  catalog: AtomicOperationCatalog,
): ClaimBackendEvidencePlan => {
  const bindings = definition.backends[backend];
  const ids = witnessIds(definition.slug, backend);
  const localIds = localObservationNodeIds(definition.slug, backend);
  const groups = [
    [ids.accepted, bindings.accepted],
    [ids.authorization, bindings.authorization],
    [ids.rejection, bindings.rejection],
  ] as const;
  const operationNodes = groups.flatMap(([witnessId, entries]) =>
    entries.map((entry): ClaimOperationPlanEntry => {
      const operation = selectOperation(catalog, entry);
      return {
        operation_semantic: entry.operation_semantic,
        node_id: `${definition.slug}-${backend}-${entry.operation_semantic}`,
        witness_id: witnessId,
        method: operation.method,
        path_template: operation.path_template,
        operation_ref_id: operation.operation_ref_id,
        expected_operation_sha256: operation.provenance.canonical_operation_sha256,
        realizes_stage_ids: entry.realizes_stage_ids,
        predicate_refs: entry.predicate_refs,
      };
    }),
  );
  if (new Set(operationNodes.map((entry) => entry.node_id)).size !== operationNodes.length) {
    throw new Error(`CLAIM_EVIDENCE_DUPLICATE_NODE_ID:${definition.intent_ref_id}:${backend}`);
  }
  if (bindings.authorization.length !== definition.required_preconditions.length) {
    throw new Error(
      `CLAIM_EVIDENCE_PRECONDITION_PLAN_INCOMPLETE:${definition.intent_ref_id}:${backend}`,
    );
  }
  if (bindings.rejection.length < definition.rejections.length) {
    throw new Error(
      `CLAIM_EVIDENCE_REJECTION_PLAN_INCOMPLETE:${definition.intent_ref_id}:${backend}`,
    );
  }
  const operationBySemantic = new Map(
    operationNodes.map((entry) => [entry.operation_semantic, entry] as const),
  );
  const observations: ClaimObservationPlanEntry[] = [
    observationEntry(
      `${definition.slug}-${backend}-journey-executed`,
      "bounded_exit_status",
      "journey_executed",
    ),
    ...operationNodes.map((entry) =>
      observationEntry(
        `${entry.node_id}-operation-observed`,
        "exact_http_operation",
        "operation_observed",
        { witness_id: entry.witness_id, node_id: entry.node_id },
      ),
    ),
    ...definition.required_preconditions.map((precondition, index) => {
      const operation = operationBySemantic.get(bindings.authorization[index]!.operation_semantic)!;
      return observationEntry(
        `${definition.slug}-${backend}-${precondition.precondition_id}-authorization-observed`,
        "authorization_boundary_request",
        "authorization_observed",
        {
          witness_id: ids.authorization,
          node_id: operation.node_id,
          precondition_id: precondition.precondition_id,
        },
      );
    }),
    ...definition.warranted_outcomes.map((outcome) =>
      observationEntry(
        `${definition.slug}-${backend}-${outcome.assertion_id}-boundary-observation`,
        "user_visible_boundary_read",
        "boundary_observation",
        {
          witness_id: ids.accepted,
          node_id: localIds.accepted_boundary,
          assertion_id: outcome.assertion_id,
        },
      ),
    ),
    ...definition.side_effects.map((effect) => {
      const kind: EvidenceClaimKind =
        effect.required_claim === "requested"
          ? "effect_requested"
          : effect.required_claim === "delivered"
            ? "effect_delivered"
            : "persistence_observed";
      const method: ClaimObservationMethod =
        effect.required_claim === "requested"
          ? "ordered_durable_outbox_readback"
          : effect.required_claim === "delivered"
            ? "provider_delivery_observation"
            : "fresh_database_readback";
      return observationEntry(
        `${definition.slug}-${backend}-${effect.effect_id}-${kind}`,
        method,
        kind,
        {
          witness_id: ids.accepted,
          node_id: localIds.accepted_outbox,
          effect_id: effect.effect_id,
        },
      );
    }),
    ...definition.rejections.map((rejection, index) => {
      const operation = operationBySemantic.get(bindings.rejection[index]!.operation_semantic)!;
      return observationEntry(
        `${definition.slug}-${backend}-${rejection.rejection_id}-rejection-observed`,
        "invalid_transition_with_state_readback",
        "rejection_observed",
        {
          witness_id: ids.rejection,
          node_id: operation.node_id,
          rejection_id: rejection.rejection_id,
        },
      );
    }),
    ...definition.freshness.map((freshness) => {
      const mapping = bindings.freshness_operations.find(
        (entry) => entry.freshness_id === freshness.freshness_id,
      );
      if (mapping === undefined) {
        throw new Error(
          `CLAIM_EVIDENCE_FRESHNESS_PLAN_INCOMPLETE:${definition.intent_ref_id}:${backend}:${freshness.freshness_id}`,
        );
      }
      const operation = operationBySemantic.get(mapping.read_operation_semantic);
      if (operation === undefined) {
        throw new Error(
          `CLAIM_EVIDENCE_FRESHNESS_READ_NODE_MISSING:${definition.intent_ref_id}:${backend}:${freshness.freshness_id}`,
        );
      }
      return observationEntry(
        `${definition.slug}-${backend}-${freshness.freshness_id}-fresh-read-observed`,
        "second_fresh_http_read",
        "fresh_read_observed",
        {
          witness_id: ids.accepted,
          node_id: operation.node_id,
          freshness_id: freshness.freshness_id,
        },
      );
    }),
  ].sort((left, right) => compareByteOrder(left.observation_id, right.observation_id));
  if (new Set(observations.map((entry) => entry.observation_id)).size !== observations.length) {
    throw new Error(
      `CLAIM_EVIDENCE_DUPLICATE_OBSERVATION_ID:${definition.intent_ref_id}:${backend}`,
    );
  }
  return {
    backend,
    witness_ids: ids,
    local_observation_node_ids: localIds,
    operation_nodes: operationNodes,
    observations,
    unsatisfied: bindings.unsatisfied ?? {},
  };
};

export const claimEvidencePlan = (
  catalogs: ClaimEvidenceCatalogs,
): readonly ClaimIntentEvidencePlan[] => {
  assertCatalogBackends(catalogs);
  return targetDefinitions.map(
    (definition): ClaimIntentEvidencePlan => ({
      intent_ref_id: definition.intent_ref_id,
      intent_revision: definition.intent_revision,
      slug: definition.slug,
      source_intent_ref_ids: definition.source_intent_ref_ids,
      semantic_ids: {
        stage_ids: definition.semantic_stages.map((entry) => entry.stage_id),
        precondition_ids: definition.required_preconditions.map((entry) => entry.precondition_id),
        assertion_ids: definition.warranted_outcomes.map((entry) => entry.assertion_id),
        effect_ids: definition.side_effects.map((entry) => entry.effect_id),
        rejection_ids: definition.rejections.map((entry) => entry.rejection_id),
        freshness_ids: definition.freshness.map((entry) => entry.freshness_id),
      },
      backends: {
        legacy_symfony: backendPlan(definition, "legacy_symfony", catalogs.legacy),
        native_effect: backendPlan(definition, "native_effect", catalogs.native),
      },
    }),
  );
};

const orderEdges = (witnessId: string, nodeIds: readonly string[]): readonly WitnessEdge[] =>
  nodeIds.slice(1).map(
    (nodeId, index): WitnessEdge => ({
      edge_id: `${witnessId}-order-${String(index + 1).padStart(2, "0")}`,
      kind: "order",
      from: nodeIds[index]!,
      to: nodeId,
      relation: "must_precede",
    }),
  );

const operationWitnessNodes = (
  entries: readonly ClaimOperationPlanEntry[],
): readonly WitnessNode[] =>
  entries.map(
    (entry): WitnessNode => ({
      node_id: entry.node_id,
      kind: "operation",
      operation_ref_id: entry.operation_ref_id,
      expected_operation_sha256: entry.expected_operation_sha256,
      realizes_stage_ids: entry.realizes_stage_ids,
      predicate_refs: entry.predicate_refs,
    }),
  );

const witnessesFor = (
  definition: TargetDefinition,
  backendPlanValue: ClaimBackendEvidencePlan,
  receiptRefIds: readonly string[],
): readonly ImplementationWitness[] => {
  const ids = backendPlanValue.witness_ids;
  const localIds = backendPlanValue.local_observation_node_ids;
  const acceptedOperations = backendPlanValue.operation_nodes.filter(
    (entry) => entry.witness_id === ids.accepted,
  );
  const authorizationOperations = backendPlanValue.operation_nodes.filter(
    (entry) => entry.witness_id === ids.authorization,
  );
  const rejectionOperations = backendPlanValue.operation_nodes.filter(
    (entry) => entry.witness_id === ids.rejection,
  );
  const unsatisfied = definition.backends[backendPlanValue.backend].unsatisfied ?? {};
  const subtract = (values: readonly string[], excluded?: readonly string[]): string[] =>
    excluded === undefined ? [...values] : values.filter((value) => !excluded.includes(value));
  const satisfiesPreconditions = subtract(
    definition.required_preconditions.map((entry) => entry.precondition_id),
    unsatisfied.precondition_ids,
  );
  const satisfiesAssertions = subtract(
    definition.warranted_outcomes.map((entry) => entry.assertion_id),
    unsatisfied.assertion_ids,
  );
  const satisfiesEffects = subtract(
    definition.side_effects.map((entry) => entry.effect_id),
    unsatisfied.effect_ids,
  );
  const satisfiesRejections = subtract(
    definition.rejections.map((entry) => entry.rejection_id),
    unsatisfied.rejection_ids,
  );
  const satisfiesFreshness = subtract(
    definition.freshness.map((entry) => entry.freshness_id),
    unsatisfied.freshness_ids,
  );
  const acceptedNodes: readonly WitnessNode[] = [
    ...operationWitnessNodes(acceptedOperations),
    {
      node_id: localIds.accepted_outbox,
      kind: "local_observation",
      observation_kind: "outbox",
      assertion_ids: [],
    },
    {
      node_id: localIds.accepted_boundary,
      kind: "local_observation",
      observation_kind: "browser",
      assertion_ids: definition.warranted_outcomes.map((entry) => entry.assertion_id),
    },
  ];
  const acceptedEdges: WitnessEdge[] = [
    ...orderEdges(
      ids.accepted,
      acceptedNodes.map((entry) => entry.node_id),
    ),
  ];
  const acceptedBySemantic = new Map(
    acceptedOperations.map((entry) => [entry.operation_semantic, entry] as const),
  );
  for (const freshness of definition.backends[backendPlanValue.backend].freshness_operations) {
    const writeNode = acceptedBySemantic.get(freshness.write_operation_semantic);
    const readNode = acceptedBySemantic.get(freshness.read_operation_semantic);
    if (writeNode === undefined || readNode === undefined) {
      throw new Error(
        `CLAIM_EVIDENCE_FRESHNESS_EDGE_NODE_MISSING:${definition.intent_ref_id}:${backendPlanValue.backend}:${freshness.freshness_id}`,
      );
    }
    acceptedEdges.push({
      edge_id: `${ids.accepted}-${freshness.freshness_id}-read-after-write`,
      kind: "order",
      from: writeNode.node_id,
      to: readNode.node_id,
      relation: "read_after_write",
    });
  }
  const authorizationTerminal: WitnessNode = {
    node_id: localIds.authorization_boundary,
    kind: "local_observation",
    observation_kind: "browser",
    assertion_ids: [],
  };
  const authorizationEdges = authorizationOperations.map(
    (entry, index): WitnessEdge => ({
      edge_id: `${ids.authorization}-authority-${String(index + 1).padStart(2, "0")}`,
      kind: "authority",
      from: entry.node_id,
      to: authorizationTerminal.node_id,
      precondition_id: definition.required_preconditions[index]!.precondition_id,
    }),
  );
  const rejectionTerminal: WitnessNode = {
    node_id: localIds.rejection_state_readback,
    kind: "local_observation",
    observation_kind: "persistence",
    assertion_ids: [],
  };
  const rejectionNodes: readonly WitnessNode[] = [
    ...operationWitnessNodes(rejectionOperations),
    rejectionTerminal,
  ];
  return [
    {
      witness_id: ids.accepted,
      purpose: "accepted",
      nodes: acceptedNodes,
      edges: acceptedEdges,
      satisfies: {
        precondition_ids: [],
        assertion_ids: satisfiesAssertions,
        effect_ids: satisfiesEffects,
        rejection_ids: [],
        freshness_ids: satisfiesFreshness,
      },
      evidence_receipt_ref_ids: receiptRefIds,
    },
    {
      witness_id: ids.authorization,
      purpose: "rejection",
      nodes: [...operationWitnessNodes(authorizationOperations), authorizationTerminal],
      edges: authorizationEdges,
      satisfies: {
        precondition_ids: satisfiesPreconditions,
        assertion_ids: [],
        effect_ids: [],
        rejection_ids: [],
        freshness_ids: [],
      },
      evidence_receipt_ref_ids: receiptRefIds,
    },
    {
      witness_id: ids.rejection,
      purpose: "rejection",
      nodes: rejectionNodes,
      edges: orderEdges(
        ids.rejection,
        rejectionNodes.map((entry) => entry.node_id),
      ),
      satisfies: {
        precondition_ids: [],
        assertion_ids: [],
        effect_ids: [],
        rejection_ids: satisfiesRejections,
        freshness_ids: [],
      },
      evidence_receipt_ref_ids: receiptRefIds,
    },
  ];
};

const receiptRefsFor = (
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
  intentRefId: ReviewedTargetIntentRef,
  backend: Backend,
): readonly string[] =>
  sortUnique(
    receiptRefs
      .filter((entry) => entry.intent_ref_id === intentRefId && entry.backend === backend)
      .map((entry) => entry.receipt_ref_id),
  );

const sourceIntentsFor = (
  migrated: AcceptedIntentV2,
  definition: TargetDefinition,
): readonly CapabilityIntent[] => {
  const byRef = new Map(migrated.intents.map((intent) => [intent.intent_ref_id, intent] as const));
  return definition.source_intent_ref_ids.map((intentRefId) => {
    const intent = byRef.get(intentRefId);
    if (intent === undefined) {
      throw new Error(`CLAIM_EVIDENCE_SOURCE_INTENT_MISSING:${intentRefId}`);
    }
    return intent;
  });
};

const reviewedIntent = (
  migrated: AcceptedIntentV2,
  definition: TargetDefinition,
  plan: ClaimIntentEvidencePlan,
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
): CapabilityIntent => {
  const sources = sourceIntentsFor(migrated, definition);
  const implementations: readonly ImplementationDefinition[] = (
    ["legacy_symfony", "native_effect"] as const
  ).map((backend) => ({
    backend,
    claim: "supported",
    reason_code: null,
    witnesses: witnessesFor(
      definition,
      plan.backends[backend],
      receiptRefsFor(receiptRefs, definition.intent_ref_id, backend),
    ),
  }));
  const sourceV1Selection =
    definition.source_intent_ref_ids.length === 1 ? sources[0]!.source_v1_selection : null;
  const withoutDigest = {
    intent_ref_id: definition.intent_ref_id,
    intent_revision: definition.intent_revision,
    source_ref_ids: sortUnique(sources.flatMap((intent) => intent.source_ref_ids)),
    source_v1_selection: sourceV1Selection,
    semantic_stages: definition.semantic_stages,
    required_preconditions: definition.required_preconditions,
    warranted_outcomes: definition.warranted_outcomes,
    side_effects: definition.side_effects,
    rejections: definition.rejections,
    freshness: definition.freshness,
    implementations,
  };
  return {
    ...withoutDigest,
    intent_digest: sha256(canonicalJson(withoutDigest)),
  };
};

const predicateDefinitions = (): readonly PredicateDefinition[] => {
  const predicateRefs = sortUnique(
    targetDefinitions.flatMap((definition) => [
      ...definition.required_preconditions.map((entry) => entry.predicate_ref),
      ...definition.rejections.map((entry) => entry.trigger_predicate_ref),
    ]),
  );
  return predicateRefs.map((predicateRef) => ({
    predicate_ref: predicateRef,
    implies: [],
    source_ref_ids: [SPEC_SOURCE_REF],
  }));
};

const mergePredicates = (
  existing: readonly PredicateDefinition[],
  additions: readonly PredicateDefinition[],
): readonly PredicateDefinition[] => {
  const byRef = new Map(existing.map((entry) => [entry.predicate_ref, entry] as const));
  for (const addition of additions) {
    if (!byRef.has(addition.predicate_ref)) byRef.set(addition.predicate_ref, addition);
  }
  return [...byRef.values()].sort((left, right) =>
    compareByteOrder(left.predicate_ref, right.predicate_ref),
  );
};

export const buildClaimSpecificAcceptedIntentV2 = (
  migratedV2: AcceptedIntentV2,
  catalogs: ClaimEvidenceCatalogs,
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
): AcceptedIntentV2 => {
  const plans = claimEvidencePlan(catalogs);
  const planByRef = new Map(plans.map((plan) => [plan.intent_ref_id, plan] as const));
  const reviewed = targetDefinitions.map((definition) =>
    reviewedIntent(migratedV2, definition, planByRef.get(definition.intent_ref_id)!, receiptRefs),
  );
  const negativeControl = migratedV2.intents.find(
    (intent) => intent.intent_ref_id === APPLICANT_ASSIGNMENT_REF,
  );
  if (negativeControl === undefined) {
    throw new Error(`CLAIM_EVIDENCE_SOURCE_INTENT_MISSING:${APPLICANT_ASSIGNMENT_REF}`);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-accepted-intent/v2",
    source_authority: migratedV2.source_authority,
    source_v1_intents: migratedV2.source_v1_intents,
    predicates: mergePredicates(migratedV2.predicates, predicateDefinitions()),
    projections: migratedV2.projections,
    intents: [...reviewed, negativeControl].sort((left, right) =>
      compareByteOrder(left.intent_ref_id, right.intent_ref_id),
    ),
    migration_diagnostics: migratedV2.migration_diagnostics,
  };
};

const catalogOperationDigests = (
  implementation: ImplementationDefinition,
  catalog: AtomicOperationCatalog,
): readonly string[] => {
  const operationByRef = new Map(
    catalog.operations.map((operation) => [operation.operation_ref_id, operation] as const),
  );
  return sortUnique(
    implementation.witnesses.flatMap((witness) =>
      witness.nodes.flatMap((node) => {
        if (node.kind !== "operation") return [];
        const operation = operationByRef.get(node.operation_ref_id);
        if (operation === undefined) {
          throw new Error(`CLAIM_EVIDENCE_RECEIPT_OPERATION_MISSING:${node.operation_ref_id}`);
        }
        if (operation.provenance.canonical_operation_sha256 !== node.expected_operation_sha256) {
          throw new Error(`CLAIM_EVIDENCE_RECEIPT_OPERATION_DRIFT:${node.operation_ref_id}`);
        }
        return [operation.provenance.canonical_operation_sha256];
      }),
    ),
  );
};

const evidenceClaim = (
  input: CapabilityEvidenceReceiptInput,
  observation: ClaimObservationPlanEntry,
): CapabilityEvidenceClaim => ({
  claim_id: stableId("claim", {
    backend: input.backend,
    intent_ref_id: input.intent_ref_id,
    observation_id: observation.observation_id,
    artifact_pointer: input.artifact_pointer,
    artifact_digest: input.artifact_digest,
  }),
  kind: observation.kind,
  witness_id: observation.witness_id,
  node_id: observation.node_id,
  precondition_id: observation.precondition_id,
  assertion_id: observation.assertion_id,
  effect_id: observation.effect_id,
  rejection_id: observation.rejection_id,
  freshness_id: observation.freshness_id,
  artifact: {
    artifact_digest: input.artifact_digest,
    artifact_pointer: input.artifact_pointer,
  },
});

export const buildCapabilityEvidenceReceipt = (
  input: CapabilityEvidenceReceiptInput,
): CapabilityEvidenceReceipt => {
  assertCatalogBackends(input.catalogs);
  if (
    (input.result === "passed" && input.exit_code !== 0) ||
    (input.result === "failed" && input.exit_code === 0)
  ) {
    throw new Error("CLAIM_EVIDENCE_RECEIPT_RESULT_EXIT_MISMATCH");
  }
  const intent = input.accepted_intent.intents.find(
    (entry) => entry.intent_ref_id === input.intent_ref_id,
  );
  if (intent === undefined) {
    throw new Error(`CLAIM_EVIDENCE_RECEIPT_INTENT_MISSING:${input.intent_ref_id}`);
  }
  const implementation = intent.implementations.find((entry) => entry.backend === input.backend);
  if (implementation === undefined) {
    throw new Error(
      `CLAIM_EVIDENCE_RECEIPT_IMPLEMENTATION_MISSING:${input.intent_ref_id}:${input.backend}`,
    );
  }
  const plan = claimEvidencePlan(input.catalogs).find(
    (entry) => entry.intent_ref_id === input.intent_ref_id,
  )!;
  const observations = plan.backends[input.backend].observations;
  const observationById = new Map(
    observations.map((observation) => [observation.observation_id, observation] as const),
  );
  if (new Set(input.observed_observation_ids).size !== input.observed_observation_ids.length) {
    throw new Error("CLAIM_EVIDENCE_RECEIPT_DUPLICATE_OBSERVATION");
  }
  const selectedObservations = input.observed_observation_ids
    .map((observationId) => {
      const observation = observationById.get(observationId);
      if (observation === undefined) {
        throw new Error(`CLAIM_EVIDENCE_RECEIPT_UNKNOWN_OBSERVATION:${observationId}`);
      }
      return observation;
    })
    .sort((left, right) => compareByteOrder(left.observation_id, right.observation_id));
  const catalog = catalogForBackend(input.catalogs, input.backend);
  const receiptWithoutRef: Omit<CapabilityEvidenceReceipt, "receipt_ref_id"> = {
    backend: input.backend,
    intent_ref_id: intent.intent_ref_id,
    intent_revision: intent.intent_revision,
    implementation_digest: sha256(canonicalJson(implementation)),
    backend_revision_ref: catalog.source_revision_ref,
    openapi_sha256: catalog.openapi_sha256,
    operation_sha256: catalogOperationDigests(implementation, catalog),
    runner_digest: input.runner_digest,
    fixture_digest: input.fixture_digest,
    result: input.result,
    exit_code: input.exit_code,
    claims: selectedObservations.map((observation) => evidenceClaim(input, observation)),
  };
  return {
    receipt_ref_id: input.receipt_ref_id ?? capabilityReceiptRef(receiptWithoutRef),
    ...receiptWithoutRef,
  };
};

export const buildCapabilityRuntimeEvidenceV2 = (
  sourceAuthority: AuthorityPin,
  receipts: readonly CapabilityEvidenceReceipt[],
): CapabilityEvidenceV2 => {
  if (new Set(receipts.map((receipt) => receipt.receipt_ref_id)).size !== receipts.length) {
    throw new Error("CLAIM_EVIDENCE_DUPLICATE_RECEIPT_REF");
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-capability-runtime-evidence/v2",
    source_authority: sourceAuthority,
    receipts: [...receipts].sort((left, right) =>
      compareByteOrder(
        `${left.intent_ref_id}:${left.backend}:${left.receipt_ref_id}`,
        `${right.intent_ref_id}:${right.backend}:${right.receipt_ref_id}`,
      ),
    ),
  };
};
