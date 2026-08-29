import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import {
  AuthzRuleId,
  AuthzTagAssignmentId,
  AuthzTagId,
  CAPABILITY_IDS,
  decodeAuthzRule,
  type AuthzCapabilityId,
  type AuthzEvidenceSlot,
  type AuthzRule,
  type AuthzRuleEffectKind,
  type AuthzTagAssignment,
} from "./schema.js";
import {
  applicableAuthzRules,
  composeCapabilityEvidence,
  evaluateCapabilityRequirements,
  resolveCapabilityParameterFills,
  type AuthzApplicabilityFacts,
  type RuleReceptiveEvidence,
} from "./rules.js";
const authorizationInstant = "2030-06-15T12:00:00.000Z";
const activeStart = "2030-01-01T00:00:00.000Z";
const person = PersonId.make("authz-person");
const otherPerson = PersonId.make("authz-other-person");
const department = DepartmentId.make("authz-department");
const otherDepartment = DepartmentId.make("authz-other-department");
const tagId = AuthzTagId.make("authz-tag");
const otherTagId = AuthzTagId.make("authz-other-tag");

const approvalRule = (options: {
  readonly ruleId: string;
  readonly subject?: AuthzRule["subject"];
  readonly scope?: AuthzRule["scope"];
  readonly slot?: "EconomyDepartmentApprovalGrant" | "EconomyGlobalReceiptApprovalGrant";
  readonly startAt?: string;
  readonly endAt?: string | null;
}): AuthzRule => {
  const slot = options.slot ?? "EconomyGlobalReceiptApprovalGrant";
  return {
    ruleId: AuthzRuleId.make(options.ruleId),
    capabilityId: "approveReceipt",
    effectKind: "delegate",
    subject: options.subject ?? { _tag: "Person", personId: person },
    scope: options.scope ?? { _tag: "Global" },
    params:
      slot === "EconomyDepartmentApprovalGrant"
        ? { slot: "EconomyDepartmentApprovalGrant" }
        : { slot: "EconomyGlobalReceiptApprovalGrant" },
    startAt: options.startAt ?? activeStart,
    endAt: options.endAt ?? null,
    revision: 0,
  };
};

const paymentRule = (options: {
  readonly ruleId: string;
  readonly paymentAccountCiphertext: string;
  readonly subject?: AuthzRule["subject"];
  readonly scope?: AuthzRule["scope"];
}): AuthzRule => ({
  ruleId: AuthzRuleId.make(options.ruleId),
  capabilityId: "submitReceipt",
  effectKind: "delegate",
  subject: options.subject ?? { _tag: "Person", personId: person },
  scope: options.scope ?? { _tag: "Receipt" },
  params: {
    slot: "EconomyPaymentAuthority",
    paymentAccountCiphertext: options.paymentAccountCiphertext,
  },
  startAt: activeStart,
  endAt: null,
  revision: 0,
});

const tagAssignment = (options: {
  readonly assignmentId: string;
  readonly tagId?: typeof tagId;
  readonly personId?: typeof person;
  readonly startAt?: string;
  readonly endAt?: string | null;
}): AuthzTagAssignment => ({
  assignmentId: AuthzTagAssignmentId.make(options.assignmentId),
  tagId: options.tagId ?? tagId,
  personId: options.personId ?? person,
  startAt: options.startAt ?? activeStart,
  endAt: options.endAt ?? null,
  revision: 0,
});

const applicabilityFacts = (
  overrides: Partial<AuthzApplicabilityFacts> = {},
): AuthzApplicabilityFacts => ({
  personId: person,
  authorizationInstant,
  requestScope: { domain: "Receipt", departmentId: department },
  tagAssignments: [],
  ...overrides,
});

type CapabilityTruthTableRow = {
  readonly name: string;
  readonly capabilityId: AuthzCapabilityId;
  readonly ruleId: string;
  readonly ruleCapabilityId: AuthzCapabilityId;
  readonly directFacts: RuleReceptiveEvidence;
  readonly activity: {
    readonly phase: "before" | "start" | "end" | "expired";
    readonly startAt: string;
    readonly endAt: string | null;
  };
  readonly effectKind: {
    readonly value: AuthzRuleEffectKind;
    readonly declared: boolean;
  };
  readonly subjectMatch: {
    readonly kind: "Person" | "Tag";
    readonly matches: boolean;
    readonly assignment: "none" | "active" | "detached";
  };
  readonly scopeMatch: {
    readonly kind: "Department" | "Receipt" | "Global";
    readonly matches: boolean;
    readonly requestDepartment: "present" | "missing";
  };
  readonly declaredSlotMatch: {
    readonly slot: AuthzEvidenceSlot;
    readonly matches: boolean;
  };
  readonly expectedApplicableRules: ReadonlyArray<string>;
  readonly expectedContributingRules: ReadonlyArray<string>;
  readonly expectedEvidenceIdentity: "same" | "changed";
  readonly expectedDecision:
    | { readonly _tag: "Allow" }
    | { readonly _tag: "Deny"; readonly reason: "Ambiguous" | "RequirementFailed" };
};

const activity = {
  before: {
    phase: "before",
    startAt: "2030-06-16T00:00:00.000Z",
    endAt: null,
  },
  start: {
    phase: "start",
    startAt: authorizationInstant,
    endAt: null,
  },
  end: {
    phase: "end",
    startAt: activeStart,
    endAt: authorizationInstant,
  },
  expired: {
    phase: "expired",
    startAt: activeStart,
    endAt: "2030-06-14T00:00:00.000Z",
  },
} as const;

const capabilityTruthTable = [
  {
    name: "approve: delegate starts at the authorization instant",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-start",
    ruleCapabilityId: "approveReceipt",
    directFacts: { approvalGrants: [] },
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: ["truth-approve-start"],
    expectedContributingRules: ["truth-approve-start"],
    expectedEvidenceIdentity: "changed",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: rule is still before its start",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-before",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.before,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: rule is inactive at its exact end",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-end",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.end,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Receipt", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: expired rule is inactive",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-expired",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.expired,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: person subject mismatch is inert",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-person-mismatch",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: false, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: active tag and Department scope contribute",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-tag-active",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Tag", matches: true, assignment: "active" },
    scopeMatch: { kind: "Department", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyDepartmentApprovalGrant", matches: true },
    expectedApplicableRules: ["truth-approve-tag-active"],
    expectedContributingRules: ["truth-approve-tag-active"],
    expectedEvidenceIdentity: "changed",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: detached tag is inert for Receipt scope",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-tag-detached",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Tag", matches: false, assignment: "detached" },
    scopeMatch: { kind: "Receipt", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: Department scope mismatch is inert",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-department-mismatch",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Department", matches: false, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyDepartmentApprovalGrant", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "approve: submit capability and slot mismatch are inert",
    capabilityId: "approveReceipt",
    ruleId: "truth-approve-capability-mismatch",
    ruleCapabilityId: "submitReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Receipt", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: false },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: Receipt delegate contributes",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-receipt",
    ruleCapabilityId: "submitReceipt",
    directFacts: { paymentAuthorities: [] },
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Receipt", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: true },
    expectedApplicableRules: ["truth-submit-receipt"],
    expectedContributingRules: ["truth-submit-receipt"],
    expectedEvidenceIdentity: "changed",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: person subject mismatch is inert for Global scope",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-person-mismatch",
    ruleCapabilityId: "submitReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: false, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: matching Department scope contributes",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-department",
    ruleCapabilityId: "submitReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Department", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: true },
    expectedApplicableRules: ["truth-submit-department"],
    expectedContributingRules: ["truth-submit-department"],
    expectedEvidenceIdentity: "changed",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: Department scope mismatch is inert",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-department-mismatch",
    ruleCapabilityId: "submitReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Department", matches: false, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: true },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: approve capability and slot mismatch are inert",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-capability-mismatch",
    ruleCapabilityId: "approveReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: false },
    expectedApplicableRules: [],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
  {
    name: "submit: missing receipt Department denies an applicable delegate",
    capabilityId: "submitReceipt",
    ruleId: "truth-submit-missing-department",
    ruleCapabilityId: "submitReceipt",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: true },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Receipt", matches: true, requestDepartment: "missing" },
    declaredSlotMatch: { slot: "EconomyPaymentAuthority", matches: true },
    expectedApplicableRules: ["truth-submit-missing-department"],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Deny", reason: "RequirementFailed" },
  },
  {
    name: "review: undeclared delegate slot remains inert",
    capabilityId: "reviewApplicants",
    ruleId: "truth-review-undeclared-slot",
    ruleCapabilityId: "reviewApplicants",
    directFacts: {},
    activity: activity.start,
    effectKind: { value: "delegate", declared: false },
    subjectMatch: { kind: "Person", matches: true, assignment: "none" },
    scopeMatch: { kind: "Global", matches: true, requestDepartment: "present" },
    declaredSlotMatch: { slot: "EconomyGlobalReceiptApprovalGrant", matches: false },
    expectedApplicableRules: ["truth-review-undeclared-slot"],
    expectedContributingRules: [],
    expectedEvidenceIdentity: "same",
    expectedDecision: { _tag: "Allow" },
  },
] as const satisfies ReadonlyArray<CapabilityTruthTableRow>;

const makeTruthTableRule = (row: CapabilityTruthTableRow): AuthzRule => {
  const subject =
    row.subjectMatch.kind === "Person"
      ? {
          _tag: "Person" as const,
          personId: row.subjectMatch.matches ? person : otherPerson,
        }
      : { _tag: "Tag" as const, tagId };
  const scope =
    row.scopeMatch.kind === "Department"
      ? {
          _tag: "Department" as const,
          departmentId: row.scopeMatch.matches ? department : otherDepartment,
        }
      : { _tag: row.scopeMatch.kind };
  const params =
    row.declaredSlotMatch.slot === "EconomyPaymentAuthority"
      ? {
          slot: "EconomyPaymentAuthority" as const,
          paymentAccountCiphertext: "truth-table-ciphertext",
        }
      : { slot: row.declaredSlotMatch.slot };

  return {
    ruleId: AuthzRuleId.make(row.ruleId),
    capabilityId: row.ruleCapabilityId,
    effectKind: row.effectKind.value,
    subject,
    scope,
    params,
    startAt: row.activity.startAt,
    endAt: row.activity.endAt,
    revision: 0,
  } as unknown as AuthzRule;
};

const makeTruthTableFacts = (row: CapabilityTruthTableRow): AuthzApplicabilityFacts =>
  applicabilityFacts({
    requestScope:
      row.scopeMatch.requestDepartment === "present"
        ? { domain: "Receipt", departmentId: department }
        : { domain: "Receipt" },
    tagAssignments:
      row.subjectMatch.kind === "Tag" && row.subjectMatch.assignment !== "none"
        ? [
            tagAssignment({
              assignmentId: `${row.ruleId}-assignment`,
              endAt: row.subjectMatch.assignment === "detached" ? authorizationInstant : undefined,
            }),
          ]
        : [],
  });

describe("authorization rule applicability at the public composer", () => {
  it("re-filters caller-supplied rules against person and department scope", () => {
    const directEvidence = {} satisfies RuleReceptiveEvidence;
    const composed = composeCapabilityEvidence(
      "approveReceipt",
      directEvidence,
      [
        approvalRule({
          ruleId: "cross-person",
          subject: { _tag: "Person", personId: otherPerson },
        }),
        approvalRule({
          ruleId: "cross-department",
          scope: { _tag: "Department", departmentId: otherDepartment },
          slot: "EconomyDepartmentApprovalGrant",
        }),
      ],
      applicabilityFacts(),
    );

    expect(composed.evidence).toBe(directEvidence);
    expect(composed.contributingRuleIds).toEqual([]);
    expect(composed.decision).toEqual({ _tag: "Allow", value: directEvidence });
  });

  it("re-filters tag rules against the evaluated person's active assignments", () => {
    const rule = approvalRule({
      ruleId: "tag-delegate",
      subject: { _tag: "Tag", tagId },
    });
    const inactive = composeCapabilityEvidence(
      "approveReceipt",
      {},
      [rule],
      applicabilityFacts({
        tagAssignments: [
          tagAssignment({ assignmentId: "wrong-person", personId: otherPerson }),
          tagAssignment({ assignmentId: "wrong-tag", tagId: otherTagId }),
          tagAssignment({ assignmentId: "ended", endAt: authorizationInstant }),
        ],
      }),
    );
    expect(inactive.contributingRuleIds).toEqual([]);

    const active = composeCapabilityEvidence(
      "approveReceipt",
      {},
      [rule],
      applicabilityFacts({
        tagAssignments: [tagAssignment({ assignmentId: "active" })],
      }),
    );
    expect(active.contributingRuleIds).toEqual([AuthzRuleId.make("tag-delegate")]);
    expect(active.evidence.approvalGrants).toHaveLength(1);
  });

  it("treats a rule as inactive at its exact endAt instant", () => {
    const directEvidence = {} satisfies RuleReceptiveEvidence;
    const composed = composeCapabilityEvidence(
      "approveReceipt",
      directEvidence,
      [approvalRule({ ruleId: "ended-rule", endAt: authorizationInstant })],
      applicabilityFacts(),
    );

    expect(composed.evidence).toBe(directEvidence);
    expect(composed.contributingRuleIds).toEqual([]);
  });

  it("preserves evidence object identity when no rule contributes", () => {
    const directEvidence = { paymentAuthorities: [] } satisfies RuleReceptiveEvidence;
    const composed = composeCapabilityEvidence(
      "submitReceipt",
      directEvidence,
      [],
      applicabilityFacts(),
    );

    expect(composed.evidence).toBe(directEvidence);
    expect(composed.decision._tag).toBe("Allow");
    if (composed.decision._tag === "Allow") {
      expect(composed.decision.value).toBe(directEvidence);
    }
  });

  it("synthesizes only the frozen approval and payment delegate facts", () => {
    const approval = composeCapabilityEvidence(
      "approveReceipt",
      {},
      [
        approvalRule({
          ruleId: "approval-global",
          slot: "EconomyGlobalReceiptApprovalGrant",
        }),
        approvalRule({
          ruleId: "approval-department",
          scope: { _tag: "Department", departmentId: department },
          slot: "EconomyDepartmentApprovalGrant",
        }),
      ],
      applicabilityFacts(),
    );
    expect(approval.evidence.approvalGrants).toEqual([
      {
        approvalGrantId: "authz-rule:approval-department",
        personId: person,
        scope: { _tag: "Department", departmentId: department },
        startAt: activeStart,
        endAt: null,
        revision: 0,
      },
      {
        approvalGrantId: "authz-rule:approval-global",
        personId: person,
        scope: { _tag: "Global" },
        startAt: activeStart,
        endAt: null,
        revision: 0,
      },
    ]);

    const payment = composeCapabilityEvidence(
      "submitReceipt",
      {},
      [paymentRule({ ruleId: "payment", paymentAccountCiphertext: "ciphertext" })],
      applicabilityFacts(),
    );
    expect(payment.evidence.paymentAuthorities).toEqual([
      {
        paymentAuthorityId: "authz-rule:payment",
        personId: person,
        departmentId: department,
        paymentAccountCiphertext: "ciphertext",
        startAt: activeStart,
        endAt: null,
        revision: 0,
      },
    ]);
  });

  it("keeps reviewApplicants inert even for an unchecked JavaScript rule value", () => {
    const directEvidence = {} satisfies RuleReceptiveEvidence;
    const uncheckedReviewRule = {
      ...approvalRule({ ruleId: "unchecked-review" }),
      capabilityId: "reviewApplicants",
    } as unknown as AuthzRule;
    const composed = composeCapabilityEvidence(
      "reviewApplicants",
      directEvidence,
      [uncheckedReviewRule],
      applicabilityFacts(),
    );

    expect(composed.evidence).toBe(directEvidence);
    expect(composed.contributingRuleIds).toEqual([]);
  });
});

describe("per-capability delegate truth table", () => {
  it("covers every declared capability and each applicability boundary column", () => {
    expect([...new Set(capabilityTruthTable.map((row) => row.capabilityId))].sort()).toEqual(
      Object.keys(CAPABILITY_IDS).sort(),
    );
    expect([...new Set(capabilityTruthTable.map((row) => row.activity.phase))].sort()).toEqual([
      "before",
      "end",
      "expired",
      "start",
    ]);
    expect([...new Set(capabilityTruthTable.map((row) => row.scopeMatch.kind))].sort()).toEqual([
      "Department",
      "Global",
      "Receipt",
    ]);
    expect(
      [
        ...new Set(
          capabilityTruthTable
            .filter((row) => row.subjectMatch.kind === "Tag")
            .map((row) => row.subjectMatch.assignment),
        ),
      ].sort(),
    ).toEqual(["active", "detached"]);
    expect(
      capabilityTruthTable.filter(
        (row) =>
          row.ruleCapabilityId !== row.capabilityId &&
          (row.capabilityId === "approveReceipt" || row.capabilityId === "submitReceipt"),
      ),
    ).toHaveLength(2);
  });

  it.each(capabilityTruthTable)("$name", (row) => {
    const rule = makeTruthTableRule(row);
    const facts = makeTruthTableFacts(row);
    const declaration = CAPABILITY_IDS[row.capabilityId];

    expect(declaration.acceptedEffects.some((effect) => effect === row.effectKind.value)).toBe(
      row.effectKind.declared,
    );
    expect(
      declaration.receptiveEvidenceSlots.some((slot) => slot === row.declaredSlotMatch.slot),
    ).toBe(row.declaredSlotMatch.matches);
    expect(
      applicableAuthzRules([rule], row.capabilityId, facts).map(({ ruleId }) => ruleId),
    ).toEqual(row.expectedApplicableRules);

    const composed = composeCapabilityEvidence(row.capabilityId, row.directFacts, [rule], facts);
    expect(composed.contributingRuleIds).toEqual(row.expectedContributingRules);
    if (row.expectedEvidenceIdentity === "same") {
      expect(composed.evidence).toBe(row.directFacts);
    } else {
      expect(composed.evidence).not.toBe(row.directFacts);
    }
    expect(composed.decision).toEqual(
      row.expectedDecision._tag === "Allow"
        ? { _tag: "Allow", value: composed.evidence }
        : row.expectedDecision,
    );
  });
});

describe("authorization composition helpers", () => {
  it("collapses duplicate parameter fills and reports different values as ambiguous", () => {
    const duplicate = resolveCapabilityParameterFills([
      {
        slot: "selection",
        value: { account: "one", ordinal: 1 },
        sourceId: "rule-b",
      },
      {
        slot: "selection",
        value: { ordinal: 1, account: "one" },
        sourceId: "rule-a",
      },
      {
        slot: "selection",
        value: { ordinal: 1, account: "one" },
        sourceId: "rule-a",
      },
    ]);
    expect(duplicate).toEqual([
      {
        _tag: "Resolved",
        slot: "selection",
        value: { account: "one", ordinal: 1 },
        sourceIds: ["rule-a", "rule-b"],
      },
    ]);

    const ambiguous = resolveCapabilityParameterFills([
      { slot: "selection", value: "one", sourceId: "rule-b" },
      { slot: "selection", value: "two", sourceId: "rule-a" },
    ]);
    expect(ambiguous).toEqual([
      {
        _tag: "Ambiguous",
        slot: "selection",
        candidates: [
          { value: "one", sourceIds: ["rule-b"] },
          { value: "two", sourceIds: ["rule-a"] },
        ],
      },
    ]);
  });

  it("fails composed requirements when any ordered requirement is unsatisfied", () => {
    expect(evaluateCapabilityRequirements([])).toEqual({
      _tag: "Satisfied",
      requirements: [],
    });

    expect(
      evaluateCapabilityRequirements([
        { requirementId: "Second", satisfied: true, sourceId: "rule-b" },
        { requirementId: "First", satisfied: false, sourceId: "rule-z" },
        { requirementId: "First", satisfied: true, sourceId: "rule-a" },
      ]),
    ).toEqual({
      _tag: "Failed",
      requirements: [
        { requirementId: "First", satisfied: true, sourceId: "rule-a" },
        { requirementId: "First", satisfied: false, sourceId: "rule-z" },
        { requirementId: "Second", satisfied: true, sourceId: "rule-b" },
      ],
      failed: [{ requirementId: "First", satisfied: false, sourceId: "rule-z" }],
    });
  });

  it("preserves Ambiguous and RequirementFailed on the composed Decision", () => {
    const ambiguous = composeCapabilityEvidence("submitReceipt", {}, [], {
      ...applicabilityFacts(),
      parameterFills: [
        { slot: "paymentSelection", value: department, sourceId: "typed-stub-a" },
        { slot: "paymentSelection", value: otherDepartment, sourceId: "typed-stub-b" },
      ],
    });
    expect(ambiguous.decision).toEqual({ _tag: "Deny", reason: "Ambiguous" });

    const failedRequirement = composeCapabilityEvidence("approveReceipt", {}, [], {
      ...applicabilityFacts(),
      requirements: [
        {
          requirementId: "OperatorConfirmation",
          satisfied: false,
          sourceId: "typed-stub-requirement",
        },
      ],
    });
    expect(failedRequirement.decision).toEqual({
      _tag: "Deny",
      reason: "RequirementFailed",
    });
  });
});

describe("authorization rule decoding", () => {
  it.effect("strictly rejects unknown declarations, invalid params, and excess fields", () => {
    const encodedRule = {
      ruleId: "decoded-rule",
      capabilityId: "approveReceipt",
      effectKind: "delegate",
      subject: { _tag: "Person", personId: "authz-person" },
      scope: { _tag: "Global" },
      params: { slot: "EconomyGlobalReceiptApprovalGrant" },
      startAt: activeStart,
      endAt: null,
      revision: 0,
    } as const;
    const invalidInputs: ReadonlyArray<unknown> = [
      { ...encodedRule, capabilityId: "unknownCapability" },
      { ...encodedRule, effectKind: "parameter" },
      { ...encodedRule, scope: { _tag: "UnknownScope" } },
      { ...encodedRule, capabilityId: "reviewApplicants" },
      { ...encodedRule, params: { slot: "UnknownSlot" } },
      {
        ...encodedRule,
        params: { slot: "EconomyGlobalReceiptApprovalGrant", extra: true },
      },
      { ...encodedRule, extra: true },
    ];

    return Effect.gen(function* () {
      const decoded = yield* decodeAuthzRule(encodedRule);
      expect(decoded.ruleId).toBe("decoded-rule");
      for (const input of invalidInputs) {
        const outcome = yield* Effect.exit(decodeAuthzRule(input));
        expect(outcome._tag).toBe("Failure");
      }
    });
  });
});
