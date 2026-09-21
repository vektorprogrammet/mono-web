import {
  canonicalizeOpenApiSchema,
  compareCapabilityIntent,
  enrichLegacyOpenApi,
  extractAtomicOperationCatalog,
  generateCapabilityArtifacts,
  migrateRuntimeEvidenceV1,
  validateCapabilityEvidenceV2,
  validateIntentGraph,
  type AcceptedIntentV2,
  type AtomicOperationCatalog,
  type AuthorityPin,
  type Backend,
  type CapabilityEvidenceClaim,
  type CapabilityEvidenceV2,
  type CapabilityIntent,
  type ImplementationDefinition,
  type ImplementationWitness,
  type LegacyMetadataRecord,
} from "../src/capability-parity.js";
import { canonicalJson, sha256, stableId } from "../src/canonical.js";

const pin: AuthorityPin = {
  repository_ref: "external:test",
  authority_path: "authority.json",
  revision: "0".repeat(40),
  blob_oid: "1".repeat(40),
  digest: sha256("authority"),
  source_schema_version: "test/v1",
};

const operation = (
  operationId: string,
  security?: readonly Record<string, readonly string[]>[],
) => ({
  operationId,
  ...(security === undefined ? {} : { security }),
  responses: { "200": { description: "ok" } },
});

const openApi = (
  ids: readonly string[],
  options: {
    readonly rootSecurity?: readonly Record<string, readonly string[]>[];
    readonly sharedPath?: boolean;
  } = {},
): string =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1" },
    ...(options.rootSecurity === undefined ? {} : { security: options.rootSecurity }),
    paths: Object.fromEntries(
      ids.map((id, index) => [
        options.sharedPath ? "/api/shared" : `/api/${index}`,
        { get: operation(id) },
      ]),
    ),
  });

const catalog = (
  backend: Backend,
  ids: readonly string[],
  options: { readonly sharedPath?: boolean } = {},
): AtomicOperationCatalog =>
  extractAtomicOperationCatalog({
    backend,
    openapiBytes: openApi(ids, options),
    generatorRef: "test-generator",
    sourceRevisionRef: "test-revision",
  });

const witness = (
  witnessId: string,
  operationCatalog: AtomicOperationCatalog,
  shape: "single" | "chain",
): ImplementationWitness => {
  const operationNodes = operationCatalog.operations.map((item, index) => ({
    node_id: `${witnessId}-operation-${index}`,
    kind: "operation" as const,
    operation_ref_id: item.operation_ref_id,
    expected_operation_sha256: item.provenance.canonical_operation_sha256,
    realizes_stage_ids: index === 0 ? ["stage-write"] : ["stage-read"],
    predicate_refs: index === 0 ? ["predicate://authorized"] : [],
  }));
  const observation = {
    node_id: `${witnessId}-observation`,
    kind: "local_observation" as const,
    observation_kind: "persistence" as const,
    assertion_ids: ["assertion-outcome"],
  };
  const edges =
    shape === "chain" && operationNodes.length > 1
      ? [
          {
            edge_id: `${witnessId}-data`,
            kind: "data" as const,
            from: operationNodes[0]!.node_id,
            to: operationNodes[1]!.node_id,
            from_selector: "$.id",
            to_selector: "$.id",
            transform_ref: "projection://identity",
          },
          {
            edge_id: `${witnessId}-order`,
            kind: "order" as const,
            from: operationNodes.at(-1)!.node_id,
            to: observation.node_id,
            relation: "read_after_write" as const,
          },
        ]
      : [
          {
            edge_id: `${witnessId}-order`,
            kind: "order" as const,
            from: operationNodes[0]!.node_id,
            to: observation.node_id,
            relation: "read_after_write" as const,
          },
        ];
  return {
    witness_id: witnessId,
    purpose: "accepted",
    nodes: [...operationNodes, observation],
    edges,
    satisfies: {
      precondition_ids: ["precondition-authorized"],
      assertion_ids: ["assertion-outcome"],
      effect_ids: ["effect-notification"],
      rejection_ids: ["rejection-forbidden"],
      freshness_ids: ["freshness-read"],
    },
    evidence_receipt_ref_ids: [],
  };
};

const semanticFixture = (
  legacyCatalog: AtomicOperationCatalog,
  nativeCatalog: AtomicOperationCatalog,
): { readonly register: AcceptedIntentV2; readonly intent: CapabilityIntent } => {
  const implementations: readonly ImplementationDefinition[] = [
    {
      backend: "legacy_symfony",
      claim: "supported",
      reason_code: null,
      witnesses: [witness("legacy-witness", legacyCatalog, "single")],
    },
    {
      backend: "native_effect",
      claim: "supported",
      reason_code: null,
      witnesses: [
        witness(
          "native-witness",
          nativeCatalog,
          nativeCatalog.operations.length > 1 ? "chain" : "single",
        ),
      ],
    },
  ];
  const withoutDigest = {
    intent_ref_id: "intent://test:composition:v1",
    intent_revision: "composition-v1",
    source_ref_ids: ["design-specs/0078"],
    source_v1_selection: null,
    semantic_stages: [
      { stage_id: "stage-write", kind: "command" as const, source_step_ids: ["write"] },
      { stage_id: "stage-read", kind: "query" as const, source_step_ids: ["read"] },
    ],
    required_preconditions: [
      {
        precondition_id: "precondition-authorized",
        predicate_ref: "predicate://authorized",
        subject: "actor" as const,
      },
    ],
    warranted_outcomes: [
      {
        assertion_id: "assertion-outcome",
        semantic_path: "$.status",
        predicate: "equals" as const,
        expected_json: '"accepted"',
        visibility: "user" as const,
      },
    ],
    side_effects: [
      {
        effect_id: "effect-notification",
        kind: "notification",
        cardinality: { min: 1, max: 1 },
        order_after_stage_id: "stage-write",
        required_claim: "requested" as const,
      },
    ],
    rejections: [
      {
        rejection_id: "rejection-forbidden",
        trigger_predicate_ref: "predicate://forbidden",
        boundary_semantic: "not_found",
        disclosure: "conceal_existence" as const,
        must_not_change_state: true,
        must_not_request_effects: true,
      },
    ],
    freshness: [
      {
        freshness_id: "freshness-read",
        mode: "read_after_write" as const,
        write_stage_id: "stage-write",
        observation_stage_id: "stage-read",
        assertion_ids: ["assertion-outcome"],
      },
    ],
    implementations,
  };
  const intent: CapabilityIntent = {
    ...withoutDigest,
    intent_digest: sha256(canonicalJson(withoutDigest)),
  };
  return {
    intent,
    register: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      schema_version: "functional-parity-accepted-intent/v2",
      source_authority: pin,
      source_v1_intents: [],
      predicates: [
        {
          predicate_ref: "predicate://authorized",
          implies: [],
          source_ref_ids: ["design-specs/0078"],
        },
        {
          predicate_ref: "predicate://forbidden",
          implies: [],
          source_ref_ids: ["design-specs/0078"],
        },
      ],
      projections: [
        {
          projection_ref: "projection://identity",
          input_selector: "$.id",
          output_selector: "$.id",
          source_ref_ids: ["design-specs/0078"],
        },
      ],
      intents: [intent],
      migration_diagnostics: [],
    },
  };
};

const claim = (
  id: string,
  kind: CapabilityEvidenceClaim["kind"],
  refs: Partial<
    Pick<
      CapabilityEvidenceClaim,
      | "witness_id"
      | "node_id"
      | "precondition_id"
      | "assertion_id"
      | "effect_id"
      | "rejection_id"
      | "freshness_id"
    >
  > = {},
): CapabilityEvidenceClaim => ({
  claim_id: id,
  kind,
  witness_id: refs.witness_id ?? null,
  node_id: refs.node_id ?? null,
  precondition_id: refs.precondition_id ?? null,
  assertion_id: refs.assertion_id ?? null,
  effect_id: refs.effect_id ?? null,
  rejection_id: refs.rejection_id ?? null,
  freshness_id: refs.freshness_id ?? null,
  artifact: { artifact_digest: sha256(`artifact:${id}`), artifact_pointer: `artifacts/${id}.json` },
});

const evidence = (
  intent: CapabilityIntent,
  catalogs: readonly AtomicOperationCatalog[],
  omittedKinds: readonly CapabilityEvidenceClaim["kind"][] = [],
): CapabilityEvidenceV2 => {
  const receipts = catalogs.map((item) => {
    const implementation = intent.implementations.find(
      (candidate) => candidate.backend === item.backend,
    )!;
    const nodes = implementation.witnesses.flatMap((item) => item.nodes);
    const witnessId = implementation.witnesses[0]!.witness_id;
    const claims = [
      ...nodes.flatMap((node) =>
        node.kind === "operation"
          ? [
              claim(`${item.backend}-${node.node_id}`, "operation_observed", {
                witness_id: witnessId,
                node_id: node.node_id,
              }),
            ]
          : [],
      ),
      claim(`${item.backend}-authorization`, "authorization_observed", {
        witness_id: witnessId,
        precondition_id: "precondition-authorized",
      }),
      claim(`${item.backend}-outcome`, "boundary_observation", {
        witness_id: witnessId,
        assertion_id: "assertion-outcome",
      }),
      claim(`${item.backend}-effect`, "effect_requested", {
        witness_id: witnessId,
        effect_id: "effect-notification",
      }),
      claim(`${item.backend}-rejection`, "rejection_observed", {
        witness_id: witnessId,
        rejection_id: "rejection-forbidden",
      }),
      claim(`${item.backend}-freshness`, "fresh_read_observed", {
        witness_id: witnessId,
        freshness_id: "freshness-read",
      }),
    ].filter((item) => !omittedKinds.includes(item.kind));
    return {
      receipt_ref_id: stableId("receipt", { backend: item.backend, intent: intent.intent_ref_id }),
      backend: item.backend,
      intent_ref_id: intent.intent_ref_id,
      intent_revision: intent.intent_revision,
      implementation_digest: sha256(canonicalJson(implementation)),
      backend_revision_ref: item.source_revision_ref,
      openapi_sha256: item.openapi_sha256,
      operation_sha256: item.operations.map(
        (operation) => operation.provenance.canonical_operation_sha256,
      ),
      runner_digest: sha256("runner"),
      fixture_digest: sha256("fixture"),
      result: "passed" as const,
      exit_code: 0,
      claims,
    };
  });
  const value: CapabilityEvidenceV2 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-capability-runtime-evidence/v2",
    source_authority: pin,
    receipts,
  };
  expect(validateCapabilityEvidenceV2(value)).toBe(true);
  return value;
};

const metadata = (overrides: Partial<LegacyMetadataRecord> = {}): LegacyMetadataRecord => ({
  resource_class_ref: "App\\Resource",
  operation_name: "Get",
  method: "GET",
  uri_template: "/things",
  operation_id: "thing.get",
  security_expression: null,
  security_post_denormalize: null,
  status: 200,
  input_ref: null,
  output_ref: null,
  provider_ref: null,
  processor_ref: null,
  read: true,
  deserialize: false,
  validate: false,
  output: true,
  validation_groups: [],
  source_ref_ids: ["apps/server/src/Resource.php#L1-L2"],
  ...overrides,
});

test("extractor preserves root inheritance, OR alternatives, AND requirements, and optional security", () => {
  const bytes = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "security", version: "1" },
    components: {
      securitySchemes: {
        JWT: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", in: "header", name: "X-Key" },
      },
    },
    security: [{ JWT: [] }, { key: [] }],
    paths: {
      "/inherit": { get: operation("security.inherit") },
      "/and": { get: operation("security.and", [{ JWT: [], key: [] }]) },
      "/optional": { get: operation("security.optional", [{}, { JWT: [] }]) },
      "/public": { get: operation("security.public", []) },
    },
  });
  const result = extractAtomicOperationCatalog({
    backend: "native_effect",
    openapiBytes: bytes,
    generatorRef: "test",
    sourceRevisionRef: "test",
  });
  const byId = new Map(result.operations.map((item) => [item.operation_id, item.security]));
  expect(byId.get("security.inherit")).toMatchObject({ effective_from: "root", mode: "required" });
  expect(byId.get("security.inherit")!.alternatives).toHaveLength(2);
  expect(byId.get("security.and")!.alternatives[0]!.all_of).toHaveLength(2);
  expect(byId.get("security.optional")).toMatchObject({
    effective_from: "operation",
    mode: "optional",
  });
  expect(byId.get("security.public")).toMatchObject({ mode: "none", alternatives: [] });
});

test("schema references canonicalize to a stable resolved representation", () => {
  const root = {
    components: {
      schemas: {
        Value: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
  };
  expect(canonicalizeOpenApiSchema(root, { $ref: "#/components/schemas/Value" })).toEqual({
    $resolved: canonicalizeOpenApiSchema(root, root.components.schemas.Value),
  });
});

test("extractor rejects missing and duplicate operation identifiers", () => {
  const missing = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "missing", version: "1" },
    paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
  });
  expect(() =>
    extractAtomicOperationCatalog({
      backend: "native_effect",
      openapiBytes: missing,
      generatorRef: "test",
      sourceRevisionRef: "test",
    }),
  ).toThrow("MISSING_OPERATION_ID:GET /a");
  const duplicate = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "duplicate", version: "1" },
    paths: { "/a": { get: operation("same") }, "/b": { post: operation("same") } },
  });
  expect(() =>
    extractAtomicOperationCatalog({
      backend: "native_effect",
      openapiBytes: duplicate,
      generatorRef: "test",
      sourceRevisionRef: "test",
    }),
  ).toThrow("DUPLICATE_OPERATION_ID:same");
});

test("legacy reconciliation rejects ambiguous mappings and explicit security conflicts", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "legacy", version: "1" },
    paths: { "/api/things": { get: operation("thing.get") } },
  };
  expect(() =>
    enrichLegacyOpenApi(document, [
      metadata({ operation_id: "one" }),
      metadata({ operation_id: "two" }),
    ]),
  ).toThrow("AMBIGUOUS_METADATA_MAPPING:GET /api/things");
  const secured = {
    ...document,
    paths: { "/api/things": { get: operation("thing.get", [{ JWT: [] }]) } },
  };
  expect(() =>
    enrichLegacyOpenApi(secured, [metadata({ security_expression: "PUBLIC_ACCESS" })]),
  ).toThrow("SECURITY_METADATA_CONFLICT:thing.get");
});

test("different finite operation graphs are equivalent when current claims warrant the same semantics", () => {
  const legacy = catalog("legacy_symfony", ["legacy.execute"]);
  const native = catalog("native_effect", ["native.start", "native.read"]);
  const { register, intent } = semanticFixture(legacy, native);
  const report = compareCapabilityIntent(
    register,
    intent,
    legacy,
    native,
    evidence(intent, [legacy, native]),
  );
  expect(report.equivalence).toBe("equivalent");
  expect(report.legacy.claim).toBe("supported");
  expect(report.native.claim).toBe("supported");
  expect(report.diagnostics).toEqual([]);
});

test("equal route sets are not equivalent when one witness omits an outcome", () => {
  const legacy = catalog("legacy_symfony", ["shared.execute"], { sharedPath: true });
  const native = catalog("native_effect", ["shared.execute"], { sharedPath: true });
  const fixture = semanticFixture(legacy, native);
  const nativeImplementation = fixture.intent.implementations.find(
    (item) => item.backend === "native_effect",
  )!;
  const incompleteNative = {
    ...nativeImplementation,
    witnesses: nativeImplementation.witnesses.map((item) => ({
      ...item,
      satisfies: { ...item.satisfies, assertion_ids: [] },
    })),
  };
  const intent = {
    ...fixture.intent,
    implementations: fixture.intent.implementations.map((item) =>
      item.backend === "native_effect" ? incompleteNative : item,
    ),
  };
  const register = { ...fixture.register, intents: [intent] };
  const report = compareCapabilityIntent(
    register,
    intent,
    legacy,
    native,
    evidence(intent, [legacy, native]),
  );
  expect(report.equivalence).toBe("not_equivalent");
  expect(report.native.claim).toBe("unsupported");
  expect(report.native.diagnostics.map((item) => item.code)).toContain("MISSING_OUTCOME");
});

test("missing authorization, effect, and freshness claims remain unknown", () => {
  const legacy = catalog("legacy_symfony", ["legacy.execute"]);
  const native = catalog("native_effect", ["native.execute"]);
  const { register, intent } = semanticFixture(legacy, native);
  const report = compareCapabilityIntent(
    register,
    intent,
    legacy,
    native,
    evidence(
      intent,
      [legacy, native],
      ["authorization_observed", "effect_requested", "fresh_read_observed"],
    ),
  );
  expect(report.equivalence).toBe("unknown");
  expect(report.native.missing_claim_kinds).toEqual([
    "authorization_observed",
    "effect_requested",
    "fresh_read_observed",
  ]);
  expect(report.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining([
      "AUTHORIZATION_UNWARRANTED",
      "EFFECT_CLAIM_UNWARRANTED",
      "FRESHNESS_UNWARRANTED",
    ]),
  );
});

test("claim scope and operation provenance are validated against each backend witness", () => {
  const legacy = catalog("legacy_symfony", ["legacy.execute"]);
  const native = catalog("native_effect", ["native.execute"]);
  const { register, intent } = semanticFixture(legacy, native);
  const valid = evidence(intent, [legacy, native]);
  const invalidScope: CapabilityEvidenceV2 = {
    ...valid,
    receipts: valid.receipts.map((receipt) =>
      receipt.backend === "native_effect"
        ? {
            ...receipt,
            claims: receipt.claims.map((item) =>
              item.kind === "boundary_observation"
                ? { ...item, witness_id: "different-witness" }
                : item,
            ),
          }
        : receipt,
    ),
  };
  expect(validateCapabilityEvidenceV2(invalidScope)).toBe(true);
  const scopeReport = compareCapabilityIntent(register, intent, legacy, native, invalidScope);
  expect(scopeReport.equivalence).toBe("unknown");
  expect(scopeReport.native.diagnostics.map((item) => item.code)).toContain("CLAIM_SCOPE_INVALID");

  const staleOperation: CapabilityEvidenceV2 = {
    ...valid,
    receipts: valid.receipts.map((receipt) =>
      receipt.backend === "native_effect"
        ? { ...receipt, operation_sha256: [sha256("stale-operation")] }
        : receipt,
    ),
  };
  const staleReport = compareCapabilityIntent(register, intent, legacy, native, staleOperation);
  expect(staleReport.equivalence).toBe("unknown");
  expect(staleReport.native.evidence_status).toBe("stale");
  expect(staleReport.native.diagnostics.map((item) => item.code)).toContain("RECEIPT_STALE");
});

test("graph validation rejects duplicates, dangling edges, and cycles across edge kinds", () => {
  const legacy = catalog("legacy_symfony", ["legacy.execute"]);
  const native = catalog("native_effect", ["native.execute"]);
  const { register, intent } = semanticFixture(legacy, native);
  const implementation = intent.implementations[0]!;
  const original = implementation.witnesses[0]!;
  const nodes = [
    ...original.nodes,
    { ...original.nodes[0]!, predicate_refs: ["predicate://missing"] },
  ];
  const cyclic: ImplementationDefinition = {
    ...implementation,
    witnesses: [
      {
        ...original,
        nodes,
        edges: [
          ...original.edges,
          {
            edge_id: "cycle-data",
            kind: "data",
            from: original.nodes.at(-1)!.node_id,
            to: original.nodes[0]!.node_id,
            from_selector: "$.id",
            to_selector: "$.id",
            transform_ref: "projection://missing",
          },
          {
            edge_id: "dangling-authority",
            kind: "authority",
            from: "missing-node",
            to: original.nodes[0]!.node_id,
            precondition_id: "precondition-authorized",
          },
        ],
      },
    ],
  };
  const details = validateIntentGraph(register, intent, cyclic, legacy).map((item) => item.detail);
  expect(details).toEqual(
    expect.arrayContaining([
      expect.stringContaining("duplicate node identifiers"),
      expect.stringContaining("dangling endpoint"),
      expect.stringContaining("contains a cycle"),
      expect.stringContaining("unknown transform"),
      expect.stringContaining("unknown predicate"),
    ]),
  );
});

test("a large operation vocabulary loses to a smaller complete composition", () => {
  const legacy = catalog(
    "legacy_symfony",
    Array.from({ length: 64 }, (_, index) => `legacy.${index}`),
  );
  const native = catalog("native_effect", ["native.complete"]);
  const fixture = semanticFixture(legacy, native);
  const legacyImplementation = fixture.intent.implementations.find(
    (item) => item.backend === "legacy_symfony",
  )!;
  const incompleteLegacy = {
    ...legacyImplementation,
    witnesses: legacyImplementation.witnesses.map((item) => ({
      ...item,
      satisfies: { ...item.satisfies, effect_ids: [] },
    })),
  };
  const intent = {
    ...fixture.intent,
    implementations: fixture.intent.implementations.map((item) =>
      item.backend === "legacy_symfony" ? incompleteLegacy : item,
    ),
  };
  const register = { ...fixture.register, intents: [intent] };
  const report = compareCapabilityIntent(
    register,
    intent,
    legacy,
    native,
    evidence(intent, [legacy, native]),
  );
  expect(report.equivalence).toBe("not_equivalent");
  expect(report.legacy.claim).toBe("unsupported");
  expect(report.native.claim).toBe("supported");
});

test("v1 receipts retain journey execution facts but cannot become v2 claim evidence", () => {
  const value = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-runtime-evidence/v1",
    receipts: [
      {
        receipt_ref_id: `receipt-${"2".repeat(64)}`,
        journey_ref_id: "intent://test:journey:v1",
        step_ids: ["step-one"],
        legacy_revision_ref_id: "rev-legacy:test",
        mono_revision_ref_id: "rev-mono:test",
        runner_source_ref_ids: [`src-${"3".repeat(64)}`],
        runner_digest: sha256("runner"),
        fixture_digest: sha256("fixture"),
        environment_kind: "local_disposable",
        exit_code: 0,
        result: "passed",
        artifact_digest: sha256("artifact"),
      },
    ],
  };
  const migrated = migrateRuntimeEvidenceV1(value);
  expect(migrated).toEqual([
    {
      receipt_ref_id: `receipt-${"2".repeat(64)}`,
      journey_ref_id: "intent://test:journey:v1",
      kind: "journey_executed",
      artifact_digest: sha256("artifact"),
      runner_source_ref_ids: [`src-${"3".repeat(64)}`],
    },
  ]);
  expect(migrated[0]).not.toHaveProperty("backend");
  expect(migrated[0]).not.toHaveProperty("claims");
});

test("artifact generation is deterministic and retains explicit migration gaps", () => {
  const digest = "4".repeat(64);
  const source = `src-${"5".repeat(64)}`;
  const acceptedV1 = {
    schema_version: "functional-parity-accepted-intent/v1",
    intents: [],
    journeys: [
      {
        journey_ref_id: "intent://test:journey:v1",
        journey_key: "test-journey",
        intent_ref_id: "intent://test:journey:v1",
        journey_revision: "journey-v1",
        journey_digest: `sha256:${digest}`,
        selected_revision_ref_ids: ["rev-legacy:test", "rev-mono:test"],
        source_ref_ids: [source],
        steps: [
          {
            step_id: "step-one",
            surface: "api_operation",
            row_ids: [`row-${"6".repeat(64)}`],
            canonical_signatures: ["GET /api/test"],
            expected_contract_ref: "design-spec:0078",
            runtime_evidence_ref_ids: [],
          },
        ],
        coverage_scope: "user_visible",
      },
    ],
  };
  const evidenceV1 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-runtime-evidence/v1",
    receipts: [
      {
        receipt_ref_id: `receipt-${"7".repeat(64)}`,
        journey_ref_id: "intent://test:journey:v1",
        step_ids: ["step-one"],
        legacy_revision_ref_id: "rev-legacy:test",
        mono_revision_ref_id: "rev-mono:test",
        runner_source_ref_ids: [source],
        runner_digest: sha256("runner"),
        fixture_digest: sha256("fixture"),
        environment_kind: "local_disposable",
        exit_code: 0,
        result: "passed",
        artifact_digest: sha256("artifact"),
      },
    ],
  };
  const legacyBytes = openApi(["legacy.execute"]);
  const nativeBytes = openApi(["native.execute"]);
  const input = {
    legacyOpenApiBytes: legacyBytes,
    nativeOpenApiBytes: nativeBytes,
    intentAuthority: acceptedV1,
    intentPin: { ...pin, source_schema_version: "functional-parity-accepted-intent/v1" },
    evidenceAuthority: evidenceV1,
    evidencePin: { ...pin, source_schema_version: "functional-parity-runtime-evidence/v1" },
    sourceRevisionRef: "test-revision",
  };
  const first = generateCapabilityArtifacts(input);
  const second = generateCapabilityArtifacts(input);
  expect(first.bytes).toEqual(second.bytes);
  expect(first.migratedIntent.source_v1_intents).toEqual([]);
  expect(first.migratedIntent.intents[0]!.source_v1_selection).toMatchObject({
    steps: [{ step_id: "step-one", row_ids: [`row-${"6".repeat(64)}`] }],
  });
  expect(first.migratedIntent.migration_diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining([
      "MISSING_OUTCOME_ASSERTION",
      "MISSING_EFFECT_ASSERTION",
      "MISSING_FRESHNESS_ASSERTION",
      "MISSING_WITNESS_BINDING",
      "MISSING_CLAIM_SPECIFIC_EVIDENCE",
    ]),
  );
  expect(first.report.rows.every((item) => item.equivalence === "unknown")).toBe(true);
});
