import { RECEIPT_DOMAIN_ID } from "../authz/access.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { DepartmentId } from "../organization/schema.js";
import { allow, deny, type Decision, type DecisionReason } from "../authz/decision.js";
import { composeCapabilityEvidence } from "../authz/rules.js";
import type { AuthzRule, AuthzTagAssignment } from "../authz/schema.js";
import {
  projectReceiptAuthority,
  selectReceiptApprovalGrant,
  type ReceiptAuthority,
} from "./authority.js";

export type ReceiptApprovalVisibility =
  | { readonly _tag: "Global" }
  | {
      readonly _tag: "Departments";
      readonly departmentIds: ReadonlyArray<DepartmentId>;
    };

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Resolves the approval projection from direct facts and rule facts at the same
 * instant. Every department-scoped rule is recomposed against that canonical
 * department, so a delegated global slot cannot escape its rule scope.
 */
export const resolveReceiptApprovalVisibility = (
  organization: OrganizationPersonAuthority,
  directAuthority: ReceiptAuthority,
  canonicalDepartmentIds: ReadonlyArray<DepartmentId>,
  rules: ReadonlyArray<AuthzRule>,
  tagAssignments: ReadonlyArray<AuthzTagAssignment>,
): Decision<ReceiptApprovalVisibility> => {
  if (directAuthority.organizationAuthority !== "Active") {
    return deny("AuthorityInactive");
  }

  const directEvidence = { approvalGrants: directAuthority.approvalGrants };
  const globalSlotRules = rules.filter(
    (rule) =>
      rule.capabilityId === "approveReceipt" &&
      rule.params.slot === "EconomyGlobalReceiptApprovalGrant",
  );
  const globalComposition = composeCapabilityEvidence(
    "approveReceipt",
    directEvidence,
    globalSlotRules,
    {
      personId: directAuthority.personId,
      authorizationInstant: directAuthority.evaluatedAt,
      requestScope: { domainId: RECEIPT_DOMAIN_ID },
      tagAssignments,
    },
  );
  let composedDenialReason: DecisionReason | undefined =
    globalComposition.decision._tag === "Deny" ? globalComposition.decision.reason : undefined;
  let inactiveGrantSeen = directAuthority.approvalGrants.length > 0;
  if (globalComposition.decision._tag === "Allow") {
    const globalAuthority = projectReceiptAuthority(
      organization,
      [],
      globalComposition.decision.value.approvalGrants ?? [],
    );
    let globalGrantSeen = false;
    for (const grant of globalAuthority.approvalGrants) {
      if (grant.scope._tag !== "Global") continue;
      globalGrantSeen = true;
      if (grant.active) return allow<ReceiptApprovalVisibility>({ _tag: "Global" });
    }
    inactiveGrantSeen ||= globalGrantSeen;
  }

  const candidateDepartments = new Map<string, DepartmentId>();
  for (const departmentId of canonicalDepartmentIds) {
    candidateDepartments.set(departmentId, departmentId);
  }
  for (const grant of directAuthority.approvalGrants) {
    if (grant.scope._tag === "Department") {
      candidateDepartments.set(grant.scope.departmentId, grant.scope.departmentId);
    }
  }
  for (const rule of rules) {
    if (rule.scope._tag === "Department") {
      candidateDepartments.set(rule.scope.departmentId, rule.scope.departmentId);
    }
  }

  const visibleDepartmentIds: Array<DepartmentId> = [];
  for (const departmentId of Array.from(candidateDepartments.values()).sort(compareText)) {
    const composition = composeCapabilityEvidence("approveReceipt", directEvidence, rules, {
      personId: directAuthority.personId,
      authorizationInstant: directAuthority.evaluatedAt,
      requestScope: { domainId: RECEIPT_DOMAIN_ID, departmentId },
      tagAssignments,
    });
    if (composition.decision._tag === "Deny") {
      composedDenialReason ??= composition.decision.reason;
      continue;
    }
    const authority = projectReceiptAuthority(
      organization,
      [],
      composition.decision.value.approvalGrants ?? [],
    );
    const selected = selectReceiptApprovalGrant(authority, departmentId);
    if (selected?.active === true) {
      visibleDepartmentIds.push(departmentId);
    } else {
      inactiveGrantSeen ||= selected !== undefined;
    }
  }

  return visibleDepartmentIds.length > 0
    ? allow<ReceiptApprovalVisibility>({
        _tag: "Departments",
        departmentIds: visibleDepartmentIds,
      })
    : composedDenialReason === undefined
      ? deny(inactiveGrantSeen ? "AuthorityInactive" : "NotInScope")
      : deny(composedDenialReason);
};
