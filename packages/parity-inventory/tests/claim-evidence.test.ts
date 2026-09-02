import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareCapabilityIntent,
  migrateAcceptedIntentV1,
  validateAcceptedIntentV2,
  validateAtomicOperationCatalog,
  validateCapabilityEvidenceV2,
  validateIntentGraph,
  type AcceptedIntentV2,
  type AtomicOperationCatalog,
  type AuthorityPin,
  type Backend,
} from "../src/capability-parity.js";
import {
  TARGET_INTENT_REFS,
  buildCapabilityEvidenceReceipt,
  buildCapabilityRuntimeEvidenceV2,
  buildClaimSpecificAcceptedIntentV2,
  claimEvidencePlan,
  type ClaimBackendEvidencePlan,
  type ClaimEvidenceCatalogs,
  type ClaimEvidenceReceiptRef,
  type ClaimObservationMethod,
  type ReviewedTargetIntentRef,
} from "../src/claim-evidence.js";
import { canonicalJson, compareByteOrder, sha256, stableId } from "../src/canonical.js";

const legacyCatalog = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../evidence/capability-parity/atomic-legacy.json"),
    "utf8",
  ),
) as AtomicOperationCatalog;
const parsedNativeCatalog = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../evidence/capability-parity/atomic-native.json"),
    "utf8",
  ),
) as AtomicOperationCatalog;
const nativeApplicationListTemplate = parsedNativeCatalog.operations.find(
  (operation) =>
    operation.operation_ref_id === "operation://native_effect/recruitment.readAssignmentBoard",
);
if (nativeApplicationListTemplate === undefined)
  throw new Error("native application-list fixture template is unavailable");
const nativeCatalog: AtomicOperationCatalog = {
  ...parsedNativeCatalog,
  operations: [
    ...parsedNativeCatalog.operations,
    {
      ...nativeApplicationListTemplate,
      operation_ref_id: "operation://native_effect/admissions.listApplications",
      operation_id: "admissions.listApplications",
      method: "GET",
      path_template: "/api/applications",
      provenance: {
        ...nativeApplicationListTemplate.provenance,
        canonical_operation_sha256: sha256(
          "fixture:admissions.listApplications:GET:/api/applications",
        ),
        json_pointer: "#/paths/~1api~1applications/get",
      },
    },
  ],
};
const catalogs: ClaimEvidenceCatalogs = { legacy: legacyCatalog, native: nativeCatalog };

const authorityPin: AuthorityPin = {
  repository_ref: "external:functional-parity-intent-authority",
  authority_path: "accepted-intent.json",
  revision: "1".repeat(40),
  blob_oid: "2".repeat(40),
  digest: sha256("external accepted intent fixture"),
  source_schema_version: "functional-parity-accepted-intent/v1",
};

const sourceRef = (value: string): string => `src-${sha256(value).slice("sha256:".length)}`;
const revisionRefs = ["rev-legacy-fixture", "rev-mono-fixture"] as const;

interface ExternalJourneyFixtureInput {
  readonly ref: string;
  readonly key: string;
  readonly revision: string;
  readonly steps: readonly string[];
  readonly coverage: "user_visible" | "operator_visible";
}

const externalJourneyFixture = (input: ExternalJourneyFixtureInput) => {
  const steps = input.steps.map((stepId, index) => ({
    step_id: stepId,
    surface: index % 2 === 0 ? ("api_operation" as const) : ("command_write" as const),
    row_ids: [],
    canonical_signatures: [`fixture:${stepId}`],
    expected_contract_ref: "design-spec:0078",
    runtime_evidence_ref_ids: [],
  }));
  const withoutDigest = {
    journey_ref_id: input.ref,
    journey_key: input.key,
    intent_ref_id: input.ref,
    journey_revision: input.revision,
    selected_revision_ref_ids: revisionRefs,
    source_ref_ids: [sourceRef(input.ref)],
    steps,
    coverage_scope: input.coverage,
  };
  return { ...withoutDigest, journey_digest: sha256(canonicalJson(withoutDigest)) };
};

const externalIntentFixture = (() => {
  const journeys = [
    externalJourneyFixture({
      ref: "intent://journey:parity:applicant_admission:v1",
      key: "applicant-admission",
      revision: "applicant-admission-v1",
      coverage: "user_visible",
      steps: [
        "applicant-admission-api-operation",
        "applicant-admission-command-write",
        "applicant-admission-legacy-route",
        "applicant-admission-mono-route",
      ],
    }),
    externalJourneyFixture({
      ref: "intent://journey:recruitment:interview-scheduling:v1",
      key: "recruitment-interview-scheduling",
      revision: "interview-scheduling-v1",
      coverage: "user_visible",
      steps: [
        "load-assigned-interviews",
        "schedule-interview",
        "applicant-loads-response",
        "applicant-accepts-interview",
        "fresh-read-accepted-interview",
      ],
    }),
    externalJourneyFixture({
      ref: "intent://journey:recruitment:invitation-response:v1",
      key: "recruitment-invitation-response",
      revision: "invitation-response-v1",
      coverage: "user_visible",
      steps: [
        "applicant-loads-invitation",
        "applicant-confirms-invitation",
        "applicant-rejects-invitation",
        "applicant-requests-new-time",
        "fresh-applicant-response-read",
        "fresh-interviewer-response-read",
        "invalid-response-preserves-state",
      ],
    }),
    externalJourneyFixture({
      ref: "intent://journey:parity:receipt_self:v1",
      key: "receipt-self",
      revision: "receipt-self-v1",
      coverage: "user_visible",
      steps: ["receipt-self-api-operation", "receipt-self-command-write"],
    }),
    externalJourneyFixture({
      ref: "intent://journey:parity:finance_operations:v1",
      key: "finance-operations",
      revision: "finance-operations-v1",
      coverage: "operator_visible",
      steps: ["finance-operations-api-operation", "finance-operations-command-write"],
    }),
    externalJourneyFixture({
      ref: "intent://journey:recruitment:applicant-assignment:v1",
      key: "recruitment-applicant-assignment",
      revision: "applicant-assignment-v1",
      coverage: "user_visible",
      steps: ["load-applicant-list", "assign-interview", "fresh-read-applicant-list"],
    }),
  ];
  const intents = journeys.map((journey) => {
    const withoutDigest = {
      intent_ref_id: journey.journey_ref_id,
      intent_revision: journey.journey_revision,
      selected_revision_ref_ids: revisionRefs,
      source_ref_ids: journey.source_ref_ids,
      purpose: "coverage" as const,
      disposition: null,
      row_ids: [],
      canonical_signatures: [],
      inventory_kinds: [],
      journey_ref_ids: [journey.journey_ref_id],
    };
    return { ...withoutDigest, intent_digest: sha256(canonicalJson(withoutDigest)) };
  });
  return {
    schema_version: "functional-parity-accepted-intent/v1" as const,
    intents,
    journeys,
  };
})();

const migratedFixture = (): AcceptedIntentV2 => {
  const migrated = migrateAcceptedIntentV1(externalIntentFixture, authorityPin);
  return {
    ...migrated,
    predicates: [
      {
        predicate_ref: "predicate://fixture/preserved",
        implies: [],
        source_ref_ids: [sourceRef("preserved predicate")],
      },
    ],
    projections: [
      {
        projection_ref: "projection://fixture/preserved",
        input_selector: "$.fixture",
        output_selector: "$.fixture",
        source_ref_ids: [sourceRef("preserved projection")],
      },
    ],
  };
};

const backendValues = ["legacy_symfony", "native_effect"] as const;

const satisfiedObservations = (
  backendPlan: ClaimBackendEvidencePlan,
): ClaimBackendEvidencePlan["observations"] => {
  const excluded = new Set([
    ...(backendPlan.unsatisfied.assertion_ids ?? []),
    ...(backendPlan.unsatisfied.effect_ids ?? []),
    ...(backendPlan.unsatisfied.freshness_ids ?? []),
    ...(backendPlan.unsatisfied.precondition_ids ?? []),
    ...(backendPlan.unsatisfied.rejection_ids ?? []),
  ]);
  return backendPlan.observations.filter((observation) =>
    [
      observation.assertion_id,
      observation.effect_id,
      observation.freshness_id,
      observation.precondition_id,
      observation.rejection_id,
    ].every((semanticId) => semanticId === null || !excluded.has(semanticId)),
  );
};

const fixedReceiptRefs = (): readonly ClaimEvidenceReceiptRef[] =>
  claimEvidencePlan(catalogs).flatMap((plan) =>
    backendValues.map((backend) => ({
      intent_ref_id: plan.intent_ref_id,
      backend,
      receipt_ref_id: stableId("receipt", {
        register: "claim-evidence-test",
        intent_ref_id: plan.intent_ref_id,
        backend,
      }),
    })),
  );

const receiptRefFor = (
  receiptRefs: readonly ClaimEvidenceReceiptRef[],
  intentRefId: ReviewedTargetIntentRef,
  backend: Backend,
): string =>
  receiptRefs.find((entry) => entry.intent_ref_id === intentRefId && entry.backend === backend)!
    .receipt_ref_id;

const reviewedIntentRefs = TARGET_INTENT_REFS.slice(0, 3) as readonly ReviewedTargetIntentRef[];

const registerFixture = () => {
  const migrated = migratedFixture();
  const receiptRefs = fixedReceiptRefs();
  return {
    migrated,
    receiptRefs,
    register: buildClaimSpecificAcceptedIntentV2(migrated, catalogs, receiptRefs),
  };
};

test("claim observation plan binds stable node and witness identifiers to committed operations", () => {
  expect(validateAtomicOperationCatalog(legacyCatalog)).toBe(true);
  expect(validateAtomicOperationCatalog(nativeCatalog)).toBe(true);

  const first = claimEvidencePlan(catalogs);
  const second = claimEvidencePlan(catalogs);
  expect(canonicalJson(first)).toBe(canonicalJson(second));
  expect(first.map((entry) => entry.intent_ref_id)).toEqual(reviewedIntentRefs);
  expect(TARGET_INTENT_REFS).toEqual([
    "intent://journey:parity:applicant_admission:v1",
    "intent://composition:recruitment:interview-scheduling-invitation-response:v1",
    "intent://composition:receipts:owner-scoped-approval:v1",
    "intent://journey:recruitment:applicant-assignment:v1",
  ]);
  expect(
    first
      .find((entry) => entry.intent_ref_id === "intent://journey:parity:applicant_admission:v1")
      ?.backends.native_effect.operation_nodes.find(
        (operation) => operation.operation_semantic === "catalog-read",
      ),
  ).toMatchObject({
    method: "GET",
    path_template: "/api/applications",
  });

  const expectedMethodByClaim: Partial<Record<string, ClaimObservationMethod>> = {
    journey_executed: "bounded_exit_status",
    operation_observed: "exact_http_operation",
    authorization_observed: "authorization_boundary_request",
    boundary_observation: "user_visible_boundary_read",
    rejection_observed: "invalid_transition_with_state_readback",
    persistence_observed: "fresh_database_readback",
    effect_requested: "ordered_durable_outbox_readback",
    fresh_read_observed: "second_fresh_http_read",
  };

  for (const target of first) {
    expect(Object.values(target.semantic_ids).every((identifiers) => identifiers.length > 0)).toBe(
      true,
    );
    for (const backend of backendValues) {
      const backendPlan = target.backends[backend];
      expect(backendPlan.witness_ids).toEqual({
        accepted: `${target.slug}-${backend}-accepted`,
        authorization: `${target.slug}-${backend}-authorization`,
        rejection: `${target.slug}-${backend}-rejection`,
      });
      const catalog = backend === "legacy_symfony" ? legacyCatalog : nativeCatalog;
      for (const node of backendPlan.operation_nodes) {
        expect(node.node_id).toBe(`${target.slug}-${backend}-${node.operation_semantic}`);
        const operation = catalog.operations.find(
          (candidate) => candidate.operation_ref_id === node.operation_ref_id,
        );
        expect(operation).toBeDefined();
        expect({
          method: node.method,
          path_template: node.path_template,
          digest: node.expected_operation_sha256,
        }).toEqual({
          method: operation!.method,
          path_template: operation!.path_template,
          digest: operation!.provenance.canonical_operation_sha256,
        });
      }
      expect(new Set(backendPlan.operation_nodes.map((entry) => entry.node_id)).size).toBe(
        backendPlan.operation_nodes.length,
      );
      expect(new Set(backendPlan.observations.map((entry) => entry.observation_id)).size).toBe(
        backendPlan.observations.length,
      );
      for (const observation of backendPlan.observations) {
        expect(observation.observation_method).toBe(expectedMethodByClaim[observation.kind]);
      }
    }
  }

  const plannedKinds = new Set(
    first.flatMap((target) =>
      backendValues.flatMap((backend) =>
        target.backends[backend].observations.map((entry) => entry.kind),
      ),
    ),
  );
  expect([...plannedKinds].sort(compareByteOrder)).toEqual(
    [
      "authorization_observed",
      "boundary_observation",
      "effect_requested",
      "fresh_read_observed",
      "journey_executed",
      "operation_observed",
      "persistence_observed",
      "rejection_observed",
    ].sort(compareByteOrder),
  );
});

test("accepted-intent builder replaces only the three reviewed targets and retains the migrated negative control", () => {
  const { migrated, register } = registerFixture();
  expect(validateAcceptedIntentV2(register)).toBe(true);
  expect(register.source_authority).toEqual(migrated.source_authority);
  expect(register.source_v1_intents).toEqual(migrated.source_v1_intents);
  expect(register.projections).toEqual(migrated.projections);
  expect(register.migration_diagnostics).toEqual(migrated.migration_diagnostics);
  expect(register.predicates).toContainEqual(migrated.predicates[0]);
  expect(register.intents.map((intent) => intent.intent_ref_id).sort(compareByteOrder)).toEqual(
    [...TARGET_INTENT_REFS].sort(compareByteOrder),
  );

  for (const intentRefId of reviewedIntentRefs) {
    const intent = register.intents.find((entry) => entry.intent_ref_id === intentRefId)!;
    const { intent_digest: intentDigest, ...withoutDigest } = intent;
    expect(intentDigest).toBe(sha256(canonicalJson(withoutDigest)));
    expect(intent.semantic_stages.length).toBeGreaterThan(0);
    expect(intent.required_preconditions.length).toBeGreaterThan(0);
    expect(intent.warranted_outcomes.length).toBeGreaterThan(0);
    expect(intent.side_effects.length).toBeGreaterThan(0);
    expect(intent.rejections.length).toBeGreaterThan(0);
    expect(intent.freshness.length).toBeGreaterThan(0);
    for (const implementation of intent.implementations) {
      const catalog = implementation.backend === "legacy_symfony" ? legacyCatalog : nativeCatalog;
      expect(validateIntentGraph(register, intent, implementation, catalog)).toEqual([]);
      expect(implementation.witnesses.map((witness) => witness.witness_id)).toEqual([
        `${claimEvidencePlan(catalogs).find((entry) => entry.intent_ref_id === intentRefId)!.slug}-${implementation.backend}-accepted`,
        `${claimEvidencePlan(catalogs).find((entry) => entry.intent_ref_id === intentRefId)!.slug}-${implementation.backend}-authorization`,
        `${claimEvidencePlan(catalogs).find((entry) => entry.intent_ref_id === intentRefId)!.slug}-${implementation.backend}-rejection`,
      ]);
      expect(
        implementation.witnesses
          .find((witness) => witness.purpose === "accepted")!
          .edges.some((edge) => edge.kind === "order" && edge.relation === "read_after_write"),
      ).toBe(true);
    }
  }

  const sourceApplicant = migrated.intents.find(
    (intent) => intent.intent_ref_id === "intent://journey:parity:applicant_admission:v1",
  )!;
  const reviewedApplicant = register.intents.find(
    (intent) => intent.intent_ref_id === "intent://journey:parity:applicant_admission:v1",
  )!;
  expect(reviewedApplicant.source_v1_selection).toEqual(sourceApplicant.source_v1_selection);
  expect(
    register.intents.find(
      (intent) =>
        intent.intent_ref_id ===
        "intent://composition:recruitment:interview-scheduling-invitation-response:v1",
    )!.source_v1_selection,
  ).toBeNull();

  const migratedNegative = migrated.intents.find(
    (intent) => intent.intent_ref_id === "intent://journey:recruitment:applicant-assignment:v1",
  )!;
  const negative = register.intents.find(
    (intent) => intent.intent_ref_id === "intent://journey:recruitment:applicant-assignment:v1",
  )!;
  expect(negative).toEqual(migratedNegative);
  expect(negative.semantic_stages).toEqual([]);
  expect(negative.required_preconditions).toEqual([]);
  expect(negative.warranted_outcomes).toEqual([]);
  expect(negative.side_effects).toEqual([]);
  expect(negative.rejections).toEqual([]);
  expect(negative.freshness).toEqual([]);
  expect(
    negative.implementations.every((implementation) => implementation.witnesses.length === 0),
  ).toBe(true);
});

test("receipt builder maps only artifact observation ids into scope-valid v2 claims", () => {
  const { register, receiptRefs } = registerFixture();
  const plans = claimEvidencePlan(catalogs);
  const receipts = plans.flatMap((plan) =>
    backendValues.map((backend) => {
      const backendPlan = plan.backends[backend];
      return buildCapabilityEvidenceReceipt({
        accepted_intent: register,
        catalogs,
        backend,
        intent_ref_id: plan.intent_ref_id,
        receipt_ref_id: receiptRefFor(receiptRefs, plan.intent_ref_id, backend),
        artifact_pointer: `artifacts/${plan.slug}-${backend}.json`,
        artifact_digest: sha256(`artifact:${plan.slug}:${backend}`),
        observed_observation_ids: satisfiedObservations(backendPlan).map(
          (entry) => entry.observation_id,
        ),
        runner_digest: sha256(`runner:${backend}`),
        fixture_digest: sha256(`fixture:${plan.slug}:${backend}`),
        result: "passed",
        exit_code: 0,
      });
    }),
  );
  const evidence = buildCapabilityRuntimeEvidenceV2(authorityPin, receipts);
  expect(validateCapabilityEvidenceV2(evidence)).toBe(true);
  expect(canonicalJson(evidence)).toBe(
    canonicalJson(buildCapabilityRuntimeEvidenceV2(authorityPin, receipts)),
  );
  expect(
    evidence.receipts.some(
      (receipt) => receipt.intent_ref_id === "intent://journey:recruitment:applicant-assignment:v1",
    ),
  ).toBe(false);

  for (const receipt of evidence.receipts) {
    const intent = register.intents.find((entry) => entry.intent_ref_id === receipt.intent_ref_id)!;
    const implementation = intent.implementations.find(
      (entry) => entry.backend === receipt.backend,
    )!;
    expect(receipt.implementation_digest).toBe(sha256(canonicalJson(implementation)));
    const plan = plans.find((entry) => entry.intent_ref_id === receipt.intent_ref_id)!;
    const plannedObservations = satisfiedObservations(plan.backends[receipt.backend]);
    expect(receipt.claims).toHaveLength(plannedObservations.length);
    for (const claim of receipt.claims) {
      expect(
        plannedObservations.some(
          (observation) =>
            observation.kind === claim.kind &&
            observation.witness_id === claim.witness_id &&
            observation.node_id === claim.node_id &&
            observation.precondition_id === claim.precondition_id &&
            observation.assertion_id === claim.assertion_id &&
            observation.effect_id === claim.effect_id &&
            observation.rejection_id === claim.rejection_id &&
            observation.freshness_id === claim.freshness_id,
        ),
      ).toBe(true);
      expect(claim.artifact).toEqual({
        artifact_pointer: `artifacts/${plan.slug}-${receipt.backend}.json`,
        artifact_digest: sha256(`artifact:${plan.slug}:${receipt.backend}`),
      });
    }
  }

  const expectedStructuralCodes: Readonly<Record<ReviewedTargetIntentRef, readonly string[]>> = {
    "intent://journey:parity:applicant_admission:v1": [
      "EFFECT_DECLARATION_MISSING",
      "MISSING_OUTCOME",
      "MISSING_REJECTION",
    ],
    "intent://composition:recruitment:interview-scheduling-invitation-response:v1": [
      "EFFECT_DECLARATION_MISSING",
      "MISSING_OUTCOME",
    ],
    "intent://composition:receipts:owner-scoped-approval:v1": ["EFFECT_DECLARATION_MISSING"],
  };
  for (const intentRefId of reviewedIntentRefs) {
    const intent = register.intents.find((entry) => entry.intent_ref_id === intentRefId)!;
    const row = compareCapabilityIntent(register, intent, legacyCatalog, nativeCatalog, evidence);
    expect(row.equivalence).toBe("not_equivalent");
    expect(row.legacy.evidence_status).toBe("missing");
    expect(row.native.evidence_status).toBe("current");
    const diagnosticCodes = new Set(row.diagnostics.map((diagnostic) => diagnostic.code));
    expect(diagnosticCodes.has("CLAIM_SCOPE_INVALID")).toBe(false);
    for (const code of expectedStructuralCodes[intentRefId]) {
      expect(diagnosticCodes.has(code)).toBe(true);
    }
  }

  const applicantPlan = plans.find(
    (entry) => entry.intent_ref_id === "intent://journey:parity:applicant_admission:v1",
  )!;
  const observedSubset = applicantPlan.backends.native_effect.observations.slice(0, 2);
  const partial = buildCapabilityEvidenceReceipt({
    accepted_intent: register,
    catalogs,
    backend: "native_effect",
    intent_ref_id: applicantPlan.intent_ref_id,
    artifact_pointer: "artifacts/failed-applicant-run.json",
    artifact_digest: sha256("failed applicant artifact"),
    observed_observation_ids: observedSubset.map((entry) => entry.observation_id),
    runner_digest: sha256("failed runner"),
    fixture_digest: sha256("failed fixture"),
    result: "failed",
    exit_code: 9,
  });
  expect(partial.result).toBe("failed");
  expect(partial.exit_code).toBe(9);
  expect(partial.claims).toHaveLength(2);
  expect(partial.claims.map((claim) => claim.kind)).toEqual(
    observedSubset.map((entry) => entry.kind),
  );
  expect(() =>
    buildCapabilityEvidenceReceipt({
      accepted_intent: register,
      catalogs,
      backend: "native_effect",
      intent_ref_id: applicantPlan.intent_ref_id,
      artifact_pointer: "artifacts/unknown-observation.json",
      artifact_digest: sha256("unknown observation artifact"),
      observed_observation_ids: ["observation-not-produced-by-runner"],
      runner_digest: sha256("runner"),
      fixture_digest: sha256("fixture"),
      result: "passed",
      exit_code: 0,
    }),
  ).toThrow("CLAIM_EVIDENCE_RECEIPT_UNKNOWN_OBSERVATION");
});
