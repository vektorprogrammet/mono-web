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
import { resolveReceiptApprovalVisibility } from "./approval-list.js";
import {
  mapExistingReceiptApprovalActor,
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  type ReceiptApprovalGrant,
} from "./authority.js";
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
}): AuthzRule => ({
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
});

const assignment = (endAt: string | null): AuthzTagAssignment => ({
  assignmentId: AuthzTagAssignmentId.make("approval-list-assignment"),
  tagId,
  personId,
  startAt: activeStart,
  endAt,
  revision: 0,
});

const resolve = (
  grants: ReadonlyArray<ReceiptApprovalGrant>,
  rules: ReadonlyArray<AuthzRule>,
  tagAssignments: ReadonlyArray<AuthzTagAssignment> = [],
) => {
  const organizationAuthority = organization();
  return resolveReceiptApprovalVisibility(
    organizationAuthority,
    projectReceiptAuthority(organizationAuthority, [], grants),
    [departmentB, departmentA, departmentA],
    rules,
    tagAssignments,
  );
};

const composeExistingApprovalAuthority = (
  grants: ReadonlyArray<ReceiptApprovalGrant>,
  rules: ReadonlyArray<AuthzRule>,
  receiptDepartmentId: DepartmentId,
) => {
  const organizationAuthority = organization();
  const directAuthority = projectReceiptAuthority(organizationAuthority, [], grants);
  const composition = composeCapabilityEvidence(
    "approveReceipt",
    { approvalGrants: directAuthority.approvalGrants },
    rules,
    {
      personId,
      authorizationInstant,
      requestScope: { domainId: RECEIPT_DOMAIN_ID, departmentId: receiptDepartmentId },
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
  it("preserves direct global, department, inactive, and absent behavior with zero rules", () => {
    expect(resolve([directGrant("direct-global", { _tag: "Global" })], [])).toEqual({
      _tag: "Allow",
      value: { _tag: "Global" },
    });
    expect(
      resolve(
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
      value: { _tag: "Departments", departmentIds: [departmentA] },
    });
    expect(
      resolve(
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
    expect(resolve([], [])).toEqual({ _tag: "Deny", reason: "NotInScope" });
    const inactiveOrganization = organization([]);
    expect(
      resolveReceiptApprovalVisibility(
        inactiveOrganization,
        projectReceiptAuthority(inactiveOrganization, [], []),
        [departmentA],
        [],
        [],
      ),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });

  it("grants a rule-only department list without exposing another department", () => {
    const departmentRule = rule({
      id: "rule-department",
      scope: { _tag: "Department", departmentId: departmentA },
      slot: "EconomyDepartmentApprovalGrant",
    });
    expect(resolve([], [departmentRule])).toEqual({
      _tag: "Allow",
      value: { _tag: "Departments", departmentIds: [departmentA] },
    });
  });

  it("treats a broad rule-sourced global grant as global visibility", () => {
    expect(
      resolve(
        [],
        [
          rule({
            id: "rule-global",
            scope: { _tag: "Global" },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual({ _tag: "Allow", value: { _tag: "Global" } });
    expect(
      resolve(
        [],
        [
          rule({
            id: "rule-receipt",
            scope: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual({ _tag: "Allow", value: { _tag: "Global" } });
  });

  it("confines a Department rule that delegates the global slot", () => {
    expect(
      resolve(
        [],
        [
          rule({
            id: "rule-department-global-slot",
            scope: { _tag: "Department", departmentId: departmentA },
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual({
      _tag: "Allow",
      value: { _tag: "Departments", departmentIds: [departmentA] },
    });
  });

  it("unions and deduplicates direct and rule departments deterministically", () => {
    expect(
      resolve(
        [
          directGrant("direct-a", {
            _tag: "Department",
            departmentId: departmentA,
          }),
        ],
        [
          rule({
            id: "rule-b-one",
            scope: { _tag: "Department", departmentId: departmentB },
            slot: "EconomyDepartmentApprovalGrant",
          }),
          rule({
            id: "rule-b-two",
            scope: { _tag: "Department", departmentId: departmentB },
            slot: "EconomyDepartmentApprovalGrant",
          }),
        ],
      ),
    ).toEqual({
      _tag: "Allow",
      value: { _tag: "Departments", departmentIds: [departmentA, departmentB] },
    });
  });

  it("requires an active interval and an active tag assignment", () => {
    const expired = rule({
      id: "rule-expired",
      scope: { _tag: "Department", departmentId: departmentA },
      slot: "EconomyDepartmentApprovalGrant",
      endAt: authorizationInstant,
    });
    expect(resolve([], [expired])).toEqual({ _tag: "Deny", reason: "NotInScope" });

    const tagged = rule({
      id: "rule-tagged",
      subject: { _tag: "Tag", tagId },
      scope: { _tag: "Department", departmentId: departmentA },
      slot: "EconomyDepartmentApprovalGrant",
    });
    expect(resolve([], [tagged], [assignment(authorizationInstant)])).toEqual({
      _tag: "Deny",
      reason: "NotInScope",
    });
    expect(resolve([], [tagged], [assignment(null)])).toEqual({
      _tag: "Allow",
      value: { _tag: "Departments", departmentIds: [departmentA] },
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
