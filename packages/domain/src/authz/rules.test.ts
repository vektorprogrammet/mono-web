import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import {
  AuthzRuleId,
  AuthzTagAssignmentId,
  AuthzTagId,
  decodeAuthzRule,
  type AuthzRule,
  type AuthzTagAssignment,
} from "./schema.js";
import {
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
  readonly slot?:
    | "EconomyDepartmentApprovalGrant"
    | "EconomyGlobalReceiptApprovalGrant";
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
