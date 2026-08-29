import type { DepartmentId, PersonId } from "../organization/schema.js";
import {
  ReceiptApprovalGrantId,
  ReceiptPaymentAuthorityId,
  type ReceiptApprovalGrant,
  type ReceiptPaymentAuthority,
} from "../receipt/authority.js";
import { compareRfc3339Instants } from "../time.js";
import { allow, deny, type Decision } from "./decision.js";
import {
  type AuthzCapabilityId,
  type AuthzRequestScope,
  type AuthzRule,
  type AuthzRuleId,
  type AuthzTagAssignment,
} from "./schema.js";

export type AuthzApplicabilityFacts = {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
  readonly requestScope: AuthzRequestScope;
  readonly tagAssignments: ReadonlyArray<AuthzTagAssignment>;
};

export const isAuthzIntervalActive = (
  interval: { readonly startAt: string; readonly endAt: string | null },
  authorizationInstant: string,
): boolean =>
  compareRfc3339Instants(interval.startAt, authorizationInstant) <= 0 &&
  (interval.endAt === null ||
    compareRfc3339Instants(authorizationInstant, interval.endAt) < 0);

export const isAuthzTagAssignmentActive = (
  assignment: AuthzTagAssignment,
  personId: PersonId,
  authorizationInstant: string,
): boolean =>
  assignment.personId === personId && isAuthzIntervalActive(assignment, authorizationInstant);

export const authzRuleSubjectApplies = (
  rule: AuthzRule,
  personId: PersonId,
  authorizationInstant: string,
  tagAssignments: ReadonlyArray<AuthzTagAssignment>,
): boolean => {
  if (rule.subject._tag === "Person") return rule.subject.personId === personId;
  return tagAssignments.some(
    (assignment) =>
      assignment.tagId === rule.subject.tagId &&
      isAuthzTagAssignmentActive(assignment, personId, authorizationInstant),
  );
};

export const authzRuleScopeApplies = (
  rule: AuthzRule,
  requestScope: AuthzRequestScope,
): boolean => {
  if (rule.scope._tag === "Global") return true;
  if (rule.scope._tag === "Receipt") return requestScope.domain === "Receipt";
  return requestScope.departmentId === rule.scope.departmentId;
};

export const isAuthzRuleApplicable = (
  rule: AuthzRule,
  capabilityId: AuthzCapabilityId,
  facts: AuthzApplicabilityFacts,
): boolean =>
  rule.capabilityId === capabilityId &&
  isAuthzIntervalActive(rule, facts.authorizationInstant) &&
  authzRuleSubjectApplies(
    rule,
    facts.personId,
    facts.authorizationInstant,
    facts.tagAssignments,
  ) &&
  authzRuleScopeApplies(rule, facts.requestScope);

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

export const applicableAuthzRules = (
  rules: ReadonlyArray<AuthzRule>,
  capabilityId: AuthzCapabilityId,
  facts: AuthzApplicabilityFacts,
): ReadonlyArray<AuthzRule> =>
  rules
    .filter((rule) => isAuthzRuleApplicable(rule, capabilityId, facts))
    .sort((left, right) => compareText(left.ruleId, right.ruleId));

export type AuthorizationParameterValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<AuthorizationParameterValue>
  | { readonly [key: string]: AuthorizationParameterValue };

export type CapabilityParameterFill<
  Slot extends string = string,
  Value extends AuthorizationParameterValue = AuthorizationParameterValue,
> = {
  readonly slot: Slot;
  readonly value: Value;
  readonly sourceId: string;
};

export type CapabilityParameterResolution<
  Slot extends string = string,
  Value extends AuthorizationParameterValue = AuthorizationParameterValue,
> =
  | {
      readonly _tag: "Resolved";
      readonly slot: Slot;
      readonly value: Value;
      readonly sourceIds: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Ambiguous";
      readonly slot: Slot;
      readonly candidates: ReadonlyArray<{
        readonly value: Value;
        readonly sourceIds: ReadonlyArray<string>;
      }>;
    };

const canonicalParameterValue = (value: AuthorizationParameterValue): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalParameterValue).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalParameterValue(entry)}`)
    .join(",")}}`;
};

export const resolveCapabilityParameterFills = <
  Slot extends string,
  Value extends AuthorizationParameterValue,
>(
  fills: ReadonlyArray<CapabilityParameterFill<Slot, Value>>,
): ReadonlyArray<CapabilityParameterResolution<Slot, Value>> => {
  const bySlot = new Map<Slot, Map<string, { value: Value; sourceIds: Array<string> }>>();
  for (const fill of fills) {
    let values = bySlot.get(fill.slot);
    if (values === undefined) {
      values = new Map();
      bySlot.set(fill.slot, values);
    }
    const canonicalValue = canonicalParameterValue(fill.value);
    const existing = values.get(canonicalValue);
    if (existing === undefined) {
      values.set(canonicalValue, { value: fill.value, sourceIds: [fill.sourceId] });
    } else if (!existing.sourceIds.includes(fill.sourceId)) {
      existing.sourceIds.push(fill.sourceId);
    }
  }

  const resolutions: Array<CapabilityParameterResolution<Slot, Value>> = [];
  for (const [slot, values] of Array.from(bySlot.entries()).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const candidates = Array.from(values.entries())
      .sort(([left], [right]) => compareText(left, right))
      .map(([, candidate]) => ({
        value: candidate.value,
        sourceIds: candidate.sourceIds.sort(compareText),
      }));
    const only = candidates[0];
    resolutions.push(
      candidates.length === 1 && only !== undefined
        ? { _tag: "Resolved", slot, value: only.value, sourceIds: only.sourceIds }
        : { _tag: "Ambiguous", slot, candidates },
    );
  }
  return resolutions;
};

export type CapabilityRequirement<RequirementId extends string = string> = {
  readonly requirementId: RequirementId;
  readonly satisfied: boolean;
  readonly sourceId: string;
};

export type CapabilityRequirementResult<RequirementId extends string = string> =
  | {
      readonly _tag: "Satisfied";
      readonly requirements: ReadonlyArray<CapabilityRequirement<RequirementId>>;
    }
  | {
      readonly _tag: "Failed";
      readonly requirements: ReadonlyArray<CapabilityRequirement<RequirementId>>;
      readonly failed: ReadonlyArray<CapabilityRequirement<RequirementId>>;
    };

export const evaluateCapabilityRequirements = <RequirementId extends string>(
  requirements: ReadonlyArray<CapabilityRequirement<RequirementId>>,
): CapabilityRequirementResult<RequirementId> => {
  const ordered = [...requirements].sort(
    (left, right) =>
      compareText(left.requirementId, right.requirementId) ||
      compareText(left.sourceId, right.sourceId),
  );
  const failed = ordered.filter((requirement) => !requirement.satisfied);
  return failed.length === 0
    ? { _tag: "Satisfied", requirements: ordered }
    : { _tag: "Failed", requirements: ordered, failed };
};

export type RuleReceptiveEvidence = {
  readonly approvalGrants?: ReadonlyArray<ReceiptApprovalGrant>;
  readonly paymentAuthorities?: ReadonlyArray<ReceiptPaymentAuthority>;
};

export type CapabilityCompilationRequestFacts = {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
  readonly departmentId?: DepartmentId;
  readonly parameterFills?: ReadonlyArray<CapabilityParameterFill>;
  readonly requirements?: ReadonlyArray<CapabilityRequirement>;
};

export type ComposedCapabilityEvidence = {
  readonly evidence: RuleReceptiveEvidence;
  readonly parameters: ReadonlyArray<CapabilityParameterResolution>;
  readonly requirements: CapabilityRequirementResult;
  readonly decision: Decision<RuleReceptiveEvidence>;
  readonly contributingRuleIds: ReadonlyArray<AuthzRuleId>;
};

const ruleFactId = (ruleId: AuthzRuleId): string => `authz-rule:${ruleId}`;

/**
 * Extends direct evidence only through frozen receptive slots. With no contributing
 * rule, `evidence` and the allowed Decision value are the original object.
 */
export const composeCapabilityEvidence = (
  capabilityId: AuthzCapabilityId,
  directEvidence: RuleReceptiveEvidence,
  applicableRules: ReadonlyArray<AuthzRule>,
  requestFacts: CapabilityCompilationRequestFacts,
): ComposedCapabilityEvidence => {
  const approvalContributions: Array<{
    readonly ruleId: AuthzRuleId;
    readonly fact: ReceiptApprovalGrant;
  }> = [];
  const paymentContributions: Array<{
    readonly ruleId: AuthzRuleId;
    readonly fact: ReceiptPaymentAuthority;
  }> = [];
  const generatedRequirements: Array<CapabilityRequirement> = [];

  for (const rule of applicableRules) {
    if (
      rule.capabilityId !== capabilityId ||
      !isAuthzIntervalActive(rule, requestFacts.authorizationInstant)
    ) {
      continue;
    }
    if (rule.capabilityId === "approveReceipt") {
      if (rule.params.slot === "EconomyGlobalReceiptApprovalGrant") {
        approvalContributions.push({
          ruleId: rule.ruleId,
          fact: {
            approvalGrantId: ReceiptApprovalGrantId.make(ruleFactId(rule.ruleId)),
            personId: requestFacts.personId,
            scope: { _tag: "Global" },
            startAt: rule.startAt,
            endAt: rule.endAt,
            revision: rule.revision,
          },
        });
      } else if (requestFacts.departmentId === undefined) {
        generatedRequirements.push({
          requirementId: "ReceiptDepartmentResolved",
          satisfied: false,
          sourceId: rule.ruleId,
        });
      } else {
        approvalContributions.push({
          ruleId: rule.ruleId,
          fact: {
            approvalGrantId: ReceiptApprovalGrantId.make(ruleFactId(rule.ruleId)),
            personId: requestFacts.personId,
            scope: { _tag: "Department", departmentId: requestFacts.departmentId },
            startAt: rule.startAt,
            endAt: rule.endAt,
            revision: rule.revision,
          },
        });
      }
    } else if (rule.capabilityId === "submitReceipt") {
      if (requestFacts.departmentId === undefined) {
        generatedRequirements.push({
          requirementId: "ReceiptDepartmentResolved",
          satisfied: false,
          sourceId: rule.ruleId,
        });
      } else {
        paymentContributions.push({
          ruleId: rule.ruleId,
          fact: {
            paymentAuthorityId: ReceiptPaymentAuthorityId.make(ruleFactId(rule.ruleId)),
            personId: requestFacts.personId,
            departmentId: requestFacts.departmentId,
            paymentAccountCiphertext: rule.params.paymentAccountCiphertext,
            startAt: rule.startAt,
            endAt: rule.endAt,
            revision: rule.revision,
          },
        });
      }
    }
  }

  approvalContributions.sort((left, right) => compareText(left.ruleId, right.ruleId));
  paymentContributions.sort((left, right) => compareText(left.ruleId, right.ruleId));

  let evidence = directEvidence;
  if (approvalContributions.length > 0) {
    evidence = {
      ...evidence,
      approvalGrants: [
        ...(evidence.approvalGrants ?? []),
        ...approvalContributions.map((contribution) => contribution.fact),
      ],
    };
  }
  if (paymentContributions.length > 0) {
    evidence = {
      ...evidence,
      paymentAuthorities: [
        ...(evidence.paymentAuthorities ?? []),
        ...paymentContributions.map((contribution) => contribution.fact),
      ],
    };
  }

  const parameters = resolveCapabilityParameterFills(requestFacts.parameterFills ?? []);
  const requirements = evaluateCapabilityRequirements([
    ...(requestFacts.requirements ?? []),
    ...generatedRequirements,
  ]);
  const ambiguous = parameters.some((resolution) => resolution._tag === "Ambiguous");
  const decision = ambiguous
    ? deny<RuleReceptiveEvidence>("Ambiguous")
    : requirements._tag === "Failed"
      ? deny<RuleReceptiveEvidence>("RequirementFailed")
      : allow(evidence);
  const contributingRuleIds = [
    ...approvalContributions.map((contribution) => contribution.ruleId),
    ...paymentContributions.map((contribution) => contribution.ruleId),
  ].sort(compareText);

  return { evidence, parameters, requirements, decision, contributingRuleIds };
};
