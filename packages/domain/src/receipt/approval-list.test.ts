import { deny, allow } from "../authz/decision.js";
import { describe, expect, it } from "@effect/vitest";
import { Schema, Effect } from "effect";
import { Scope, PrincipalSchema, RECEIPT_DOMAIN_ID } from "../authz/access.js";
import { composeCapabilityEvidence } from "../authz/rules.js";
import {
  AuthzRuleSchema,
  AuthzRuleSubjectSchema,
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
  selectAuthorizedReceiptFileForApproval,
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
    unitLeader: false,
    unitKind: "Team",
    teamScope: "HomeDepartment",
    departmentIndependent: false,
  })),
  nationalBoardSeats: [],
  delegations: [],
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
  Schema.decodeUnknownSync(AuthzRuleSchema)({
    ruleId: AuthzRuleId.make(options.id),
    capabilityId: "approveReceipt",
    effectKind: "delegate",
    subject: options.subject ?? PrincipalSchema.cases.Person.make({ personId }),
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

const requirement = (
  id: string,
  requirementId: "receipts.pending" | "receipts.approver-relationship",
): AuthzRule =>
  Schema.decodeUnknownSync(AuthzRuleSchema)({
    ruleId: AuthzRuleId.make(id),
    capabilityId: "approveReceipt",
    effectKind: "requirement",
    subject: PrincipalSchema.cases.Person.make({ personId }),
    scope: Scope.Global(),
    params: { requirementId, parameters: {} },
    startAt: activeStart,
    endAt: null,
    revision: 0,
  });

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
      principal: PrincipalSchema.cases.Person.make({ personId }),
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
    expect(select(candidates, [directGrant("direct-global", Scope.Global())], [])).toEqual(
      allow({ receiptIds: ["receipt-a", "receipt-b"] }),
    );
    expect(
      select(
        candidates,
        [directGrant("direct-department", Scope.Department({ departmentId: departmentA }))],
        [],
      ),
    ).toEqual(allow({ receiptIds: ["receipt-a"] }));
    expect(
      select(
        candidates,
        [
          directGrant(
            "direct-inactive",
            Scope.Department({ departmentId: departmentA }),
            authorizationInstant,
          ),
        ],
        [],
      ),
    ).toEqual(deny("AuthorityInactive"));
    expect(select(candidates, [], [])).toEqual(deny("NotInScope"));
    const inactiveOrganization = organization([]);
    expect(
      selectAuthorizedReceiptApprovals(
        inactiveOrganization,
        projectReceiptAuthority(inactiveOrganization, [], []),
        candidates,
        [],
        [],
      ),
    ).toEqual(deny("AuthorityInactive"));
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
            scope: Scope.Department({ departmentId: departmentA }),
            slot: "EconomyDepartmentApprovalGrant",
          }),
        ],
      ),
    ).toEqual(allow({ receiptIds: ["receipt-a"] }));
    expect(
      select(
        candidates,
        [],
        [
          rule({
            id: "rule-global",
            scope: Scope.Global(),
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual(allow({ receiptIds: ["receipt-a", "receipt-b"] }));
  });

  it("confines a Department rule that delegates the global slot", () => {
    expect(
      select(
        [candidate("receipt-a", departmentA), candidate("receipt-b", departmentB)],
        [],
        [
          rule({
            id: "rule-department-global-slot",
            scope: Scope.Department({ departmentId: departmentA }),
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
        ],
      ),
    ).toEqual(allow({ receiptIds: ["receipt-a"] }));
  });

  it("requires active rule and tag intervals at the authorization instant", () => {
    const receipt = candidate("receipt-a", departmentA);

    const expired = rule({
      id: "rule-expired",
      scope: Scope.Department({ departmentId: departmentA }),
      slot: "EconomyDepartmentApprovalGrant",
      endAt: authorizationInstant,
    });

    expect(select([receipt], [], [expired])).toEqual(deny("NotInScope"));

    const tagged = rule({
      id: "rule-tagged",
      subject: AuthzRuleSubjectSchema.cases.Tag.make({ tagId }),
      scope: Scope.Department({ departmentId: departmentA }),
      slot: "EconomyDepartmentApprovalGrant",
    });

    expect(select([receipt], [], [tagged], [assignment(authorizationInstant)])).toEqual(
      deny("NotInScope"),
    );
    expect(select([receipt], [], [tagged], [assignment(null)])).toEqual(
      allow({ receiptIds: ["receipt-a"] }),
    );
  });

  it("filters nonpending and foreign receipts through typed requirements", () => {
    const rules = [
      rule({
        id: "delegate",
        scope: Scope.Global(),
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
    ).toEqual(allow({ receiptIds: ["pending-related"] }));
  });

  it("keeps active scoped terminal receipts readable without the pending decision requirement", () => {
    const organizationAuthority = organization([departmentA]);

    const directAuthority = projectReceiptAuthority(
      organizationAuthority,
      [],
      [directGrant("file-read-department", Scope.Department({ departmentId: departmentA }))],
    );

    const terminal = candidate("terminal-file", departmentA, "Approved");

    const rules = [
      requirement("file-read-require-pending", "receipts.pending"),
      requirement("file-read-require-approver", "receipts.approver-relationship"),
    ];

    expect(
      selectAuthorizedReceiptApprovals(
        organizationAuthority,
        directAuthority,
        [terminal],
        rules,
        [],
      ),
    ).toEqual(deny("RequirementFailed"));
    expect(
      selectAuthorizedReceiptFileForApproval(
        organizationAuthority,
        directAuthority,
        terminal,
        rules,
        [],
      ),
    ).toEqual(allow({ receiptIds: ["terminal-file"] }));
  });

  it("deduplicates rules and still requires authority for an empty projection", () => {
    const duplicate = requirement("require-pending", "receipts.pending");
    expect(
      select(
        [candidate("pending", departmentA)],
        [],
        [
          rule({
            id: "delegate",
            scope: Scope.Global(),
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
          duplicate,
          duplicate,
        ],
      ),
    ).toEqual(allow({ receiptIds: ["pending"] }));
    expect(select([], [], [])).toEqual(deny("NotInScope"));
    expect(select([], [directGrant("empty-global", Scope.Global())], [])).toEqual(
      allow({ receiptIds: [] }),
    );
  });

  it.effect("maps a zero-rule foreign existing Receipt to scope denial", () =>
    Effect.gen(function* () {
      const receiptId = "approval-existing-foreign";

      const foreignAuthority = composeExistingApprovalAuthority(
        [directGrant("direct-department-a", Scope.Department({ departmentId: departmentA }))],
        [],
        departmentB,
      );

      const denied = yield* Effect.flip(
        mapExistingReceiptApprovalActor(foreignAuthority, receiptId, departmentB),
      );

      {
        const observedTaggedValue = denied;
        expect(observedTaggedValue).toHaveProperty(["_tag"], "ReceiptScopeDenied");
        expect(observedTaggedValue).toMatchObject({
          receiptId,
          departmentId: departmentB,
        });
      }
    }),
  );

  it.effect("maps rule-only composed department and global approval grants", () =>
    Effect.gen(function* () {
      const cases = [
        {
          receiptId: ReceiptId.make("approval-rule-department"),
          approvalRule: rule({
            id: "rule-existing-department",
            scope: Scope.Department({ departmentId: departmentB }),
            slot: "EconomyDepartmentApprovalGrant",
          }),
          approvalScope: Scope.Department({ departmentId: departmentB }),
        },
        {
          receiptId: ReceiptId.make("approval-rule-global"),
          approvalRule: rule({
            id: "rule-existing-global",
            scope: Scope.Domain({ domainId: RECEIPT_DOMAIN_ID }),
            slot: "EconomyGlobalReceiptApprovalGrant",
          }),
          approvalScope: Scope.Global(),
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
    {
      const observedTaggedValue = receiptCompositionFailure("Ambiguous", personId, "submitReceipt");
      expect(observedTaggedValue).toHaveProperty(["_tag"], "AmbiguousParameterFill");
      expect(observedTaggedValue).toMatchObject({
        personId,
        capabilityId: "submitReceipt",
      });
    }

    {
      const observedTaggedValue = receiptCompositionFailure(
        "RequirementFailed",
        personId,
        "approveReceipt",
      );

      expect(observedTaggedValue).toHaveProperty(["_tag"], "FailedComposedRequirement");
      expect(observedTaggedValue).toMatchObject({
        personId,
        capabilityId: "approveReceipt",
      });
    }

    expect(receiptCompositionFailure("NotInScope", personId, "submitReceipt")).toBeUndefined();
  });
});
