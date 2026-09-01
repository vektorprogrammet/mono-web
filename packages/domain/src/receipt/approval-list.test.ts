import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { RECEIPT_DOMAIN_ID } from "../authz/access.js";
import { composeCapabilityEvidence } from "../authz/rules.js";
import {
  AuthzRuleId,
  AuthzTagAssignmentId,
  AuthzTagId,
  type AuthzRule,
  type AuthzTagAssignment,
} from "../authz/schema.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import {
  makeReceiptApprovalContext,
  selectAuthorizedReceiptApprovals,
  type ReceiptApprovalCandidate,
} from "./approval-list.js";
import {
  mapExistingReceiptApprovalActor,
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  type ReceiptApprovalGrant,
} from "./authority.js";
import { ReceiptId } from "./schema.js";
import { receiptCompositionFailure } from "./errors.js";

const authorizationInstant = "2037-06-15T12:00:00.000Z";
const activeStart = "2037-01-01T00:00:00.000Z";
const personId = PersonId.make("approval-list-person");
const departmentA = DepartmentId.make("approval-list-department-a");
const departmentB = DepartmentId.make("approval-list-department-b");
const tagId = AuthzTagId.make("approval-list-tag");

const organization = (
  departmentIds: ReadonlyArray<DepartmentId> = [departmentA, departmentB],
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator: "Absent",
  memberships: departmentIds.map((departmentId, index) => ({
    membershipId: MembershipId.make(`approval-list-membership-${index}`),
    teamId: TeamId.make(`approval-list-team-${index}`),
    departmentId,
    active: true,
    teamLeader: false,
  })),
});

const directGrant = (
  id: string,
  scope: ReceiptApprovalGrant["scope"],
  endAt: string | null = null,
): ReceiptApprovalGrant => ({
  approvalGrantId: ReceiptApprovalGrantId.make(id),
  personId,
  scope,
  startAt: activeStart,
  endAt,
  revision: 0,
});

const rule = (options: {
  readonly id: string;
  readonly scope: AuthzRule["scope"];
  readonly slot: "EconomyDepartmentApprovalGrant" | "EconomyGlobalReceiptApprovalGrant";
  readonly subject?: AuthzRule["subject"];
  readonly endAt?: string | null;
}): AuthzRule =>
  ({
    ruleId: AuthzRuleId.make(options.id),
    capabilityId: "approveReceipt",
    effectKind: "delegate",
    subject: options.subject ?? { _tag: "Person", personId },
    scope: options.scope,
    params:
      options.slot === "EconomyDepartmentApprovalGrant"
        ? { slot: "EconomyDepartmentApprovalGrant" }
        : { slot: "EconomyGlobalReceiptApprovalGrant" },
    startAt: activeStart,
    endAt: options.endAt ?? null,
    revision: 0,
  }) as AuthzRule;

const assignment = (endAt: string | null): AuthzTagAssignment => ({
  assignmentId: AuthzTagAssignmentId.make("approval-list-assignment"),
  tagId,
  personId,
  startAt: activeStart,
  endAt,
  revision: 0,
});

const requirement = (
  id: string,
  requirementId: "receipts.pending" | "receipts.approver-relationship",
): AuthzRule =>
  ({
    ruleId: AuthzRuleId.make(id),
    capabilityId: "approveReceipt",
    effectKind: "requirement",
    subject: { _tag: "Person", personId },
    scope: { _tag: "Global" },
    params: { requirementId, parameters: {} },
    startAt: activeStart,
    endAt: null,
    revision: 0,
  }) as AuthzRule;

const candidate = (
  receiptId: string,
  departmentId: DepartmentId,
  status: ReceiptApprovalCandidate["status"] = "Pending",
): ReceiptApprovalCandidate => ({
  receiptId: ReceiptId.make(receiptId),
  ownerPersonId: PersonId.make("approval-list-owner"),
  departmentId,
  status,
  revision: 0,
});

const select = (
  candidates: ReadonlyArray<ReceiptApprovalCandidate>,
  grants: ReadonlyArray<ReceiptApprovalGrant>,
  rules: ReadonlyArray<AuthzRule>,
  tagAssignments: ReadonlyArray<AuthzTagAssignment> = [],
) => {
  const organizationAuthority = organization();
  return selectAuthorizedReceiptApprovals(
    organizationAuthority,
    projectReceiptAuthority(organizationAuthority, [], grants),
    candidates,
    rules,
    tagAssignments,
  );
};

const composeExistingApprovalAuthority = (
  grants: ReadonlyArray<ReceiptApprovalGrant>,
  rules: ReadonlyArray<AuthzRule>,
  receiptDepartmentId: DepartmentId,
) => {
  const receipt = candidate("approval-list-existing", receiptDepartmentId);
  const organizationAuthority = organization();
  const directAuthority = projectReceiptAuthority(organizationAuthority, [], grants);
  const composition = composeCapabilityEvidence(
    "approveReceipt",
    { approvalGrants: directAuthority.approvalGrants },
    rules,
    {
      personId,
      authorizationInstant,
      context: makeReceiptApprovalContext(receipt, organizationAuthority, directAuthority, rules),
      tagAssignments: [],
    },
  );
  return projectReceiptAuthority(
    organizationAuthority,
    [],
    composition.evidence.approvalGrants ?? [],
  );
};

describe("rule-aware Receipt approval visibility", () => {
  it("preserves direct global, department, inactive, and absent behavior", () => {
    const candidates = [candidate("receipt-a", departmentA), candidate("receipt-b", departmentB)];
    expect(select(candidates, [directGrant("direct-global", { _tag: "Global" })], [])).toEqual({
      _tag: "Allow",
      value: { receiptIds: ["receipt-a", "receipt-b"] },
    });
    expect(
      select(
        candidates,
        [
          directGrant("direct-department", {
            _tag: "Department",
            departmentId: departmentA,
          }),
        ],
        [],
      ),
    ).toEqual({
      _tag: "Allow",
      value: { receiptIds: ["receipt-a"] },
    });
    expect(
      select(
        candidates,
        [
          directGrant(
            "direct-inactive",
            { _tag: "Department", departmentId: departmentA },
            authorizationInstant,
          ),
        ],
        [],
      ),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
    expect(select(candidates, [], [])).toEqual({ _tag: "Deny", reason: "NotInScope" });
    const inactiveOrganization = organization([]);
    expect(
      selectAuthorizedReceiptApprovals(
        inactiveOrganization,
        projectReceiptAuthority(inactiveOrganization, [], []),
        candidates,
        [],
        [],
      ),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });

  it("evaluates department and global delegates against each receipt context", () => {
    const candidates = [candidate("receipt-a", departmentA), candidate("receipt-b", departmentB)];
    expect(
      select(
        candidates,
        [],
        [
          rule({
            id: "rule-department",
            scope: { _tag: "Department", departmentId: departmentA },
            slot: "EconomyDepartmentApprovalGrant",
          }),
        ],
      ),
    ).toEqual({ _tag: "Allow", value: { receiptIds: ["receipt-a"] } });
    expect(
      select(
        candidates,
        [],
        [
          rule({
            id: "rule-global",
            scope: { _tag: "Global" },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual({
      _tag: "Allow",
      value: { receiptIds: ["receipt-a", "receipt-b"] },
    });
  });

  it("confines a Department rule that delegates the global slot", () => {
    expect(
      select(
        [candidate("receipt-a", departmentA), candidate("receipt-b", departmentB)],
        [],
        [
          rule({
            id: "rule-department-global-slot",
            scope: { _tag: "Department", departmentId: departmentA },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual({ _tag: "Allow", value: { receiptIds: ["receipt-a"] } });
  });

  it("requires active rule and tag intervals at the authorization instant", () => {
    const receipt = candidate("receipt-a", departmentA);
    const expired = rule({
      id: "rule-expired",
      scope: { _tag: "Department", departmentId: departmentA },
      slot: "EconomyDepartmentApprovalGrant",
      endAt: authorizationInstant,
    });
    expect(select([receipt], [], [expired])).toEqual({ _tag: "Deny", reason: "NotInScope" });

    const tagged = rule({
      id: "rule-tagged",
      subject: { _tag: "Tag", tagId },
      scope: { _tag: "Department", departmentId: departmentA },
      slot: "EconomyDepartmentApprovalGrant",
    });
    expect(select([receipt], [], [tagged], [assignment(authorizationInstant)])).toEqual({
      _tag: "Deny",
      reason: "NotInScope",
    });
    expect(select([receipt], [], [tagged], [assignment(null)])).toEqual({
      _tag: "Allow",
      value: { receiptIds: ["receipt-a"] },
    });
  });

  it("filters nonpending and foreign receipts through typed requirements", () => {
    const rules = [
      rule({
        id: "delegate",
        scope: { _tag: "Global" },
        slot: "EconomyGlobalReceiptApprovalGrant",
      }),
      requirement("require-pending", "receipts.pending"),
      requirement("require-approver", "receipts.approver-relationship"),
    ];
    expect(
      select(
        [
          candidate("pending-related", departmentA),
          candidate("rejected-related", departmentA, "Rejected"),
          candidate("pending-foreign", DepartmentId.make("approval-list-foreign-department")),
        ],
        [],
        rules,
      ),
    ).toEqual({
      _tag: "Allow",
      value: { receiptIds: ["pending-related"] },
    });
  });

  it("deduplicates rules and returns an empty allowed projection for no contexts", () => {
    const duplicate = requirement("require-pending", "receipts.pending");
    expect(
      select(
        [candidate("pending", departmentA)],
        [],
        [
          rule({
            id: "delegate",
            scope: { _tag: "Global" },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
          duplicate,
          duplicate,
        ],
      ),
    ).toEqual({ _tag: "Allow", value: { receiptIds: ["pending"] } });
    expect(select([], [], [])).toEqual({
      _tag: "Allow",
      value: { receiptIds: [] },
    });
  });

  it.effect("maps a zero-rule foreign existing Receipt to scope denial", () =>
    Effect.gen(function* () {
      const receiptId = "approval-existing-foreign";
      const foreignAuthority = composeExistingApprovalAuthority(
        [
          directGrant("direct-department-a", {
            _tag: "Department",
            departmentId: departmentA,
          }),
        ],
        [],
        departmentB,
      );

      const denied = yield* Effect.flip(
        mapExistingReceiptApprovalActor(foreignAuthority, receiptId, departmentB),
      );
      expect(denied).toMatchObject({
        _tag: "ReceiptScopeDenied",
        receiptId,
        departmentId: departmentB,
      });
    }),
  );

  it.effect("maps rule-only composed department and global approval grants", () =>
    Effect.gen(function* () {
      const cases = [
        {
          receiptId: "approval-rule-department",
          approvalRule: rule({
            id: "rule-existing-department",
            scope: { _tag: "Department", departmentId: departmentB },
            slot: "EconomyDepartmentApprovalGrant",
          }),
          approvalScope: { _tag: "Department", departmentId: departmentB },
        },
        {
          receiptId: "approval-rule-global",
          approvalRule: rule({
            id: "rule-existing-global",
            scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
          approvalScope: { _tag: "Global" },
        },
      ] as const;

      for (const approvalCase of cases) {
        const authority = composeExistingApprovalAuthority(
          [],
          [approvalCase.approvalRule],
          departmentB,
        );
        expect(
          yield* mapExistingReceiptApprovalActor(authority, approvalCase.receiptId, departmentB),
        ).toMatchObject({
          active: true,
          approvalScope: approvalCase.approvalScope,
        });
      }
    }),
  );

  it("maps bounded composer denials to stable Receipt failures without persisted effects", () => {
    expect(receiptCompositionFailure("Ambiguous", personId, "submitReceipt")).toMatchObject({
      _tag: "AmbiguousParameterFill",
      personId,
      capabilityId: "submitReceipt",
    });
    expect(
      receiptCompositionFailure("RequirementFailed", personId, "approveReceipt"),
    ).toMatchObject({
      _tag: "FailedComposedRequirement",
      personId,
      capabilityId: "approveReceipt",
    });
    expect(receiptCompositionFailure("NotInScope", personId, "submitReceipt")).toBeUndefined();
  });
});
