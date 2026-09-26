import { ApprovalScopeSchema } from "./schema.js";
import { Scope } from "../authz/access.js";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import {
  mapExistingReceiptSettlementActor,
  mapReceiptDepartmentApprovalActor,
  mapReceiptGlobalApprovalActor,
  mapReceiptOwnerActor,
  mapReceiptOwnerPrincipal,
  mapReceiptSubmissionPrincipal,
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  ReceiptPaymentAuthorityId,
  ReceiptSettlementGrantId,
  type ReceiptApprovalGrant,
  type ReceiptPaymentAuthority,
  type ReceiptSettlementGrant,
} from "./authority.js";

const evaluatedAt = "2026-08-24T12:00:00.000Z";

const personId = PersonId.make("person-receipt-authority");

const departmentOne = DepartmentId.make("department-one");

const departmentTwo = DepartmentId.make("department-two");

const organizationAuthority = (
  memberships: OrganizationPersonAuthority["memberships"],
  globalAdministrator: OrganizationPersonAuthority["globalAdministrator"] = "Absent",
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt,
  globalAdministrator,
  memberships,
  nationalBoardSeats: [],
  delegations: [],
});

const membership = (
  departmentId: DepartmentId,
  active: boolean,
): OrganizationPersonAuthority["memberships"][number] => ({
  membershipId: MembershipId.make(`membership-${departmentId}`),
  teamId: TeamId.make(`team-${departmentId}`),
  departmentId,
  active,
  unitLeader: false,
  unitKind: "Team",
  teamScope: "HomeDepartment",
  departmentIndependent: false,
});

const paymentAuthority = (
  id: string,
  departmentId: DepartmentId,
  paymentAccountCiphertext: string,
  startAt = "2026-08-01T00:00:00.000Z",
  endAt: string | null = null,
): ReceiptPaymentAuthority => ({
  paymentAuthorityId: ReceiptPaymentAuthorityId.make(id),
  personId,
  departmentId,
  paymentAccountCiphertext,
  startAt,
  endAt,
  revision: 0,
});

const approvalGrant = (
  id: string,
  scope: ReceiptApprovalGrant["scope"],
  startAt = "2026-08-01T00:00:00.000Z",
  endAt: string | null = null,
): ReceiptApprovalGrant => ({
  approvalGrantId: ReceiptApprovalGrantId.make(id),
  personId,
  scope,
  startAt,
  endAt,
  revision: 0,
});

const settlementGrant = (
  id: string,
  scope: ReceiptSettlementGrant["scope"],
  startAt = "2026-08-01T00:00:00.000Z",
  endAt: string | null = null,
): ReceiptSettlementGrant => ({
  settlementGrantId: ReceiptSettlementGrantId.make(id),
  personId,
  scope,
  startAt,
  endAt,
  revision: 0,
});

it.effect("maps explicit department and global Receipt approval grants", () =>
  Effect.gen(function* () {
    const authority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [],
      [
        approvalGrant("approval-department", Scope.Department({ departmentId: departmentOne })),
        approvalGrant("approval-global", Scope.Global()),
      ],
    );

    const departmentActor = yield* mapReceiptDepartmentApprovalActor(authority, departmentOne);
    expect(departmentActor).toEqual({
      personId,
      departmentId: departmentOne,
      active: true,
      approvalScope: Scope.Department({ departmentId: departmentOne }),
    });

    const globalActor = yield* mapReceiptGlobalApprovalActor(authority, departmentTwo);
    expect(globalActor).toEqual({
      personId,
      departmentId: departmentTwo,
      active: true,
      approvalScope: Scope.Global(),
    });
  }),
);

it.effect("requires an active current settlement grant and conceals its scope", () =>
  Effect.gen(function* () {
    const departmentAuthority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [],
      [],
      [settlementGrant("settlement-department", Scope.Department({ departmentId: departmentOne }))],
    );

    const actor = yield* mapExistingReceiptSettlementActor(
      departmentAuthority,
      "receipt-settlement-1",
      departmentOne,
    );

    expect(actor).toEqual({
      personId,
      active: true,
      settlementScope: Scope.Department({ departmentId: departmentOne }),
    });

    const wrongDepartment = yield* Effect.flip(
      mapExistingReceiptSettlementActor(departmentAuthority, "receipt-settlement-2", departmentTwo),
    );

    expect(wrongDepartment._tag).toBe("ReceiptNotFound");

    const expiredAuthority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [],
      [],
      [
        settlementGrant(
          "settlement-expired",
          Scope.Department({ departmentId: departmentOne }),
          "2026-08-01T00:00:00.000Z",
          evaluatedAt,
        ),
      ],
    );

    const expired = yield* Effect.flip(
      mapExistingReceiptSettlementActor(expiredAuthority, "receipt-settlement-3", departmentOne),
    );

    expect(expired._tag).toBe("ReceiptNotFound");

    const detachedAuthority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, false)]),
      [],
      [],
      [settlementGrant("settlement-detached", Scope.Department({ departmentId: departmentOne }))],
    );

    const detached = yield* Effect.flip(
      mapExistingReceiptSettlementActor(detachedAuthority, "receipt-settlement-4", departmentOne),
    );

    expect(detached._tag).toBe("ReceiptNotFound");

    const globalAuthority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [],
      [],
      [settlementGrant("settlement-global", Scope.Global())],
    );

    const global = yield* mapExistingReceiptSettlementActor(
      globalAuthority,
      "receipt-settlement-4",
      departmentTwo,
    );

    expect(global.settlementScope).toEqual(Scope.Global());
  }),
);

it.effect("preserves multiple payment departments and uses an explicit selection", () =>
  Effect.gen(function* () {
    const authority = projectReceiptAuthority(
      organizationAuthority([membership(departmentTwo, true), membership(departmentOne, true)]),
      [
        paymentAuthority("payment-two", departmentTwo, "ciphertext:two"),
        paymentAuthority("payment-one", departmentOne, "ciphertext:one"),
      ],
      [],
    );

    expect(authority.paymentAuthorities.map((payment) => payment.departmentId)).toEqual([
      departmentOne,
      departmentTwo,
    ]);
    const principal = yield* mapReceiptSubmissionPrincipal(authority, departmentTwo);
    expect(principal.paymentAccountCiphertext).toBe("ciphertext:two");
    expect(principal.actor).toEqual({
      personId,
      departmentId: departmentTwo,
      active: true,
      approvalScope: ApprovalScopeSchema.cases.None.make({}),
    });
  }),
);

it.effect("rejects an ambiguous active payment selection", () =>
  Effect.gen(function* () {
    const authority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true), membership(departmentTwo, true)]),
      [
        paymentAuthority("payment-one", departmentOne, "ciphertext:one"),
        paymentAuthority("payment-two", departmentTwo, "ciphertext:two"),
      ],
      [],
    );

    const failure = yield* Effect.flip(mapReceiptSubmissionPrincipal(authority));
    {
      const observedTaggedValue = failure;
      expect(observedTaggedValue).toHaveProperty(["_tag"], "AmbiguousReceiptPaymentAuthority");
      expect(observedTaggedValue).toMatchObject({
        departmentIds: [departmentOne, departmentTwo],
      });
    }
  }),
);

it.effect("keeps inactive payment, approval, and owner authority as inactive actors", () =>
  Effect.gen(function* () {
    const endedAt = evaluatedAt;

    const authority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [
        paymentAuthority(
          "payment-ended",
          departmentOne,
          "ciphertext:ended",
          "2026-08-01T00:00:00.000Z",
          endedAt,
        ),
      ],
      [
        approvalGrant(
          "approval-ended",
          Scope.Department({ departmentId: departmentOne }),
          "2026-08-01T00:00:00.000Z",
          endedAt,
        ),
      ],
    );

    const submission = yield* mapReceiptSubmissionPrincipal(authority, departmentOne);
    expect(submission.actor.active).toBe(false);
    const approval = yield* mapReceiptDepartmentApprovalActor(authority, departmentOne);
    expect(approval.active).toBe(false);

    const inactiveOwnerAuthority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, false)]),
      [],
      [],
    );

    const owner = yield* mapReceiptOwnerPrincipal(inactiveOwnerAuthority);
    expect(owner).toEqual({ personId, active: false });
    const ownerActor = yield* mapReceiptOwnerActor(inactiveOwnerAuthority, departmentOne);
    expect(ownerActor.active).toBe(false);
  }),
);

it.effect("never infers Receipt approval from Organization administrator authority", () =>
  Effect.gen(function* () {
    const authority = projectReceiptAuthority(organizationAuthority([], "Active"), [], []);

    const departmentDenied = yield* Effect.flip(
      mapReceiptDepartmentApprovalActor(authority, departmentOne),
    );

    expect(departmentDenied._tag).toBe("ReceiptAuthorityDenied");

    const globalDenied = yield* Effect.flip(
      mapReceiptGlobalApprovalActor(authority, departmentOne),
    );

    expect(globalDenied._tag).toBe("ReceiptAuthorityDenied");
  }),
);
