import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import {
  mapReceiptDepartmentApprovalActor,
  mapReceiptGlobalApprovalActor,
  mapReceiptOwnerActor,
  mapReceiptOwnerPrincipal,
  mapReceiptSubmissionPrincipal,
  projectReceiptAuthority,
  ReceiptApprovalGrantId,
  ReceiptPaymentAuthorityId,
  type ReceiptApprovalGrant,
  type ReceiptPaymentAuthority,
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
});

const membership = (
  departmentId: DepartmentId,
  active: boolean,
): OrganizationPersonAuthority["memberships"][number] => ({
  membershipId: MembershipId.make(`membership-${departmentId}`),
  teamId: TeamId.make(`team-${departmentId}`),
  departmentId,
  active,
  teamLeader: false,
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

it.effect("maps explicit department and global Receipt approval grants", () =>
  Effect.gen(function* () {
    const authority = projectReceiptAuthority(
      organizationAuthority([membership(departmentOne, true)]),
      [],
      [
        approvalGrant("approval-department", {
          _tag: "Department",
          departmentId: departmentOne,
        }),
        approvalGrant("approval-global", { _tag: "Global" }),
      ],
    );

    const departmentActor = yield* mapReceiptDepartmentApprovalActor(authority, departmentOne);
    expect(departmentActor).toEqual({
      personId,
      departmentId: departmentOne,
      active: true,
      approvalScope: { _tag: "Department", departmentId: departmentOne },
    });

    const globalActor = yield* mapReceiptGlobalApprovalActor(authority, departmentTwo);
    expect(globalActor).toEqual({
      personId,
      departmentId: departmentTwo,
      active: true,
      approvalScope: { _tag: "Global" },
    });
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
      approvalScope: { _tag: "None" },
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
    expect(failure).toMatchObject({
      _tag: "AmbiguousReceiptPaymentAuthority",
      departmentIds: [departmentOne, departmentTwo],
    });
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
          { _tag: "Department", departmentId: departmentOne },
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
